'use strict';

const state = {
  projects: [],
  tasks: [],
  sessions: [],
  stats: null,
  selectedProject: 'all',
  filter: 'open'
};

const COLORS = ['#6366f1', '#22d3ee', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#f87171'];

function $(sel) { return document.querySelector(sel); }

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

async function api(path, options) {
  const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options));
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  if (!res.ok) throw new Error((body && body.error) || ('Request failed (' + res.status + ')'));
  return body;
}

let toastTimer = null;
function toast(message, isError) {
  const t = $('#toast');
  t.textContent = message;
  t.className = 'toast' + (isError ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
}

function projectName(id) {
  const p = state.projects.filter(function (x) { return Number(x.id) === Number(id); })[0];
  return p ? p.name : null;
}

function selectedProjectObj() {
  if (state.selectedProject === 'all') return null;
  return state.projects.filter(function (p) {
    return Number(p.id) === Number(state.selectedProject);
  })[0] || null;
}

function visibleTasks() {
  let tasks = state.tasks.slice();
  if (state.selectedProject !== 'all') {
    tasks = tasks.filter(function (t) {
      return Number(t.project_id) === Number(state.selectedProject);
    });
  }
  if (state.filter === 'open') tasks = tasks.filter(function (t) { return t.status !== 'done'; });
  if (state.filter === 'done') tasks = tasks.filter(function (t) { return t.status === 'done'; });
  const rank = { doing: 0, todo: 1, done: 2 };
  tasks.sort(function (a, b) {
    const ra = rank[a.status] === undefined ? 3 : rank[a.status];
    const rb = rank[b.status] === undefined ? 3 : rank[b.status];
    if (ra !== rb) return ra - rb;
    return (a.position - b.position) || (a.id - b.id);
  });
  return tasks;
}

/* ---------------- rendering ---------------- */

function renderProjects() {
  const list = $('#project-list');
  list.innerHTML = '';

  const allBtn = el('button', 'project-item' + (state.selectedProject === 'all' ? ' active' : ''));
  allBtn.type = 'button';
  const allDot = el('span', 'swatch');
  allDot.style.background = 'linear-gradient(135deg,#6366f1,#22d3ee)';
  allBtn.append(allDot, el('span', 'project-name', 'All work'));
  const openTotal = state.tasks.filter(function (t) { return t.status !== 'done'; }).length;
  allBtn.append(el('span', 'project-count', String(openTotal)));
  allBtn.addEventListener('click', function () { selectProject('all'); });
  const allLi = el('li');
  allLi.appendChild(allBtn);
  list.appendChild(allLi);

  state.projects.forEach(function (p) {
    const btn = el('button', 'project-item' + (Number(state.selectedProject) === Number(p.id) ? ' active' : ''));
    btn.type = 'button';
    const dot = el('span', 'swatch');
    dot.style.background = p.color;
    const count = state.tasks.filter(function (t) {
      return Number(t.project_id) === Number(p.id) && t.status !== 'done';
    }).length;
    btn.append(dot, el('span', 'project-name', p.name), el('span', 'project-count', String(count)));
    btn.addEventListener('click', function () { selectProject(p.id); });
    const li = el('li');
    li.appendChild(btn);
    list.appendChild(li);
  });
}

function renderHeader() {
  const project = selectedProjectObj();
  $('#view-title').textContent = project ? project.name : 'All work';
  const openCount = visibleTasks().filter(function (t) { return t.status !== 'done'; }).length;
  $('#view-sub').textContent = project
    ? ((project.description || 'No description yet.') + ' \u00b7 ' + openCount + ' open')
    : (state.projects.length + ' projects \u00b7 ' + openCount + ' to move');
}

function renderStats() {
  const s = state.stats || { minutes_today: 0, minutes_week: 0, done_today: 0, open_tasks: 0, week: [] };
  const box = $('#stats');
  box.innerHTML = '';
  const cards = [
    ['Focus today', s.minutes_today + ' min'],
    ['Focus this week', s.minutes_week + ' min'],
    ['Done today', String(s.done_today)],
    ['Open tasks', String(s.open_tasks)]
  ];
  cards.forEach(function (card) {
    const d = el('div', 'stat');
    d.append(el('div', 'k', card[0]), el('div', 'v', card[1]));
    box.appendChild(d);
  });

  const strip = $('#week-strip');
  strip.innerHTML = '';
  const week = s.week || [];
  const max = Math.max.apply(null, [25].concat(week.map(function (w) { return w.minutes; })));
  week.forEach(function (day) {
    const bar = el('div', 'week-bar' + (day.minutes > 0 ? ' has' : ''));
    bar.style.height = Math.max(3, Math.round((day.minutes / max) * 40)) + 'px';
    const d = new Date(day.day + 'T12:00:00');
    bar.title = d.toDateString() + ' \u2014 ' + day.minutes + ' min';
    if (day.minutes > 0) bar.appendChild(el('span', '', String(day.minutes)));
    strip.appendChild(bar);
  });
}

function renderTasks() {
  const list = $('#task-list');
  list.innerHTML = '';
  const tasks = visibleTasks();
  $('#empty').hidden = tasks.length > 0;

  tasks.forEach(function (t) {
    const row = el('div', 'task ' + (t.status === 'done' ? 'done' : t.status === 'doing' ? 'doing' : ''));

    const check = el('button', 'check', t.status === 'done' ? '\u2713' : t.status === 'doing' ? '\u2022' : '');
    check.type = 'button';
    check.title = t.status === 'done' ? 'Mark as to do' : 'Mark as done';
    check.addEventListener('click', function () { toggleTask(t); });

    const body = el('div');
    body.appendChild(el('div', 'task-title', t.title));
    const meta = el('div', 'task-meta');
    if (t.status === 'doing') meta.appendChild(el('span', 'badge', 'in progress'));
    if (t.status === 'done') meta.appendChild(el('span', 'badge', 'done'));
    meta.appendChild(el('span', 'badge ' + t.priority, t.priority + ' priority'));
    if (state.selectedProject === 'all' && projectName(t.project_id)) {
      meta.appendChild(el('span', 'badge proj', projectName(t.project_id)));
    }
    if (t.due_date) {
      const due = new Date(String(t.due_date).slice(0, 10) + 'T12:00:00');
      meta.appendChild(el('span', 'badge', 'due ' + due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })));
    }
    body.appendChild(meta);
    if (t.notes) body.appendChild(el('p', 'task-notes', t.notes));

    const actions = el('div', 'task-actions');
    if (t.status === 'todo') {
      const start = el('button', 'icon-btn', 'Start');
      start.type = 'button';
      start.addEventListener('click', function () { updateTask(t.id, { status: 'doing' }); });
      actions.appendChild(start);
    }
    const focus = el('button', 'icon-btn', 'Log time');
    focus.type = 'button';
    focus.addEventListener('click', function () { openSessionModal(t); });
    const edit = el('button', 'icon-btn', 'Edit');
    edit.type = 'button';
    edit.addEventListener('click', function () { openTaskModal(t); });
    const del = el('button', 'icon-btn danger', 'Delete');
    del.type = 'button';
    del.addEventListener('click', function () { deleteTask(t); });
    actions.append(focus, edit, del);

    row.append(check, body, actions);
    list.appendChild(row);
  });
}

