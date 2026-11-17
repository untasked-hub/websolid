/* Recovery snapshot export smoke test (Round 6).
   The restore banner must offer a non-destructive third choice: download the
   pending browser-local snapshot as a portable .websolid.json part file
   without restoring it and without deleting it from this browser. */
var fs = require('fs');
var f = [];
function ok(c, m) { if (!c) f.push(m); else console.log('ok - ' + m); }

var html = fs.readFileSync(__dirname + '/public/cad.html', 'utf8');
var js = fs.readFileSync(__dirname + '/public/cad.js', 'utf8');

ok(/id="btn-save-snapshot"/.test(html), 'restore banner has a save-snapshot button');
ok(/id="btn-restore-session"/.test(html) && /id="btn-discard-session"/.test(html),
  'restore and discard actions are still present');

ok(/function exportPendingSnapshot\(\)/.test(js), 'cad.js defines exportPendingSnapshot');
ok(/getElementById\('btn-save-snapshot'\)[\s\S]{0,120}addEventListener\('click', exportPendingSnapshot\)/.test(js),
  'save-snapshot button is wired to exportPendingSnapshot');

/* The export must read the pending snapshot, not the open part. */
var fn = js.slice(js.indexOf('function exportPendingSnapshot()'));
fn = fn.slice(0, fn.indexOf('\n  }\n') + 4);
ok(/pendingRestore\.part/.test(fn), 'export serializes the pending snapshot part');
ok(/partFilePayloadFor\(pendingRestore\.part\)/.test(fn), 'export reuses the portable part-file payload');
ok(/\.websolid\.json/.test(fn), 'download filename uses the .websolid.json extension');
ok(/snapshot/.test(fn), 'download filename marks the file as a snapshot');
ok(!/pendingRestore = null/.test(fn) && !/removeItem/.test(fn) && !/discardSessionSnapshot/.test(fn),
  'export does not clear or discard the snapshot');
ok(!/loadPartIntoEditor/.test(fn) && !/restoreSessionSnapshot\(/.test(fn),
  'export does not restore the snapshot into the editor');

/* Shared payload builder must still serve the normal Save file path. */
ok(/function partFilePayload\(\) \{\s*return partFilePayloadFor\(part\);/.test(js),
  'partFilePayload still serializes the open part');

if (f.length) { console.error('FAIL', f); process.exit(1); }
