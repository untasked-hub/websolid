/* Check summary smoke test (Round 35). */
var fs = require('fs');
var S = require('./public/checksummary.js');
var f = [];
function ok(c, m) { if (!c) f.push(m); else console.log('ok - ' + m); }

var t1 = S.buildSummary({
  name: 'Flange Bracket',
  feature: 'extrude',
  metrics: { volumeCm3: 18.4, massG: 49.68, bbox: [80, 50, 12], tris: 240 },
  material: { id: 'aluminium', name: 'Aluminium 6061', density: 2.7, pricePerKg: 5.5, priceSource: 'custom', defaultPricePerKg: 4 },
  cost: { raw: 0.27, drilling: 0.16, total: 0.43, holeCount: 2 },
  print: {
    ran: true, profile: 'fdm', ok: false, fails: 1, stale: false, triangles: 240,
    thresholds: { minWall: 1.2, minHole: 2.5, overhang: 45 },
    checks: [
      { id: 'manifold', label: 'Manifold mesh', pass: true, note: '0 open edges' },
      { id: 'wall', label: 'Minimum wall', pass: false, note: '0.90 mm < 1.20 mm' }
    ]
  },
  preflight: { blocking: ['No hole circles cross or leave the sketch profile.'], advisory: ['Minimum nominal hole-to-profile clearance: 4.50 mm'] }
});

ok(/WebSolid check summary/.test(t1), 'includes title');
ok(/Part: Flange Bracket \(extrude\)/.test(t1), 'includes part and feature');
ok(/volume 18\.40 cm³ · mass 49\.68 g · bounding box 80 × 50 × 12 mm · 240 triangles/.test(t1), 'includes size metrics');
ok(/5\.50 €\/kg \(custom rate, built-in 4\.00\)/.test(t1), 'includes custom price provenance');
ok(/raw material €0\.27 \+ drilling €0\.16 \(2 holes\) = total €0\.43/.test(t1), 'includes cost components');
ok(/Printability: FDM profile · 1 check need review · thresholds wall ≥ 1\.20 mm, hole ≥ 2\.50 mm, overhang ≤ 45° · from 240 triangles/.test(t1), 'includes printability summary and thresholds');
ok(/✓ Manifold mesh — 0 open edges/.test(t1) && /✗ Minimum wall — 0\.90 mm < 1\.20 mm/.test(t1), 'includes individual check verdicts');
ok(/Advisory only:.*not engineering certification or a supplier quote/i.test(t1), 'includes advisory disclaimer footer');

var t2 = S.buildSummary({ name: 'Pin', print: { ran: true, profile: 'resin', ok: true, fails: 0, stale: true } });
ok(/\(stale\) these results come from an earlier part or profile/.test(t2), 'flags stale printability');

var t3 = S.buildSummary({});
ok(/Untitled part/.test(t3) && /not run for the current part/.test(t3), 'handles empty context and unrun printability');

var html = fs.readFileSync(__dirname + '/public/cad.html', 'utf8');
var js = fs.readFileSync(__dirname + '/public/cad.js', 'utf8');
ok(/id="btn-copy-summary"/.test(html) && /src="\/checksummary\.js"/.test(html), 'cad.html wires button and script');
ok(/function currentCheckSummary/.test(js) && /function copyCheckSummary/.test(js), 'cad.js defines copy helpers');