function renderSessions() {
  const s = state.stats || { minutes_today: 0 };
  const summary = $('#focus-summary');
  summary.innerHTML = '';
  summary.appendChild(el('strong', '', s.minutes_today + ' min'));
  summary.appendChild(el('span', '', 'focused today'));

  const list = $('#session-list');
  list.innerHTML = '';
  const recent = state.sessions.slice(0, 12);
  if (!recent.length) {
    const li = el('li', 'session-row');
    li.appendChild(el('span', 'note', 'No focus blocks yet.'));
    list.appendChild(li);
    return;
  }
  recent.forEach(function (sess) {
    const row = el('div', 'session-row');
    const left = el('div');
    left.appendChild(el('div', 'note', sess.note || projectName(sess.project_id) || 'Solo work'));
    const d = new Date(sess.created_at);
    left.appendChild(el('div', 'when', d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' \u00b7 ' + (projectName(sess.project_id) || 'Solo work')));

    const right = el('div');
    right.style.display = 'flex';
    right.style.alignItems = 'center';
    right.style.gap = '6px';
    right.appendChild(el('span', 'mins', sess.minutes + 'm'));
    const del = el('button', '', '\u00d7');
    del.type = 'button';
    del.title = 'Delete this focus block';
    del.addEventListener('click', function () { deleteSession(sess.id); });
    right.appendChild(del);

    row.append(left, right);
    const li = el('li');
    li.appendChild(row);
    list.appendChild(li);
  });
}

