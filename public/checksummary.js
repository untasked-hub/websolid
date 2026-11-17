/* WebSolid handoff summary — pure text builder for the "Copy check summary"
   button. It only formats inputs it is given (part state, readout metrics,
   cost basis, printability run, preflight lists) so the same code unit-tests
   under Node and runs in the browser. No DOM, no network, no clock. */
(function (root) {
  'use strict';

  var TITLE = 'WebSolid check summary';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function n(v, d) {
    if (!isNum(v)) return typeof v === 'string' && v ? v : (d === undefined ? '—' : d);
    return String(Math.round(v * 100) / 100);
  }
  function fixed(v, d) { return isNum(v) ? v.toFixed(d) : '—'; }
  function list(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

  function partLine(ctx) {
    var name = (ctx.name && String(ctx.name).trim()) || 'Untitled part';
    var feature = ctx.feature ? String(ctx.feature) : '';
    return 'Part: ' + name + (feature ? ' (' + feature + ')' : '');
  }

  function sizeLine(m) {
    if (!m) return null;
    var bits = [];
    if (isNum(m.volumeCm3)) bits.push('volume ' + fixed(m.volumeCm3, 2) + ' cm³');
    if (isNum(m.massG)) bits.push('mass ' + fixed(m.massG, 2) + ' g');
    if (list(m.bbox) && m.bbox.length === 3) {
      bits.push('bounding box ' + n(m.bbox[0], 1) + ' × ' + n(m.bbox[1], 1) + ' × ' + n(m.bbox[2], 1) + ' mm');
    }
    if (isNum(m.tris)) bits.push(n(m.tris, 0) + ' triangles');
    return bits.length ? 'Size: ' + bits.join(' · ') : null;
  }

  function materialLine(ctx) {
    var mat = ctx.material;
    if (!mat) return null;
    var bits = [mat.name || mat.id || 'selected material'];
    if (isNum(mat.density)) bits.push('density ' + fixed(mat.density, 2) + ' g/cm³');
    if (isNum(mat.pricePerKg)) {
      var src = mat.priceSource === 'custom'
        ? 'custom rate' + (isNum(mat.defaultPricePerKg) ? ', built-in ' + fixed(mat.defaultPricePerKg, 2) : '')
        : 'built-in rate';
      bits.push(fixed(mat.pricePerKg, 2) + ' €/kg (' + src + ')');
    }
    return 'Material: ' + bits.join(' · ');
  }

  function costLine(ctx) {
    var c = ctx.cost;
    if (!c) return null;
    var bits = [];
    if (isNum(c.raw)) bits.push('raw material €' + fixed(c.raw, 2));
    if (isNum(c.drilling)) bits.push('drilling €' + fixed(c.drilling, 2) + (isNum(c.holeCount) ? ' (' + c.holeCount + ' hole' + (c.holeCount === 1 ? '' : 's') + ')' : ''));
    var text = bits.length ? bits.join(' + ') : '';
    if (isNum(c.total)) text += (text ? ' = ' : '') + 'total €' + fixed(c.total, 2);
    return text ? 'Cost estimate: ' + text : null;
  }

  function printLines(ctx) {
    var p = ctx.print;
    if (!p || !p.ran) {
      return ['Printability: not run for the current part. Run Check to include mesh estimates.'];
    }
    var th = p.thresholds || {};
    var limits = [];
    if (isNum(th.minWall)) limits.push('wall ≥ ' + fixed(th.minWall, 2) + ' mm');
    if (isNum(th.minHole)) limits.push('hole ≥ ' + fixed(th.minHole, 2) + ' mm');
    if (isNum(th.overhang)) limits.push('overhang ≤ ' + fixed(th.overhang, 0) + '°');
    var profile = p.profile === 'resin' ? 'resin' : 'FDM';
    var verdict = p.ok ? 'all analyzed checks passed' : n(p.fails, 0) + ' check' + (p.fails === 1 ? '' : 's') + ' need review';
    var head = 'Printability: ' + profile + ' profile · ' + verdict;
    if (limits.length) head += ' · thresholds ' + limits.join(', ');
    if (isNum(p.triangles)) head += ' · from ' + n(p.triangles, 0) + ' triangles';
    var out = [head];
    if (p.stale) out.push('  (stale) these results come from an earlier part or profile — run Check again before relying on them.');
    if (list(p.checks)) {
      for (var i = 0; i < p.checks.length; i++) {
        var c = p.checks[i] || {};
        var line = '  ' + (c.pass ? '✓ ' : '✗ ') + (c.label || c.id || 'check');
        if (c.note) line += ' — ' + String(c.note);
        out.push(line);
      }
    }
    return out;
  }

  function preflightLines(ctx) {
    var pf = ctx.preflight;
    if (!pf) return [];
    var out = [];
    if (list(pf.blocking) && pf.blocking.length) {
      out.push('Sketch/feature review (not mesh-based):');
      for (var i = 0; i < pf.blocking.length; i++) out.push('  ! ' + pf.blocking[i]);
    }
    if (list(pf.advisory) && pf.advisory.length) {
      out.push('Configuration notes:');
      for (var j = 0; j < pf.advisory.length; j++) out.push('  - ' + pf.advisory[j]);
    }
    return out;
  }

  var FOOTER = 'Advisory only: numbers above come from the current browser-local part state, configured inputs, and the last exported mesh. '
    + 'They are estimates for review, not engineering certification or a supplier quote. Nothing was uploaded.';

  /* ctx:
     { name, feature, metrics:{volumeCm3,massG,bbox,tris},
       material:{id,name,density,pricePerKg,priceSource,defaultPricePerKg},
       cost:{raw,drilling,total,holeCount},
       print:{ran,profile,ok,fails,stale,triangles,thresholds:{minWall,minHole,overhang},checks:[{id,label,pass,note}]},
       preflight:{blocking:[],advisory:[]},
       notes:[] }  ->  plain text with \n newlines */
  function buildSummary(ctx) {
    ctx = ctx || {};
    var lines = [TITLE, partLine(ctx)];
    var s = sizeLine(ctx.metrics);
    if (s) lines.push(s);
    var m = materialLine(ctx);
    if (m) lines.push(m);
    var c = costLine(ctx);
    if (c) lines.push(c);
    lines = lines.concat(printLines(ctx));
    lines = lines.concat(preflightLines(ctx));
    if (list(ctx.notes)) {
      for (var i = 0; i < ctx.notes.length; i++) if (ctx.notes[i]) lines.push('Note: ' + ctx.notes[i]);
    }
    lines.push('', FOOTER);
    return lines.join('\n');
  }


  /* One-click print setup brief: a portable, human-readable text brief a maker
     can keep next to a .websolid.json part file. Same rules as buildSummary:
     pure formatting of the ctx it is given, no DOM, no network, no clock. */
  var BRIEF_TITLE = 'WebSolid print setup brief';

  function briefSetupLine(s) {
    var bits = [];
    if (isNum(s.layerMm)) bits.push('layer ' + fixed(s.layerMm, 2) + ' mm');
    if (isNum(s.nozzleMm)) bits.push('nozzle ' + fixed(s.nozzleMm, 2) + ' mm');
    if (isNum(s.perimeters)) bits.push(s.perimeters + ' perimeters');
    if (isNum(s.infill)) bits.push(Math.round(s.infill * 100) + '% infill');
    if (isNum(s.speedMmS)) bits.push(fixed(s.speedMmS, 0) + ' mm/s');
    return bits.length ? 'Slicer setup (assumed, not slicer-verified): ' + bits.join(' · ') : null;
  }

  function buildPrintBrief(ctx) {
    ctx = ctx || {};
    var s = ctx.setup || {};
    var lines = [BRIEF_TITLE, partLine(ctx)];
    lines.push('Units: millimetres (mm). Coordinates and dimensions as shown in the modeler.');
    var size = sizeLine(ctx.metrics);
    if (size) lines.push(size);
    var m = materialLine(ctx);
    if (m) lines.push(m);
    var setup = briefSetupLine(s);
    if (setup) lines.push(setup);
    if (isNum(s.filamentDiameterMm)) lines.push('Filament: ' + fixed(s.filamentDiameterMm, 2) + ' mm diameter');
    var est = [];
    if (isNum(s.estMinutes)) {
      est.push('≈ ' + Math.round(s.estMinutes) + ' min print time');
      if (isNum(s.estLowMinutes) && isNum(s.estHighMinutes)) {
        est[est.length - 1] += ' (range ' + Math.round(s.estLowMinutes) + '–' + Math.round(s.estHighMinutes) + ' min)';
      }
    }
    if (isNum(s.layers)) est.push(s.layers + ' layers over ' + fixed(s.heightMm, 1) + ' mm height');
    if (isNum(s.filamentGrams)) est.push('≈ ' + fixed(s.filamentGrams, 1) + ' g filament' + (isNum(s.filamentMetres) ? ' (≈ ' + fixed(s.filamentMetres, 2) + ' m)' : ''));
    if (est.length) lines.push('Estimated print: ' + est.join(' · '));
    var c = costLine(ctx);
    if (c) lines.push(c);
    lines = lines.concat(printLines(ctx));
    lines = lines.concat(preflightLines(ctx));
    lines.push('', 'This brief is an estimate from the browser-local model, not a slicer profile or a guarantee. Verify settings in your slicer before printing. Nothing was uploaded.');
    return lines.join('\n');
  }

  var ESTIMATE_TITLE = 'WebSolid material & estimate summary';

  function buildEstimateSummary(ctx) {
    ctx = ctx || {};
    var lines = [ESTIMATE_TITLE, partLine(ctx)];
    var size = sizeLine(ctx.metrics);
    if (size) lines.push(size);
    var m = materialLine(ctx);
    if (m) lines.push(m);
    var c = costLine(ctx);
    if (c) lines.push(c);
    var s = ctx.setup || {};
    var est = [];
    if (isNum(s.filamentGrams)) est.push('\u2248 ' + fixed(s.filamentGrams, 1) + ' g filament' + (isNum(s.filamentMetres) ? ' (\u2248 ' + fixed(s.filamentMetres, 2) + ' m)' : ''));
    if (isNum(s.estMinutes)) {
      var t = '\u2248 ' + Math.round(s.estMinutes) + ' min print time';
      if (isNum(s.estLowMinutes) && isNum(s.estHighMinutes)) t += ' (range ' + Math.round(s.estLowMinutes) + '\u2013' + Math.round(s.estHighMinutes) + ' min)';
      est.push(t);
    }
    if (isNum(s.layers)) est.push(s.layers + ' layers' + (isNum(s.heightMm) ? ' over ' + fixed(s.heightMm, 1) + ' mm height' : ''));
    if (est.length) lines.push('Print estimate: ' + est.join(' \u00b7 '));
    lines.push('', 'Estimate from the browser-local model with the inputs shown; not a quote or a slicer guarantee. Replace with supplier pricing before ordering. Nothing was uploaded.');
    return lines.join('\n');
  }

  var api = { buildSummary: buildSummary, buildPrintBrief: buildPrintBrief, buildEstimateSummary: buildEstimateSummary, FOOTER: FOOTER, TITLE: TITLE, BRIEF_TITLE: BRIEF_TITLE, ESTIMATE_TITLE: ESTIMATE_TITLE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SolidCheckSummary = api;
})(typeof window !== 'undefined' ? window : this);