var b = S.buildPrintBrief({
  name: 'Flange Bracket', feature: 'extrude',
  metrics: { volumeCm3: 18.4, massG: 49.68, bbox: [80, 50, 12], tris: 240 },
  material: { id: 'pla', name: 'PLA', density: 1.24, pricePerKg: 20, priceSource: 'default', defaultPricePerKg: 20 },
  cost: { raw: 0.11, drilling: 0, total: 0.11, holeCount: 0 },
  print: { ran: true, profile: 'fdm', ok: true, fails: 0, stale: false, triangles: 240, thresholds: { minWall: 1.2, minHole: 2.5, overhang: 45 }, checks: [] },
  preflight: { blocking: [], advisory: ['Hole-to-hole spacing: not applicable (fewer than two nominal holes).'] },
  setup: { layerMm: 0.2, nozzleMm: 0.4, perimeters: 2, infill: 0.2, speedMmS: 60, filamentDiameterMm: 1.75, estMinutes: 32, estLowMinutes: 24, estHighMinutes: 43, layers: 60, heightMm: 12, filamentGrams: 5.2, filamentMetres: 0.56 }
});
ok(/WebSolid print setup brief/.test(b), 'brief has title');
ok(/Units: millimetres/.test(b), 'brief states units');
ok(/layer 0\.20 mm · nozzle 0\.40 mm · 2 perimeters · 20% infill/.test(b), 'brief includes slicer assumptions');
ok(/1\.75 mm diameter/.test(b), 'brief includes filament diameter');
ok(/≈ 32 min print time \(range 24–43 min\)/.test(b), 'brief includes time estimate with range');
ok(/≈ 5\.2 g filament/.test(b), 'brief includes filament grams');
ok(/not a slicer profile or a guarantee/.test(b), 'brief carries estimate caveat');
ok(/Not.*uploaded|Nothing was uploaded/i.test(b), 'brief states local-only');

var empty = S.buildPrintBrief({});
ok(/Untitled part/.test(empty), 'brief handles empty context');

var html2 = fs.readFileSync(__dirname + '/public/cad.html');
ok(/id="btn-print-brief"/.test(html2), 'cad.html wires print brief button');
var js2 = fs.readFileSync(__dirname + '/public/cad.js', 'utf8');
ok(/downloadPrintBrief/.test(js2) && /buildPrintBrief\(ctx\)/.test(js2), 'cad.js defines and calls brief builder');


var e = S.buildEstimateSummary({
  name: 'Flange Bracket', feature: 'extrude',
  metrics: { volumeCm3: 18.4, massG: 49.68, bbox: [80, 50, 12], tris: 240 },
  material: { id: 'pla', name: 'PLA', density: 1.24, pricePerKg: 20, priceSource: 'default', defaultPricePerKg: 20 },
  cost: { raw: 0.12, drilling: 0.05, total: 0.17, holeCount: 2 },
  setup: { layerMm: 0.2, nozzleMm: 0.4, perimeters: 2, infill: 0.2, speedMmS: 60, filamentDiameterMm: 1.75, estMinutes: 32, estLowMinutes: 24, estHighMinutes: 43, layers: 60, heightMm: 12, filamentGrams: 5.2, filamentMetres: 0.56 }
});
ok(/WebSolid material & estimate summary/.test(e), 'estimate has title');
ok(/Part: Flange Bracket \(extrude\)/.test(e), 'estimate has part line');
ok(/volume 18\.40 cm³/.test(e), 'estimate has size');
ok(/Material: PLA/.test(e), 'estimate has material');
ok(/raw material €0\.12 \+ drilling €0\.05 \(2 holes\) = total €0\.17/.test(e), 'estimate has cost line');
ok(/≈ 5\.2 g filament/.test(e) && /≈ 32 min print time \(range 24–43 min\)/.test(e), 'estimate has filament and time');
ok(/not a quote or a slicer guarantee/.test(e), 'estimate carries caveat');
ok(/Nothing was uploaded/.test(e), 'estimate states local-only');
var ee = S.buildEstimateSummary({});
ok(/Untitled part/.test(ee), 'estimate handles empty context');
var html3 = fs.readFileSync(__dirname + '/public/cad.html', 'utf8');
var js3 = fs.readFileSync(__dirname + '/public/cad.js', 'utf8');
ok(/id="btn-copy-estimate"/.test(html3), 'cad.html wires copy estimate button');
ok(/function copyEstimateSummary/.test(js3) && /buildEstimateSummary\(ctx\)/.test(js3), 'cad.js defines and calls estimate builder');

if (f.length) { console.error('FAIL', f); process.exit(1); }