function render() {
  renderProjects();
  renderHeader();
  renderStats();
  renderTasks();
  renderSessions();
}

/* ---------------- data ---------------- */

async function load() {
  try {
    const data = await api('/api/state');
    state.projects = data.projects;
    state.tasks = data.tasks;
    state.sessions = data.sessions;
    state.stats = data.stats;
    const stillThere = state.projects.some(function (p) {
      return Number(p.id) === Number(state.selectedProject);
    });
    if (state.selectedProject !== 'all' && !stillThere) state.selectedProject = 'all';
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

function selectProject(id) {
  state.selectedProject = id;
  render();
}

async function refreshState() {
  const data = await api('/api/state');
  state.stats = data.stats;
  state.sessions = data.sessions;
}

async function addTask(title, priority) {
  const projectId = state.selectedProject === 'all'
    ? (state.projects[0] ? state.projects[0].id : null)
    : state.selectedProject;
  if (!projectId) { toast('Create a project first.', true); return; }
  try {
    const data = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: title, priority: priority, project_id: projectId })
    });
    state.tasks.push(data);
    await refreshState();
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

async function updateTask(id, patch) {
  try {
    const data = await api('/api/tasks/' + id, { method: 'PATCH', body: JSON.stringify(patch) });
    const idx = state.tasks.findIndex(function (t) { return Number(t.id) === Number(id); });
    if (idx >= 0) state.tasks[idx] = data;
    await refreshState();
    render();
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  }
}

async function toggleTask(task) {
  const next = task.status === 'done' ? 'todo' : 'done';
  const ok = await updateTask(task.id, { status: next });
  if (ok && next === 'done') toast('Done \u2014 one thing off the list.');
}

