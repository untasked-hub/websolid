/* Cost basis smoke test (Round 34). */
var fs = require('fs'), vm = require('vm');
var src = fs.readFileSync(__dirname + '/public/cad.js', 'utf8');
var f = [];
function ok(c, m) { if (!c) f.push(m); else console.log('ok - ' + m); }
function fn(name) {
  var m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}'));
  if (!m) throw new Error('missing ' + name); return m[0];
}
var ctx = { MATERIALS: [{ id: 'aluminium', name: 'Aluminium', density: 2.7 }, { id: 'steel', name: 'Steel', density: 7.85 }],
  COST: { pricePerKg: { aluminium: 4, steel: 2 } }, num: function (v, d) { v = Number(v); return isFinite(v) ? v : d; } };
vm.createContext(ctx);
vm.runInContext(fn('sanitizeCostPrice') + fn('costBasisFor'), ctx);
var s = ctx.sanitizeCostPrice({ aluminium: '5.555', steel: -1, bogus: 3, x: 'a' });
ok(s.aluminium === 5.56 && !('steel' in s) && !('bogus' in s), 'sanitize keeps valid, drops invalid/unknown');
ok(Object.keys(ctx.sanitizeCostPrice(null)).length === 0, 'null sanitizes to empty');
var mat = ctx.MATERIALS[0];
var b = ctx.costBasisFor({ costPrice: { aluminium: 6 } }, mat, 6);
ok(b.priceSource === 'custom' && b.defaultPricePerKg === 4 && b.density === 2.7, 'custom basis reported');
b = ctx.costBasisFor({ costPrice: {} }, mat, 4);
ok(b.priceSource === 'default' && b.pricePerKg === 4, 'default basis reported');
var html = fs.readFileSync(__dirname + '/public/cad.html', 'utf8');
ok(/cost-price-reset/.test(html), 'html has reset control');
ok(/id="cost-disclosure"/.test(html) && /modeled solid volume/.test(html), 'html discloses solid-volume basis');
ok(/<dt>Solid material<\/dt>/.test(html) && /<dt>Drilling proxy<\/dt>/.test(html) && /<dt>Material \+ drilling<\/dt>/.test(html), 'cost labels name solid material and drilling proxy');
ok(/<dt>Solid mass<\/dt>/.test(html), 'mass label names solid mass');
ok(/Infill does not change the solid mass or material cost/.test(html), 'disclosure separates infill from material cost');
ok(/id="cost-filament"/.test(html) && /<dt>Slicer filament<\/dt>/.test(html), 'html has slicer filament readout');
if (f.length) { console.log('FAIL', f); process.exit(1); }
