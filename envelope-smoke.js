
/* Fit-envelope guardrail smoke test (Round 29). Node-only: stubs the DOM
   pieces the module touches at load time, then exercises sanitize defaults,
   clamping, advisory off-state, and edit-time blocking behavior of
   numberField's commit path via source-level checks. */
var fs = require('fs');
var src = fs.readFileSync(__dirname + '/public/cad.js', 'utf8');
var failures = [];
function ok(cond, msg) { if (!cond) failures.push(msg); else console.log('ok - ' + msg); }

/* structural checks */
ok(src.indexOf("envelope: { on: false, x: 220, y: 220, z: 250 }") >= 0, 'defaultPart has envelope defaults');
ok(/out\.envelope = \(function|envelope: \(function \(\) \{/.test(src) && src.indexOf("Math.min(20000, Math.max(1") >= 0, 'sanitizePart clamps envelope to 1-20000');
ok(src.indexOf('function envelopeOversize()') >= 0, 'envelopeOversize helper exists');
ok(src.indexOf('Fit envelope: part exceeds the target build volume') >= 0, 'preflight advisory for oversized part');
ok(src.indexOf('Fit envelope: not configured') >= 0, 'preflight advisory when not configured');
ok(src.indexOf('would exceed the fit envelope') >= 0, 'commit path blocks oversized edits');
ok(src.indexOf('envelope-presets') >= 0 && src.indexOf('220\\u00d7220\\u00d7250') >= 0, 'FeatureManager presets rendered');
ok(src.indexOf('restorePart();') > src.indexOf('would exceed the fit envelope') - 400, 'blocked edit restores last accepted part');

/* functional check of the sanitize + comparison logic in isolation */
var num = function (v, d) { v = Number(v); return isFinite(v) ? v : d; };
var s2 = src.match(/envelope: \(function \(\) \{[\s\S]*?\}\)\(\)/)[0];
var fn = new Function('num', 'raw',
  'var out={};' + s2.replace('envelope: ', 'out.envelope = ') + ';return out.envelope;');
var e1 = fn(num, {});
ok(e1.on === false && e1.x === 220 && e1.y === 220 && e1.z === 250, 'sanitize defaults applied');
var e2 = fn(num, { envelope: { on: true, x: 99999, y: -5, z: 'abc' } });
ok(e2.on === true && e2.x === 20000 && e2.y === 1 && e2.z === 250, 'sanitize clamps and coerces');

/* envelope comparison semantics */
function oversize(bbox, env) {
  if (!env.on || !bbox) return '';
  var over = [];
  if (bbox[0] > env.x) over.push('X');
  if (bbox[1] > env.y) over.push('Y');
  if (bbox[2] > env.z) over.push('Z');
  return over.join(';');
}
ok(oversize([300, 100, 50], { on: true, x: 220, y: 220, z: 250 }) === 'X', 'over-axis detection');
ok(oversize([300, 100, 50], { on: false, x: 220, y: 220, z: 250 }) === '', 'advisory when disabled');

/* orientation hint (Round 31): execute the production helper with minimal stubs */
ok(src.indexOf('function envelopeOrientationHint()') >= 0, 'envelopeOrientationHint helper exists');
ok(src.indexOf('Fit envelope orientation: ') >= 0, 'orientation advisory is surfaced in preflight');
ok(src.indexOf('verify orientation and printer limits yourself') >= 0, 'orientation hint is advisory and disclaims printer compatibility');
ok(src.indexOf('Only six axis-aligned orderings are checked; angled placements are not analyzed.') >= 0, 'fit result bounds its claim to six axis-aligned orderings');
ok(src.indexOf('None of the six axis-aligned orderings fits.') >= 0 && src.indexOf('does not establish that no possible placement fits') >= 0, 'no-fit result does not overclaim all orientations');
ok(src.indexOf('Compared extents (part X × Y × Z): ') >= 0 && src.indexOf('envelope: ') >= 0, 'advisory shows compared extents');
var helperMatch = src.match(/function envelopeOrientationHint\(\) \{[\s\S]*?\n  \}/);
ok(!!helperMatch, 'production helper source can be isolated');
function hintFor(bbox, envelope) {
  var part = { envelope: envelope };
  var metrics = { bbox: bbox };
  function fmt(v, digits) { return Number(v).toFixed(digits); }
  function envelopeOversize() {
    return bbox[0] > envelope.x || bbox[1] > envelope.y || bbox[2] > envelope.z ? 'oversize' : '';
  }
  return new Function('part', 'metrics', 'fmt', 'envelopeOversize', helperMatch[0] + '\nreturn envelopeOrientationHint();')(part, metrics, fmt, envelopeOversize);
}
var fitsSwapped = hintFor([300, 100, 50], { on: true, x: 100, y: 300, z: 60 });
ok(fitsSwapped.indexOf('Axis-order fit found: part Y along envelope X, X along Y, Z along Z.') >= 0, 'production helper names the fitting axis ordering');
ok(fitsSwapped.indexOf('300.0 × 100.0 × 50.0 mm') >= 0 && fitsSwapped.indexOf('envelope: 100 × 300 × 60 mm') >= 0, 'production fit advice reports both extents');
ok(fitsSwapped.indexOf('Only six axis-aligned orderings are checked') >= 0 && fitsSwapped.indexOf('angled placements are not analyzed') >= 0, 'production fit advice bounds its scope');
var noneFit = hintFor([300, 100, 50], { on: true, x: 220, y: 220, z: 250 });
ok(noneFit.indexOf('None of the six axis-aligned orderings fits.') === 0 && noneFit.indexOf('does not establish that no possible placement fits') >= 0, 'production no-fit advice is bounded to checked orderings');
ok(noneFit.indexOf('300.0 × 100.0 × 50.0 mm') >= 0 && noneFit.indexOf('envelope: 220 × 220 × 250 mm') >= 0, 'production no-fit advice reports compared extents');
ok(hintFor([100, 100, 50], { on: true, x: 220, y: 220, z: 250 }) === '', 'production helper stays quiet when the part fits as modeled');
ok(hintFor([300, 100, 50], { on: false, x: 220, y: 220, z: 250 }) === '', 'production helper stays quiet when envelope is disabled');

if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('fit-envelope smoke: all ok');