async function deleteTask(task) {
  if (!confirm('Delete "' + task.title + '"?')) return;
  try {
    await api('/api/tasks/' + task.id, { method: 'DELETE' });
    state.tasks = state.tasks.filter(function (t) { return Number(t.id) !== Number(task.id); });
    await refreshState();
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteSession(id) {
  try {
    await api('/api/sessions/' + id, { method: 'DELETE' });
    state.sessions = state.sessions.filter(function (s) { return Number(s.id) !== Number(id); });
    await refreshState();
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveSession(payload) {
  try {
    await api('/api/sessions', { method: 'POST', body: JSON.stringify(payload) });
    await refreshState();
    render();
    toast('Focus block logged.');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- modals ---------------- */

let modalSave = null;

function openModal(title, contentNode, onSave, saveLabel) {
  $('#modal-title').textContent = title;
  const body = $('#modal-body');
  body.innerHTML = '';
  body.appendChild(contentNode);
  $('#modal-save').textContent = saveLabel || 'Save';
  modalSave = onSave;
  $('#modal').hidden = false;
  const first = contentNode.querySelector('input, select, textarea');
  if (first) setTimeout(function () { first.focus(); }, 30);
}

function closeModal() {
  $('#modal').hidden = true;
  modalSave = null;
}

function field(labelText, inputNode) {
  const wrap = el('label', 'field');
  wrap.appendChild(el('span', 'field-label', labelText));
  wrap.appendChild(inputNode);
  return wrap;
}

function openTaskModal(task) {
  const editing = !!task;
  const form = el('form', 'modal-form');
  form.addEventListener('submit', function (e) { e.preventDefault(); });

  const titleInput = el('input');
  titleInput.type = 'text';
  titleInput.maxLength = 300;
  titleInput.placeholder = 'What needs doing?';
  titleInput.value = editing ? task.title : '';

  const notesInput = el('textarea');
  notesInput.rows = 3;
  notesInput.maxLength = 2000;
  notesInput.placeholder = 'Optional detail, links, next step…';
  notesInput.value = editing ? task.notes || '' : '';

  const projectSelect = el('select');
  state.projects.forEach(function (p) {
    const o = el('option', '', p.name);
    o.value = String(p.id);
    projectSelect.appendChild(o);
  });
  const defaultProject = editing ? task.project_id
    : (state.selectedProject === 'all' ? (state.projects[0] && state.projects[0].id) : state.selectedProject);
  if (defaultProject != null) projectSelect.value = String(defaultProject);

  const prioritySelect = el('select');
  ['low', 'medium', 'high'].forEach(function (p) {
    const o = el('option', '', p.charAt(0).toUpperCase() + p.slice(1));
    o.value = p;
    prioritySelect.appendChild(o);
  });
  prioritySelect.value = editing ? task.priority : 'medium';

  const statusSelect = el('select');
  [['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']].forEach(function (s) {
    const o = el('option', '', s[1]);
    o.value = s[0];
    statusSelect.appendChild(o);
  });
  statusSelect.value = editing ? task.status : 'todo';

  const dueInput = el('input');
  dueInput.type = 'date';
  dueInput.value = editing && task.due_date ? String(task.due_date).slice(0, 10) : '';

  const grid = el('div', 'field-grid');
  grid.append(field('Project', projectSelect), field('Priority', prioritySelect), field('Status', statusSelect), field('Due date', dueInput));

  form.append(field('Title', titleInput), field('Notes', notesInput), grid);

  openModal(editing ? 'Edit task' : 'New task', form, async function () {
    const title = titleInput.value.trim();
    if (!title) { toast('A task needs a title.', true); return false; }
    const payload = {
      title: title,
      notes: notesInput.value.trim(),
      priority: prioritySelect.value,
      status: statusSelect.value,
      due_date: dueInput.value || null,
      project_id: Number(projectSelect.value)
    };
    if (!projectSelect.value) delete payload.project_id;
    if (editing) {
      return updateTask(task.id, payload);
    }
    try {
      const created = await api('/api/tasks', { method: 'POST', body: JSON.stringify(payload) });
      state.tasks.push(created);
      await refreshState();
      render();
      toast('Task added.');
      return true;
    } catch (err) {
      toast(err.message, true);
      return false;
    }
  }, editing ? 'Save task' : 'Add task');
}

function openProjectModal() {
  const form = el('form', 'modal-form');
  form.addEventListener('submit', function (e) { e.preventDefault(); });

  const nameInput = el('input');
  nameInput.type = 'text';
  nameInput.maxLength = 200;
  nameInput.placeholder = 'e.g. Client launch';

  const descInput = el('textarea');
  descInput.rows = 2;
  descInput.maxLength = 500;
  descInput.placeholder = 'What is this project about?';

  const swatches = el('div', 'swatches');
  let chosen = COLORS[0];
  COLORS.forEach(function (c, i) {
    const b = el('button', 'swatch-btn' + (i === 0 ? ' on' : ''));
    b.type = 'button';
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', function () {
      chosen = c;
      Array.prototype.forEach.call(swatches.children, function (x) { x.classList.remove('on'); });
      b.classList.add('on');
    });
    swatches.appendChild(b);
  });

  form.append(field('Name', nameInput), field('Description', descInput), field('Colour', swatches));

  openModal('New project', form, async function () {
    const name = nameInput.value.trim();
    if (!name) { toast('A project needs a name.', true); return false; }
    try {
      const created = await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name: name, description: descInput.value.trim(), color: chosen })
      });
      state.projects.push(created);
      state.selectedProject = created.id;
      await load();
      toast('Project created.');
      return true;
    } catch (err) {
      toast(err.message, true);
      return false;
    }
  }, 'Create project');
}

