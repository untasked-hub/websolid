/* Preflight "Fix" action smoke test (Round 7).
   Each mapped printability/preflight line must render a Fix button that jumps
   to the parameter control responsible, without changing any value. */
var fs = require('fs');
var f = [];
function ok(c, m) { if (!c) f.push(m); else console.log('ok - ' + m); }

var js = fs.readFileSync(__dirname + '/public/cad.js', 'utf8');
var css = fs.readFileSync(__dirname + '/public/cad.css', 'utf8');

ok(/function preflightFixFor\(text\)/.test(js), 'cad.js defines preflightFixFor');
ok(/function focusPreflightFix\(selector\)/.test(js), 'cad.js defines focusPreflightFix');

var map = js.slice(js.indexOf('function preflightFixFor(text)'));
map = map.slice(0, map.indexOf('\n  }\n') + 4);
ok(/#min-wall/.test(map), 'min-wall clearance maps to the min-wall input');
ok(/holes\.0\.d/.test(map), 'overlapping hole circles map to a hole diameter field');
ok(/holes\.' \+ idx \+ '\.x/.test(map), 'out-of-profile hole maps to that hole X field');
ok(/data-fix="envelope"/.test(map), 'oversize envelope maps to the envelope fields');
ok(/#btn-printability/.test(map), 'stale/missing printability maps to the Check button');
ok(/return null;/.test(map), 'unmatched lines get no Fix action');

var focus = js.slice(js.indexOf('function focusPreflightFix(selector)'));
focus = focus.slice(0, focus.indexOf('\n  }\n') + 4);
ok(/querySelector\(selector\)/.test(focus), 'focus helper resolves the selector');
ok(/scrollIntoView/.test(focus), 'focus helper scrolls the control into view');
ok(/fix-flash/.test(focus), 'focus helper flashes the control');
ok(!/\.value\s*=/.test(focus), 'focus helper never changes a value');

var render = js.slice(js.indexOf('function renderPreflight()'));
render = render.slice(0, render.indexOf('\n  }\n') + 4);
ok(/preflightFixFor\(text\)/.test(render), 'renderPreflight consults the fix map');
ok(/preflight-fix/.test(render), 'renderPreflight renders a Fix button');
ok(/addEventListener\('click', function \(\) \{ focusPreflightFix\(fix\.selector\); \}\)/.test(render),
  'Fix button calls the focus helper with the mapped selector');
ok(/span\.textContent = text/.test(render), 'warning text is still rendered as text (no HTML injection)');

ok(/envField\.setAttribute\('data-fix', 'envelope'\)/.test(js), 'envelope fields carry the data-fix anchor');
ok(/\.preflight-fix\s*\{/.test(css), 'Fix button has styling');
ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}fix-flash/.test(css),
  'flash animation respects reduced motion');

if (f.length) { console.error('FAIL', f); process.exit(1); }
