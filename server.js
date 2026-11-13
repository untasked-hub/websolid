'use strict';

const fs = require('fs');
const { resolveAll } = require('./public/equations.js');
const path = require('path');
const express = require('express');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 8080);
const DATABASE_URL = process.env.DATABASE_URL || '';

function needsSsl(url) {
  if (!url) return false;
  if (/sslmode=(require|verify|prefer)/i.test(url)) return true;
  try {
    const host = new URL(url).hostname;
    // local compose service or loopback: plain TCP is fine
    return !(host === 'db' || host === 'localhost' || host === '127.0.0.1');
  } catch (err) {
    return false;
  }
}

const MIGRATION_DATABASE_URL = process.env.MIGRATION_DATABASE_URL || '';

const pool = new Pool({
  connectionString: DATABASE_URL || undefined,
  ssl: needsSsl(DATABASE_URL) ? { rejectUnauthorized: false } : false,
  max: 5,
});

// Preview and hosted databases give the runtime role no CREATE privilege.
// The owner connection is used once, at boot, to shape the schema.
const migrationPool = MIGRATION_DATABASE_URL && MIGRATION_DATABASE_URL !== DATABASE_URL
  ? new Pool({
      connectionString: MIGRATION_DATABASE_URL,
      ssl: needsSsl(MIGRATION_DATABASE_URL) ? { rejectUnauthorized: false } : false,
      max: 2,
    })
  : null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#6366f1',
  status TEXT NOT NULL DEFAULT 'active',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tasks (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT NOT NULL DEFAULT 'medium',
  due_date DATE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS sessions (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL,
  minutes INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS parts (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  payload JSONB NOT NULL,
  volume_mm3 DOUBLE PRECISION,
  mass_g DOUBLE PRECISION,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id);
CREATE INDEX IF NOT EXISTS sessions_created_idx ON sessions(created_at);
`;

async function grantToRuntime() {
  if (!migrationPool) return;
  const who = await pool.query('SELECT current_user AS u');
  const runtimeRole = who.rows[0].u;
  const schema = await pool.query('SELECT current_schema() AS s');
  const s = schema.rows[0].s || 'public';
  const ident = '"' + String(runtimeRole).replace(/"/g, '""') + '"';
  const sch = '"' + String(s).replace(/"/g, '""') + '"';
  await migrationPool.query('GRANT USAGE, CREATE ON SCHEMA ' + sch + ' TO ' + ident);
  await migrationPool.query('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ' + sch + ' TO ' + ident);
  await migrationPool.query('GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ' + sch + ' TO ' + ident);
}

async function migrate() {
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      if (migrationPool) {
        await migrationPool.query(SCHEMA);
        await grantToRuntime();
      } else {
        await pool.query(SCHEMA);
      }
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM projects');
      const partsCount = await pool.query('SELECT count(*)::int AS n FROM parts');
      if (rows[0].n === 0 && partsCount.rows[0].n === 0) await seed();
      return;
    } catch (err) {
      console.error('db not ready (attempt ' + attempt + '):', err.message);
      if (attempt === 20) throw err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = await client.query(
      'INSERT INTO projects (name, description, color, position) VALUES ($1, $2, $3, 0) RETURNING id',
      ['WebSolid launch', 'Ship the first public version of WebSolid.', '#6366f1']
    );
    const projectId = p.rows[0].id;
    const tasks = [
      ['Sketch a bracket end to end', 'Sketch to extrude to holes, then export STL.', 'done', 'high', 0],
      ['Persist the parts library', 'Every saved part survives a reload.', 'doing', 'high', 1],
      ['Second-opinion check on hole seats', 'Verify counterbore depth against the wall rule.', 'todo', 'low', 2],
      ['Try SVG sketch import on a real profile', 'Paste a path from an existing drawing.', 'todo', 'medium', 3],
    ];
    for (const t of tasks) {
      await client.query(
        'INSERT INTO tasks (project_id, title, notes, status, priority, position, completed_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [projectId, t[0], t[1], t[2], t[3], t[4], t[2] === 'done' ? new Date() : null]
      );
    }
    await client.query(
      "INSERT INTO sessions (project_id, minutes, note, created_at) VALUES ($1, 25, 'First planning block', now() - interval '1 day')",
      [projectId]
    );
    const exampleParts = [
      ['Mounting bracket', { name: 'Mounting bracket', material: 'aluminium', sketch: { type: 'rect', width: 80, height: 50, round: 6 }, extrude: { depth: 12 }, holes: [{ x: -27, y: -14, d: 8 }, { x: 27, y: -14, d: 8 }, { x: 0, y: 9, d: 16 }] }],
      ['Flange washer', { name: 'Flange washer', material: 'steel', sketch: { type: 'circle', width: 60, height: 60, round: 0 }, extrude: { depth: 10 }, holes: [{ x: 0, y: 0, d: 26 }] }],
      ['Hex standoff', { name: 'Hex standoff', material: 'brass', sketch: { type: 'hex', width: 22, height: 22, round: 0 }, extrude: { depth: 18 }, holes: [{ x: 0, y: 0, d: 6 }] }]
    ];
    for (const ep of exampleParts) {
      await client.query('INSERT INTO parts (name, payload) VALUES ($1, $2)', [ep[0], JSON.stringify(ep[1])]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const app = express();
app.use(express.json({ limit: '256kb' }));

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

const STATUSES = new Set(['todo', 'doing', 'done']);
const PRIORITIES = new Set(['low', 'medium', 'high']);

// The health check must answer even while the database is still warming up,
// otherwise the platform kills the machine before it ever becomes ready.
app.get('/healthz', async (req, res) => {
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    res.json({ ok: true, db: 'up' });
  } catch (err) {
    res.json({ ok: true, db: 'starting' });
  }
});

app.get('/api/state', wrap(async (req, res) => {
  const projects = await pool.query('SELECT * FROM projects ORDER BY position, id');
  const tasks = await pool.query('SELECT * FROM tasks ORDER BY position, id');
  const sessions = await pool.query('SELECT * FROM sessions ORDER BY created_at DESC LIMIT 200');
  const stats = await pool.query(`
    SELECT
      COALESCE((SELECT sum(minutes) FROM sessions WHERE created_at::date = now()::date), 0)::int AS minutes_today,
      COALESCE((SELECT sum(minutes) FROM sessions WHERE created_at >= now() - interval '7 days'), 0)::int AS minutes_week,
      COALESCE((SELECT count(*) FROM tasks WHERE completed_at::date = now()::date), 0)::int AS done_today,
      COALESCE((SELECT count(*) FROM tasks WHERE status <> 'done'), 0)::int AS open_tasks
  `);
  const week = await pool.query(`
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(sum(s.minutes), 0)::int AS minutes
    FROM generate_series(now()::date - interval '6 days', now()::date, interval '1 day') AS d(day)
    LEFT JOIN sessions s ON s.created_at::date = d.day::date
    GROUP BY d.day ORDER BY d.day
  `);
  res.json({
    projects: projects.rows,
    tasks: tasks.rows,
    sessions: sessions.rows,
    stats: Object.assign({}, stats.rows[0], { week: week.rows }),
  });
}));

app.post('/api/projects', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return badRequest(res, 'Project name is required.');
  const color = String(req.body.color || '#6366f1').slice(0, 16);
  const description = String(req.body.description || '').slice(0, 2000);
  const { rows } = await pool.query(
    'INSERT INTO projects (name, description, color, position) VALUES ($1,$2,$3, COALESCE((SELECT max(position) + 1 FROM projects), 0)) RETURNING *',
    [name.slice(0, 200), description, color]
  );
  res.status(201).json(rows[0]);
}));

app.patch('/api/projects/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const fields = [];
  const values = [];
  const push = (col, val) => { values.push(val); fields.push(col + ' = $' + values.length); };
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return badRequest(res, 'Project name cannot be empty.');
    push('name', name.slice(0, 200));
  }
  if (req.body.description !== undefined) push('description', String(req.body.description).slice(0, 2000));
  if (req.body.color !== undefined) push('color', String(req.body.color).slice(0, 16));
  if (req.body.status !== undefined) {
    const status = String(req.body.status);
    if (['active', 'paused', 'done'].indexOf(status) === -1) return badRequest(res, 'Unknown project status.');
    push('status', status);
  }
  if (!fields.length) return badRequest(res, 'Nothing to update.');
  values.push(id);
  const { rows } = await pool.query(
    'UPDATE projects SET ' + fields.join(', ') + ' WHERE id = $' + values.length + ' RETURNING *', values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Project not found.' });
  res.json(rows[0]);
}));

app.delete('/api/projects/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { rowCount } = await pool.query('DELETE FROM projects WHERE id = $1', [id]);
  if (!rowCount) return res.status(404).json({ error: 'Project not found.' });
  res.json({ ok: true });
}));

app.post('/api/tasks', wrap(async (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return badRequest(res, 'Task title is required.');
  const projectId = req.body.project_id ? Number(req.body.project_id) : null;
  const priority = PRIORITIES.has(req.body.priority) ? req.body.priority : 'medium';
  const notes = String(req.body.notes || '').slice(0, 4000);
  const due = req.body.due_date ? String(req.body.due_date).slice(0, 10) : null;
  try {
    const { rows } = await pool.query(
      'INSERT INTO tasks (project_id, title, notes, priority, due_date, position) VALUES ($1,$2,$3,$4,$5, COALESCE((SELECT max(position) + 1 FROM tasks WHERE project_id IS NOT DISTINCT FROM $1), 0)) RETURNING *',
      [projectId, title.slice(0, 300), notes, priority, due]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23503') return badRequest(res, 'That project does not exist.');
    throw err;
  }
}));

app.patch('/api/tasks/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const fields = [];
  const values = [];
  const push = (col, val) => { values.push(val); fields.push(col + ' = $' + values.length); };
  if (req.body.title !== undefined) {
    const title = String(req.body.title).trim();
    if (!title) return badRequest(res, 'Task title cannot be empty.');
    push('title', title.slice(0, 300));
  }
  if (req.body.notes !== undefined) push('notes', String(req.body.notes).slice(0, 4000));
  if (req.body.priority !== undefined) {
    if (!PRIORITIES.has(req.body.priority)) return badRequest(res, 'Unknown priority.');
    push('priority', req.body.priority);
  }
  if (req.body.status !== undefined) {
    if (!STATUSES.has(req.body.status)) return badRequest(res, 'Unknown status.');
    push('status', req.body.status);
    push('completed_at', req.body.status === 'done' ? new Date() : null);
  }
  if (req.body.due_date !== undefined) push('due_date', req.body.due_date ? String(req.body.due_date).slice(0, 10) : null);
  if (req.body.project_id !== undefined) push('project_id', req.body.project_id ? Number(req.body.project_id) : null);
  if (!fields.length) return badRequest(res, 'Nothing to update.');
  values.push(id);
  const { rows } = await pool.query(
    'UPDATE tasks SET ' + fields.join(', ') + ' WHERE id = $' + values.length + ' RETURNING *', values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Task not found.' });
  res.json(rows[0]);
}));

app.delete('/api/tasks/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { rowCount } = await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
  if (!rowCount) return res.status(404).json({ error: 'Task not found.' });
  res.json({ ok: true });
}));

app.post('/api/sessions', wrap(async (req, res) => {
  const minutes = Math.round(Number(req.body.minutes));
  if (!Number.isFinite(minutes) || minutes <= 0) return badRequest(res, 'Minutes must be a positive number.');
  if (minutes > 1440) return badRequest(res, 'That is more than a day. Try a smaller block.');
  const projectId = req.body.project_id ? Number(req.body.project_id) : null;
  const taskId = req.body.task_id ? Number(req.body.task_id) : null;
  const note = String(req.body.note || '').slice(0, 1000);
  const { rows } = await pool.query(
    'INSERT INTO sessions (project_id, task_id, minutes, note) VALUES ($1,$2,$3,$4) RETURNING *',
    [projectId, taskId, minutes, note]
  );
  res.status(201).json(rows[0]);
}));

app.delete('/api/sessions/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { rowCount } = await pool.query('DELETE FROM sessions WHERE id = $1', [id]);
  if (!rowCount) return res.status(404).json({ error: 'Session not found.' });
  res.json({ ok: true });
}));

/* ---------------------------------------------------------------- parts API
   A part is a small parametric model: sketch profile + extrude + holes.
   Payload is stored as JSONB so the modeler can evolve without migrations. */

function sanitizePayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const types = ['rect', 'circle', 'hex', 'L', 'slot', 'custom'];
  const coord = (v) => Math.max(-2000, Math.min(2000, num(v, 0)));
  const entitiesIn = Array.isArray(sk.entities) ? sk.entities.slice(0, 128) : [];
  const entitiesOut = [];
  for (const e of entitiesIn) {
    if (!e || typeof e !== 'object') continue;
    if (e.kind === 'arc') {
      const r = num(e.r, NaN);
      if (!(r >= 0.2 && r <= 500)) continue;
      entitiesOut.push({ kind: 'arc', cx: coord(e.cx), cy: coord(e.cy), r,
        a0: num(e.a0, 0), a1: num(e.a1, Math.PI) });
    } else if (e.kind === 'line') {
      entitiesOut.push({ kind: 'line', x1: coord(e.x1), y1: coord(e.y1), x2: coord(e.x2), y2: coord(e.y2) });
    }
  }
  const dimsIn = Array.isArray(sk.dims) ? sk.dims.slice(0, 32) : [];
  const dimsOut = [];
  for (const d of dimsIn) {
    if (!d || typeof d !== 'object') continue;
    const entIdx = Math.floor(num(d.entIdx, -1));
    const e = entitiesOut[entIdx];
    if (!e) continue;
    const valid = e.kind === 'line' ? ['length', 'dx', 'dy'].includes(d.type) : d.type === 'radius';
    const value = num(d.value, NaN);
    if (valid && Number.isFinite(value) && Math.abs(value) <= 2000) dimsOut.push({ entIdx, type: d.type, value });
  }
  const constraintsIn = Array.isArray(sk.constraints) ? sk.constraints.slice(0, 32) : [];
  const constraintsOut = [];
  for (const c of constraintsIn) {
    if (!c || typeof c !== 'object') continue;
    const entIdx = Math.floor(num(c.entIdx, -1));
    const e = entitiesOut[entIdx];
    if (!e) continue;
    if (['horizontal', 'vertical'].includes(c.type) && e.kind === 'line') constraintsOut.push({ entIdx, type: c.type });
    else if (c.type === 'equal') {
      const refIdx = Math.floor(num(c.refIdx, -1));
      if (entitiesOut[refIdx] && refIdx !== entIdx && entitiesOut[refIdx].kind === e.kind) constraintsOut.push({ entIdx, type: 'equal', refIdx });
    }
  }
  const materials = ['steel', 'aluminium', 'brass', 'abs', 'nylon'];
  const sk = raw.sketch && typeof raw.sketch === 'object' ? raw.sketch : {};
  const ex = raw.extrude && typeof raw.extrude === 'object' ? raw.extrude : {};
  const holesIn = Array.isArray(raw.holes) ? raw.holes.slice(0, 24) : [];
  // Global equations: resolve expressions BEFORE clamping so a variable-driven
  // dimension is never silently snapped by the clamp (TestApp review note).
  const eqIn = raw.equations && typeof raw.equations === 'object' && !Array.isArray(raw.equations)
    ? raw.equations : {};
  const varsIn = eqIn.vars && typeof eqIn.vars === 'object' && !Array.isArray(eqIn.vars) ? eqIn.vars : {};
  const bindIn = eqIn.bindings && typeof eqIn.bindings === 'object' && !Array.isArray(eqIn.bindings) ? eqIn.bindings : {};
  const strNum = (v, d) => {
    const n = Number(typeof v === 'string' && v.trim() ? resolveExpr(v, varsIn) : v);
    return Number.isFinite(n) ? n : d;
  };
  const payload = {
    name: String(raw.name || 'Untitled part').slice(0, 160),
    material: materials.indexOf(raw.material) >= 0 ? raw.material : 'aluminium',
    sketch: {
      type: types.indexOf(sk.type) >= 0 ? sk.type : 'rect',
      width: Math.min(2000, Math.max(0.5, strNum(sk.width, 80))),
      height: Math.min(2000, Math.max(0.5, strNum(sk.height, 50))),
      round: Math.min(500, Math.max(0, strNum(sk.round, 0))),
      // Chamfer mode for sketch corners (flat 45-degree bevels) vs fillet arcs.
      corner: sk.corner === 'chamfer' ? 'chamfer' : 'fillet',
      slotAngle: Math.min(90, Math.max(-90, strNum(sk.slotAngle, 0))),
      corners: (Array.isArray(sk.corners) ? sk.corners.slice(0, 4) : []).map(c => ({ on: !!(c && c.on), r: Math.min(500, Math.max(0, strNum(c && c.r, 0))), mode: c && c.mode === 'chamfer' ? 'chamfer' : 'fillet' })),
      entities: entitiesOut, dims: dimsOut, constraints: constraintsOut,
    },
    extrude: { depth: Math.min(2000, Math.max(0.5, strNum(ex.depth, 12))) },
    // Mirror feature: which sketch centerline (if any) mirrors holes.
    mirror: { axis: ['x', 'y'].indexOf(raw.mirror && raw.mirror.axis) >= 0 ? raw.mirror.axis : 'none' },
    holes: holesIn.map((h, hi) => {
      const out = {
        x: Math.max(-1000, Math.min(1000, strNum(h && h.x, 0))),
        y: Math.max(-1000, Math.min(1000, strNum(h && h.y, 0))),
        d: Math.max(0.1, Math.min(1000, strNum(h && h.d, 8))),
      };
      // Hole seat (counterbore / countersink) preserved per hole.
      const seatIn = h && h.seat && typeof h.seat === 'object' ? h.seat : null;
      if (seatIn && (seatIn.type === 'cbore' || seatIn.type === 'csink')) {
        out.seat = {
          type: seatIn.type,
          dia: Math.max(0, Math.min(1000, num(seatIn.dia, 0))),
          depth: Math.max(0, Math.min(1000, num(seatIn.depth, 0))),
        };
      }
      // Hole pattern spec on the seed hole (hole 0 only): linear or polar.
      if (hi === 0 && h && h.pattern && typeof h.pattern === 'object') {
        const p = h.pattern;
        if (p.mode === 'polar') {
          out.pattern = {
            mode: 'polar',
            count: Math.min(24, Math.max(1, Math.round(num(p.count, 6)))),
            span: Math.min(360, Math.max(10, num(p.span, 360))),
            radius: Math.max(0, Math.min(1000, num(p.radius, 0))),
            cx: Math.max(-1000, Math.min(1000, num(p.cx, 0))),
            cy: Math.max(-1000, Math.min(1000, num(p.cy, 0))),
          };
        } else {
          out.pattern = {
            mode: 'linear',
            rows: Math.min(10, Math.max(1, Math.round(num(p.rows, 1)))),
            cols: Math.min(10, Math.max(1, Math.round(num(p.cols, 1)))),
            dx: Math.max(-1000, Math.min(1000, num(p.dx, 20))),
            dy: Math.max(-1000, Math.min(1000, num(p.dy, 20))),
            centered: !!p.centered,
          };
        }
      }
      return out;
    }),
    macro: []
  };
  const macIn = Array.isArray(raw.macro) ? raw.macro.slice(0, 60) : [];
  for (let i = 0; i < macIn.length; i++) {
    const step = macIn[i];
    if (!step || typeof step !== 'object') continue;
    payload.macro.push({ label: String(step.label || 'edit').slice(0, 120) });
  }
  const eqOut = { vars: {}, bindings: {} };
  const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
  for (const name of Object.keys(varsIn).slice(0, 20)) {
    if (!NAME_RE.test(name)) continue;
    const v = varsIn[name];
    eqOut.vars[name] = typeof v === 'number' && Number.isFinite(v) ? v : String(v == null ? '' : v).slice(0, 80);
  }
  const PATH_RE = /^[a-z]+\.[a-z0-9]+$/i;
  for (const path of Object.keys(bindIn).slice(0, 40)) {
    if (!PATH_RE.test(path)) continue;
    const b = bindIn[path];
    eqOut.bindings[path] = typeof b === 'number' && Number.isFinite(b) ? b : String(b == null ? '' : b).slice(0, 80);
  }
  // Resolve once server-side so stored payloads always carry concrete numbers
  // for every bound dimension (the resolved model, not just intent).
  const resolved = resolveAll(eqOut.vars, eqOut.bindings);
  if (resolved.ok && payload.sketch && typeof eqOut.bindings['sketch.width'] !== 'undefined') payload.sketch.width = clamp('sketch.width', resolved.dims['sketch.width'], payload.sketch.width);
  payload.equations = eqOut;
  return payload;
}

/* Expression helper: numbers pass through; strings resolve against vars. */
function resolveExpr(src, vars) {
  if (typeof src !== 'string' || !src.trim()) return NaN;
  const r = resolveAll(vars, {});
  const parsed = require('./public/equations.js').parse(src);
  if (!parsed.ok) return NaN;
  return parsed.fn(r.vars);
}

/* Clamp only the dimensions whose binding actually resolved. */
function clamp(path, value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

// Parts endpoints wait for the schema when the process just started.
app.use('/api/parts', async (req, res, next) => {
  const p = globalThis.__solidSchema;
  if (!p) return next();
  try {
    await p;
  } catch (err) {
    return res.status(503).json({ error: 'The database is still starting. Try again in a few seconds.' });
  }
  next();
});

app.get('/api/parts', wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, payload, volume_mm3, mass_g, updated_at, created_at FROM parts ORDER BY updated_at DESC LIMIT 100'
  );
  res.json({ parts: rows });
}));

app.get('/api/parts/:id', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM parts WHERE id = $1', [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: 'Part not found.' });
  res.json(rows[0]);
}));

app.post('/api/parts', wrap(async (req, res) => {
  const payload = sanitizePayload(req.body.payload || req.body);
  if (!payload) return badRequest(res, 'A part payload is required.');
  const name = String(req.body.name || payload.name || 'Untitled part').trim().slice(0, 160) || 'Untitled part';
  payload.name = name;
  const volume = Number.isFinite(Number(req.body.volume_mm3)) ? Number(req.body.volume_mm3) : null;
  const mass = Number.isFinite(Number(req.body.mass_g)) ? Number(req.body.mass_g) : null;
  const { rows } = await pool.query(
    'INSERT INTO parts (name, payload, volume_mm3, mass_g) VALUES ($1, $2, $3, $4) RETURNING id, name, payload, volume_mm3, mass_g, updated_at',
    [name, JSON.stringify(payload), volume, mass]
  );
  res.status(201).json(rows[0]);
}));

app.put('/api/parts/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const payload = sanitizePayload(req.body.payload || req.body);
  if (!payload) return badRequest(res, 'A part payload is required.');
  const name = String(req.body.name || payload.name || 'Untitled part').trim().slice(0, 160) || 'Untitled part';
  payload.name = name;
  const volume = Number.isFinite(Number(req.body.volume_mm3)) ? Number(req.body.volume_mm3) : null;
  const mass = Number.isFinite(Number(req.body.mass_g)) ? Number(req.body.mass_g) : null;
  const { rows } = await pool.query(
    'UPDATE parts SET name = $1, payload = $2, volume_mm3 = $3, mass_g = $4, updated_at = now() WHERE id = $5 RETURNING id, name, payload, volume_mm3, mass_g, updated_at',
    [name, JSON.stringify(payload), volume, mass, id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Part not found.' });
  res.json(rows[0]);
}));

app.delete('/api/parts/:id', wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM parts WHERE id = $1', [Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'Part not found.' });
  res.json({ ok: true });
}));

// The modeler is the front door; the work planner lives at /index.html.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cad.html')));

// three.js ships as three chunks under public/vendor/chunks (the single 613 KB
// file exceeded the commit path limit), so serve the concatenated build here and
// cache it in memory after the first request.
let threeBundle = null;
app.get('/libs/three.min.js', (req, res) => {
  if (!threeBundle) {
    // Preferred: the npm package installed in the image at build time, which keeps
    // the 600 KB library out of git while still serving it from our own origin.
    const candidates = [
      path.join(__dirname, 'node_modules', 'three', 'build', 'three.min.js'),
      path.join(__dirname, 'public', 'libs', 'three.min.js'),
    ];
    for (const file of candidates) {
      try {
        threeBundle = fs.readFileSync(file, 'utf8');
        break;
      } catch (err) {
        /* try the next layout */
      }
    }
  }
  if (!threeBundle) {
    const files = [1, 2, 3].map((n) => path.join(__dirname, 'public', 'libs', 'chunks', `three.part${n}.js`));
    try {
      threeBundle = files.map((f) => fs.readFileSync(f, 'utf8')).join('');
    } catch (err) {
      console.error('three.js bundle unavailable', err.message);
      return res.status(404).type('text/plain').send('three.js bundle unavailable');
    }
  }
  res.type('application/javascript').set('Cache-Control', 'public, max-age=86400');
  res.send(threeBundle);
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

// Listen first so the platform health check succeeds immediately, then shape the
// schema in the background. Requests that need tables retry until migrate() is done.
function boot() {
  const schemaReady = migrate().catch((err) => {
    console.error('startup migration failed', err);
    throw err;
  });
  globalThis.__solidSchema = schemaReady;
  schemaReady.catch(() => {});
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('WebSolid listening on ' + PORT);
  boot();
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