function openSessionModal(task) {
  const form = el('form', 'modal-form');
  form.addEventListener('submit', function (e) { e.preventDefault(); });

  const minsInput = el('input');
  minsInput.type = 'number';
  minsInput.min = '1';
  minsInput.max = '1440';
  minsInput.value = '25';

  const projectSelect = el('select');
  const noneOpt = el('option', '', 'No project');
  noneOpt.value = '';
  projectSelect.appendChild(noneOpt);
  state.projects.forEach(function (p) {
    const o = el('option', '', p.name);
    o.value = String(p.id);
    projectSelect.appendChild(o);
  });
  const dp = task ? task.project_id : (state.selectedProject === 'all' ? null : state.selectedProject);
  if (dp != null) projectSelect.value = String(dp);

  const noteInput = el('input');
  noteInput.type = 'text';
  noteInput.maxLength = 500;
  noteInput.placeholder = task ? ('Worked on: ' + task.title).slice(0, 80) : 'What did you move forward?';

  const quick = el('div', 'swatches');
  [15, 25, 45, 60].forEach(function (m) {
    const b = el('button', 'chip', m + 'm');
    b.type = 'button';
    b.addEventListener('click', function () { minsInput.value = String(m); });
    quick.appendChild(b);
  });

  form.append(field('Minutes', minsInput), field('Quick pick', quick), field('Project', projectSelect), field('Note', noteInput));

  openModal(task ? 'Log focus on this task' : 'Log a focus block', form, async function () {
    const minutes = Number(minsInput.value);
    if (!Number.isFinite(minutes) || minutes <= 0) { toast('Enter minutes above zero.', true); return false; }
    const payload = { minutes: Math.round(minutes), note: noteInput.value.trim() };
    if (projectSelect.value) payload.project_id = Number(projectSelect.value);
    if (task) payload.task_id = task.id;
    await saveSession(payload);
    return true;
  }, 'Log block');
}

/* ---------------- boot ---------------- */

function wire() {
  $('#task-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    const input = $('#task-input');
    const title = input.value.trim();
    if (!title) return;
    input.value = '';
    await addTask(title, $('#task-priority').value);
  });

  $('#new-project-btn').addEventListener('click', openProjectModal);
  $('#focus-btn').addEventListener('click', function () { openSessionModal(null); });
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-save').addEventListener('click', async function () {
    if (!modalSave) return closeModal();
    const btn = $('#modal-save');
    btn.disabled = true;
    const ok = await modalSave();
    btn.disabled = false;
    if (ok !== false) closeModal();
  });
  $('#modal').addEventListener('click', function (e) {
    if (e.target === $('#modal')) closeModal();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('#modal').hidden) closeModal();
    if (e.key === '/' && document.activeElement === document.body) {
      e.preventDefault();
      $('#task-input').focus();
    }
  });

  $('#filters').addEventListener('click', function (e) {
    const btn = e.target.closest('.chip');
    if (!btn || !btn.dataset.filter) return;
    state.filter = btn.dataset.filter;
    Array.prototype.forEach.call($('#filters').children, function (c) { c.classList.remove('active'); });
    btn.classList.add('active');
    render();
  });

  $('#task-list').addEventListener('dblclick', function (e) {
    const row = e.target.closest('.task');
    if (!row) return;
    const title = row.querySelector('.task-title');
    if (!title) return;
    const task = visibleTasks().filter(function (t) { return t.title === title.textContent; })[0];
    if (task) openTaskModal(task);
  });
}

wire();
load();

// Poll gently so two open tabs stay close to the same truth.
setInterval(function () {
  if (document.hidden || !$('#modal').hidden) return;
  load();
}, 30000);

