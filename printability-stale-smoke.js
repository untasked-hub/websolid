/* Printability freshness smoke test (Round 33).
   Node-only: evaluates the production freshness helpers with deterministic stubs. */
var fs = require('fs');
var src = fs.readFileSync(__dirname + '/public/cad.js', 'utf8');
var failures = [];
function ok(condition, message) {
  if (!condition) failures.push(message);
  else console.log('ok - ' + message);
}
function functionSource(name) {
  var match = src.match(new RegExp('function ' + name + '\\(\\) \\{[\\s\\S]*?\\n  \\}'));
  if (!match) throw new Error('Missing production helper: ' + name);
  return match[0];
}

var positionArray = [0, 0, 0, 12, 0, 0, 0, 8, 0];
var mesh = { geometry: { attributes: { position: { array: positionArray } } } };
var part = { feature: 'extrude', printability: { profile: 'fdm' } };
var window = { SolidPrintability: { thresholds: function (opts) {
  return { profile: opts.printability.profile, minWall: 1.2, minHole: 2, overhang: 45 };
} } };
var document = { elements: {
  'print-stale': { hidden: true, textContent: '' },
  'print-chips': { attrs: {}, setAttribute: function (k, v) { this.attrs[k] = v; },
    removeAttribute: function (k) { delete this.attrs[k]; } }
}, getElementById: function (id) { return this.elements[id] || null; } };
var num = function (value, fallback) { value = Number(value); return isFinite(value) ? value : fallback; };
var mirroredHoles = function () { return [{ d: 3 }]; };
var printSummary = { key: '', stale: false };
var helpers = 'var printSummary = this.printSummary;\n' + functionSource('printabilityInputKey') + '\n' +
  functionSource('refreshPrintStaleness') +
  '\nthis.printabilityInputKey = printabilityInputKey; this.refreshPrintStaleness = refreshPrintStaleness;';
var scope = { printSummary: printSummary };
new Function('mesh', 'part', 'window', 'document', 'num', 'mirroredHoles', helpers).call(scope, mesh, part, window, document, num, mirroredHoles);

var initialKey = scope.printabilityInputKey();
printSummary.key = initialKey;
ok(!!initialKey, 'freshness key computed from mesh and profile assumptions');
ok(scope.refreshPrintStaleness() === false && document.elements['print-stale'].hidden,
  'matching checked inputs remain current');
positionArray[3] = 18;
ok(scope.refreshPrintStaleness() === true && !document.elements['print-stale'].hidden,
  'geometry change visibly marks prior result stale');
ok(document.elements['print-chips'].attrs['data-stale'] === 'true',
  'prior result chips are marked as earlier estimates');
part.printability.profile = 'resin';
ok(scope.refreshPrintStaleness() === true, 'profile change continues to mark result stale');
printSummary.key = scope.printabilityInputKey();
ok(scope.refreshPrintStaleness() === false && document.elements['print-stale'].hidden,
  'new checked signature clears stale state');

if (failures.length) {
  console.error('\n' + failures.length + ' printability freshness assertion(s) failed');
  process.exit(1);
}
console.log('\nAll printability freshness checks passed.');
