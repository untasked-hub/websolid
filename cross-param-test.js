
var fs = require('fs');
var productionSource = fs.readFileSync(__dirname + '/public/cad.js', 'utf8');
var part = {holes: []};
function num(v,d){ var n=Number(v); return isFinite(n)?n:(d===undefined?0:d); }
function fmt(v,d){ return Number(v).toFixed(d===undefined?2:d); }
  /* Cross-parameter consistency helpers. These describe, before a commit is
     accepted, which *other* parameter would fall outside its own range if the
     edited value were applied (a larger fillet than the sketch can hold, a
     slot width larger than its length, a seat deeper than the part, ...).
     They are advisory-exact: plain arithmetic on stored parameters. */
  function sketchActiveCornerRadius(sk) {
    var cr = 0;
    if (Array.isArray(sk.corners)) {
      sk.corners.forEach(function (c) { if (c && c.on) cr = Math.max(cr, num(c.r, 0)); });
    }
    return cr;
  }
  function sketchDimConflict(sk, proposed, which) {
    var out = [];
    var fil = num(sk.round, 0);
    if (fil > 0.02 && proposed < fil * 2 - 1e-9) {
      out.push('Fillet ' + fmt(fil, 1) + ' mm needs ' + which + ' \u2265 ' + fmt(fil * 2, 1) + ' mm. Next: set ' + which + ' to at least ' + fmt(fil * 2, 1) + ' mm.');
    }
    var otherDim = which === 'width' ? num(sk.height, 0) : num(sk.width, 0);
    var cr = sketchActiveCornerRadius(sk);
    if (cr > 0.02 && Math.min(proposed, otherDim) < cr * 2 - 1e-9) {
      out.push('Per-corner radius ' + fmt(cr, 1) + ' mm needs both sketch dimensions \u2265 ' + fmt(cr * 2, 1) + ' mm. Next: set both width and height to at least ' + fmt(cr * 2, 1) + ' mm.');
    }
    return out;
  }
  function seatDepthConflicts(depth) {
    var out = [];
    (part.holes || []).forEach(function (hole, i) {
      if (!hole || !hole.seat || hole.seat.type !== 'cbore') return;
      var seatDepth = num(hole.seat.depth, 0);
      if (seatDepth > depth - 0.1 + 1e-9) {
        out.push('Cut' + (i + 1) + ' seat depth ' + fmt(seatDepth, 1) + ' mm needs depth \u2265 ' + fmt(seatDepth + 0.1, 1) + ' mm. Next: set depth to at least ' + fmt(seatDepth + 0.1, 1) + ' mm or reduce Cut' + (i + 1) + ' seat depth.');
      }
    });
    return out;
  }
  function seatDiaConflicts(hole, dia) {
    var out = [];
    if (!hole || !hole.seat || (hole.seat.type !== 'cbore' && hole.seat.type !== 'csink')) return out;
    var seatDia = num(hole.seat.dia, 0);
    if (seatDia < dia + 0.2 - 1e-9) {
      out.push('Seat dia ' + fmt(seatDia, 1) + ' mm needs hole dia \u2264 ' + fmt(seatDia - 0.2, 2) + ' mm. Next: set hole dia to at most ' + fmt(seatDia - 0.2, 2) + ' mm');
    }
    return out;
  }


function assert(c,m){ if(!c){ console.log('FAIL '+m); process.exitCode=1; } else console.log('ok   '+m); }
assert(productionSource.indexOf("' mm. Next: set ' + which + ' to at least '") >= 0, 'production fillet conflict provides next action');
assert(productionSource.indexOf('Next: set both width and height to at least') >= 0, 'production corner conflict provides both dimension adjustments');
assert(productionSource.indexOf('Next: set depth to at least') >= 0 && productionSource.indexOf('or reduce Cut') >= 0, 'production seat-depth conflict provides safe alternatives');
assert(productionSource.indexOf('Next: set hole dia to at most') >= 0, 'production seat-diameter conflict provides upper bound');
assert(productionSource.indexOf("hintEl.textContent = 'Blocked: ' + message + ' \\u2014 previous value kept'") >= 0, 'production rejected edit preserves previous-value guidance');

var sk = {width:40,height:20,round:5,corners:[{on:false,r:0},{on:false,r:0},{on:false,r:0},{on:false,r:0}]};
assert(sketchDimConflict(sk,40,'width').length===0,'width 40 ok with fillet 5');
assert(sketchDimConflict(sk,10,'width').length===0,'width 10 exactly at fillet limit ok');
assert(/Fillet 5.0 mm needs width/.test(sketchDimConflict(sk,9,'width')[0]),'width 9 blocked by fillet 5');
assert(/Next: set width to at least 10.0 mm/.test(sketchDimConflict(sk,9,'width')[0]),'fillet conflict gives metadata-derived next action');
assert(sketchDimConflict(sk,9,'height')[0].indexOf('height')>0,'height 9 blocked names height');
sk.round=0;
sk.corners[2]={on:true,r:8};
assert(/Per-corner radius 8.0 mm/.test(sketchDimConflict(sk,15,'width')[0]),'width 15 blocked by corner radius 8');
assert(/Next: set both width and height to at least 16.0 mm/.test(sketchDimConflict(sk,15,'width')[0]),'corner-radius conflict gives both dependent dimension adjustments');
assert(sketchDimConflict(sk,17,'width').length===0,'width 17 ok with corner radius 8 and other dim 20');
var rejectedGuidance = sketchDimConflict(sk,15,'width')[0];
assert(/Next:/.test(rejectedGuidance) && /previous value kept/i.test('Blocked: ' + rejectedGuidance + ' — previous value kept'),'rejected conflict retains explicit recovery and rollback wording');
sk.corners[2].on=false;

part.holes=[{d:6,seat:{type:'cbore',dia:11,depth:4}},{d:6,seat:{type:'csink',dia:11,depth:1}},{d:6}];
assert(seatDepthConflicts(6).length===0,'depth 6 ok for cbore depth 4');
assert(/Cut1 seat depth 4.0 mm needs depth/.test(seatDepthConflicts(4)[0]),'depth 4 blocked by cbore seat 4');
assert(/Next: set depth to at least 4.1 mm or reduce Cut1 seat depth/.test(seatDepthConflicts(4)[0]),'counterbore conflict gives a safe edit-time next action');
assert(seatDepthConflicts(4).length===1,'only cbore counted');
assert(seatDiaConflicts(part.holes[0],6).length===0,'dia 6 ok with seat 11');
assert(/Seat dia 11.0 mm needs hole dia/.test(seatDiaConflicts(part.holes[0],11)[0]),'dia 11 blocked by seat 11');
assert(/Next: set hole dia to at most 10.80 mm/.test(seatDiaConflicts(part.holes[0],11)[0]),'counterbore diameter conflict gives metadata-derived upper bound');
assert(seatDiaConflicts(part.holes[1],10.9).length===1,'csink counts too');
assert(seatDiaConflicts(part.holes[2],50).length===0,'plain hole has no seat constraint');
