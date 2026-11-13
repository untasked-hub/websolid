
'use strict';

/* WebSolid - a small parametric part modeler.
   Sketch a profile (rectangle with fillets / circle / hexagon / L),
   add through-holes, extrude to a solid, read real mass properties,
   export STL. Every dimension is a parameter: change the number and
   the solid rebuilds. Parts persist in Postgres. */

(function () {
  var THREE = window.THREE;

  var MATERIALS = [
    { id: 'steel', name: 'Steel AISI 1020', density: 7.87, color: 0x9aa6b2, metal: 0.75, rough: 0.32 },
    { id: 'aluminium', name: 'Aluminium 6061', density: 2.70, color: 0xc9d3dd, metal: 0.70, rough: 0.34 },
    { id: 'brass', name: 'Brass C360', density: 8.50, color: 0xd7b46a, metal: 0.80, rough: 0.28 },
    { id: 'abs', name: 'ABS plastic', density: 1.04, color: 0xe6e0d4, metal: 0.05, rough: 0.62 },
    { id: 'nylon', name: 'Nylon 6/6', density: 1.14, color: 0xd9e5e1, metal: 0.05, rough: 0.58 }
  ];

  /* Fit envelope: advisory build-volume check. bbox axes are [x, y, z] sizes
     in mm from the rebuilt mesh; the envelope is a user-set target volume. */
  /* Set while the envelope's own dimension fields commit: tightening the
     envelope must never be rejected as "part too large". */
  var editingEnvelopeField = false;

  function envelopeOversize() {
    if (!part.envelope || !part.envelope.on || !metrics || !metrics.bbox) return '';
    var b = metrics.bbox, e = part.envelope, over = [];
    if (b[0] > e.x) over.push('X ' + fmt(b[0], 1) + ' mm > ' + e.x + ' mm');
    if (b[1] > e.y) over.push('Y ' + fmt(b[1], 1) + ' mm > ' + e.y + ' mm');
    if (b[2] > e.z) over.push('Z ' + fmt(b[2], 1) + ' mm > ' + e.z + ' mm');
    return over.join('; ');
  }

  /* Advisory only: checks whether permuting the bbox axes (a rigid re-orientation
     of the printed part, not a geometry change) would fit the envelope. Returns
     '' when no envelope is configured or the part is not oversize. Never claims
     printer compatibility or an optimized placement. */
  function envelopeOrientationHint() {
    if (!part.envelope || !part.envelope.on || !metrics || !metrics.bbox) return '';
    var b = metrics.bbox, e = part.envelope, t = [e.x, e.y, e.z];
    if (!envelopeOversize()) return '';
    var perms = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
    var names = ['X', 'Y', 'Z'];
    for (var p = 0; p < perms.length; p++) {
      var q = perms[p];
      if (b[q[0]] <= t[0] && b[q[1]] <= t[1] && b[q[2]] <= t[2]) {
        return 'Axis-order fit found: part ' + names[q[0]] + ' along envelope X, ' + names[q[1]] + ' along Y, ' + names[q[2]] + ' along Z. Compared extents (part X × Y × Z): ' + b.map(function (v) { return fmt(v, 1); }).join(' × ') + ' mm; envelope: ' + t.join(' × ') + ' mm. Only six axis-aligned orderings are checked; angled placements are not analyzed. Advisory only; verify orientation and printer limits yourself.';
      }
    }
    return 'None of the six axis-aligned orderings fits. Compared extents (part X × Y × Z): ' + b.map(function (v) { return fmt(v, 1); }).join(' × ') + ' mm; envelope: ' + t.join(' × ') + ' mm. Angled placements are not analyzed, so this does not establish that no possible placement fits. Consider reducing dimensions or raising the envelope.';
  }

  function buildPreflight() {
    var blocking = [], advisory = [];
    var holes = part.feature === 'extrude' ? mirroredHoles() : [];
    for (var i = 0; i < holes.length; i++) {
      var check = holeClearance(holes[i], num(part.minWall, 2));
      if (check.status === 'outside') blocking.push('Hole ' + (i + 1) + ' circle crosses or lies outside the sketch profile; hole checks use the nominal circle and current profile.');
    }
    if (!holes.length) blocking.push('No nominal hole circles to check against the sketch profile.');
    if (!blocking.length) blocking.push('No hole circles cross or leave the sketch profile.');

    if (holes.length > 1) {
      var pair = holeSpacingPairs();
      if (pair && pair.gap <= 0) advisory.push('Nominal hole circles overlap or touch (minimum gap ' + pair.gap.toFixed(2) + ' mm); this may be intentional and is not a mesh/ligament check.');
      else if (pair) advisory.push('Nominal hole circles do not overlap; minimum pair gap ' + pair.gap.toFixed(2) + ' mm. Counterbore/countersink seats are excluded.');
    } else advisory.push('Hole-to-hole spacing: not applicable (fewer than two nominal holes).');

    var edge = minEdgeClearance();
    if (edge === null) advisory.push('Minimum edge wall: not applicable (no holes).');
    else if (edge >= 0) advisory.push('Minimum nominal hole-to-profile clearance: ' + edge.toFixed(2) + ' mm; configured minimum wall is ' + num(part.minWall, 2).toFixed(2) + ' mm. This is a 2D estimate.');
    if (part.envelope && part.envelope.on) {
      var env = envelopeOversize();
      if (env) advisory.push('Fit envelope: part exceeds the target build volume (' + env + '). Edits that would keep it oversized are rejected.');
      var orient = envelopeOrientationHint();
      if (orient) advisory.push('Fit envelope orientation: ' + orient);
      else advisory.push('Fit envelope: part fits the target build volume ' + part.envelope.x + ' \u00d7 ' + part.envelope.y + ' \u00d7 ' + part.envelope.z + ' mm.');
    } else advisory.push('Fit envelope: not configured. Enable it in Extrude & features to check the part against a target build volume.');
    if (printSummary) advisory.push('Printability estimates: ' + (printSummary.stale ? 'stale — run Check again for the current part' : (printSummary.ok ? 'all analyzed checks passed' : printSummary.fails + ' check(s) need review') + ' from the most recent run') + '. Not engineering certification.');
    else advisory.push('Printability estimates have not been run for the current part. Use Check for global mesh estimates; results are not certification.');
    return { blocking: blocking, advisory: advisory };
  }

  function renderPreflight() {
    var report = buildPreflight();
    var targets = [
      { id: 'preflight-blocking', items: report.blocking, kind: 'preflight-blocked' },
      { id: 'preflight-advisory', items: report.advisory, kind: 'preflight-advisory' }
    ];
    targets.forEach(function (target) {
      var list = document.getElementById(target.id);
      if (!list) return;
      list.replaceChildren();
      target.items.forEach(function (text) {
        var li = document.createElement('li');
        li.className = target.kind;
        li.textContent = text;
        list.appendChild(li);
      });
    });
  }

  function openExportHandoff(format, exportAction) {
    var panel = document.getElementById('handoff-panel');
    var toggle = document.getElementById('btn-handoff');
    var close = document.getElementById('btn-handoff-close');
    var summary = document.getElementById('handoff-summary');
    var labels = { stl: 'STL · whole-part binary mesh', dxf: 'DXF R12 · active sketch only', svg: 'SVG · orthographic drawing', csv: 'CSV · bill of materials' };
    var limits = {
      stl: 'STL has no unit metadata; import using millimetres.',
      dxf: 'DXF contains the active sketch outline and hole/seat circles, not the extruded 3D solid.',
      svg: 'SVG contains top, front, and right orthographic views with scale and mm dimensions.',
      csv: 'CSV contains the hole list and part/material summary.'
    };
    if (!mesh || !metrics) { toast('Build a part before exporting', true); return; }
    var b = metrics.bbox || [];
    summary.textContent = 'Part: ' + (part.name || 'part') + ' · Units: mm · Bounds: ' +
      (b.length === 3 ? b.map(function (n) { return Number(n).toFixed(2); }).join(' × ') + ' mm' : 'unavailable') +
      ' · Format: ' + labels[format] + ' · ' + limits[format];
    renderPreflight();
    var checklist = document.getElementById('handoff-checklist');
    if (checklist) {
      var steps = {
        stl: ['Scope: the current whole-part mesh; it does not preserve editable parameters.', 'Units: coordinates are mm; STL has no unit field, so set millimetres on import.', 'Next step: check the bounds above in your target tool before printing or machining.'],
        dxf: ['Scope: active sketch outline and hole/seat circles only.', 'Units: DXF is tagged millimetres ($INSUNITS = 4).', 'Next step: the extruded 3D solid is not in this file; use STL for solid geometry.'],
        svg: ['Scope: orthographic top, front, and right views of the whole part.', 'Units: sheet lists px/mm scale, each view’s mm dimensions, and overall mm bounds.', 'Next step: treat this as a reference preview; add tolerances in a drafting tool.'],
        csv: ['Scope: hole list plus part name, material, volume, mass, and bounding box.', 'Units: dimensions in mm, volume in mm³, mass in g.', 'Next step: verify hole positions against your design before ordering parts.']
      };
      var artifactReceipt = document.getElementById('artifact-receipt');
      if (artifactReceipt) {
        var facts = steps[format] || [];
        artifactReceipt.textContent = 'Artifact: ' + labels[format] + ' · ' + facts[0] + ' · ' + facts[1] + ' · ' + facts[2] +
          ' · This export is not an editable WebSolid part. Use Save file for a portable editable definition.';
      }
      checklist.innerHTML = '';
      (steps[format] || []).forEach(function (text) {
        var li = document.createElement('li');
        li.textContent = text;
        checklist.appendChild(li);
      });
    }
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    close.focus();
    var confirm = document.getElementById('btn-handoff-export');
    confirm.hidden = false;
    confirm.onclick = function () {
      panel.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      toggle.focus();
      exportAction();
    };
  }

  function defaultPart() {
    return {
      name: 'Mounting bracket',
      material: 'aluminium',
      sketch: { type: 'rect', width: 80, height: 50, round: 6, corner: 'fillet' },
      extrude: { depth: 12 },
      feature: 'extrude',
      revolve: { angle: 360 },
      shell: { on: false, wall: 2 },
      mirror: { axis: 'none' },
      holes: [
        { x: -27, y: -14, d: 8 },
        { x: 27, y: -14, d: 8 },
        { x: 0, y: 9, d: 16 }
      ],
      equations: { vars: {}, bindings: {} },
      macro: [],
      pushPulls: [],
      envelope: { on: false, x: 220, y: 220, z: 250 }
    };
  }

  var EQ = window.SolidEquations || { parse: null };
  var part = defaultPart();
  var partId = null;
  var view = { edges: true, sketch: false, grid: true, wire: false, section: false, sectionAxis: 'y', sectionOffset: 0.5 };

  var host = document.getElementById('viewport');

  // Real WebGL when the browser hands us a context; otherwise a small
  // software rasteriser on a 2D canvas keeps the solid visible (headless
  // browsers, locked-down GPUs, remote desktops).
  var renderer = null;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  } catch (err) {
    renderer = null;
  }

  var canvas2d = null;
  var gfxBadge = document.createElement('span');
  gfxBadge.className = 'gfx-badge' + (renderer ? '' : ' warn');

  if (renderer) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.localClippingEnabled = true;
    renderer.setClearColor(0x12161c, 1);
    host.appendChild(renderer.domElement);
    gfxBadge.textContent = 'WebGL';
  } else {
    canvas2d = document.createElement('canvas');
    canvas2d.className = 'fallback2d';
    host.appendChild(canvas2d);
    gfxBadge.textContent = 'software render';
  }
  host.appendChild(gfxBadge);

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(38, 1, 0.5, 8000);
  camera.up.set(0, 0, 1);

  scene.add(new THREE.HemisphereLight(0xe3f2ff, 0x1a1f27, 0.9));
  var keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
  keyLight.position.set(180, -240, 320);
  scene.add(keyLight);
  var fillLight = new THREE.DirectionalLight(0xa6dcff, 0.5);
  fillLight.position.set(-260, 180, 140);
  scene.add(fillLight);
  var rimLight = new THREE.DirectionalLight(0xffffff, 0.4);
  rimLight.position.set(40, 260, -200);
  scene.add(rimLight);

  var gridHelper = new THREE.GridHelper(600, 60, 0x38465a, 0x1e2733);
  gridHelper.rotation.x = Math.PI / 2;
  gridHelper.position.z = -0.05;
  scene.add(gridHelper);

  var axes = new THREE.AxesHelper(40);
  axes.position.set(-120, -120, 0);
  scene.add(axes);

  var model = new THREE.Group();
  scene.add(model);
  var overlay = new THREE.Group();
  scene.add(overlay);

  var cam = { theta: -1.02, phi: 1.05, dist: 250, target: new THREE.Vector3(0, 0, 0) };

  function applyCamera() {
    var sp = Math.sin(cam.phi);
    camera.position.set(
      cam.target.x + cam.dist * sp * Math.cos(cam.theta),
      cam.target.y + cam.dist * sp * Math.sin(cam.theta),
      cam.target.z + cam.dist * Math.cos(cam.phi)
    );
    camera.lookAt(cam.target);
  }

  /* ------------------------------------------------------------- geometry */

  var SEG = 72;

  function num(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  function profilePoints(sk) {
    var pts = [];
    var w = Math.max(0.5, num(sk.width, 80));
    var h = Math.max(0.5, num(sk.height, 50));

    if (sk.type === 'custom') {
      var custom = entityProfilePoints(sk.entities);
      if (custom) return custom;
      /* fall through to the rectangle when the entity list is unusable */
    }

    if (sk.type === 'circle') {
      var r0 = Math.max(0.2, w / 2);
      for (var i = 0; i < SEG; i++) {
        var a0 = (i / SEG) * Math.PI * 2;
        pts.push([Math.cos(a0) * r0, Math.sin(a0) * r0]);
      }
      return pts;
    }

    if (sk.type === 'hex') {
      var af = Math.max(0.2, w);
      var rr = af / 2 / Math.cos(Math.PI / 6);
      for (var j = 0; j < 6; j++) {
        var a1 = (j / 6) * Math.PI * 2 + Math.PI / 6;
        pts.push([Math.cos(a1) * rr, Math.sin(a1) * rr]);
      }
      return pts;
    }

    if (sk.type === 'slot') {
      /* Slot / obround: overall length w, width h, orientation slotAngle.
         Two straight edges plus 180-degree end arcs. */
      var rS = Math.max(0.2, h / 2);
      var sS = Math.max(0.001, w - h);
      var angS = (num(sk.slotAngle, 0) * Math.PI) / 180;
      var cs = Math.cos(angS), sn = Math.sin(angS);
      var arcSteps = 10;
      var seqS = [
        { x: -sS / 2, y: -rS },
        { x: sS / 2, y: -rS }
      ];
      for (var ai = 0; ai <= arcSteps; ai++) {
        var aa = -Math.PI / 2 + (ai / arcSteps) * Math.PI;
        seqS.push({ x: sS / 2 + Math.cos(aa) * rS, y: Math.sin(aa) * rS });
      }
      seqS.push({ x: -sS / 2, y: rS });
      for (var bi = 0; bi <= arcSteps; bi++) {
        var ab = Math.PI / 2 + (bi / arcSteps) * Math.PI;
        seqS.push({ x: -sS / 2 + Math.cos(ab) * rS, y: Math.sin(ab) * rS });
      }
      for (var pi2 = 0; pi2 < seqS.length; pi2++) {
        pts.push([
          seqS[pi2].x * cs - seqS[pi2].y * sn,
          seqS[pi2].x * sn + seqS[pi2].y * cs
        ]);
      }
      return pts;
    }

    if (sk.type === 'L') {
      var t = Math.min(Math.max(0.5, num(sk.round, 6)), Math.min(w, h) / 2 - 0.01);
      pts.push([-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, -h / 2 + t],
               [-w / 2 + t, -h / 2 + t], [-w / 2 + t, h / 2], [-w / 2, h / 2]);
      return pts;
    }

    /* Per-corner fillet/chamfer overrides: sketch.corners = [{r, on, mode} x4]
       in corner order BL, BR, TR, TL (matches the UI corner numbering).
       Corners switched on get their own radius (fillet arc or 45-degree
       chamfer); corners left off fall back to the global sk.round /
       sk.corner treatment. Radii are clamped so adjacent corner
       treatments cannot overlap along a shared edge. */
    var cs = Array.isArray(sk.corners) ? sk.corners : null;
    var anyCorner = cs && cs.some(function (c) { return c && c.on && num(c.r, 0) > 0.02; });
    if (anyCorner) {
      var base = [
        [-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]
      ]; /* BL, BR, TR, TL (CCW) */
      var rad = Math.min(Math.max(0, num(sk.round, 0)), Math.min(w, h) / 2 - 0.01);
      var used = [rad, rad, rad, rad];
      var modes = [];
      for (var ci = 0; ci < 4; ci++) {
        var cc = cs[ci];
        if (cc && cc.on && num(cc.r, 0) > 0.02) {
          used[ci] = num(cc.r, 0);
          modes[ci] = cc.mode === 'chamfer' ? 'chamfer' : 'fillet';
        } else {
          modes[ci] = sk.corner === 'chamfer' ? 'chamfer' : 'fillet';
        }
      }
      /* Clamp so the two treatments sharing an edge still fit along it. */
      for (var ci2 = 0; ci2 < 4; ci2++) {
        var ni = (ci2 + 1) % 4;
        var maxSum = (ci2 % 2 === 0 ? w : h) - 0.02; /* edge 0-1,2-3 horizontal (w); 1-2,3-0 vertical (h) */
        var s = used[ci2] + used[ni];
        if (s > maxSum) {
          var k = maxSum / s;
          used[ci2] *= k;
          used[ni] *= k;
        }
      }
      /* Walk the rectangle CCW; each corner emits its trimmed tangent
         points (chamfer) or a tangent arc (fillet). */
      for (var oi = 0; oi < 4; oi++) {
        var P = base[oi];
        var A = base[(oi + 3) % 4], B = base[(oi + 1) % 4];
        var ux = A[0] - P[0], uy = A[1] - P[1];
        var vx = B[0] - P[0], vy = B[1] - P[1];
        var lu = Math.sqrt(ux * ux + uy * uy);
        var lv = Math.sqrt(vx * vx + vy * vy);
        var rC = Math.min(used[oi], lu - 0.01, lv - 0.01);
        if (rC <= 0.02) { pts.push(P); continue; }
        /* Tangent points: back along the incoming edge, forward along the outgoing one. */
        var tAx = P[0] + ux / lu * rC, tAy = P[1] + uy / lu * rC;
        var tBx = P[0] + vx / lv * rC, tBy = P[1] + vy / lv * rC;
        if (modes[oi] === 'chamfer') {
          pts.push([tAx, tAy], [tBx, tBy]);
        } else {
          /* Arc centre: rC into the polygon along each edge inward normal
             (interior of a CCW polygon is left of the travel direction). */
          var nAx = uy / lu, nAy = -ux / lu;      /* rotate90 of -u_hat */
          var nBx = -vy / lv, nBy = vx / lv;      /* rotate90 of v_hat */
          var cX = tAx + nAx * rC, cY = tAy + nAy * rC;
          var aStart = Math.atan2(tAy - cY, tAx - cX);
          var dIn = Math.atan2(-uy, -ux), dOut = Math.atan2(vy, vx);
          var sweep = dOut - dIn;
          while (sweep < -Math.PI) sweep += Math.PI * 2;
          while (sweep > Math.PI) sweep -= Math.PI * 2;
          var steps = 9;
          for (var kk = 0; kk <= steps; kk++) {
            var ang = aStart + (kk / steps) * sweep;
            pts.push([cX + Math.cos(ang) * rC, cY + Math.sin(ang) * rC]);
          }
        }
      }
      return pts;
    }
    var rad = Math.min(Math.max(0, num(sk.round, 0)), Math.min(w, h) / 2 - 0.01);
    if (sk.corner === 'chamfer' && rad > 0.02) {
      /* Chamfer: each corner cut with a flat 45-degree bevel of size rad.
         Area = w*h - 2*rad^2 (matches the shoelace area the metrics read). */
      pts.push(
        [-w / 2 + rad, -h / 2], [w / 2 - rad, -h / 2],
        [w / 2, -h / 2 + rad], [w / 2, h / 2 - rad],
        [w / 2 - rad, h / 2], [-w / 2 + rad, h / 2],
        [-w / 2, h / 2 - rad], [-w / 2, -h / 2 + rad]
      );
      return pts;
    }
    if (rad > 0.02) {
      var steps = 9;
      var corners = [
        [w / 2 - rad, -h / 2 + rad, -Math.PI / 2],
        [w / 2 - rad, h / 2 - rad, 0],
        [-w / 2 + rad, h / 2 - rad, Math.PI / 2],
        [-w / 2 + rad, -h / 2 + rad, Math.PI]
      ];
      for (var c = 0; c < corners.length; c++) {
        for (var k = 0; k <= steps; k++) {
          var a2 = corners[c][2] + (k / steps) * (Math.PI / 2);
          pts.push([corners[c][0] + Math.cos(a2) * rad, corners[c][1] + Math.sin(a2) * rad]);
        }
      }
    } else {
      pts.push([-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]);
    }
    return pts;
  }

  function polygonArea(pts) {
    var a = 0;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      var q = pts[(i + 1) % pts.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(a) / 2;
  }

  function holeRadius(hole) {
    return Math.max(0.05, num(hole.d, 8) / 2);
  }

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
      out.push('Seat dia ' + fmt(seatDia, 1) + ' mm needs hole dia \u2264 ' + fmt(seatDia - 0.2, 2) + ' mm. Next: set hole dia to at most ' + fmt(seatDia - 0.2, 2) + ' mm.');
    }
    return out;
  }

  /* Hole-to-edge clearance: distance from each hole's edge to the nearest
     sketch boundary segment. Pure 2D sketch math, no BREP claims.
     Primary number is edge-of-hole to boundary (centerDist - radius);
     a circle that crosses or sits outside the boundary is a topology
     error, not a clearance violation. */
  function pointSegDist(px, py, a, b) {
    var abx = b[0] - a[0], aby = b[1] - a[1];
    var len2 = abx * abx + aby * aby;
    var t = len2 > 0 ? Math.max(0, Math.min(1, ((px - a[0]) * abx + (py - a[1]) * aby) / len2)) : 0;
    var dx = px - (a[0] + t * abx), dy = py - (a[1] + t * aby);
    return Math.sqrt(dx * dx + dy * dy);
  }

  function pointInPolygon(px, py, pts) {
    var inside = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if (((yi > py) !== (yj > py)) &&
          (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function holeClearance(hole, minWall) {
    var pts = profilePoints(part.sketch);
    var x = num(hole.x, 0), y = num(hole.y, 0), r = holeRadius(hole);
    var d = Infinity;
    for (var i = 0; i < pts.length; i++) {
      d = Math.min(d, pointSegDist(x, y, pts[i], pts[(i + 1) % pts.length]));
    }
    var edge = d - r;
    if (!isFinite(d) || !pointInPolygon(x, y, pts) || edge < 0) {
      return { edge: edge, status: 'outside' };
    }
    if (edge < Math.max(0, num(minWall, 2))) return { edge: edge, status: 'warn' };
    return { edge: edge, status: 'ok' };
  }

  /* Hole-to-hole spacing: pairwise nominal-circle gaps across the effective
     (pattern + mirror expanded) hole list. Only the nominal hole circles are
     compared — counterbore/countersink seats are ignored, and this is not a
     mesh or ligament measurement. Returns the narrowest pair, or null when
     there are fewer than two holes to compare. */
  function holeSpacingPairs() {
    var eff = mirroredHoles();
    if (eff.length < 2) return null;
    var best = null;
    for (var i = 0; i < eff.length; i++) {
      var ri = holeRadius(eff[i]);
      var xi = num(eff[i].x, 0), yi = num(eff[i].y, 0);
      for (var j = i + 1; j < eff.length; j++) {
        var dx = num(eff[j].x, 0) - xi, dy = num(eff[j].y, 0) - yi;
        var gap = Math.sqrt(dx * dx + dy * dy) - ri - holeRadius(eff[j]);
        if (!best || gap < best.gap) best = { gap: gap, a: i, b: j };
      }
    }
    best.count = eff.length;
    return best;
  }

  /* Nearest neighbour of one hole index in the effective list, for the
     per-hole readout. Indices below part.holes.length are the same numbers
     the panel labels, so the badge can name the hole to move. */
  function holeNeighbour(idx) {
    var eff = mirroredHoles();
    if (eff.length < 2 || idx >= eff.length) return null;
    var best = null;
    var ri = holeRadius(eff[idx]);
    for (var j = 0; j < eff.length; j++) {
      if (j === idx) continue;
      var dx = num(eff[j].x, 0) - num(eff[idx].x, 0);
      var dy = num(eff[j].y, 0) - num(eff[idx].y, 0);
      var gap = Math.sqrt(dx * dx + dy * dy) - ri - holeRadius(eff[j]);
      if (!best || gap < best.gap) {
        best = {
          gap: gap,
          label: j < part.holes.length ? ('Hole ' + (j + 1)) : 'a mirrored copy'
        };
      }
    }
    return best;
  }

  function minEdgeClearance() {
    var holes = mirroredHoles();
    if (!holes.length) return null;
    var min = Infinity, any = false;
    for (var i = 0; i < holes.length; i++) {
      var c = holeClearance(holes[i], num(part.minWall, 2));
      if (c.status === 'outside') return -1; /* topology error wins */
      any = true;
      min = Math.min(min, c.edge);
    }
    return any ? min : null;
  }

  function revolveAngles() {
    var deg = Math.min(360, Math.max(0.5, num(part.revolve && part.revolve.angle, 360)));
    return deg * Math.PI / 180;
  }

  /* Sweep profile edges + hole circles around the Y axis (x -> radius). */
  function revolveGeometry(built, angleRad) {
    var steps = Math.max(6, Math.ceil(SEG * angleRad / (Math.PI * 2)));
    var positions = [];
    var indices = [];
    var cos = [], sin = [];
    for (var k = 0; k <= steps; k++) {
      var a = angleRad * k / steps;
      cos.push(Math.cos(a));
      sin.push(Math.sin(a));
    }

    function sweep(ring) {
      var s = positions.length / 3;
      for (var i = 0; i < ring.length; i++) {
        for (var k = 0; k <= steps; k++) {
          positions.push(ring[i][0] * cos[k], ring[i][1], ring[i][0] * sin[k]);
        }
      }
      for (var k = 0; k < steps; k++) {
        var i0 = s + k, i1 = s + k + 1;
        var i2 = s + ring.length * (steps + 1) + k, i3 = s + ring.length * (steps + 1) + k + 1;
        indices.push(i0, i2, i1, i1, i2, i3);
      }
    }

    var pts = built.pts;
    for (var i = 0; i < pts.length; i++) {
      sweep([pts[i], pts[(i + 1) % pts.length]]);
    }

    for (var h = 0; h < part.holes.length; h++) {
      var r = holeRadius(part.holes[h]);
      var cx = num(part.holes[h].x, 0), cy = num(part.holes[h].y, 0);
      var C = 36;
      for (var c = 0; c < C; c++) {
        var t0 = (c / C) * Math.PI * 2, t1 = ((c + 1) / C) * Math.PI * 2;
        sweep([
          [cx + Math.cos(t0) * r, cy + Math.sin(t0) * r],
          [cx + Math.cos(t1) * r, cy + Math.sin(t1) * r]
        ]);
      }
    }

    if (angleRad < Math.PI * 2 - 0.01) {
      var cap = new THREE.ShapeGeometry(built.shape, 24);
      var cp = cap.attributes.position;
      var idx = cap.index ? cap.index.array : null;
      if (!idx) {
        idx = [];
        for (var v = 0; v < cp.count; v++) idx.push(v);
      }
      for (var side = 0; side < 2; side++) {
        var a = side === 0 ? 0 : angleRad;
        var ca = Math.cos(a), sa = Math.sin(a);
        var s2 = positions.length / 3;
        for (var v = 0; v < cp.count; v++) {
          positions.push(cp.getX(v) * ca, cp.getY(v), cp.getX(v) * sa);
        }
        for (var v = 0; v < idx.length; v++) indices.push(s2 + idx[v]);
      }
      cap.dispose();
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  /* Pappus: volume = angle * integral of x over the profile face. */
  function revolveVolume(built, angleRad) {
    var pts = built.pts;
    var ix = 0;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i], q = pts[(i + 1) % pts.length];
      ix += (p[0] * p[0] + p[0] * q[0] + q[0] * q[0]) * (p[0] * q[1] - q[0] * p[1]);
    }
    ix = Math.abs(ix / 6);
    for (var h = 0; h < part.holes.length; h++) {
      var r = holeRadius(part.holes[h]);
      ix -= Math.PI * r * r * num(part.holes[h].x, 0);
    }
    return Math.max(0, ix * angleRad);
  }

  /* Signed volume of the closed mesh via the divergence theorem:
     V = (1/6) * sum over triangles of v0 . (v1 x v2). */
  function meshVolume(pos) {
    var s = 0;
    for (var i = 0; i + 2 < pos.count; i += 3) {
      var ax = pos.getX(i), ay = pos.getY(i), az = pos.getZ(i);
      var bx = pos.getX(i + 1), by = pos.getY(i + 1), bz = pos.getZ(i + 1);
      var cx = pos.getX(i + 2), cy = pos.getY(i + 2), cz = pos.getZ(i + 2);
      var c1 = by * cz - bz * cy;
      var c2 = bz * cx - bx * cz;
      var c3 = bx * cy - by * cx;
      s += ax * c1 + ay * c2 + az * c3;
    }
    return Math.abs(s) / 6;
  }


  /* Counterbore / countersink seat helpers. A hole may carry
     hole.seat = { type: 'cbore'|'csink', dia, depth } (angle fixed 90 deg;
     depth ignored for csink — the cone runs from dia down to the hole over
     (dia - d) / 2 of depth). Seats only affect the extruded mesh; the
     revolve feature ignores them. */

  /* Build the extruded solid for parts with seated holes by stacking flat
     slabs between consecutive cut levels. Each slab is the profile with
     through-holes of radius r(z) at that level; merging consecutive slabs
     reproduces the stepped counterbore / conical countersink. Coincident
     internal faces between slabs cancel in the divergence-theorem volume
     sum and in the STL watertightness check. */
  function seatedExtrudeGeometry(built, holes, depth) {
    var top = depth / 2;
    var levels = {};
    var any = false;
    for (var h = 0; h < holes.length; h++) {
      var lv = holeCutLevels(holes[h], depth);
      if (!lv) continue;
      any = true;
      for (var i = 0; i < lv.length; i++) {
        var z = lv[i].z;
        if (levels[z] === undefined) levels[z] = [];
        levels[z].push(lv[i]);
      }
    }
    if (!any) return null;
    /* per-hole cut boundaries: [ { z, r } ] top→bottom, hole-tagged.
       Each boundary list is reduced to constant-radius segments (skipping
       zero-thickness step pairs); a slab gets the min radius of the
       segments it overlaps, so countersink slabs cut the mid taper. */
    var perHole = [];
    for (var hp = 0; hp < holes.length; hp++) {
      var lh = holeCutLevels(holes[hp], depth);
      if (!lh) {
        /* plain through-hole: constant radius across the whole solid */
        perHole[hp] = [{ top: depth / 2, bot: -depth / 2, r: holeRadius(holes[hp]) }];
        continue;
      }
      var segs = [];
      for (var si = 0; si < lh.length - 1; si++) {
        var zA = lh[si].z, zB = lh[si + 1].z;
        if (zA - zB < 1e-6) continue;              /* step pair, zero thick */
        segs.push({ top: zA, bot: zB, r: (lh[si].r + lh[si + 1].r) / 2 });
      }
      perHole[hp] = segs;
    }
    var zsSet = {};
    for (var hp2 = 0; hp2 < perHole.length; hp2++) {
      if (!perHole[hp2]) continue;
      for (var li = 0; li < perHole[hp2].length; li++) {
        zsSet[perHole[hp2][li].top.toFixed(5)] = true;
        zsSet[perHole[hp2][li].bot.toFixed(5)] = true;
      }
    }
    var zs = Object.keys(zsSet).map(Number).sort(function (a, b) { return b - a; });
    var geos = [];
    for (var s = 0; s < zs.length - 1; s++) {
      var zTop = zs[s], zBot = zs[s + 1];
      var thick = zTop - zBot;
      if (thick < 1e-6) continue;
      var shape = new THREE.Shape(built.pts.map(function (q) { return new THREE.Vector2(q[0], q[1]); }));
      for (var h2 = 0; h2 < perHole.length; h2++) {
        var segs2 = perHole[h2];
        if (!segs2 || !segs2.length) continue;
        var rr = Infinity;
        for (var j = 0; j < segs2.length; j++) {
          if (segs2[j].bot >= zTop - 1e-6 || segs2[j].top <= zBot + 1e-6) continue;
          if (segs2[j].r < rr) rr = segs2[j].r;
        }
        if (!isFinite(rr)) rr = holeRadius(holes[h2]);
        var path = new THREE.Path();
        path.absarc(num(holes[h2].x, 0), num(holes[h2].y, 0), rr, 0, Math.PI * 2, true);
        shape.holes.push(path);
      }
      var g = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false, curveSegments: 24, steps: 1 });
      g.translate(0, 0, zBot + thick / 2);
      geos.push(g);
    }
    var merged = geos[0];
    for (var k = 1; k < geos.length; k++) {
      merged = mergeGeoms(merged, geos[k]);
      geos[k].dispose();
    }
    return merged;
  }

  /* Minimal non-indexed geometry merge (both inputs are non-indexed
     ExtrudeGeometry outputs from the same THREE build). */
  function mergeGeoms(a, b) {
    function toNonIndexed(g) {
      return g.index ? g.toNonIndexed() : g;
    }
    var ga = toNonIndexed(a), gb = toNonIndexed(b);
    var pa = ga.attributes.position.array, pb = gb.attributes.position.array;
    var out = new Float32Array(pa.length + pb.length);
    out.set(pa, 0); out.set(pb, pa.length);
    var merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(out, 3));
    merged.computeVertexNormals();
    return merged;
  }

  function holeSeat(hole) {
    var s = hole && hole.seat;
    if (!s || (s.type !== 'cbore' && s.type !== 'csink')) return null;
    var r = holeRadius(hole);
    var dia = Math.max(r * 2 + 0.2, num(s.dia, 0));
    if (dia <= r * 2 + 0.19) return null;
    if (s.type === 'cbore') {
      var depth = Math.min(1000, Math.max(0.1, num(s.depth, 0)));
      return { type: 'cbore', dia: dia, r: dia / 2, depth: depth };
    }
    return { type: 'csink', dia: dia, r: dia / 2, depth: (dia / 2 - r) };
  }

  /* Cosmetic thread callout on a hole: hole.thread = { designation, through,
     depth }. Purely an annotation (like a cosmetic thread) — it
     changes no geometry. Returns a normalized object or null when absent. */
  function holeThread(hole) {
    var t = hole && hole.thread;
    if (!t || typeof t !== 'object') return null;
    var des = String(t.designation == null ? '' : t.designation).trim().slice(0, 24);
    if (!des) return null;
    var through = !!t.through;
    var depth = through ? null : Math.min(2000, Math.max(0.1, num(t.depth, 0)));
    return { designation: des, through: through, depth: depth };
  }

  function threadCallout(thread) {
    if (!thread) return '';
    return thread.designation + (thread.through ? ' THRU' : ' ' + fmt(thread.depth, 1) + ' DEEP');
  }

  /* Cut levels for one hole (z measured from mid-plane, extrusion spans
     -depth/2 .. +depth/2 with +z toward the top face). Returns sorted unique
     cut boundaries clamped to the solid so layered extrusion can slice it:
     [ {z, r} ] from top to bottom describing the hole radius at each level. */
  function holeCutLevels(hole, depth) {
    var seat = holeSeat(hole);
    var top = depth / 2, bot = -depth / 2;
    if (!seat) return null;
    var r = holeRadius(hole);
    if (seat.type === 'cbore') {
      /* clamp a too-deep seat just above the bottom face instead of
         dropping the hole entirely */
      var dpt = Math.min(seat.depth, depth - 0.1);
      var zSeat = top - dpt;
      return [
        { z: top, r: seat.r },
        { z: zSeat, r: seat.r },
        { z: zSeat, r: r },
        { z: bot, r: r }
      ];
    }
    /* countersink: 90 deg cone from seat.r down to r over seat.depth.
       Subdivide the cone into rings so the layered extrusion approximates
       the taper instead of cutting a straight cylinder. */
    var dpt2 = Math.min(seat.depth, depth - 0.1);
    var steps = Math.min(12, Math.max(3, Math.ceil((seat.r - r) / 0.5)));
    var lv = [];
    for (var s = 0; s <= steps; s++) {
      var f = s / steps;
      lv.push({ z: top - dpt2 * f, r: seat.r + (r - seat.r) * f });
    }
    lv.push({ z: bot, r: r });
    return lv;
  }

  /* Inward offset of a polygon by `off` (miter joins). The profile is
     CCW, so the interior is left of travel: the inward normal of edge
     (a→b) is rotate90(b-a) normalized. Returns null when the wall
     thickness is too large for the profile (offset self-intersects the
     centroid region or reverses). */
  function offsetPolygonInner(pts, off) {
    if (!pts || pts.length < 3 || !(off > 0.02)) return null;
    var out = [];
    var n = pts.length;
    for (var i = 0; i < n; i++) {
      var a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
      var e1x = b[0] - a[0], e1y = b[1] - a[1];
      var e2x = c[0] - b[0], e2y = c[1] - b[1];
      var l1 = Math.hypot(e1x, e1y), l2 = Math.hypot(e2x, e2y);
      if (l1 < 1e-9 || l2 < 1e-9) return null;
      /* inward normals of CCW polygon edges */
      var n1x = -e1y / l1, n1y = e1x / l1;
      var n2x = -e2y / l2, n2y = e2x / l2;
      /* miter bisector */
      var mx = n1x + n2x, my = n1y + n2y;
      var ml = Math.hypot(mx, my);
      if (ml < 1e-9) { mx = n2x; my = n2y; ml = 1; }
      var sinHalf = ml / 2; /* sin of half the turn angle between normals */
      var dist = off / Math.max(0.15, sinHalf);
      if (dist > 1e6) return null;
      out.push([b[0] + mx / ml * dist, b[1] + my / ml * dist]);
    }
    /* validity: offset area must be positive and smaller than the source,
       and every offset vertex must land inside the source polygon */
    var a0 = polygonArea(pts);
    var a1 = polygonArea(out);
    if (!(a1 > 0.02) || a1 >= a0) return null;
    for (var k = 0; k < out.length; k++) {
      var hit = false;
      for (var e = 0, j = pts.length - 1; e < pts.length; j = e++) {
        var p = pts[e], q = pts[j];
        if ((p[1] > out[k][1]) !== (q[1] > out[k][1]) &&
            out[k][0] < (q[0] - p[0]) * (out[k][1] - p[1]) / (q[1] - p[1]) + p[0]) hit = !hit;
      }
      if (!hit) return null;
      /* every offset vertex must still be at least `off` away from every
         source edge segment (clamped) — rejects degenerate self-inverting
         insets when the offset exceeds the inradius */
      for (var e2 = 0, j2 = pts.length - 1; e2 < pts.length; j2 = e2++) {
        var p2 = pts[e2], q2 = pts[j2];
        var ex = q2[0] - p2[0], ey = q2[1] - p2[1];
        var el2 = ex * ex + ey * ey;
        if (el2 < 1e-12) continue;
        var t = ((out[k][0] - p2[0]) * ex + (out[k][1] - p2[1]) * ey) / el2;
        t = Math.max(0, Math.min(1, t));
        var dx = out[k][0] - (p2[0] + ex * t), dy = out[k][1] - (p2[1] + ey * t);
        if (Math.hypot(dx, dy) < off - 0.05) return null;
      }
    }
    return out;
  }

  function shellWall() {
    /* wall fits inside the profile: keep it under half the min sketch
       dimension, minus clearance for the offset validity check */
    var s = part.sketch;
    var lim = Math.max(0.15, Math.min(s.width, s.height) / 2 - 0.3);
    return Math.min(Math.max(0.1, num(part.shell && part.shell.wall, 2)), lim);
  }

  function buildShape() {
    var pts = profilePoints(part.sketch);
    var v2 = pts.map(function (p) { return new THREE.Vector2(p[0], p[1]); });
    var shape = new THREE.Shape(v2);
    var holeArea = 0;
    var cutHoles = mirroredHoles();
    var shelling = part.feature === 'extrude' && part.shell && part.shell.on;
    var wall = shelling ? shellWall() : 0;
    for (var i = 0; i < cutHoles.length; i++) {
      var hole = cutHoles[i];
      var r = holeRadius(hole);
      if (shelling) r += wall; /* drilled holes pierce the added wall too */
      var path = new THREE.Path();
      path.absarc(num(hole.x, 0), num(hole.y, 0), r, 0, Math.PI * 2, true);
      shape.holes.push(path);
      holeArea += Math.PI * r * r;
    }
    if (shelling) {
      /* uniform cavity: an inner offset ring as one more hole. The cavity
         merges with grown through-holes so the result reads as one hollow
         solid; if the offset is invalid (wall too thick), skip silently. */
      var inner = offsetPolygonInner(pts, wall);
      if (inner) {
        var cav = new THREE.Path();
        for (var c = 0; c < inner.length; c++) {
          if (c === 0) cav.moveTo(inner[c][0], inner[c][1]);
          else cav.lineTo(inner[c][0], inner[c][1]);
        }
        cav.closePath();
        shape.holes.push(cav);
      }
    }
    return { shape: shape, pts: pts, holeArea: holeArea, shell: shelling && !!inner ? wall : 0 };
  }

  var mesh = null;
  var edgeLines = null;
  var metrics = null;
  var sectionPlane = null;
  var pushPullMode = false;
  var pushPullPreview = null;
  var pushPullSelection = null;
  var pushPullCoachDismissed = false;
  var pushPullCoachKey = 'websolid.pushPullCoachDismissed.v1';
  var orientationDismissed = false;
  var orientationKey = 'websolid.orientationDismissed.v1';
  try { orientationDismissed = window.localStorage.getItem(orientationKey) === '1'; } catch (e) {}
  try { pushPullCoachDismissed = window.localStorage.getItem(pushPullCoachKey) === '1'; } catch (e) {}
  var measurePreview = null;
  var measureMode = false;
  var pushPullsDiscardedOnFeatureChange = false;
  var pushPullsDiscardedOnReplay = false;

  var SECTION_AXES = {
    x: new THREE.Vector3(1, 0, 0),
    y: new THREE.Vector3(0, 1, 0),
    z: new THREE.Vector3(0, 0, 1)
  };

  // Keep the material on the low side of the axis (axisCoord < offset).
  // localClippingEnabled only exists on the WebGL renderer; the software
  // fallback simply ignores section (documented limitation).
  function updateSection() {
    if (!renderer || !mesh) return;
    renderer.localClippingEnabled = view.section;
    var planes = [];
    if (view.section) {
      var dir = SECTION_AXES[view.sectionAxis] || SECTION_AXES.y;
      var bb = new THREE.Box3().setFromBufferAttribute(mesh.geometry.attributes.position);
      var mn = dir.x ? bb.min.x : dir.y ? bb.min.y : bb.min.z;
      var mx = dir.x ? bb.max.x : dir.y ? bb.max.y : bb.max.z;
      var off = mn + (mx - mn) * view.sectionOffset;
      if (mx - mn < 1e-9) off = mn;
      if (!sectionPlane) sectionPlane = new THREE.Plane(new THREE.Vector3(), 0);
      sectionPlane.setFromNormalAndCoplanarPoint(dir.clone().negate(), dir.clone().multiplyScalar(off));
      planes = [sectionPlane];
    }
    if (mesh.material.clippingPlanes !== undefined) {
      mesh.material.clippingPlanes = planes;
      mesh.material.needsUpdate = true;
    }
    if (edgeLines && edgeLines.material.clippingPlanes !== undefined) {
      edgeLines.material.clippingPlanes = planes;
      edgeLines.material.needsUpdate = true;
    }
  }

  // Per-side volume after the cut: integrate the closed sub-solid that stays
  // on the kept side (fragment triangles + cut-face caps) using signed tetra
  // volumes to the origin. Works for extrude and revolve.
  function sectionVolume() {
    if (!mesh || !view.section) return null;
    var dir = SECTION_AXES[view.sectionAxis] || SECTION_AXES.y;
    // Keep the low side of the axis, exactly like updateSection(). Compute the
    // plane offset from the mesh bounds so the volume works in both the WebGL
    // renderer and the canvas2d fallback (where sectionPlane stays null).
    var bbv = new THREE.Box3().setFromBufferAttribute(mesh.geometry.attributes.position);
    var bmn = dir.x ? bbv.min.x : dir.y ? bbv.min.y : bbv.min.z;
    var bmx = dir.x ? bbv.max.x : dir.y ? bbv.max.y : bbv.max.z;
    var cut = bmn + (bmx - bmn) * view.sectionOffset;
    if (bmx - bmn < 1e-9) cut = bmn;
    var keep = function (p) {
      return dir.x * p.x + dir.y * p.y + dir.z * p.z <= cut + 1e-9;
    };
    var pos = mesh.geometry.attributes.position;
    var index = mesh.geometry.index;
    var tri = function (i) {
      if (index) return [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
      var base = i * 3;
      return [base, base + 1, base + 2];
    };
    var getV = function (idx) {
      return new THREE.Vector3(pos.getX(idx), pos.getY(idx), pos.getZ(idx));
    };
    var vol = 0;
    var polys = [], segs = [];
    var n = index ? index.count / 3 : pos.count / 3;
    var P0 = new THREE.Vector3(), P1 = new THREE.Vector3(), P2 = new THREE.Vector3();
    var tet = function (a, b, c) {
      var cx = b.y * c.z - b.z * c.y, cy = b.z * c.x - b.x * c.z, cz = b.x * c.y - b.y * c.x;
      return (a.x * cx + a.y * cy + a.z * cz) / 6;
    };
    for (var i = 0; i < n; i++) {
      var ids = tri(i);
      P0.copy(getV(ids[0])); P1.copy(getV(ids[1])); P2.copy(getV(ids[2]));
      var s0 = keep(P0), s1 = keep(P1), s2 = keep(P2);
      var ks = (s0 ? 1 : 0) + (s1 ? 1 : 0) + (s2 ? 1 : 0);
      if (ks === 3) {
        vol += tet(P0, P1, P2);
      } else if (ks === 0) {
        // fully removed
      } else {
        // clip triangle to kept half-space, then fan-triangulate fragment + cap
        var pts = [P0, P1, P2];
        var cls = [s0, s1, s2];
        var frag = [], cappts = [];
        for (var k = 0; k < 3; k++) {
          var a = pts[k], b = pts[(k + 1) % 3];
          if (cls[k]) frag.push(a.clone());
          if (cls[k] !== cls[(k + 1) % 3]) {
            var da = cut - (dir.x * a.x + dir.y * a.y + dir.z * a.z);
            var db = cut - (dir.x * b.x + dir.y * b.y + dir.z * b.z);
            var t = da / (da - db);
            var ip = new THREE.Vector3().copy(a).lerp(b, t);
            frag.push(ip);
            cappts.push(ip);
          }
        }
        if (frag.length >= 3) polys.push(frag);
        if (cappts.length === 2) segs.push(cappts);
      }
    }
    // Chain cap segments into closed loops (handles holes / concave profiles),
    // then sum every fragment and cap as a signed tetrahedral fan. The kept
    // side is below the plane, so an outward cap normal points along +dir.
    var key = function (p) {
      return p.x.toFixed(4) + ',' + p.y.toFixed(4) + ',' + p.z.toFixed(4);
    };
    while (segs.length) {
      var loop = [segs[0][0], segs[0][1]];
      segs.shift();
      while (true) {
        var end = key(loop[loop.length - 1]);
        var found = -1;
        for (var j = 0; j < segs.length; j++) {
          if (key(segs[j][0]) === end || key(segs[j][1]) === end) { found = j; break; }
        }
        if (found < 0) break;
        var pair = segs[found];
        var other = key(pair[0]) === end ? pair[1] : pair[0];
        segs.splice(found, 1);
        if (key(other) === key(loop[0])) { loop.push(loop[0]); break; }
        loop.push(other);
      }
      if (loop.length >= 4) {
        var lp = key(loop[0]) === key(loop[loop.length - 1]) ? loop.slice(0, loop.length - 1) : loop;
        var nx = 0, ny = 0, nz = 0;
        for (j = 0; j < lp.length; j++) {
          var a2 = lp[j], b2 = lp[(j + 1) % lp.length];
          nx += (a2.y - b2.y) * (a2.z + b2.z);
          ny += (a2.z - b2.z) * (a2.x + b2.x);
          nz += (a2.x - b2.x) * (a2.y + b2.y);
        }
        if (nx * dir.x + ny * dir.y + nz * dir.z < 0) lp = lp.slice().reverse();
        polys.push(lp);
      }
    }
    for (var k = 0; k < polys.length; k++) {
      var pg = polys[k];
      for (var j = 1; j < pg.length - 1; j++) vol += tet(pg[0], pg[j], pg[j + 1]);
    }
    return Math.abs(vol);
  }

  function findMaterial(id) {
    for (var i = 0; i < MATERIALS.length; i++) if (MATERIALS[i].id === id) return MATERIALS[i];
    return MATERIALS[0];
  }

  /* ---------------------------------------------------------------- macro
     Records every parametric edit as a labeled step so the model can be
     replayed from a clean start - like a feature macro. */

  function recordMacro(label) {
    part.macro.push({ label: String(label).slice(0, 120) });
    if (part.macro.length > 60) part.macro.shift();
    renderMacroPanel();
  }

  function renderMacroPanel() {
    var box = document.getElementById('macro-panel');
    if (!box) return;
    var steps = part.macro || [];
    var lines = ['<h2>Macro <span class="macro-count">' + steps.length + '</span></h2>'];
    if (!steps.length) {
      lines.push('<p class="hint">No steps yet. Edit a dimension and it is recorded here.</p>');
    } else {
      lines.push('<ol class="macro-list">');
      for (var i = 0; i < steps.length; i++) {
        lines.push('<li><em>' + (i + 1) + '.</em> ' + escapeHtml(steps[i].label) + '</li>');
      }
      lines.push('</ol>');
      lines.push('<div class="macro-actions">');
      lines.push('<button id="macro-copy" class="tool">Copy</button>');
      lines.push('<button id="macro-replay" class="tool">Replay</button>');
      lines.push('<button id="macro-clear" class="tool">Clear</button>');
      lines.push('</div>');
    }
    box.innerHTML = lines.join('');
    if (!steps.length) return;
    document.getElementById('macro-copy').addEventListener('click', function () {
      var txt = (part.name || 'Part') + ' — feature macro\n';
      for (var i = 0; i < steps.length; i++) txt += (i + 1) + '. ' + steps[i].label + '\n';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () { toast('Macro copied'); },
          function () { toast('Copy failed', true); });
      } else { toast('Copy failed', true); }
    });
    document.getElementById('macro-replay').addEventListener('click', function () {
      rebuild();
      renderMacroPanel();
      toast('Replayed ' + steps.length + ' steps — solid rebuilt from feature history');
    });
    document.getElementById('macro-clear').addEventListener('click', function () {
      part.macro = [];
      renderMacroPanel();
      toast('Macro cleared');
    });
  }

  /* Re-derive pattern instances from the seed hole (keeps seed spec live). */
  function patternInstances(P, seed) {
    var out = [];
    if (P.mode === 'polar') {
      var count = Math.min(24, Math.max(1, Math.round(num(P.count, 6))));
      var span = Math.min(360, Math.max(10, num(P.span, 360)));
      var px = num(P.cx, 0), py = num(P.cy, 0);
      var r = Math.max(0, num(P.radius, Math.sqrt(Math.pow(seed.x - px, 2) + Math.pow(seed.y - py, 2))));
      var a0 = Math.atan2(seed.y - py, seed.x - px);
      var step = (span >= 359.9 ? span / count : span / Math.max(1, count - 1)) * Math.PI / 180;
      var skip = {};
      if (Array.isArray(P.skip)) {
        for (var s = 0; s < P.skip.length; s++) skip[Math.round(Number(P.skip[s]))] = true;
      }
      for (var i = 1; i < count; i++) {
        if (skip[i]) continue; /* skipped polar instance (seed is instance 0) */
        var a = a0 + step * i;
        out.push({ x: px + Math.cos(a) * r, y: py + Math.sin(a) * r });
      }
      return out;
    }
    if (P.mode === 'vector') {
      var count = Math.min(24, Math.max(1, Math.round(num(P.count, 4))));
      var pitch = Math.min(500, Math.max(1, num(P.pitch, 20)));
      var dir = num(P.dir, 0) * Math.PI / 180;
      var dx = Math.cos(dir) * pitch, dy = Math.sin(dir) * pitch;
      var skip = {};
      if (Array.isArray(P.skip)) {
        for (var s = 0; s < P.skip.length; s++) skip[Math.round(Number(P.skip[s]))] = true;
      }
      for (var i = 1; i < count; i++) {
        if (skip[i]) continue; /* skipped forward instance (seed is instance 0) */
        out.push({ x: seed.x + dx * i, y: seed.y + dy * i });
      }
      if (P.twoWay) {
        var count2 = Math.min(24, Math.max(1, Math.round(num(P.count2, 4))));
        var pitch2 = Math.min(500, Math.max(1, num(P.pitch2, pitch)));
        var dx2 = Math.cos(dir) * pitch2, dy2 = Math.sin(dir) * pitch2;
        for (var j = 1; j < count2; j++) {
          if (skip[j]) continue; /* skipped reverse instance */
          out.push({ x: seed.x - dx2 * j, y: seed.y - dy2 * j });
        }
      }
      return out;
    }
    var rows = Math.min(10, Math.max(1, Math.round(num(P.rows, 1))));
    var cols = Math.min(10, Math.max(1, Math.round(num(P.cols, 1))));
    var cx = seed.x, cy = seed.y;
    if (P.centered) {
      cx = seed.x - ((cols - 1) * num(P.dx, 20)) / 2;
      cy = seed.y - ((rows - 1) * num(P.dy, 20)) / 2;
    }
    for (var rr = 0; rr < rows; rr++) {
      for (var cc = 0; cc < cols; cc++) {
        if (rr === 0 && cc === 0) continue;
        out.push({ x: cx + cc * num(P.dx, 20), y: cy + rr * num(P.dy, 20) });
      }
    }
    return out;
  }

  function applyPattern() {
    var seed = part.holes[0];
    if (!seed || !seed.pattern) return;
    var inst = patternInstances(seed.pattern, seed);
    for (var t = part.holes.length - 1; t >= 1; t--) {
      if (part.holes[t].derived && (t - 1) >= inst.length) part.holes.splice(t, 1);
    }
    var idx = 1;
    for (var k = 0; k < inst.length && idx < 24; k++) {
      if (!part.holes[idx] || !part.holes[idx].derived) part.holes[idx] = { derived: true };
      part.holes[idx].x = inst[k].x;
      part.holes[idx].y = inst[k].y;
      part.holes[idx].d = seed.d;
      if (seed.seat) part.holes[idx].seat = Object.assign({}, seed.seat);
      else delete part.holes[idx].seat;
      idx++;
    }
  }

  /* Mirror feature: derive holes mirrored about the X or Y sketch centerline.
     Holes already at (or within 0.01 mm of) the mirrored position are not
     duplicated; the profile itself is symmetric by construction. */
  function mirrorAxisAngle() {
    /* Axis line angle in degrees through the sketch origin (0 = X axis). */
    var a = num(part.mirror && part.mirror.angle, 0);
    if (!isFinite(a)) a = 0;
    return Math.min(180, Math.max(-180, a)) * Math.PI / 180;
  }

  function mirrorPoint(p, axis, angleRad) {
    if (axis === 'line') {
      var c = Math.cos(angleRad), s = Math.sin(angleRad);
      var dot = p.x * c + p.y * s;
      return { x: 2 * dot * c - p.x, y: 2 * dot * s - p.y };
    }
    return { x: axis === 'x' ? -p.x : p.x, y: axis === 'y' ? -p.y : p.y };
  }

  function mirroredHoles() {
    var axis = part.mirror && part.mirror.axis;
    if (axis !== 'x' && axis !== 'y' && axis !== 'line') return part.holes;
    var angleRad = mirrorAxisAngle();
    var out = part.holes.slice(0, 24);
    var base = part.holes.map(function (h) {
      var b = { x: num(h.x, 0), y: num(h.y, 0), d: Math.max(0.1, num(h.d, 8)) };
      if (h.seat) b.seat = h.seat;
      b.mirror = h.mirror !== false;
      return b;
    });
    for (var i = 0; i < base.length && out.length < 24; i++) {
      var h = base[i];
      if (h.mirror === false) continue; /* opted out of the mirror feature */
      var mp = mirrorPoint(h, axis, angleRad);
      var mx = mp.x, my = mp.y;
      var dup = false;
      for (var k = 0; k < base.length; k++) {
        if (Math.abs(base[k].x - mx) < 0.01 && Math.abs(base[k].y - my) < 0.01) { dup = true; break; }
      }
      if (!dup) {
        var mh = { x: mx, y: my, d: h.d, derived: true, mirrored: true };
        if (h.seat) mh.seat = h.seat;
        out.push(mh);
      }
    }
    return out;
  }

  function rebuild() {
    updateUndoButtons();
    scheduleSessionSnapshot();
    if (EQ.resolveAll) {
      var res = applyEquations();
      if (!res.ok) { var el = document.getElementById('eq-hint'); if (el) el.textContent = res.errors.slice(0, 3).join(' · '); }
    }
    if (pushPullSelection && pushPullSelection.geometryKey !== pushPullGeometryKey()) {
      pushPullSelection = null;
      clearPushPullPreview();
      setPushPullStatus('Selection expired after a geometry edit — pick the face again', true);
    }
    if (part.sketch && part.sketch.type === 'custom' && Array.isArray(part.sketch.entities)) {
      part.sketch.constraints = sanitizeConstraints(part.sketch.constraints, part.sketch.entities);
      applyConstraints(part.sketch.entities, part.sketch.constraints);
    }
    var built = buildShape();
    var isRevolve = part.feature === 'revolve';
    pushPullsDiscardedOnFeatureChange = false;
    pushPullsDiscardedOnReplay = false;
    var depth = Math.max(0.5, num(part.extrude.depth, 12));
    var baseDepth = depth;
    // Extrusion starts centered on its sketch plane. Face edits keep the
    // opposite face fixed: top moves by +d, bottom by -d.
    var ppDepth = 0, ppShift = 0;
    var requestedDepth = depth;
    if (isRevolve && (part.pushPulls || []).length) {
      part.pushPulls = [];
      pushPullsDiscardedOnFeatureChange = true;
    }
    // Replay valid features in order. Invalid/stale operations are ignored,
    // never clamped into a different shape. This bounds legacy histories too.
    var validOps = [], replayDepth = baseDepth;
    (part.pushPulls || []).forEach(function (op) {
      var d = Number(op.distance), side = Number(op.side), next = replayDepth + d;
      var sourceMatches = op && op.sourceKey === pushPullSourceKey(validOps);
      if ((side === 1 || side === -1) && sourceMatches && isFinite(d) && Math.abs(d) >= 0.01 && Math.abs(d) <= 1000 && next >= 0.5 && next <= 2000) {
        validOps.push(op); replayDepth = next;
        ppDepth += d; ppShift += side * d / 2;
        requestedDepth = replayDepth;
      }
    });
    if (validOps.length !== (part.pushPulls || []).length) {
      pushPullsDiscardedOnReplay = true;
      part.pushPulls = validOps;
    }
    depth = requestedDepth;

    var geo;
    if (isRevolve) {
      geo = revolveGeometry(built, revolveAngles());
    } else {
      var seated = false;
      if (part.shell && part.shell.on) { part.shell.wall = shellWall(); }
      var cutHolesAll = mirroredHoles();
      for (var sh = 0; sh < cutHolesAll.length; sh++) { if (holeCutLevels(cutHolesAll[sh], depth)) { seated = true; break; } }
      if (seated) {
        geo = seatedExtrudeGeometry(built, cutHolesAll, depth);
      } else {
      geo = new THREE.ExtrudeGeometry(built.shape, {
        depth: depth, bevelEnabled: false, curveSegments: 24, steps: 1
      });
      }
      geo.translate(0, 0, -depth / 2);
      if (Math.abs(ppShift) > 1e-9) geo.translate(0, 0, ppShift);
      geo.computeVertexNormals();
    }

    if (pushPullPreview) { model.remove(pushPullPreview); pushPullPreview.geometry.dispose(); pushPullPreview.material.dispose(); pushPullPreview = null; }
    if (mesh) {
      model.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    if (edgeLines) {
      model.remove(edgeLines);
      edgeLines.geometry.dispose();
      edgeLines.material.dispose();
    }

    var mat = findMaterial(part.material);
    mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: mat.color,
      metalness: mat.metal,
      roughness: mat.rough,
      wireframe: view.wire,
      side: isRevolve ? THREE.DoubleSide : THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1
    }));
    mesh.name = 'solid';
    model.add(mesh);

    edgeLines = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo, 22),
      new THREE.LineBasicMaterial({ color: 0x0b131c, transparent: true, opacity: 0.6 })
    );
    edgeLines.visible = view.edges && !view.wire;
    model.add(edgeLines);
    updateSection();

    var pos = geo.attributes.position;
    var bb = new THREE.Box3().setFromBufferAttribute(pos);
    var size = bb.getSize(new THREE.Vector3());

    var surface = 0;
    for (var i = 0; i < pos.count; i += 3) {
      var ax = pos.getX(i), ay = pos.getY(i), az = pos.getZ(i);
      var bx = pos.getX(i + 1), by = pos.getY(i + 1), bz = pos.getZ(i + 1);
      var cx = pos.getX(i + 2), cy = pos.getY(i + 2), cz = pos.getZ(i + 2);
      var ux = bx - ax, uy = by - ay, uz = bz - az;
      var vx = cx - ax, vy = cy - ay, vz = cz - az;
      var nx = uy * vz - uz * vy;
      var ny = uz * vx - ux * vz;
      var nz = ux * vy - uy * vx;
      surface += Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
    }

    var faceArea = Math.max(0, polygonArea(built.pts) - built.holeArea);
    /* Shell cavity area subtracted for the analytic fallback (the cavity is a
       hole in the shape but not part of holeArea bookkeeping). */
    var shellWallUsed = built.shell || 0;
    var analytic = isRevolve ? revolveVolume(built, revolveAngles()) : faceArea * depth;
    if (shellWallUsed > 0) {
      var innerB = offsetPolygonInner(built.pts, shellWallUsed);
      if (innerB) analytic -= polygonArea(innerB) * depth;
    }
    // Divergence theorem over the closed mesh: each triangle contributes a
    // signed tetrahedron volume (1/6 * v0 . (v1 x v2)). Exact for extrude,
    // revolve sweeps, mirror, and chamfer alike; the analytic value is the
    // fallback for degenerate geometry.
    var volumeMm3 = meshVolume(pos);
    if (!(volumeMm3 > 0)) volumeMm3 = analytic;

    metrics = {
      volumeMm3: volumeMm3,
      volumeCm3: volumeMm3 / 1000,
      massG: (volumeMm3 / 1000) * mat.density,
      areaMm2: surface,
      bbox: [size.x, size.y, size.z],
      tris: pos.count / 3,
      faceArea: faceArea,
      depth: depth,
      density: mat.density,
      minEdgeClearanceMm: part.feature === 'extrude' ? minEdgeClearance() : null
    };

    var sec = sectionVolume();
    var dir = SECTION_AXES[view.sectionAxis] || SECTION_AXES.y;
    metrics.section = view.section && sec !== null
      ? { keptMm3: sec, removedMm3: Math.max(0, volumeMm3 - sec),
          axis: view.sectionAxis,
          positionMm: null }
      : null;
    if (metrics.section) {
      var bb2 = new THREE.Box3().setFromBufferAttribute(mesh.geometry.attributes.position);
      var mn = dir.x ? bb2.min.x : dir.y ? bb2.min.y : bb2.min.z;
      var mx = dir.x ? bb2.max.x : dir.y ? bb2.max.y : bb2.max.z;
      metrics.section.positionMm = mn + (mx - mn) * view.sectionOffset;
    }
    refreshPrintStaleness();

    renderReadout(mat);
    renderCost();
    if (pushPullsDiscardedOnFeatureChange) {
      toast('Push/Pull history removed because face edits apply to extruded parts only');
      renderTree();
    } else if (pushPullsDiscardedOnReplay) {
      toast('Stale Push/Pull history removed; face identity no longer matches this part', true);
      renderTree();
    }
    buildOverlay(built.pts, depth);
    document.getElementById('part-name').textContent = part.name || 'Untitled part';
    pushUndo();
    needRender = true;
  }

  function fmt(n, digits) {
    var d = digits === undefined ? 2 : digits;
    if (!isFinite(n)) return '-';
    return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function renderCost() {
    var box = document.getElementById('cost-readout');
    if (!box || !metrics) return;
    var mat = findMaterial(part.material);
    var pk = num(part.costPrice && part.costPrice[part.material], COST.pricePerKg[part.material]);
    var est = computeCostEstimate(part, mat, metrics.volumeMm3, mirroredHoles(), pk);
    document.getElementById('cost-raw').textContent = '€ ' + fmt(est.rawMaterialCost, 2);
    document.getElementById('cost-drill').textContent =
      '€ ' + fmt(est.drillingCost, 2) + '  (' + est.holeCount + ' holes)';
    document.getElementById('cost-total').textContent = '€ ' + fmt(est.total, 2);
    document.getElementById('cost-note').textContent =
      fmt(est.pricePerKg, 2) + ' €/kg · density ' + mat.density.toFixed(2) + ' g/cm3';
    var b = est.basis;
    function setT(id, t) { var e = document.getElementById(id); if (e) e.textContent = t; }
    setT('cost-basis-volume', fmt(metrics.volumeMm3 / 1000, 2) + ' cm³');
    setT('cost-basis-material', b.materialName || b.materialId);
    setT('cost-basis-density', b.density.toFixed(2) + ' g/cm³');
    setT('cost-basis-price', fmt(b.pricePerKg, 2) + ' €/kg (' + b.priceSource + (b.priceSource === 'custom' ? ', built-in ' + fmt(b.defaultPricePerKg, 2) : '') + ')');
    setT('cost-basis-holes', String(est.holeCount));
    var flag = document.getElementById('cost-basis-flag');
    if (flag) { flag.hidden = false; flag.textContent = b.priceSource === 'custom' ? 'custom rate' : 'default rate'; flag.className = 'cost-basis-flag' + (b.priceSource === 'custom' ? ' custom' : ''); }
    var inp = document.getElementById('cost-price');
    if (inp && document.activeElement !== inp) inp.value = b.priceSource === 'custom' ? String(b.pricePerKg) : '';
    if (inp) inp.placeholder = fmt(b.defaultPricePerKg, 2);
    var rb = document.getElementById('cost-price-reset');
    if (rb) rb.disabled = b.priceSource !== 'custom';
    var assumptions = document.getElementById('cost-assumption-inputs');
    if (assumptions) assumptions.textContent =
      'Current inputs: ' + fmt(metrics.volumeMm3 / 1000, 2) + ' cm³ modeled volume; ' +
      (part.material || 'selected material') + '; ' + fmt(est.pricePerKg, 2) + ' €/kg; ' +
      est.holeCount + ' modeled hole' + (est.holeCount === 1 ? '' : 's') +
      '. The drilling component is a heuristic, not a machine-time calculation.';
  }

  function renderReadout(mat) {
    var m = metrics;
    document.getElementById('rp-vol').textContent = fmt(m.volumeMm3, 0) + ' mm3  (' + fmt(m.volumeCm3, 2) + ' cm3)';
    document.getElementById('rp-mass').textContent = fmt(m.massG, 2) + ' g  (' + fmt(m.massG / 1000, 3) + ' kg)';
    document.getElementById('rp-area').textContent = fmt(m.areaMm2, 0) + ' mm2';
    document.getElementById('rp-bbox').textContent =
      fmt(m.bbox[0], 1) + ' x ' + fmt(m.bbox[1], 1) + ' x ' + fmt(m.bbox[2], 1) + ' mm';
    document.getElementById('rp-faces').textContent = fmt(m.tris, 0) + ' triangles';
    document.getElementById('mat-note').textContent = 'Density ' + mat.density.toFixed(2) + ' g/cm3';
    var secDl = document.getElementById('sec-readout');
    if (secDl) {
      if (m.section) {
        secDl.style.display = '';
        document.getElementById('sec-pos').textContent =
          m.section.axis.toUpperCase() + ' = ' + fmt(m.section.positionMm, 1) + ' mm';
        document.getElementById('sec-kept').textContent = fmt(m.section.keptMm3, 0) + ' mm3  (' + fmt(m.section.keptMm3 / 1000, 2) + ' cm3)';
        document.getElementById('sec-rem').textContent = fmt(m.section.removedMm3, 0) + ' mm3  (' + fmt(m.section.removedMm3 / 1000, 2) + ' cm3)';
      } else {
        secDl.style.display = 'none';
      }
    }
  }

  function clearOverlay() {
    while (overlay.children.length) {
      var child = overlay.children.pop();
      overlay.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
  }

  function buildOverlay(pts, depth) {
    clearOverlay();
    if (!view.sketch) return;
    var z = depth / 2 + 0.08;

    var linePts = [];
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i];
      var b = pts[(i + 1) % pts.length];
      linePts.push(new THREE.Vector3(a[0], a[1], z), new THREE.Vector3(b[0], b[1], z));
    }
    overlay.add(new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(linePts),
      new THREE.LineBasicMaterial({ color: 0x64d2ff })
    ));

    for (var h = 0; h < part.holes.length; h++) {
      var hole = part.holes[h];
      var cx = num(hole.x, 0);
      var cy = num(hole.y, 0);
      var r = holeRadius(hole);
      var circ = [];
      for (var k = 0; k < 48; k++) {
        var ang = (k / 48) * Math.PI * 2;
        circ.push(new THREE.Vector3(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r, z));
      }
      overlay.add(new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(circ),
        new THREE.LineBasicMaterial({ color: 0xffd166 })
      ));
      var seatInfo = holeSeat(hole);
      if (seatInfo) {
        var sc = [];
        for (var sk2 = 0; sk2 < 48; sk2++) {
          var ang2 = (sk2 / 48) * Math.PI * 2;
          sc.push(new THREE.Vector3(cx + Math.cos(ang2) * seatInfo.r, cy + Math.sin(ang2) * seatInfo.r, z));
        }
        overlay.add(new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(sc),
          new THREE.LineBasicMaterial({ color: 0xffa94d })
        ));
      }
      var axis = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(cx, cy, -depth / 2 - 8),
          new THREE.Vector3(cx, cy, depth / 2 + 8)
        ]),
        new THREE.LineDashedMaterial({ color: 0xffd166, dashSize: 3, gapSize: 3, transparent: true, opacity: 0.85 })
      );
      axis.computeLineDistances();
      overlay.add(axis);
      var th = holeThread(hole);
      if (th) {
        var tr2 = r * 1.12;
        var tRing = [];
        for (var tk = 0; tk < 48; tk++) {
          var ta = (tk / 48) * Math.PI * 2;
          tRing.push(new THREE.Vector3(cx + Math.cos(ta) * tr2, cy + Math.sin(ta) * tr2, z));
        }
        overlay.add(new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(tRing),
          new THREE.LineDashedMaterial({ color: 0x7cf29b, dashSize: 2, gapSize: 2, transparent: true, opacity: 0.9 })
        ));
      }
    }

    /* Driving dimension overlays: amber leader lines + value labels. */
    if (part.sketch && part.sketch.type === 'custom' && Array.isArray(part.sketch.dims)) {
      var ents = part.sketch.entities || [];
      part.sketch.dims.forEach(function (dim) {
        var ent = ents[dim.entIdx];
        if (!ent) return;
        var ax, ay, bx, by;
        if (ent.kind === 'arc') {
          ax = ent.cx; ay = ent.cy;
          bx = ent.cx + Math.cos((ent.a0 + ent.a1) / 2) * ent.r;
          by = ent.cy + Math.sin((ent.a0 + ent.a1) / 2) * ent.r;
        } else {
          ax = ent.x1; ay = ent.y1; bx = ent.x2; by = ent.y2;
        }
        var mx = (ax + bx) / 2, my = (ay + by) / 2;
        var off = 6;
        var lx = mx, ly = my + off;
        overlay.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(ax, ay, z), new THREE.Vector3(bx, by, z)
          ]),
          new THREE.LineBasicMaterial({ color: 0xffd166 })
        ));
        var label = makeTextSprite(dim.value.toFixed(1) + ' mm');
        label.position.set(lx, ly, z + 0.02);
        overlay.add(label);
      });
    }
    if (part.sketch && part.sketch.type === 'custom' && Array.isArray(part.sketch.constraints)) {
      var cents = part.sketch.entities || [];
      part.sketch.constraints.forEach(function (c) {
        var ent = cents[c.entIdx];
        if (!ent) return;
        var mx = ent.kind === 'arc' ? ent.cx : (ent.x1 + ent.x2) / 2;
        var my = ent.kind === 'arc' ? ent.cy - ent.r - 4 : (ent.y1 + ent.y2) / 2 - 5;
        var tag = c.type === 'horizontal' ? 'H' : c.type === 'vertical' ? 'V' : ('=' + (c.refIdx + 1));
        var sp = makeTextSprite('[' + tag + ']');
        sp.position.set(mx, my, z + 0.02);
        overlay.add(sp);
      });
    }
  }


  /* ----------------------------------------------------------- interaction */

  var dragging = false;
  var panning = false;
  var lastX = 0;
  var lastY = 0;
  var pointerDownX = 0, pointerDownY = 0;
  var needRender = true;

  // Orbit/pan/zoom always attach to whichever canvas is on screen.
  var el = renderer ? renderer.domElement : canvas2d;

  /* Sketch drag-editing: hit-test entity handles on the sketch plane and
     move them while dragging. Sketch coordinates map directly to world x/y
     on the overlay plane at z = depth/2 + 0.08. */
  var sketchDrag = null;

  function pointerToSketch(e) {
    var rect = el.getBoundingClientRect();
    var ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    var ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    var zPlane = Math.max(0, (part.extrude.depth || 0) / 2) + 0.08;
    var t = (zPlane - ray.ray.origin.z) / ray.ray.direction.z;
    if (!isFinite(t) || t < 0) return null;
    return { x: ray.ray.origin.x + ray.ray.direction.x * t,
             y: ray.ray.origin.y + ray.ray.direction.y * t };
  }

  function pickEntityHandle(e) {
    if (!view.sketch || !part.sketch || part.sketch.type !== 'custom') return null;
    var ents = part.sketch.entities;
    if (!Array.isArray(ents) || !ents.length) return null;
    var p = pointerToSketch(e);
    if (!p) return null;
    var tol = Math.max(3, cam.dist * 0.02);
    var best = null, bestD = tol;
    function consider(entIdx, handle, hx, hy) {
      var d = Math.hypot(p.x - hx, p.y - hy);
      if (d < bestD) { bestD = d; best = { entIdx: entIdx, handle: handle, ent: ents[entIdx] }; }
    }
    for (var i = 0; i < ents.length; i++) {
      var en = ents[i];
      if (en.kind === 'arc') {
        consider(i, 'start', en.cx + Math.cos(en.a0) * en.r, en.cy + Math.sin(en.a0) * en.r);
        consider(i, 'end', en.cx + Math.cos(en.a1) * en.r, en.cy + Math.sin(en.a1) * en.r);
        consider(i, 'center', en.cx, en.cy);
      } else {
        consider(i, 'start', en.x1, en.y1);
        consider(i, 'end', en.x2, en.y2);
      }
    }
    return best;
  }

  el.addEventListener('pointerdown', function (e) {
    var hit = pickEntityHandle(e);
    if (hit) { sketchDrag = hit; return; }
    pointerDownX = e.clientX; pointerDownY = e.clientY;
    dragging = true;
    panning = e.shiftKey || e.button === 2;
    lastX = e.clientX;
    lastY = e.clientY;
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener('pointerup', function (e) {
    if (sketchDrag) {
      recordMacro('Sketch1 entity edited on canvas');
      sketchDrag = null;
      renderSketchFields();
      renderTree();
      rebuild();
      needRender = true;
      return;
    }
    if (measureMode && Math.hypot(e.clientX - pointerDownX, e.clientY - pointerDownY) < 5) recordMeasureFace(e);
    else if (pushPullMode && Math.hypot(e.clientX - pointerDownX, e.clientY - pointerDownY) < 5) pickPushPullFace(e);
    dragging = false;
    panning = false;
    try { el.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });

  el.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  el.addEventListener('pointermove', function (e) {
    if (sketchDrag) {
      var sp = pointerToSketch(e);
      if (sp) {
        var se = sketchDrag.ent;
        var snx = snap(sp.x), sny = snap(sp.y);
        if (sketchDrag.handle === 'center') {
          se.cx = snx; se.cy = sny;
        } else if (se.kind === 'arc') {
          var ra = Math.max(0.5, Math.hypot(snx - se.cx, sny - se.cy));
          se.r = Math.round(ra * 2) / 2;
          se[sketchDrag.handle === 'start' ? 'a0' : 'a1'] = Math.atan2(sny - se.cy, snx - se.cx);
        } else {
          se[sketchDrag.handle === 'start' ? 'x1' : 'x2'] = snx;
          se[sketchDrag.handle === 'start' ? 'y1' : 'y2'] = sny;
        }
        rebuild();
        needRender = true;
      }
      return;
    }
    if (!dragging) return;
    var dx = e.clientX - lastX;
    var dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    if (panning) {
      var scale = cam.dist * 0.0016;
      var right = new THREE.Vector3();
      var up = new THREE.Vector3();
      camera.getWorldDirection(right);
      right.cross(camera.up).normalize();
      up.copy(camera.up).normalize();
      cam.target.addScaledVector(right, -dx * scale);
      cam.target.addScaledVector(up, dy * scale);
    } else {
      cam.theta -= dx * 0.008;
      cam.phi = Math.min(Math.PI - 0.05, Math.max(0.05, cam.phi - dy * 0.008));
    }
    applyCamera();
    needRender = true;
  });

  el.addEventListener('wheel', function (e) {
    e.preventDefault();
    var factor = Math.exp(e.deltaY * 0.0012);
    cam.dist = Math.min(3000, Math.max(20, cam.dist * factor));
    applyCamera();
    needRender = true;
  }, { passive: false });

  function syncPushPullCoach() {
    var coach = document.getElementById('pushpull-coach');
    if (coach) coach.hidden = !pushPullMode || pushPullCoachDismissed;
  }

  function setOrientationVisible(visible) {
    var panel = document.getElementById('orientation-strip');
    var show = document.getElementById('orientation-show');
    if (panel) panel.hidden = !visible;
    if (show) show.hidden = visible;
  }

  function dismissOrientation() {
    orientationDismissed = true;
    try { window.localStorage.setItem(orientationKey, '1'); } catch (e) {}
    setOrientationVisible(false);
  }

  function dismissPushPullCoach() {
    pushPullCoachDismissed = true;
    try { window.localStorage.setItem(pushPullCoachKey, '1'); } catch (e) {}
    syncPushPullCoach();
  }

  function togglePushPull() {
    if (!pushPullMode) closeMeasure();
    pushPullMode = !pushPullMode;
    var panel = document.getElementById('pushpull-panel');
    panel.hidden = !pushPullMode;
    syncPushPullCoach();
    document.getElementById('btn-pushpull').classList.toggle('active', pushPullMode);
    el.style.cursor = pushPullMode ? 'crosshair' : '';
    pushPullSelection = null;
    clearPushPullPreview(); closeMeasure();
    setPushPullStatus(pushPullMode ? 'Click a top or bottom planar face' : 'Choose a planar face', true);
  }

  function setPushPullStatus(text, bad) {
    var s = document.getElementById('pushpull-status');
    if (s) { s.textContent = text; s.classList.toggle('error', !!bad); }
    var apply = document.getElementById('pushpull-apply');
    var d = Number(document.getElementById('pushpull-distance').value);
    if (apply) apply.disabled = !pushPullSelection || !isFinite(d) || Math.abs(d) < 0.01 || Math.abs(d) > 1000;
  }

  // Face identity is deliberately conservative: any upstream geometry edit
  // invalidates the pick instead of silently applying it to a different face.
  function pushPullSourceKey(operations, sourcePart) {
    var base = sourcePart || part;
    return JSON.stringify({ feature: base.feature, sketch: base.sketch, extrude: base.extrude,
      holes: base.holes, mirror: base.mirror, pushPulls: operations || [] });
  }

  function pushPullGeometryKey() {
    return pushPullSourceKey(part.pushPulls || []);
  }

  // A valid planar end face must be one connected region: every through-hole
  // stays strictly inside the profile and holes do not touch/overlap. Use the
  // same polygonal profile as the mesh, with a small clearance tolerance.
  function pushPullFaceTopologyIsSafe() {
    var pts = profilePoints(part.sketch);
    var holes = mirroredHoles();
    var inside = function (x, y) {
      var hit = false;
      for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        var a = pts[i], b = pts[j];
        if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
      }
      return hit;
    };
    for (var h = 0; h < holes.length; h++) {
      var hole = holes[h], x = num(hole.x, 0), y = num(hole.y, 0), r = holeRadius(hole);
      if (!inside(x, y)) return false;
      for (var e = 0; e < pts.length; e++) {
        var a = pts[e], b = pts[(e + 1) % pts.length];
        var dx = b[0] - a[0], dy = b[1] - a[1];
        var t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        if (Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy)) <= r + 0.02) return false;
      }
      for (var k = 0; k < h; k++) {
        var prev = holes[k];
        if (Math.hypot(x - num(prev.x, 0), y - num(prev.y, 0)) <= r + holeRadius(prev) + 0.02) return false;
      }
    }
    return true;
  }

  function pushPullSelectionIsCurrent() {
    if (!pushPullSelection) return false;
    if (pushPullSelection.geometryKey === pushPullGeometryKey()) return true;
    pushPullSelection = null;
    clearPushPullPreview();
    setPushPullStatus('Selection expired after a geometry edit — pick the face again', true);
    return false;
  }

  function clearPushPullPreview() {
    if (!pushPullPreview) return;
    model.remove(pushPullPreview);
    pushPullPreview.geometry.dispose(); pushPullPreview.material.dispose();
    pushPullPreview = null; needRender = true;
  }

  function clearMeasurePreview() {
    if (!measurePreview) return;
    model.remove(measurePreview);
    measurePreview.geometry.dispose(); measurePreview.material.dispose();
    measurePreview = null; needRender = true;
  }

  function pointSegDist3D(p, a, b) {
    var abx=b[0]-a[0], aby=b[1]-a[1], abz=b[2]-a[2];
    var len2=abx*abx+aby*aby+abz*abz;
    var t=0;
    if (len2>0) t=Math.max(0, Math.min(1, ((p[0]-a[0])*abx + (p[1]-a[1])*aby + (p[2]-a[2])*abz)/len2));
    return Math.hypot(p[0]-(a[0]+t*abx), p[1]-(a[1]+t*aby), p[2]-(a[2]+t*abz));
  }

  /* Smart measure: click two faces on the solid, raycast to collect exact
     surface sample points on each, then report min/mean/max point-to-face
     distances. MVP scope: the planar z-normal top/bottom faces (the same
     faces Push/Pull accepts). */
  var measureClicks = [];

  function measureFaceSamplingPoints(sideKey) {
    var pos = mesh.geometry.attributes.position, idx = mesh.geometry.index;
    var get = function(i){ return [pos.getX(i), pos.getY(i), pos.getZ(i)]; };
    var pts = [];
    for (var t = 0; t < idx.count; t += 3) {
      var a = get(idx.getX(t)), b = get(idx.getX(t+1)), c = get(idx.getX(t+2));
      var zA=a[2], zB=b[2], zC=c[2];
      var isZ = sideKey==='top' ? (zA>0.001 && zB>0.001 && zC>0.001)
                               : (zA<-0.001 && zB<-0.001 && zC<-0.001);
      if (!isZ) continue;
      var eps = 1e-9;
      var avgZ = (zA+zB+zC)/3;
      var _ = eps; // keep eps referenced
      var sample = [ (a[0]+b[0]+c[0])/3, (a[1]+b[1]+c[1])/3, avgZ ];
      var dedupKey = sample[0].toFixed(4)+','+sample[1].toFixed(4)+','+sample[2].toFixed(4);
      pts.push({ key: dedupKey, p: sample });
    }
    var seen = {}; var out = [];
    for (var k = 0; k < pts.length; k++) { if (!seen[pts[k].key]) { seen[pts[k].key]=1; out.push(pts[k].p); } }
    return out;
  }

  function computeFaceMeasure(aKey, bKey) {
    var A = measureFaceSamplingPoints(aKey), B = measureFaceSamplingPoints(bKey);
    if (!A.length || !B.length) return null;
    var min = Infinity, max = 0, sum = 0;
    for (var i = 0; i < A.length; i++) {
      var d = Infinity;
      for (var j = 0; j < B.length; j++) d = Math.min(d, pointSegDist3D(A[i], B[j], B[(j+1)%B.length]));
      min = Math.min(min, d); max = Math.max(max, d); sum += d;
    }
    return { min: min, mean: sum / A.length, max: max };
  }

  function measureFaceZBound(sideKey) {
    var pos = mesh.geometry.attributes.position;
    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < pos.count; i++) { lo = Math.min(lo, pos.getZ(i)); hi = Math.max(hi, pos.getZ(i)); }
    return sideKey==='top' ? hi : lo;
  }

  function updateMeasurePreview() {
    clearMeasurePreview();
    if (!measureClicks || measureClicks.length !== 2) return;
    try {
      var a = measureClicks[0], b = measureClicks[1];
      var pa = measureFaceSamplingPoints(a), pb = measureFaceSamplingPoints(b);
      var both = pa.concat(pb);
      if (!both.length) return;
      var pts = [];
      for (var i = 0; i < both.length; i++) {
        var z = both[i][2];
        pts.push(both[i][0], both[i][1], z + (z > 0 ? 0.15 : -0.15));
      }
      var geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
      var idxArr = [];
      for (var k = 0; k < both.length; k++) idxArr.push(k);
      geom.setIndex(idxArr);
      measurePreview = new THREE.Points(geom, new THREE.PointsMaterial({ color: 0x64d2ff, size: 3, sizeAttenuation: false }));
      model.add(measurePreview); needRender = true;
    } catch (err) { /* keep silent; preview is best effort */ }
  }

  function recordMeasureFace(event) {
    if (!mesh) return;
    var rect = el.getBoundingClientRect();
    var pointer = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    var ray = new THREE.Raycaster(); ray.setFromCamera(pointer, camera);
    var hits = ray.intersectObject(mesh, false);
    if (!hits.length || !hits[0].face) { setPushPullStatus('Measure: no face hit — click the solid', true); return; }
    var n = hits[0].face.normal.clone().transformDirection(mesh.matrixWorld);
    if (Math.abs(n.z) < 0.995) { setPushPullStatus('Measure MVP supports the planar top and bottom faces only', true); return; }
    var key = n.z > 0 ? 'top' : 'bottom';
    if (measureClicks.length >= 2) measureClicks = [];
    measureClicks.push(key);
    setPushPullStatus('Measure: ' + measureClicks.join(' + ') + ' face selected', false);
    updateMeasurePreview();
    if (measureClicks.length === 2) {
      var m = computeFaceMeasure(measureClicks[0], measureClicks[1]);
      if (m) {
        setPushPullStatus('Measure ' + measureClicks[0] + '↔' + measureClicks[1] +
          ': min ' + fmt(m.min, 2) + ' · mean ' + fmt(m.mean, 2) + ' · max ' + fmt(m.max, 2) + ' mm', false);
      } else {
        setPushPullStatus('Measure: could not sample both faces', true);
      }
    }
  }

  function closeMeasure() {
    measureMode = false; measureClicks = []; clearMeasurePreview();
    var btn = document.getElementById('btn-measure');
    if (btn) btn.classList.remove('active');
    el.style.cursor = '';
  }

  function toggleMeasure() {
    measureMode = !measureMode;
    var btn = document.getElementById('btn-measure');
    if (btn) btn.classList.toggle('active', measureMode);
    el.style.cursor = measureMode ? 'crosshair' : '';
    if (!measureMode) closeMeasure();
  }

  function closePushPull() {
    pushPullMode = false; pushPullSelection = null; clearPushPullPreview(); closeMeasure();
    document.getElementById('pushpull-panel').hidden = true;
    syncPushPullCoach();
    document.getElementById('btn-pushpull').classList.remove('active');
    el.style.cursor = '';
  }

  function pushPullTestReplay(raw) {
    var p = sanitizePart(raw), depth = p.extrude.depth, accepted = [];
    (p.pushPulls || []).forEach(function (op) { accepted.push(op); depth += op.distance; });
    return { accepted: accepted.length, depth: depth, sourceKeys: accepted.map(function (op) { return op.sourceKey; }) };
  }

  function pickPushPullFace(event) {
    if (!mesh || part.feature === 'revolve') { setPushPullStatus('Push/Pull supports extruded parts only', true); return; }
    if (!pushPullFaceTopologyIsSafe()) {
      pushPullSelection = null; clearPushPullPreview();
      setPushPullStatus('Rejected: holes must stay separate and fully inside the profile for a single face', true);
      return;
    }
    var rect = el.getBoundingClientRect();
    var pointer = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    var ray = new THREE.Raycaster(); ray.setFromCamera(pointer, camera);
    var hits = ray.intersectObject(mesh, false);
    if (!hits.length || !hits[0].face) { pushPullSelection = null; clearPushPullPreview(); setPushPullStatus('No face hit — click the solid', true); return; }
    var n = hits[0].face.normal.clone().transformDirection(mesh.matrixWorld);
    if (Math.abs(n.z) < 0.995) { pushPullSelection = null; clearPushPullPreview(); setPushPullStatus('MVP supports the planar top and bottom faces only', true); return; }
    pushPullSelection = { side: n.z > 0 ? 1 : -1, key: n.z > 0 ? 'top' : 'bottom', geometryKey: pushPullGeometryKey() };
    setPushPullStatus(pushPullSelection.key + ' planar face selected · preview ready', false);
    updatePushPullPreview();
  }

  function updatePushPullPreview() {
    if (!pushPullSelection || !mesh || !pushPullSelectionIsCurrent()) return;
    clearPushPullPreview();
    var distance = Number(document.getElementById('pushpull-distance').value);
    if (!isFinite(distance) || Math.abs(distance) < 0.01 || Math.abs(distance) > 1000) { setPushPullStatus('Enter a distance from 0.01 to 1000 mm (signed)', true); return; }
    var currentDepth = metrics && metrics.bbox[2];
    var nextDepth = currentDepth + distance;
    if (!(currentDepth > 0) || nextDepth < 0.5 || nextDepth > 2000) { setPushPullStatus('Rejected: thickness must remain between 0.5 and 2000 mm', true); return; }
    if (metrics && metrics.faceArea > 0 && metrics.volumeMm3 + distance * metrics.faceArea <= 1e-6) {
      setPushPullStatus('Rejected: edit would collapse or invert the solid volume', true); return;
    }
    // Stretch the cloned solid about the opposite, fixed face. This preview
    // shows the actual predicted thickness, not a translated duplicate mesh.
    var geometry = mesh.geometry.clone();
    var bounds = new THREE.Box3().setFromBufferAttribute(geometry.attributes.position);
    var anchor = pushPullSelection.side > 0 ? bounds.min.z : bounds.max.z;
    var ratio = nextDepth / currentDepth;
    var pos = geometry.attributes.position;
    for (var i = 0; i < pos.count; i++) pos.setZ(i, anchor + (pos.getZ(i) - anchor) * ratio);
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
    pushPullPreview = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x54d6ff, transparent: true, opacity: 0.34, depthWrite: false, side: THREE.DoubleSide }));
    model.add(pushPullPreview); needRender = true;
    setPushPullStatus(pushPullSelection.key + ' face preview · ' + (distance > 0 ? '+' : '') + distance + ' mm', false);
  }

  function commitPushPull() {
    if (!pushPullSelection || !pushPullSelectionIsCurrent()) return;
    updatePushPullPreview();
    if (!pushPullPreview) return;
    var distance = Number(document.getElementById('pushpull-distance').value);
    var currentDepth = metrics && metrics.bbox[2];
    if (!isFinite(distance) || Math.abs(distance) < 0.01 || Math.abs(distance) > 1000 || !isFinite(currentDepth) || currentDepth + distance < 0.5 || currentDepth + distance > 2000) {
      setPushPullStatus('Rejected: distance out of range or resulting thickness must be 0.5–2000 mm', true); return;
    }
    part.pushPulls = part.pushPulls || [];
    if (part.pushPulls.length >= 20) { setPushPullStatus('History limit reached (20 face edits)', true); return; }
    var op = { name: 'PushPull' + (part.pushPulls.length + 1), side: pushPullSelection.side,
      distance: Math.round(distance * 1000) / 1000, sourceKey: pushPullSourceKey(part.pushPulls) };
    part.pushPulls.push(op);
    recordMacro(op.name + ' ' + pushPullSelection.key + ' face ' + (distance > 0 ? '+' : '') + distance + ' mm');
    closePushPull(); renderTree(); rebuild();
    toast(op.name + ' committed to feature history');
  }

  var VIEWS = {
    iso:   { theta: -1.02, phi: 1.05 },
    front: { theta: -Math.PI / 2, phi: Math.PI / 2 },
    top:   { theta: -Math.PI / 2, phi: 0.0001 },
    right: { theta: 0, phi: Math.PI / 2 }
  };

  function setView(name) {
    var v = VIEWS[name];
    if (!v) return;
    cam.theta = v.theta;
    cam.phi = v.phi;
    applyCamera();
    needRender = true;
    var buttons = document.querySelectorAll('.toolbar .tool[data-view]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('active', buttons[i].getAttribute('data-view') === name);
    }
  }

  function fitView() {
    var bb = new THREE.Box3().setFromObject(model);
    if (bb.isEmpty()) return;
    var size = bb.getSize(new THREE.Vector3());
    var center = bb.getCenter(new THREE.Vector3());
    var radius = Math.max(size.x, size.y, size.z) / 2 || 10;
    var fov = camera.fov * Math.PI / 180;
    cam.dist = Math.max(30, (radius / Math.sin(fov / 2)) * 1.9);
    cam.target.copy(center);
    applyCamera();
    needRender = true;
  }

  /* ------------------------------------------------------------ form wiring */

  var sketchFields = document.getElementById('sketch-fields');
  var extrudeFields = document.getElementById('extrude-fields');
  var holeFields = document.getElementById('hole-fields');

  var SHAPES = [
    { id: 'rect', label: 'Rectangle' },
    { id: 'circle', label: 'Circle' },
    { id: 'hex', label: 'Hexagon' },
    { id: 'L', label: 'L-profile' },
    { id: 'slot', label: 'Slot' },
    { id: 'custom', label: 'Custom sketch' }
  ];

  var SNAP = 0.5;
  function snap(v) { return Math.round(Number(v) / SNAP) * SNAP; }

  /* Custom sketch entities: lines and arcs in sketch coordinates (mm).
     line: {kind:'line', x1,y1,x2,y2}
     arc : {kind:'arc',  cx,cy,r,a0,a1} (radians, CCW from a0 to a1)
     Entities form an open polyline in list order; profilePoints closes it. */
  var ENTITY_MAX = 128;
  function sanitizeEntities(src) {
    var arr = Array.isArray(src) ? src.slice(0, ENTITY_MAX) : [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var e = arr[i];
      if (!e || typeof e !== 'object') continue;
      if (e.kind === 'arc') {
        var r = num(e.r, NaN);
        if (!(r > 0.2) || r > 250) continue;
        out.push({
          kind: 'arc',
          cx: snap(num(e.cx, 0)), cy: snap(num(e.cy, 0)),
          r: Math.round(r * 2) / 2,
          a0: num(e.a0, 0), a1: num(e.a1, Math.PI)
        });
      } else {
        out.push({
          kind: 'line',
          x1: snap(num(e.x1, 0)), y1: snap(num(e.y1, 0)),
          x2: snap(num(e.x2, 0)), y2: snap(num(e.y2, 0))
        });
      }
    }
    return out;
  }


  /* Driving sketch dimensions: each dim pins one scalar of an entity
     (line length, dx, dy, or arc radius). Editing the dim value re-solves
     the entity: lines keep their start point and direction (dx/dy dims
     pin the end-point offset), arcs keep centre and angles. */
  var DIM_MAX = 16;
  function sanitizeDims(src, ents) {
    var arr = Array.isArray(src) ? src.slice(0, DIM_MAX) : [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var d = arr[i];
      if (!d || typeof d !== 'object') continue;
      var ei = Math.floor(num(d.entIdx, -1));
      if (!Array.isArray(ents) || ei < 0 || ei >= ents.length) continue;
      var kind = ents[ei].kind;
      var type = d.type;
      if (kind === 'line' ? (type !== 'length' && type !== 'dx' && type !== 'dy') : type !== 'radius') continue;
      var v = num(d.value, NaN);
      if (!isFinite(v) || Math.abs(v) > 500) continue;
      out.push({ entIdx: ei, type: type, value: Math.round(v * 100) / 100 });
    }
    return out;
  }

  function dimMeasure(ent, type) {
    if (!ent) return 0;
    if (type === 'radius') return ent.r;
    if (type === 'dx') return ent.x2 - ent.x1;
    if (type === 'dy') return ent.y2 - ent.y1;
    return Math.hypot(ent.x2 - ent.x1, ent.y2 - ent.y1);
  }

  function applyDim(ents, dim, value) {
    var ent = ents[dim.entIdx];
    if (!ent) return false;
    var v = Number(value);
    if (!isFinite(v)) return false;
    if (dim.type === 'radius') {
      if (!(v > 0.2) || v > 250) return false;
      ent.r = Math.round(v * 2) / 2;
    } else if (dim.type === 'dx') {
      ent.x2 = snap(ent.x1 + v);
    } else if (dim.type === 'dy') {
      ent.y2 = snap(ent.y1 + v);
    } else {
      var len = Math.hypot(ent.x2 - ent.x1, ent.y2 - ent.y1);
      if (!(v > 0.2) || v > 500) return false;
      if (len < 1e-6) { ent.x2 = snap(ent.x1 + v); return true; }
      var k = v / len;
      ent.x2 = snap(ent.x1 + (ent.x2 - ent.x1) * k);
      ent.y2 = snap(ent.y1 + (ent.y2 - ent.y1) * k);
    }
    return true;
  }

  var CONSTR_MAX = 16;
  function sanitizeConstraints(src, ents) {
    var arr = Array.isArray(src) ? src.slice(0, CONSTR_MAX) : [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var c = arr[i];
      if (!c || typeof c !== 'object') continue;
      var ei = Math.floor(num(c.entIdx, -1));
      if (!Array.isArray(ents) || ei < 0 || ei >= ents.length) continue;
      var kind = ents[ei].kind;
      var type = c.type;
      if (type === 'horizontal' || type === 'vertical') {
        if (kind !== 'line') continue;
        out.push({ entIdx: ei, type: type });
      } else if (type === 'equal') {
        var ri = Math.floor(num(c.refIdx, -1));
        if (ri < 0 || ri >= ents.length || ri === ei || ents[ri].kind !== kind) continue;
        out.push({ entIdx: ei, type: 'equal', refIdx: ri });
      }
    }
    return out;
  }

  function applyConstraints(ents, constrs) {
    if (!Array.isArray(ents) || !Array.isArray(constrs)) return;
    for (var i = 0; i < constrs.length; i++) {
      var c = constrs[i];
      var ent = ents[c.entIdx];
      if (!ent) continue;
      if (c.type === 'horizontal' && ent.kind === 'line') {
        var lh = Math.max(0.5, Math.hypot(ent.x2 - ent.x1, ent.y2 - ent.y1));
        var sh = ent.x2 >= ent.x1 ? 1 : -1;
        ent.x2 = snap(ent.x1 + sh * lh);
        ent.y2 = ent.y1;
      } else if (c.type === 'vertical' && ent.kind === 'line') {
        var lv = Math.max(0.5, Math.hypot(ent.x2 - ent.x1, ent.y2 - ent.y1));
        var sv = ent.y2 >= ent.y1 ? 1 : -1;
        ent.x2 = ent.x1;
        ent.y2 = snap(ent.y1 + sv * lv);
      } else if (c.type === 'equal') {
        var ref = ents[c.refIdx];
        if (!ref || ref.kind !== ent.kind) continue;
        if (ent.kind === 'arc') {
          ent.r = ref.r;
        } else {
          var rl = Math.hypot(ref.x2 - ref.x1, ref.y2 - ref.y1);
          applyDim(ents, { entIdx: c.entIdx, type: 'length' }, rl);
        }
      }
    }
  }

  function makeTextSprite(text) {
    var cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = 'rgba(10,16,28,0.85)';
    ctx.fillRect(0, 0, 256, 64);
    ctx.font = 'bold 34px monospace';
    ctx.fillStyle = '#ffd166';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 34);
    var tex = new THREE.CanvasTexture(cv);
    tex.minFilter = THREE.LinearFilter;
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sp.scale.set(14, 3.5, 1);
    return sp;
  }

  /* Flatten custom entities into a closed polygon of [x,y] points.
     Lines contribute one segment; arcs are sampled every ~9 degrees.
     Returns null when there are no usable entities. */
  function entityProfilePoints(ents) {
    if (!Array.isArray(ents) || ents.length < 2) return null;
    var pts = [];
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i];
      if (e.kind === 'arc') {
        var span = e.a1 - e.a0;
        while (span < 0) span += Math.PI * 2;
        span = Math.min(span, Math.PI * 2 - 1e-6);
        var steps = Math.max(2, Math.ceil((span / (Math.PI * 2)) * 40));
        for (var s = 0; s <= steps; s++) {
          if (s === 0 && pts.length) {
            var sx = e.cx + Math.cos(e.a0) * e.r, sy = e.cy + Math.sin(e.a0) * e.r;
            var lp = pts[pts.length - 1];
            if (Math.abs(lp[0] - sx) < 0.01 && Math.abs(lp[1] - sy) < 0.01) continue;
          }
          var a = e.a0 + (span * s) / steps;
          pts.push([e.cx + Math.cos(a) * e.r, e.cy + Math.sin(a) * e.r]);
        }
      } else {
        pts.push([e.x2, e.y2]);
      }
    }
    /* first point of first line is the implicit start; re-add for closure */
    var e0 = ents[0];
    if (e0.kind === 'line' && pts.length) {
      var p0 = [e0.x1, e0.y1];
      if (Math.abs(pts[0][0] - p0[0]) > 0.01 || Math.abs(pts[0][1] - p0[1]) > 0.01)
        pts.unshift(p0);
    }
    if (pts.length > 2) {
      var a0p = pts[0], ap = pts[pts.length - 1];
      if (Math.abs(a0p[0] - ap[0]) < 0.01 && Math.abs(a0p[1] - ap[1]) < 0.01) pts.pop();
    }
    return pts.length >= 3 ? pts : null;
  }

  /* Length (line) or arc length (arc) of an entity, for the dims editor. */
  function entityLength(e) {
    if (e.kind === 'arc') return Math.abs(e.a1 - e.a0) * e.r;
    return Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
  }

  /* Parse a comma-separated list of instance indices to skip (seed = 0). */
  function parseSkipList(txt) {
    var out = [];
    String(txt || '').split(',').forEach(function (t) {
      var n = Math.round(Number(String(t).trim()));
      if (isFinite(n) && n > 0 && n <= 24 && out.indexOf(n) < 0) out.push(n);
    });
    return out;
  }

  /* Sanitize a skip list into a bounded sorted int array (or drop it). */
  function cleanSkipList(list) {
    if (typeof list === 'string') {
      list = list.split(/[\s,;]+/).filter(function (t) { return t !== ''; });
    }
    if (!Array.isArray(list)) return null;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var n = Math.round(Number(list[i]));
      if (isFinite(n) && n > 0 && n <= 24 && out.indexOf(n) < 0) out.push(n);
    }
    out.sort(function (a, b) { return a - b; });
    return out.length ? out.slice(0, 24) : null;
  }

  /* Free-text field row (label + text input + hint). */
  function textFieldRow(label, value, placeholder, onInput) {
    var wrap = document.createElement('label');
    wrap.className = 'field';
    var span = document.createElement('span');
    span.textContent = label;
    var input = document.createElement('input');
    input.type = 'text';
    input.value = Array.isArray(value) ? value.join(',') : '';
    input.placeholder = placeholder || '';
    input.addEventListener('input', function () { onInput(input.value); });
    var u = document.createElement('em');
    wrap.appendChild(span);
    wrap.appendChild(input);
    wrap.appendChild(u);
    return wrap;
  }

  var fieldHintSeq = 0;

  /* Compact unit/range hint for an editable dimension. When hint is given the
     field states the accepted range and refuses to commit an out-of-range or
     non-numeric edit, keeping the previous value on the model. */
  function limitCount(v, max) {
    return Math.min(max, Math.max(1, Math.round(v)));
  }
  function limitNote(entered, applied, subject, unit) {
    var u = unit || '';
    if (applied !== entered) {
      return 'Rounded or limited from ' + fmt(entered, 2) + u + ' to ' + applied + u + '; rebuilt ' + subject;
    }
    return 'Rebuilt ' + subject + ' at ' + fmt(applied, 2).replace(/\.00$/, '') + u;
  }
  function numberField(label, value, unit, onInput, step, eqPath, hint) {
    var wrap = document.createElement('label');
    wrap.className = 'field';
    var span = document.createElement('span');
    span.textContent = label;
    var input = document.createElement('input');
    input.type = 'number';
    input.value = value;
    input.step = step || 1;
    if (eqPath) {
      input.setAttribute('data-eqpath', eqPath);
      wrap.setAttribute('data-bound', eqPath);
    }
    var hintEl = null;
    function effectiveMax() {
      if (hint && typeof hint.maxValue === 'function') {
        var value = Number(hint.maxValue());
        if (isFinite(value)) return Math.min(hint.max === undefined ? value : hint.max, value);
      }
      return hint && hint.max;
    }
    function effectiveMin() {
      if (hint && typeof hint.minValue === 'function') {
        var value = Number(hint.minValue());
        if (isFinite(value)) return Math.max(hint.min === undefined ? value : hint.min, value);
      }
      return hint && hint.min;
    }
    function rangeText() {
      var bits = [];
      var suffix = unit ? ' ' + unit.trim() : '';
      var min = effectiveMin();
      var max = effectiveMax();
      if (min !== undefined && max !== undefined) bits.push(min + '\u2013' + max + suffix);
      else if (min !== undefined) bits.push('\u2265 ' + min + suffix);
      else if (max !== undefined) bits.push('\u2264 ' + max + suffix);
      if (hint.note) bits.push(typeof hint.note === 'function' ? hint.note() : hint.note);
      return bits.join(' \u00b7 ');
    }
    function showApplied(message) {
      if (!hintEl || !message) return;
      hintEl.classList.remove('field-hint-error');
      hintEl.classList.add('field-hint-warning');
      hintEl.textContent = message + ' — ' + rangeText();
    }
    function clearInvalid() {
      if (!hintEl) return;
      input.removeAttribute('aria-invalid');
      input.classList.remove('invalid');
      hintEl.classList.remove('field-hint-error');
      hintEl.textContent = rangeText();
    }
    function markInvalid() {
      if (!hintEl) return;
      input.setAttribute('aria-invalid', 'true');
      input.classList.add('invalid');
      hintEl.classList.add('field-hint-error');
      hintEl.textContent = 'Enter ' + rangeText() + ' \u2014 previous value kept';
    }
    /* Cross-parameter consistency: a value can be inside its own range and
       still push a dependent parameter outside its range. hint.dependents(v)
       returns short explanations naming the dependent parameter; the first
       one blocks the commit and keeps the last accepted value. */
    function markConflict(message) {
      if (!hintEl) { toast(message); return; }
      input.setAttribute('aria-invalid', 'true');
      input.classList.add('invalid');
      hintEl.classList.add('field-hint-error');
      hintEl.textContent = 'Blocked: ' + message + ' \u2014 previous value kept';
    }
    function dependentConflict(v) {
      if (!hint || typeof hint.dependents !== 'function') return '';
      var conflicts = hint.dependents(v);
      if (!conflicts || !conflicts.length) return '';
      return String(conflicts[0]);
    }
    if (hint) {
      hintEl = document.createElement('span');
      hintEl.className = 'field-hint';
      hintEl.id = 'field-hint-' + (++fieldHintSeq);
      hintEl.textContent = rangeText();
      input.setAttribute('aria-describedby', hintEl.id);
      if (effectiveMin() !== undefined) input.min = effectiveMin();
      if (effectiveMax() !== undefined) input.max = effectiveMax();
    }
    var lastValidValue = String(value);
    function withinRange(v) {
      var min = effectiveMin(), max = effectiveMax();
      return isFinite(v) && !(min !== undefined && v < min) && !(max !== undefined && v > max);
    }
    input.addEventListener('input', function () {
      if (eqPath && part.equations.bindings[eqPath]) return; /* driven by expression */
      if (hint) {
        /* Typing is transient: do not rebuild or reject intermediate values until commit. */
        clearInvalid();
        return;
      }
      onInput(Number(input.value));
    });
    if (hint) input.addEventListener('change', function () {
      if (eqPath && part.equations.bindings[eqPath]) return; /* driven by expression */
      var raw = input.value.trim();
      var v = raw === '' ? NaN : Number(raw);
      if (!withinRange(v)) {
        markInvalid();
        input.value = lastValidValue;
        return;
      }
      var conflict = dependentConflict(v);
      if (conflict) {
        markConflict(conflict);
        input.value = lastValidValue;
        return;
      }
      /* Keep an independent model snapshot until the rebuild callback accepts
         the edit. Parameter state is plain JSON data; geometry lives outside it. */
      var partBefore = JSON.parse(JSON.stringify(part));
      function restorePart() {
        Object.keys(part).forEach(function (key) { delete part[key]; });
        Object.keys(partBefore).forEach(function (key) { part[key] = partBefore[key]; });
      }
      editingEnvelopeField = false;
      try {
        var appliedMessage = onInput(v);
        var wasEnvelopeField = editingEnvelopeField;
        editingEnvelopeField = false;
        /* Fit-envelope guardrail: reject the committed edit when the rebuilt
           part exceeds the enabled target build volume, and restore the last
           accepted part and geometry. Advisory only when disabled. */
        if (!wasEnvelopeField && part.envelope && part.envelope.on) {
          var envOver = envelopeOversize();
          if (envOver) {
            restorePart();
            try { onInput(Number(lastValidValue)); } catch (rebuildErr) { restorePart(); }
            input.value = lastValidValue;
            markConflict('would exceed the fit envelope \u2014 ' + envOver);
            return;
          }
        }
        lastValidValue = String(input.value);
        clearInvalid();
        if (appliedMessage) showApplied(appliedMessage);
      } catch (err) {
        /* Revert model data, then ask the same rebuild path to restore the
           last accepted geometry. Never leave the typed value looking applied. */
        restorePart();
        try { onInput(Number(lastValidValue)); }
        catch (rebuildErr) { restorePart(); }
        input.value = lastValidValue;
        markInvalid();
      }
    });
    var u = document.createElement('em');
    u.textContent = unit || '';
    wrap.appendChild(span);
    wrap.appendChild(input);
    wrap.appendChild(u);
    if (hintEl) wrap.appendChild(hintEl);
    return wrap;
  }

  function renderSketchFields() {
    sketchFields.innerHTML = '';
    var sk = part.sketch;

    var row = document.createElement('div');
    row.className = 'shape-picker';
    SHAPES.forEach(function (s) {
      var b = document.createElement('button');
      b.className = 'chip' + (sk.type === s.id ? ' active' : '');
      b.textContent = s.label;
      b.addEventListener('click', function () {
        sk.type = s.id;
        if (s.id === 'hex' && !sk.width) sk.width = 40;
        if (s.id === 'slot' && !(sk.height > 0)) sk.height = 20;
        if (s.id === 'slot' && !isFinite(num(sk.slotAngle, NaN))) sk.slotAngle = 0;
        if (s.id === 'custom' && (!Array.isArray(sk.entities) || sk.entities.length < 2))
          sk.entities = sanitizeEntities([{ kind: 'line', x1: -40, y1: -25, x2: 40, y2: -25 },
                                          { kind: 'line', x1: 40, y1: -25, x2: 40, y2: 25 },
                                          { kind: 'line', x1: 40, y1: 25, x2: -40, y2: 25 },
                                          { kind: 'line', x1: -40, y1: 25, x2: -40, y2: -25 }]);
        renderAll();
      });
      row.appendChild(b);
    });
    sketchFields.appendChild(row);

    var mrow = document.createElement('div');
    mrow.className = 'shape-picker';
    [
      { id: 'none', label: 'Mirror: none' },
      { id: 'x', label: 'Mirror ↔ (Y axis)' },
      { id: 'y', label: 'Mirror ↕ (X axis)' },
      { id: 'line', label: 'Mirror / (axis line)' }
    ].forEach(function (m) {
      var b = document.createElement('button');
      b.className = 'chip' + ((part.mirror && part.mirror.axis) === m.id ? ' active' : '');
      b.textContent = m.label;
      b.addEventListener('click', function () {
        part.mirror = part.mirror || {};
        part.mirror.axis = m.id;
        if (m.id === 'line' && !isFinite(num(part.mirror.angle, NaN))) part.mirror.angle = 45;
        if (m.id !== 'none') recordMacro(m.id === 'line'
          ? 'Mirror holes about axis line ' + num(part.mirror.angle, 45) + '\u00b0 through origin'
          : 'Mirror holes about ' + (m.id === 'x' ? 'Y' : 'X') + ' centerline');
        rebuild();
        renderAll();
      });
      mrow.appendChild(b);
    });
    sketchFields.appendChild(mrow);

    if ((part.mirror && part.mirror.axis) === 'line') {
      sketchFields.appendChild(numberField('Mirror axis angle', part.mirror.angle, '\u00b0', function (v) {
        if (num(part.mirror.angle, 0) !== v) recordMacro('Mirror axis angle ' + v + '\u00b0');
        part.mirror.angle = v;
        rebuild();
      }, 1, 'mirror.angle', { min: -180, max: 180, note: 'degrees; \u00b1180 is the same axis line' }));
    }

    if (sk.type === 'circle') {
      sketchFields.appendChild(numberField('Diameter', sk.width, 'mm', function (v) {
        if (sk.width !== v) recordMacro('Sketch1 Diameter ' + v + ' mm');
        sk.width = v; rebuild();
      }, 1, 'sketch.width', { min: 0.5, max: 2000, note: 'outline size' }));
    } else if (sk.type === 'slot') {
      sketchFields.appendChild(numberField('Slot length', sk.width, 'mm', function (v) {
        if (sk.width !== v) recordMacro('Sketch1 Slot length ' + v + ' mm');
        sk.width = Math.max(1, v); rebuild();
      }, 1, 'sketch.width', { min: 0.5, max: 2000, note: 'outline size',
        dependents: function (v) {
          var sw = num(sk.height, 0);
          return sw > 0.02 && v < sw - 1e-9
            ? ['Slot width ' + fmt(sw, 1) + ' mm needs slot length \u2265 ' + fmt(sw, 1) + ' mm. Next: increase slot length to at least ' + fmt(sw, 1) + ' mm or reduce slot width.']
            : [];
        } }));
      sketchFields.appendChild(numberField('Slot width', sk.height, 'mm', function (v) {
        var applied = Math.min(sk.width, Math.max(1, v));
        if (applied !== v) toast('Slot width limited to the slot length (' + fmt(applied, 1) + ' mm)');
        if (sk.height !== applied) recordMacro('Sketch1 Slot width ' + applied + ' mm');
        sk.height = applied; rebuild();
        return applied !== v ? 'Limited from ' + fmt(v, 1) + ' to ' + fmt(applied, 1) + ' mm because width cannot exceed slot length' : '';
      }, 1, 'sketch.height', { min: 0.5, max: 2000, maxValue: function () { return sk.width; }, note: function () { return 'cannot exceed current slot length (' + fmt(sk.width, 1) + ' mm)'; } }));
      sketchFields.appendChild(numberField('Slot angle', sk.slotAngle || 0, '\u00b0', function (v) {
        if (num(sk.slotAngle, 0) !== v) recordMacro('Sketch1 Slot angle ' + v + '\u00b0');
        sk.slotAngle = v; rebuild();
      }, 1, 'sketch.slotAngle', { min: -90, max: 90, note: 'degrees about the sketch centre' }));
    } else {
      sketchFields.appendChild(numberField('Width', sk.width, 'mm', function (v) {
        if (sk.width !== v) recordMacro('Sketch1 Width ' + v + ' mm');
        sk.width = v; rebuild();
      }, 1, 'sketch.width', { min: 0.5, max: 2000, note: 'outline size',
        dependents: function (v) { return sketchDimConflict(sk, v, 'width'); } }));
      sketchFields.appendChild(numberField('Height', sk.height, 'mm', function (v) {
        if (sk.height !== v) recordMacro('Sketch1 Height ' + v + ' mm');
        sk.height = v; rebuild();
      }, 1, 'sketch.height', { min: 0.5, max: 2000, note: 'outline size',
        dependents: function (v) { return sketchDimConflict(sk, v, 'height'); } }));
      if (sk.type === 'rect' && (sk.round || sk.corner === 'chamfer')) {
        var crow = document.createElement('div');
        crow.className = 'shape-picker';
        [
          { id: 'fillet', label: 'Fillet' },
          { id: 'chamfer', label: 'Chamfer' }
        ].forEach(function (c) {
          var b = document.createElement('button');
          b.className = 'chip' + ((sk.corner || 'fillet') === c.id ? ' active' : '');
          b.textContent = c.label;
          b.addEventListener('click', function () {
            if ((sk.corner || 'fillet') !== c.id) recordMacro('Sketch1 corner ' + c.id + ' ' + (sk.round || 6) + ' mm');
            sk.corner = c.id;
            rebuild();
            renderAll();
          });
          crow.appendChild(b);
        });
        sketchFields.appendChild(crow);
      }
      sketchFields.appendChild(numberField(sk.type === 'L' ? 'Wall' : ((sk.corner || 'fillet') === 'chamfer' ? 'Chamfer size' : 'Fillet'), sk.round, 'mm', function (v) {
        if (sk.round !== v) recordMacro('Sketch1 ' + (sk.type === 'L' ? 'Wall' : ((sk.corner || 'fillet') === 'chamfer' ? 'Chamfer' : 'Fillet')) + ' ' + v + ' mm');
        var roundLimit = Math.max(0, Math.min(num(sk.width, 0), num(sk.height, 0)) / 2);
        var applied = Math.min(v, roundLimit);
        sk.round = applied; rebuild();
        return applied !== v ? 'Limited from ' + fmt(v, 1) + ' to ' + fmt(applied, 1) + ' mm by current sketch size' : 'Rebuilt sketch and downstream features';
      }, 0.5, 'sketch.round', { min: 0, max: 500, maxValue: function () { return Math.max(0, Math.min(num(sk.width, 0), num(sk.height, 0)) / 2); }, note: '0 for none; max is half the smaller sketch dimension' }));

      if (sk.type === 'rect') {
        if (!Array.isArray(sk.corners) || sk.corners.length !== 4) sk.corners = sanitizeCorners(null);
        var anyOn = sk.corners.some(function (c) { return c && c.on && num(c.r, 0) > 0.02; });
        var tog = document.createElement('button');
        tog.className = 'chip' + (anyOn ? ' active' : '');
        tog.textContent = 'Per-corner fillets';
        tog.title = 'Give each rectangle corner its own fillet or chamfer radius';
        tog.addEventListener('click', function () {
          sk._cornersOpen = !sk._cornersOpen;
          renderAll();
        });
        var prow = document.createElement('div');
        prow.className = 'shape-picker';
        prow.appendChild(tog);
        sketchFields.appendChild(prow);
        if (sk._cornersOpen) {
          var names = ['Bottom-left', 'Bottom-right', 'Top-right', 'Top-left'];
          for (var cI = 0; cI < 4; cI++) {
            (function (ci) {
              var c = sk.corners[ci];
              var r2 = document.createElement('div');
              r2.className = 'shape-picker';
              var lbl = document.createElement('span');
              lbl.className = 'chip';
              lbl.textContent = names[ci];
              r2.appendChild(lbl);
              var onb = document.createElement('button');
              onb.className = 'chip' + (c.on ? ' active' : '');
              onb.textContent = c.on ? 'On' : 'Off';
              onb.addEventListener('click', function () {
                c.on = !c.on;
                if (c.on && !(num(c.r, 0) > 0)) c.r = 5;
                recordMacro('Sketch1 ' + names[ci] + ' corner ' + (c.on ? 'fillet on' : 'off'));
                rebuild();
                renderAll();
              });
              r2.appendChild(onb);
              [
                { id: 'fillet', label: 'Fillet' },
                { id: 'chamfer', label: 'Chamfer' }
              ].forEach(function (md) {
                var mb = document.createElement('button');
                mb.className = 'chip' + (c.mode === md.id ? ' active' : '');
                mb.textContent = md.label;
                mb.addEventListener('click', function () {
                  c.mode = md.id;
                  if (c.on) recordMacro('Sketch1 ' + names[ci] + ' corner ' + md.id);
                  rebuild();
                  renderAll();
                });
                r2.appendChild(mb);
              });
              sketchFields.appendChild(r2);
              var cornerLimit = Math.max(0, Math.min(num(sk.width, 0), num(sk.height, 0)) / 2);
              sketchFields.appendChild(numberField(names[ci] + ' radius', c.r, 'mm', function (v) {
                var applied = Math.min(v, cornerLimit);
                c.r = applied;
                if (!c.on) c.on = true;
                rebuild();
                return applied !== v ? 'Limited from ' + fmt(v, 1) + ' to ' + fmt(applied, 1) + ' mm by current sketch size' : 'Rebuilt sketch and downstream features';
              }, 0.5, 'sketch.corners.' + ci + '.r', { min: 0, max: 500, maxValue: function () { return cornerLimit; }, note: function () { return 'max is half the smaller sketch dimension (' + fmt(cornerLimit, 1) + ' mm)'; } }));
            })(cI);
          }
        }
      }
    }

    if (sk.type === 'custom') {
      if (!Array.isArray(sk.entities)) sk.entities = sanitizeEntities(null);
      sk.dims = sanitizeDims(sk.dims, sk.entities);
      sk.constraints = sanitizeConstraints(sk.constraints, sk.entities);
      sketchFields.appendChild(sketchEntitiesPanel(sk));
    }
  }

  /* Entity editor for the custom sketch type: a list of line/arc entities
     with editable start/end (or center/radius/angles) values snapped to
     0.5 mm, a chip to append a line or arc, and delete buttons. Polyline
     order is the list order; the profile closes from last entity back to
     the first point. */
  function sketchEntitiesPanel(sk) {
    var panel = document.createElement('div');
    panel.className = 'entity-panel';

    var head = document.createElement('div');
    head.className = 'shape-picker';
    var lbl = document.createElement('span');
    lbl.className = 'chip';
    var n = sk.entities.length;
    var pl = entityProfilePoints(sk.entities);
    lbl.textContent = pl ? ('Closed profile: ' + n + ' entities, area ' +
      Math.abs(polygonArea(pl)).toFixed(1) + ' mm\u00b2') : 'Need at least 2 entities to close a profile';
    head.appendChild(lbl);
    panel.appendChild(head);

    var addRow = document.createElement('div');
    addRow.className = 'shape-picker';
    [
      { label: '+ Line' },
      { label: '+ Arc' },
      { label: 'Delete last' }
    ].forEach(function (a, ai) {
      var b = document.createElement('button');
      b.className = 'chip';
      b.textContent = a.label;
      b.addEventListener('click', function () {
        if (ai === 2) {
          if (sk.entities.length) {
            recordMacro('Sketch1 entity removed');
            sk.entities.pop();
          }
        } else {
          if (sk.entities.length >= ENTITY_MAX) return;
          var last = sk.entities[sk.entities.length - 1];
          var px = last ? (last.kind === 'arc' ? last.cx + Math.cos(last.a1) * last.r : last.x2) : 0;
          var py = last ? (last.kind === 'arc' ? last.cy + Math.sin(last.a1) * last.r : last.y2) : 0;
          if (ai === 0) {
            recordMacro('Sketch1 line added');
            sk.entities.push({ kind: 'line', x1: px, y1: py, x2: snap(px + 20), y2: snap(py) });
          } else {
            recordMacro('Sketch1 arc added');
            sk.entities.push({ kind: 'arc', cx: snap(px), cy: snap(py + 10), r: 10,
                               a0: -Math.PI / 2, a1: 0 });
          }
        }
        rebuild();
        renderAll();
      });
      addRow.appendChild(b);
    });
    panel.appendChild(addRow);

    /* SVG import: paste a path "d" string, convert to entities. */
    var impRow = document.createElement('div');
    impRow.className = 'shape-picker';
    var impInp = document.createElement('input');
    impInp.type = 'text';
    impInp.className = 'svg-import-input';
    impInp.placeholder = 'Paste SVG path d="..."';
    impRow.appendChild(impInp);
    var impBtn = document.createElement('button');
    impBtn.className = 'chip';
    impBtn.textContent = 'Import SVG path';
    impBtn.title = 'Convert an SVG path into sketch entities (y axis is flipped, d scales to mm)';
    impBtn.addEventListener('click', function () {
      var d = impInp.value.trim();
      if (!d) return;
      var ents;
      try { ents = window.SvgImport.importPath(d, {}); }
      catch (err) { toast('SVG path error: ' + err.message, true); return; }
      if (!ents || ents.length < 2) { toast('SVG path produced fewer than 2 usable entities', true); return; }
      var n = Math.min(ents.length, ENTITY_MAX);
      sk.entities = ents.slice(0, n).map(function (e) {
        return e.type === 'line'
          ? { kind: 'line', x1: snap(e.x1), y1: snap(e.y1), x2: snap(e.x2), y2: snap(e.y2) }
          : { kind: 'arc', cx: snap(e.cx), cy: snap(e.cy), r: snap(e.r), a0: e.a0, a1: e.a1 };
      });
      sk.dims = [];
      sk.constraints = [];
      recordMacro('Sketch1 SVG path imported, ' + n + ' entities');
      rebuild();
      renderAll();
      toast(n === ents.length ? ('Imported ' + n + ' entities from SVG path') :
        ('Imported first ' + n + ' of ' + ents.length + ' entities (limit reached)'));
    });
    impRow.appendChild(impBtn);
    panel.appendChild(impRow);

    /* Full SVG document import. Reading and converting happen before the existing
       sketch is touched, so a bad file or an oversized preview is non-destructive. */
    var fileRow = document.createElement('div');
    fileRow.className = 'shape-picker svg-file-row';
    var fileInput = document.createElement('input');
    fileInput.type = 'file'; fileInput.accept = '.svg,image/svg+xml'; fileInput.hidden = true;
    var chooseBtn = document.createElement('button');
    chooseBtn.className = 'chip'; chooseBtn.textContent = 'Choose SVG file…';
    var fileName = document.createElement('span'); fileName.className = 'svg-file-name'; fileName.textContent = 'No file selected';
    var unitSelect = document.createElement('select'); unitSelect.title = 'SVG user units';
    [['auto','Auto units'],['px','px (1 unit = 1 mm)'],['mm','mm'],['cm','cm'],['in','inches']].forEach(function (u) {
      var option = document.createElement('option'); option.value = u[0]; option.textContent = u[1]; unitSelect.appendChild(option);
    });
    var preview = document.createElement('div'); preview.className = 'svg-import-preview'; preview.hidden = true;
    var pendingImport = null;
    chooseBtn.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      pendingImport = null; preview.hidden = true;
      if (!file) { fileName.textContent = 'No file selected'; return; }
      if (file.size > 2000000) { fileName.textContent = file.name; toast('SVG files must be smaller than 2 MB', true); return; }
      fileName.textContent = file.name; chooseBtn.disabled = true; chooseBtn.textContent = 'Reading…';
      var reader = new FileReader();
      reader.onerror = function () { chooseBtn.disabled = false; chooseBtn.textContent = 'Choose SVG file…'; toast('Could not read the SVG file', true); };
      reader.onload = function () {
        chooseBtn.disabled = false; chooseBtn.textContent = 'Choose SVG file…';
        try {
          pendingImport = window.SvgImport.svgDocumentToEntities(reader.result, { units: unitSelect.value });
          var s = pendingImport.summary;
          preview.textContent = 'Preview: ' + s.lines + ' lines + ' + s.arcs + ' arcs · ' + s.width.toFixed(2) + ' × ' + s.height.toFixed(2) + ' mm · ' + pendingImport.pathCount + ' shape(s)';
          preview.hidden = false;
          commitBtn.disabled = pendingImport.entities.length > ENTITY_MAX;
          if (pendingImport.entities.length > ENTITY_MAX) preview.textContent += ' · Too many entities (max ' + ENTITY_MAX + ')'; 
        } catch (err) { pendingImport = null; toast('SVG import: ' + err.message, true); }
      };
      reader.readAsText(file);
    });
    unitSelect.addEventListener('change', function () {
      if (!fileInput.files || !fileInput.files[0]) return;
      // Re-dispatch through the same reader path with the newly selected units.
      var event = document.createEvent('Event'); event.initEvent('change', true, false); fileInput.dispatchEvent(event);
    });
    var commitBtn = document.createElement('button'); commitBtn.className = 'chip primary'; commitBtn.textContent = 'Apply import'; commitBtn.disabled = true;
    commitBtn.addEventListener('click', function () {
      if (!pendingImport || pendingImport.entities.length > ENTITY_MAX) return;
      sk.entities = sanitizeEntities(pendingImport.entities.map(function (e) {
        return e.type === 'line' ? { kind: 'line', x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 }
          : { kind: 'arc', cx: e.cx, cy: e.cy, r: e.r, a0: e.a0, a1: e.a1 };
      }));
      if (sk.entities.length !== pendingImport.entities.length) { toast('Some entities are outside supported sketch limits; import cancelled', true); return; }
      sk.dims = []; sk.constraints = [];
      recordMacro('Sketch1 SVG file imported, ' + sk.entities.length + ' entities');
      rebuild(); renderAll(); toast('Imported ' + sk.entities.length + ' entities from SVG file');
    });
    fileRow.appendChild(chooseBtn); fileRow.appendChild(fileName); fileRow.appendChild(fileInput);
    panel.appendChild(fileRow); panel.appendChild(unitSelect); panel.appendChild(preview); panel.appendChild(commitBtn);

    sk.entities.forEach(function (e, ei) {
      var row = document.createElement('div');
      row.className = 'entity-row';
      var tag = document.createElement('span');
      tag.className = 'chip entity-tag';
      tag.textContent = (ei + 1) + ' ' + e.kind + ' \u2014 ' + entityLength(e).toFixed(1) + ' mm';
      row.appendChild(tag);

      if (e.kind === 'line') {
        entityInput(row, 'Start X', 'x1', false); entityInput(row, 'Start Y', 'y1', false);
        entityInput(row, 'End X', 'x2', false); entityInput(row, 'End Y', 'y2', false);
      } else {
        entityInput(row, 'Center X', 'cx', false); entityInput(row, 'Center Y', 'cy', false);
        entityInput(row, 'Radius', 'r', false);
        entityInput(row, 'Start angle', 'a0d', true); entityInput(row, 'End angle', 'a1d', true);
      }
      row.querySelectorAll('input').forEach(function (inp) { if (inp.__bind) inp.__bind(e); });
      var del = document.createElement('button');
      del.className = 'chip entity-del';
      del.textContent = '\u00d7';
      del.title = 'Remove entity';
      del.addEventListener('click', function () {
        sk.entities.splice(ei, 1);
        if (Array.isArray(sk.dims)) {
          sk.dims = sk.dims.filter(function (d) { return d.entIdx !== ei; });
          sk.dims.forEach(function (d) { if (d.entIdx > ei) d.entIdx--; });
        }
        if (Array.isArray(sk.constraints)) {
          sk.constraints = sk.constraints.filter(function (c) { return c.entIdx !== ei && c.refIdx !== ei; });
          sk.constraints.forEach(function (c) {
            if (c.entIdx > ei) c.entIdx--;
            if (typeof c.refIdx === 'number' && c.refIdx > ei) c.refIdx--;
          });
        }
        recordMacro('Sketch1 entity ' + (ei + 1) + ' removed');
        rebuild();
        renderAll();
      });
      row.appendChild(del);
      panel.appendChild(row);
    });

    /* Driving dimensions: add a dim chip per entity, edit values to
       re-solve geometry (line length/dx/dy, arc radius). */
    if (!Array.isArray(sk.dims)) sk.dims = [];
    var dimHead = document.createElement('div');
    dimHead.className = 'shape-picker';
    var dimLbl = document.createElement('span');
    dimLbl.className = 'chip';
    dimLbl.textContent = 'Driving dims (' + sk.dims.length + ')';
    dimHead.appendChild(dimLbl);
    panel.appendChild(dimHead);

    sk.entities.forEach(function (e, ei) {
      var dRow = document.createElement('div');
      dRow.className = 'shape-picker';
      var types = e.kind === 'arc' ? ['radius'] : ['length', 'dx', 'dy'];
      types.forEach(function (t) {
        var b = document.createElement('button');
        b.className = 'chip';
        b.textContent = '+ ' + (ei + 1) + ' ' + t;
        b.title = 'Add a driving ' + t + ' dimension on entity ' + (ei + 1);
        b.addEventListener('click', function () {
          if (sk.dims.length >= DIM_MAX) { toast('Dimension limit reached', true); return; }
          if (sk.dims.some(function (d) { return d.entIdx === ei && d.type === t; })) return;
          sk.dims.push({ entIdx: ei, type: t, value: Math.round(dimMeasure(e, t) * 100) / 100 });
          recordMacro('Sketch1 dim ' + t + ' on entity ' + (ei + 1));
          rebuild();
          renderAll();
        });
        dRow.appendChild(b);
      });
      panel.appendChild(dRow);
    });

    sk.dims.forEach(function (dim, di) {
      var dRow = document.createElement('div');
      dRow.className = 'entity-row';
      var dTag = document.createElement('span');
      dTag.className = 'chip entity-tag';
      dTag.textContent = 'E' + (dim.entIdx + 1) + ' ' + dim.type;
      dRow.appendChild(dTag);
      var dInp = document.createElement('input');
      dInp.type = 'number';
      dInp.step = 0.5;
      dInp.title = 'Driving ' + dim.type + ' value (mm); edits re-solve the entity';
      dInp.value = dim.value;
      dInp.addEventListener('change', function () {
        var v = Number(dInp.value);
        if (!applyDim(sk.entities, dim, v)) { toast('Invalid dimension value', true); dInp.value = dim.value; return; }
        dim.value = Math.round(dimMeasure(sk.entities[dim.entIdx], dim.type) * 100) / 100;
        recordMacro('Sketch1 dim E' + (dim.entIdx + 1) + ' ' + dim.type + ' = ' + dim.value);
        rebuild();
        renderAll();
      });
      dRow.appendChild(dInp);
      var dDel = document.createElement('button');
      dDel.className = 'chip entity-del';
      dDel.textContent = '\u00d7';
      dDel.title = 'Remove dimension';
      dDel.addEventListener('click', function () {
        sk.dims.splice(di, 1);
        recordMacro('Sketch1 dim removed');
        rebuild();
        renderAll();
      });
      dRow.appendChild(dDel);
      panel.appendChild(dRow);
    });

    /* Geometric constraints (H / V / = length or radius). */
    if (!Array.isArray(sk.constraints)) sk.constraints = [];
    var cHead = document.createElement('div');
    cHead.className = 'shape-picker';
    var cLbl = document.createElement('span');
    cLbl.className = 'chip';
    cLbl.textContent = 'Constraints (' + sk.constraints.length + ')';
    cHead.appendChild(cLbl);
    panel.appendChild(cHead);

    sk.entities.forEach(function (e, ei) {
      var cRow = document.createElement('div');
      cRow.className = 'shape-picker';
      if (e.kind === 'line') {
        ['horizontal', 'vertical'].forEach(function (ct) {
          var b = document.createElement('button');
          b.className = 'chip';
          b.textContent = '+ E' + (ei + 1) + ' ' + (ct === 'horizontal' ? 'H' : 'V');
          b.title = 'Constrain entity ' + (ei + 1) + ' ' + ct;
          b.addEventListener('click', function () {
            if (sk.constraints.length >= CONSTR_MAX) { toast('Constraint limit reached', true); return; }
            sk.constraints = sk.constraints.filter(function (c) {
              return !(c.entIdx === ei && (c.type === 'horizontal' || c.type === 'vertical'));
            });
            sk.constraints.push({ entIdx: ei, type: ct });
            recordMacro('Sketch1 constraint E' + (ei + 1) + ' ' + ct);
            rebuild();
            renderAll();
          });
          cRow.appendChild(b);
        });
      }
      for (var ri = 0; ri < sk.entities.length; ri++) {
        if (ri !== ei && sk.entities[ri].kind === e.kind) {
          (function (refIdx) {
            var bEq = document.createElement('button');
            bEq.className = 'chip';
            bEq.textContent = '+ E' + (ei + 1) + '=E' + (refIdx + 1);
            bEq.title = 'Constrain entity ' + (ei + 1) + ' equal to entity ' + (refIdx + 1);
            bEq.addEventListener('click', function () {
              if (sk.constraints.length >= CONSTR_MAX) { toast('Constraint limit reached', true); return; }
              sk.constraints = sk.constraints.filter(function (c) { return !(c.entIdx === ei && c.type === 'equal'); });
              sk.constraints.push({ entIdx: ei, type: 'equal', refIdx: refIdx });
              recordMacro('Sketch1 constraint E' + (ei + 1) + ' = E' + (refIdx + 1));
              rebuild();
              renderAll();
            });
            cRow.appendChild(bEq);
          })(ri);
          break;
        }
      }
      if (cRow.childNodes.length) panel.appendChild(cRow);
    });

    sk.constraints.forEach(function (c, ci) {
      var cRow = document.createElement('div');
      cRow.className = 'entity-row';
      var cTag = document.createElement('span');
      cTag.className = 'chip entity-tag';
      cTag.textContent = 'E' + (c.entIdx + 1) + ' ' + (c.type === 'equal' ? ('= E' + (c.refIdx + 1)) : c.type);
      cRow.appendChild(cTag);
      var cDel = document.createElement('button');
      cDel.className = 'chip entity-del';
      cDel.textContent = '\u00d7';
      cDel.title = 'Remove constraint';
      cDel.addEventListener('click', function () {
        sk.constraints.splice(ci, 1);
        recordMacro('Sketch1 constraint removed');
        rebuild();
        renderAll();
      });
      cRow.appendChild(cDel);
      panel.appendChild(cRow);
    });

    return panel;
  }

  /* One bounded numeric editor bound to an entity field. Angle fields
     display degrees and store radians. Snaps lengths to 0.5 mm. */
  function entityInput(row, label, key, isAngle) {
    var inp = document.createElement('input');
    inp.type = 'number';
    inp.step = isAngle ? 5 : 0.5;
    inp.title = label;
    inp.addEventListener('change', function () {
      var v = Number(inp.value);
      if (!isFinite(v)) return;
      var ent = inp.__ent;
      if (!ent) return;
      if (isAngle) {
        ent[key === 'a0d' ? 'a0' : 'a1'] = (v * Math.PI) / 180;
      } else {
        ent[key] = snap(v);
      }
      rebuild();
      renderAll();
    });
    inp.__bind = function (ent) {
      inp.__ent = ent;
      var v = isAngle ? ent[key === 'a0d' ? 'a0' : 'a1'] : ent[key];
      inp.value = Math.round((isAngle ? (v * 180) / Math.PI : v) * 100) / 100;
    };
    row.appendChild(inp);
    return inp;
  }

  function renderExtrudeFields() {
    extrudeFields.innerHTML = '';
    var chips = document.createElement('div');
    chips.className = 'shape-picker';
    [
      { id: 'extrude', label: 'Extrude' },
      { id: 'revolve', label: 'Revolve' }
    ].forEach(function (f) {
      var b = document.createElement('button');
      b.className = 'chip' + (part.feature === f.id ? ' active' : '');
      b.textContent = f.label;
      b.addEventListener('click', function () {
        part.feature = f.id;
        renderAll();
      });
      chips.appendChild(b);
    });
    extrudeFields.appendChild(chips);

    if (part.feature === 'revolve') {
      extrudeFields.appendChild(numberField('Angle', part.revolve.angle, 'deg', function (v) {
        var applied = Math.min(360, Math.max(0.5, v));
        if (applied !== v) toast('Revolve angle limited to ' + applied + '\u00b0 (0.5\u2013360 accepted)');
        if (part.revolve.angle !== applied) recordMacro('Revolve1 Angle ' + applied + '\u00b0');
        part.revolve.angle = applied;
        rebuild();
        return applied !== v
          ? 'Limited from ' + fmt(v, 2) + '\u00b0 to ' + fmt(applied, 2) + '\u00b0; rebuilt the revolve'
          : 'Rebuilt the revolve and downstream features';
      }, 5, 'revolve.angle', { min: 0.5, max: 360, note: 'degrees around the Y axis; under 360 leaves it open' }));
      var d2 = document.createElement('p');
      d2.className = 'hint';
      d2.textContent = 'Revolve sketch profile around the Y axis. Holes cut through.';
      extrudeFields.appendChild(d2);
    } else {
      extrudeFields.appendChild(numberField('Depth', part.extrude.depth, 'mm', function (v) {
        if (part.extrude.depth !== v) recordMacro('Extrude1 Depth ' + v + ' mm');
        part.extrude.depth = v;
        rebuild();
      }, 0.5, 'extrude.depth', { min: 0.5, max: 2000, note: 'extrusion height',
        dependents: function (v) { return seatDepthConflicts(v); } }));
      var shellWrap = document.createElement('label');
      shellWrap.className = 'field';
      shellWrap.innerHTML = '<span>Shell (hollow)</span>';
      var shellCb = document.createElement('input');
      shellCb.type = 'checkbox';
      shellCb.checked = !!(part.shell && part.shell.on);
      shellCb.addEventListener('change', function () {
        if (!part.shell || typeof part.shell !== 'object') part.shell = { on: false, wall: 2 };
        part.shell.on = shellCb.checked;
        if (shellCb.checked) recordMacro('Shell on, wall ' + shellWall().toFixed(1) + ' mm');
        renderExtrudeFields();
        rebuild();
      });
      shellWrap.appendChild(shellCb);
      extrudeFields.appendChild(shellWrap);
      if (part.shell && part.shell.on) {
        var wallLimit = Math.max(0.15, Math.min(part.sketch.width, part.sketch.height) / 2 - 0.3);
        extrudeFields.appendChild(numberField('Wall thickness', shellWall(), 'mm', function (v) {
          var applied = Math.min(v, wallLimit);
          if (applied !== v) toast('Wall thickness limited to ' + fmt(applied, 2) + ' mm \u2014 half the smallest sketch dimension');
          part.shell.wall = applied;
          rebuild();
          return applied !== v
            ? 'Limited from ' + fmt(v, 2) + ' to ' + fmt(applied, 2) + ' mm so the two walls cannot meet; rebuilt the shell'
            : 'Rebuilt the shell and downstream features';
        }, 0.2, 'shell.wall', { min: 0.2, max: Math.round(wallLimit * 100) / 100, note: function () { return 'max ' + fmt(wallLimit, 2) + ' mm for this sketch size'; } }));
      }
      var d = document.createElement('p');
      d.className = 'hint';
      d.textContent = part.shell && part.shell.on
        ? 'Shelled extrude: uniform side walls, closed top and bottom. Holes pierce the wall.'
        : 'Mid-plane extrude, one direction. Holes cut through all.';
      extrudeFields.appendChild(d);
    }

    /* Fit envelope: optional target build volume. When enabled, committed
       parameter edits that would leave the part oversized are rejected and
       the last accepted part is kept. Presets cover common 3D-print build
       volumes; dimensions are clamped to 1\u201320000 mm. */
    var envWrap = document.createElement('div');
    envWrap.className = 'envelope-block';
    var envHead = document.createElement('label');
    envHead.className = 'field envelope-head';
    var envCb = document.createElement('input');
    envCb.type = 'checkbox';
    envCb.checked = !!(part.envelope && part.envelope.on);
    envCb.addEventListener('change', function () {
      part.envelope.on = envCb.checked;
      renderExtrudeFields();
      rebuild();
    });
    envHead.appendChild(envCb);
    var envTitle = document.createElement('span');
    envTitle.textContent = 'Fit envelope (build volume)';
    envHead.appendChild(envTitle);
    envWrap.appendChild(envHead);
    var envRow = document.createElement('div');
    envRow.className = 'envelope-presets';
    [
      { label: '220\u00d7220\u00d7250 (desktop printer)', x: 220, y: 220, z: 250 },
      { label: '100 cube (small printer)', x: 100, y: 100, z: 100 },
      { label: '300\u00d7300\u00d7350 (large printer)', x: 300, y: 300, z: 350 }
    ].forEach(function (preset) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip envelope-preset';
      b.textContent = preset.label;
      b.addEventListener('click', function () {
        part.envelope.x = preset.x; part.envelope.y = preset.y; part.envelope.z = preset.z;
        renderExtrudeFields();
        rebuild();
      });
      envRow.appendChild(b);
    });
    envWrap.appendChild(envRow);
    ['x', 'y', 'z'].forEach(function (axis) {
      envWrap.appendChild(numberField('Envelope ' + axis.toUpperCase(), part.envelope[axis], 'mm', function (v) {
        editingEnvelopeField = true;
        part.envelope[axis] = Math.min(20000, Math.max(1, v));
        rebuild();
      }, 1, null, { min: 1, max: 20000, note: 'target build volume axis size' }));
    });
    var envHint = document.createElement('p');
    envHint.className = 'hint';
    envHint.textContent = part.envelope && part.envelope.on
      ? 'Enabled: committed edits that leave the part larger than the envelope are rejected; the last accepted part is kept. Preflight reports fit status.'
      : 'Disabled: the envelope is advisory only \u2014 preflight reports fit status but edits are accepted.';
    envWrap.appendChild(envHint);
    extrudeFields.appendChild(envWrap);
  }

  function renderHoleFields() {
    renderMacroPanel();
    holeFields.innerHTML = '';
    if (!part.holes.length) {
      var p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'No holes. Add one to cut the solid.';
      holeFields.appendChild(p);
      var emptyClearance = document.getElementById('clearance-summary');
      var emptySpacing = document.getElementById('spacing-summary');
      if (emptyClearance) {
        emptyClearance.textContent = 'Add holes to check edge clearance.';
        emptyClearance.className = 'hint clearance-neutral';
      }
      if (emptySpacing) {
        emptySpacing.textContent = 'Hole-to-hole spacing: add at least two holes to compare gaps.';
        emptySpacing.className = 'hint clearance-neutral';
      }
      return;
    }
    part.holes.forEach(function (hole, idx) {
      var card = document.createElement('div');
      card.className = 'hole-card';
      var head = document.createElement('div');
      head.className = 'hole-head';
      var derived = !!hole.derived;
      var isSeed = idx === 0 && hole.pattern;
      head.innerHTML = '<b>Hole ' + (idx + 1) + '</b>' +
        (derived ? ' <em class="pattern-tag">pattern instance</em>' :
         isSeed ? ' <em class="pattern-tag">pattern seed</em>' : '');
      var del = document.createElement('button');
      del.className = 'link-danger';
      del.textContent = 'remove';
      if (derived || isSeed) {
        /* Deleting the seed removes the whole pattern (instances re-derive). */
        del.addEventListener('click', function () {
          part.holes.splice(0, 1);
          renderAll();
        });
        head.appendChild(del);
        card.appendChild(head);
        if (derived) {
          var hintP = document.createElement('p');
          hintP.className = 'hint';
          hintP.textContent = 'Derived from Hole 1 seed — edit the seed diameter or pattern spacing.';
          card.appendChild(hintP);
        }
      } else {
        del.addEventListener('click', function () {
          part.holes.splice(idx, 1);
          renderAll();
        });
        head.appendChild(del);
        card.appendChild(head);
      }

      var clr = holeClearance(hole, num(part.minWall, 2));
      var clrRow = document.createElement('div');
      clrRow.className = 'field clearance-row';
      var clrSpan = document.createElement('span');
      clrSpan.textContent = 'Edge clearance';
      var clrVal = document.createElement('b');
      if (clr.status === 'outside') {
        clrVal.textContent = 'circle crosses or leaves the profile';
        clrVal.className = 'clearance-bad';
      } else {
        clrVal.textContent = fmt(clr.edge, 2) + ' mm' +
          (clr.status === 'warn' ? '  · below ' + num(part.minWall, 2) + ' mm min wall' : '');
        clrVal.className = clr.status === 'warn' ? 'clearance-warn' : 'clearance-ok';
      }
      clrRow.appendChild(clrSpan);
      clrRow.appendChild(clrVal);
      card.appendChild(clrRow);

      /* Hole-to-hole readout: the closest other hole and the ligament width
         between the two nominal circles. */
      var nb = holeNeighbour(idx);
      var gapRow = document.createElement('div');
      gapRow.className = 'field clearance-row';
      var gapSpan = document.createElement('span');
      gapSpan.textContent = 'Nearest hole';
      var gapVal = document.createElement('b');
      if (!nb) {
        gapVal.textContent = 'no other hole to compare';
        gapVal.className = 'clearance-neutral';
      } else {
        var minW = Math.max(0, num(part.minWall, 2));
        var gapState = nb.gap < -0.001 ? 'bad' : (nb.gap < minW ? 'warn' : 'ok');
        var gapText = nb.gap < -0.001
          ? (nb.label + ' · overlaps by ' + fmt(Math.abs(nb.gap), 2) + ' mm')
          : (nb.label + ' · ' + fmt(nb.gap, 2) + ' mm gap' +
             (nb.gap < minW ? '  · below ' + minW + ' mm min wall' : ''));
        gapVal.textContent = gapText;
        gapVal.className = gapState === 'bad' ? 'clearance-bad'
          : gapState === 'warn' ? 'clearance-warn' : 'clearance-ok';
      }
      gapRow.appendChild(gapSpan);
      gapRow.appendChild(gapVal);
      card.appendChild(gapRow);

      var grid = document.createElement('div');
      grid.className = 'hole-grid';
      grid.appendChild(numberField('X', hole.x, '', function (v) {
        if (derived) return;
        if (hole.x !== v) recordMacro('Cut' + (idx + 1) + ' X ' + v);
        hole.x = v; if (isSeed) applyPattern(); rebuild();
      }, 1, 'holes.' + idx + '.x', { min: -2000, max: 2000, note: 'sketch X in mm' }));
      grid.appendChild(numberField('Y', hole.y, '', function (v) {
        if (derived) return;
        if (hole.y !== v) recordMacro('Cut' + (idx + 1) + ' Y ' + v);
        hole.y = v; if (isSeed) applyPattern(); rebuild();
      }, 1, 'holes.' + idx + '.y', { min: -2000, max: 2000, note: 'sketch Y in mm' }));
      grid.appendChild(numberField('Dia', hole.d, '', function (v) {
        if (derived) return;
        if (isSeed) {
          hole.d = v;
          applyPattern();
          rebuild();
          renderAll();
        } else {
          if (hole.d !== v) recordMacro('Cut' + (idx + 1) + ' Dia ' + v + ' mm');
          hole.d = v; rebuild();
        }
      }, 0.5, 'holes.' + idx + '.d', { min: 0.1, max: 2000, note: 'through-hole diameter',
        dependents: function (v) { return seatDiaConflicts(hole, v); } }));
      card.appendChild(grid);

      /* Mirror feature participation — opt-out toggle; legacy holes (no flag)
         default to true so pre-existing parts keep their mirrored copies. */
      var mrow2 = document.createElement('div');
      mrow2.className = 'shape-picker';
      var mirb = document.createElement('button');
      mirb.className = 'chip' + (hole.mirror !== false ? ' active' : '');
      mirb.textContent = 'In mirror: ' + (hole.mirror !== false ? 'on' : 'off');
      mirb.title = 'Include this hole in the mirror feature';
      mirb.addEventListener('click', function () {
        hole.mirror = hole.mirror === false;
        recordMacro('Cut' + (idx + 1) + ' mirror ' + (hole.mirror ? 'on' : 'off'));
        rebuild(); renderAll();
      });
      mrow2.appendChild(mirb);
      card.appendChild(mrow2);

      if (!derived) {
        var seat = hole.seat && typeof hole.seat === 'object' ? hole.seat : null;
        var seatType = seat && (seat.type === 'cbore' || seat.type === 'csink') ? seat.type : 'none';
        var srow = document.createElement('div');
        srow.className = 'shape-picker';
        [
          { id: 'none', label: 'Plain' },
          { id: 'cbore', label: 'Counterbore' },
          { id: 'csink', label: 'Countersink' }
        ].forEach(function (st) {
          var b = document.createElement('button');
          b.className = 'chip' + (seatType === st.id ? ' active' : '');
          b.textContent = st.label;
          b.addEventListener('click', function () {
            if (st.id === 'none') {
              delete hole.seat;
              recordMacro('Cut' + (idx + 1) + ' plain');
            } else {
              var r0 = holeRadius(hole);
              hole.seat = {
                type: st.id,
                dia: Math.max(r0 * 2 + 0.2, seat && num(seat.dia, 0) > r0 * 2 + 0.2 ? num(seat.dia, 0) : r0 * 2 + 4),
                depth: st.id === 'cbore' ? Math.max(0.1, seat ? num(seat.depth, 3) : 3) : 0
              };
              recordMacro('Cut' + (idx + 1) + ' ' + st.id);
            }
            rebuild(); renderAll();
          });
          srow.appendChild(b);
        });
        card.appendChild(srow);
        if (seatType !== 'none') {
          var sg = document.createElement('div');
          sg.className = 'hole-grid';
          sg.appendChild(numberField('Seat dia', hole.seat.dia, '', function (v) {
            if (hole.seat.dia !== v) recordMacro('Cut' + (idx + 1) + ' seat dia ' + v);
            hole.seat.dia = v; rebuild();
            return 'Rebuilt cut and downstream geometry';
          }, 0.5, 'holes.' + idx + '.seat.dia', { min: 1, minValue: function () { return holeRadius(hole) * 2 + 0.2; }, note: function () { return 'must exceed hole diameter (' + fmt(holeRadius(hole) * 2, 1) + ' mm)'; } }));
          if (seatType === 'cbore') {
            sg.appendChild(numberField('Seat depth', hole.seat.depth, '', function (v) {
              var limit = Math.max(0.1, num(part.extrude.depth, 12) - 0.1);
              var applied = Math.min(v, limit);
              if (hole.seat.depth !== applied) recordMacro('Cut' + (idx + 1) + ' seat depth ' + applied);
              hole.seat.depth = applied; rebuild();
              return applied !== v ? 'Limited to ' + fmt(applied, 1) + ' mm to keep the seat inside the part' : 'Rebuilt cut geometry';
            }, 0.5, 'holes.' + idx + '.seat.depth', { min: 0.1, max: 500, maxValue: function () { return Math.max(0.1, num(part.extrude.depth, 12) - 0.1); }, note: 'must stay below part thickness by 0.1 mm' }));
          } else {
            var cone = document.createElement('div');
            cone.className = 'field';
            var cs = document.createElement('span');
            cs.textContent = 'Included angle';
            var cv = document.createElement('b');
            cv.textContent = '90\u00b0 (fixed)';
            cone.appendChild(cs); cone.appendChild(cv);
            sg.appendChild(cone);
          }
          var sHint = document.createElement('p');
          sHint.className = 'hint';
          sHint.textContent = seatType === 'cbore'
            ? 'Stepped seat from the top face; depth is clamped below the solid thickness.'
            : 'Conical seat from the top face; depth = (seat dia \u2212 hole dia) / 2.';
          card.appendChild(sg);
          card.appendChild(sHint);
        }

        /* Cosmetic thread callout (annotation only — no geometry change). */
        var thr = holeThread(hole);
        var tg = document.createElement('div');
        tg.className = 'hole-grid';
        tg.appendChild(textFieldRow('Thread', thr ? thr.designation : '', 'e.g. M8x1.25', function (txt) {
          var des = String(txt || '').trim().slice(0, 24);
          if (!des) { delete hole.thread; recordMacro('Cut' + (idx + 1) + ' thread none'); rebuild(); renderAll(); return; }
          var prev = holeThread(hole);
          hole.thread = { designation: des, through: prev ? prev.through : false, depth: prev ? num(prev.depth, 10) : 10 };
          recordMacro('Cut' + (idx + 1) + ' thread ' + threadCallout(holeThread(hole)));
          rebuild(); renderAll();
        }));
        var thrPrev = holeThread(hole);
        if (thrPrev && !thrPrev.through) {
          tg.appendChild(numberField('Thread depth', thrPrev.depth, ' mm', function (v) {
            if (!(v > 0)) return;
            if (hole.thread.depth !== v) recordMacro('Cut' + (idx + 1) + ' thread depth ' + v);
            hole.thread.depth = v; rebuild();
          }, 0.5, null, { min: 0.5, max: 500, note: 'under the hole depth' }));
        }
        var thru = document.createElement('button');
        thru.className = 'chip' + (thrPrev && thrPrev.through ? ' active' : '');
        thru.textContent = 'Thru';
        thru.title = 'Thread runs the full hole depth (no depth callout)';
        thru.addEventListener('click', function () {
          var des = thrPrev ? thrPrev.designation : '';
          if (!des) { toast('Type a thread designation first', true); return; }
          hole.thread = { designation: des, through: !thrPrev.through, depth: thrPrev ? num(thrPrev.depth, 10) : 10 };
          recordMacro('Cut' + (idx + 1) + ' thread ' + threadCallout(holeThread(hole)));
          rebuild(); renderAll();
        });
        tg.appendChild(thru);
        card.appendChild(tg);
      }
      if (derived) {
        var dis = card.querySelectorAll('input[type=number]');
        for (var di = 0; di < dis.length; di++) { dis[di].disabled = true; dis[di].style.opacity = '0.6'; }
      }
      if (isSeed) {
        var P = hole.pattern;
        if (!P.mode) P.mode = 'linear';
        var modeRow = document.createElement('div');
        modeRow.className = 'shape-picker';
        [
          { id: 'linear', label: 'Linear' },
          { id: 'vector', label: 'Directional' },
          { id: 'polar', label: 'Polar' }
        ].forEach(function (m) {
          var b = document.createElement('button');
          b.className = 'chip' + (P.mode === m.id ? ' active' : '');
          b.textContent = m.label;
          b.addEventListener('click', function () {
            P.mode = m.id;
            if (m.id === 'polar' && P.count == null) {
              P.count = 6; P.span = 360; P.radius = Math.sqrt(seed.x * seed.x + seed.y * seed.y) || 20;
              P.cx = 0; P.cy = 0;
            }
            if (m.id === 'vector' && P.pitch == null) {
              P.count = 4; P.pitch = 20; P.dir = 0; P.twoWay = false; P.count2 = 4; P.pitch2 = 20;
            }
            applyPattern(); rebuild(); renderAll();
          });
          modeRow.appendChild(b);
        });
        card.appendChild(modeRow);
        if (P.mode === 'vector') {
          var pv = document.createElement('div');
          pv.className = 'hole-grid';
          pv.appendChild(numberField('Count', P.count, '', function (v) {
            var applied = limitCount(v, 24);
            P.count = applied; applyPattern(); rebuild(); renderAll();
            return limitNote(v, applied, 'hole copies', '');
          }, 1, null, { min: 1, max: 24, note: 'whole copies; one seed hole plus copies' }));
          pv.appendChild(numberField('Pitch', P.pitch, ' mm', function (v) {
            var applied = Math.min(500, Math.max(1, v));
            P.pitch = applied; applyPattern(); rebuild();
            return limitNote(v, applied, 'pitch', ' mm');
          }, 1, null, { min: 1, max: 500, note: 'centre-to-centre spacing' }));
          pv.appendChild(numberField('Angle', P.dir, ' deg', function (v) {
            var applied = Math.min(180, Math.max(-180, v));
            P.dir = applied; applyPattern(); rebuild();
            return limitNote(v, applied, 'pattern direction', '\u00b0');
          }, 5, null, { min: -180, max: 180, note: '0 = along +X' }));
          pv.appendChild(numberField('Count 2', P.twoWay ? P.count2 : null, '', function (v) {
            P.twoWay = true;
            var applied = limitCount(v, 24);
            P.count2 = applied; applyPattern(); rebuild(); renderAll();
            return limitNote(v, applied, 'reverse copies (turns on the second direction)', '');
          }, 1, null, { min: 1, max: 24, note: 'whole copies each way' }));
          pv.appendChild(numberField('Pitch 2', P.twoWay ? P.pitch2 : null, ' mm', function (v) {
            P.twoWay = true;
            var applied = Math.min(500, Math.max(1, v));
            P.pitch2 = applied; applyPattern(); rebuild();
            return limitNote(v, applied, 'reverse pitch (turns on the second direction)', ' mm');
          }, 1, null, { min: 1, max: 500, note: 'centre-to-centre spacing' }));
          pv.appendChild(textFieldRow('Skip', P.skip, 'e.g. 2,4', function (txt) {
            P.skip = parseSkipList(txt); applyPattern(); rebuild();
          }));
          card.appendChild(pv);
        } else if (P.mode === 'polar') {
          var pg2 = document.createElement('div');
          pg2.className = 'hole-grid';
          pg2.appendChild(numberField('Count', P.count, '', function (v) {
            var applied = limitCount(v, 24);
            P.count = applied; applyPattern(); rebuild(); renderAll();
            return limitNote(v, applied, 'holes around the circle', '');
          }, 1, null, { min: 1, max: 24, note: 'whole copies' }));
          pg2.appendChild(numberField('Span', P.span, ' deg', function (v) {
            var applied = Math.min(360, Math.max(10, v));
            P.span = applied; applyPattern(); rebuild();
            return limitNote(v, applied, 'arc span', '\u00b0');
          }, 5, null, { min: 10, max: 360, note: 'total arc covered' }));
          pg2.appendChild(numberField('Radius', P.radius, ' mm', function (v) {
            var applied = Math.max(0, v);
            P.radius = applied; applyPattern(); rebuild();
            return limitNote(v, applied, 'pattern radius', ' mm');
          }, 1, null, { min: 0, max: 2000, note: 'distance from the pattern centre' }));
          pg2.appendChild(numberField('Ctr X', P.cx, '', function (v) {
            P.cx = v; applyPattern(); rebuild();
            return 'Rebuilt the polar pattern about X ' + fmt(v, 1) + ' mm';
          }, 1, null, { min: -2000, max: 2000, note: 'pattern centre X in mm' }));
          pg2.appendChild(numberField('Ctr Y', P.cy, '', function (v) {
            P.cy = v; applyPattern(); rebuild();
            return 'Rebuilt the polar pattern about Y ' + fmt(v, 1) + ' mm';
          }, 1, null, { min: -2000, max: 2000, note: 'pattern centre Y in mm' }));
          pg2.appendChild(textFieldRow('Skip', P.skip, 'e.g. 2,4', function (txt) {
            P.skip = parseSkipList(txt); applyPattern(); rebuild();
          }));
          card.appendChild(pg2);
        } else {
          var pg = document.createElement('div');
          pg.className = 'hole-grid';
          pg.appendChild(numberField('Rows', P.rows, '', function (v) {
            var applied = limitCount(v, 10);
            P.rows = applied; applyPattern(); rebuild(); renderAll();
            return limitNote(v, applied, 'grid rows', '');
          }, 1, null, { min: 1, max: 10, note: 'whole rows' }));
          pg.appendChild(numberField('Cols', P.cols, '', function (v) {
            var applied = limitCount(v, 10);
            P.cols = applied; applyPattern(); rebuild(); renderAll();
            return limitNote(v, applied, 'grid columns', '');
          }, 1, null, { min: 1, max: 10, note: 'whole columns' }));
          pg.appendChild(numberField('Pitch X', P.dx, ' mm', function (v) {
            P.dx = v; applyPattern(); rebuild();
            return 'Rebuilt the grid at ' + fmt(v, 1) + ' mm column spacing';
          }, 1, null, { min: -2000, max: 2000, note: 'column spacing; negative runs the other way' }));
          pg.appendChild(numberField('Pitch Y', P.dy, ' mm', function (v) {
            P.dy = v; applyPattern(); rebuild();
            return 'Rebuilt the grid at ' + fmt(v, 1) + ' mm row spacing';
          }, 1, null, { min: -2000, max: 2000, note: 'row spacing; negative runs the other way' }));
          card.appendChild(pg);
          var ck = document.createElement('label');
          ck.className = 'field';
          ck.innerHTML = '<span>Center grid</span>';
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = !!P.centered;
          cb.addEventListener('change', function () {
            P.centered = cb.checked; applyPattern(); rebuild();
          });
          ck.appendChild(cb);
          card.appendChild(ck);
        }
        var addP = document.createElement('button');
        addP.className = 'link';
        addP.textContent = 'Dissolve pattern into individual holes';
        addP.addEventListener('click', function () {
          for (var k = 0; k < part.holes.length; k++) delete part.holes[k].derived;
          delete part.holes[0].pattern;
          recordMacro('Dissolve hole pattern');
          renderAll();
        });
        card.appendChild(addP);
      }
      holeFields.appendChild(card);
    });

    var sum = document.getElementById('clearance-summary');
    if (sum) {
      var min = minEdgeClearance();
      if (min === null) {
        sum.textContent = 'Hole clearance: add a hole to see the readout.';
      } else if (min < 0) {
        sum.textContent = 'Hole clearance: a circle crosses or leaves the profile — fix the sketch.';
        sum.className = 'hint clearance-bad';
      } else {
        sum.textContent = 'Minimum edge clearance: ' + fmt(min, 2) + ' mm' +
          (min < num(part.minWall, 2) ? ' — below ' + num(part.minWall, 2) + ' mm min wall' : '');
        sum.className = 'hint ' + (min < num(part.minWall, 2) ? 'clearance-warn' : 'clearance-ok');
      }
    }

    var spacing = document.getElementById('spacing-summary');
    if (spacing) {
      var pair = part.feature === 'extrude' ? holeSpacingPairs() : null;
      var minWall = Math.max(0, num(part.minWall, 2));
      if (part.feature !== 'extrude') {
        spacing.textContent = 'Hole-to-hole spacing: checked for extruded parts only.';
        spacing.className = 'hint clearance-neutral';
      } else if (!pair) {
        spacing.textContent = 'Hole-to-hole spacing: add a second hole to compare gaps.';
        spacing.className = 'hint clearance-neutral';
      } else {
        var near = pair.a < part.holes.length ? ('Hole ' + (pair.a + 1))
          : 'a mirrored copy';
        var far = pair.b < part.holes.length ? ('Hole ' + (pair.b + 1))
          : 'a mirrored copy';
        var where = pair.a < part.holes.length && pair.b < part.holes.length
          ? (pair.a + 1) + ' and ' + (pair.b + 1)
          : near + ' and ' + far;
        if (pair.gap < -0.001) {
          spacing.textContent = 'Hole-to-hole spacing: holes ' + where + ' overlap by ' +
            fmt(Math.abs(pair.gap), 2) + ' mm — the cut is not a valid through-hole pair.';
          spacing.className = 'hint clearance-bad';
        } else {
          spacing.textContent = 'Narrowest hole-to-hole gap: ' + fmt(pair.gap, 2) + ' mm between holes ' +
            where + (pair.gap < minWall ? ' — below ' + minWall + ' mm min wall' : '');
          spacing.className = 'hint ' + (pair.gap < minWall ? 'clearance-warn' : 'clearance-ok');
        }
        spacing.textContent += ' (' + pair.count + ' circles compared; nominal diameters only.)';
      }
    }
  }

  function renderTree() {
    renderMacroPanel();
    var tree = document.getElementById('tree');
    tree.innerHTML = '';
    function row(icon, label, detail) {
      var d = document.createElement('div');
      d.className = 'tree-row';
      d.innerHTML = '<i>' + icon + '</i><span>' + label + '</span>' +
        (detail ? '<em>' + detail + '</em>' : '');
      return d;
    }
    tree.appendChild(row('P', part.name || 'Part', part.material));
    var shapeLabel = { rect: 'Rectangle', circle: 'Circle', hex: 'Hexagon', L: 'L-profile', slot: 'Slot' }[part.sketch.type] || 'Sketch';
    var dims = part.sketch.type === 'circle'
      ? 'D' + part.sketch.width
      : part.sketch.width + ' x ' + part.sketch.height;
    if (part.sketch.type === 'rect' && part.sketch.corner === 'chamfer' && part.sketch.round > 0.02) dims += '  chamfer ' + part.sketch.round;
    tree.appendChild(row('S', 'Sketch1', shapeLabel + '  ' + dims));
    if (part.feature === 'revolve') {
      tree.appendChild(row('E', 'Revolve1', 'around Y  ' + (part.revolve.angle || 360) + ' deg'));
    } else {
      tree.appendChild(row('E', 'Extrude1', 'mid-plane  ' + part.extrude.depth + ' mm'));
    }
    if (part.mirror && part.mirror.axis !== 'none') {
      var mlabel = part.mirror.axis === 'x' ? 'Y' : part.mirror.axis === 'y' ? 'X' :
        'axis line ' + num(part.mirror.angle, 45) + '\u00b0 through origin';
      tree.appendChild(row('M', 'Mirror1', 'holes about ' + mlabel));
    }
    (part.pushPulls || []).forEach(function (op, i) {
      tree.appendChild(row('↕', op.name || ('PushPull' + (i + 1)), (op.side > 0 ? 'top' : 'bottom') + ' face  ' + (op.distance > 0 ? '+' : '') + op.distance + ' mm'));
    });
    var cutHoles = mirroredHoles();
    cutHoles.forEach(function (h, i) {
      var isSeed = i === 0 && h.pattern;
      var patTxt = h.pattern && h.pattern.mode === 'polar'
        ? 'polar ' + h.pattern.count + '× over ' + h.pattern.span + '° r' + Math.round(num(h.pattern.radius, 0))
          + (Array.isArray(h.pattern.skip) && h.pattern.skip.length ? ' skip ' + h.pattern.skip.join(',') : '')
        : h.pattern && h.pattern.mode === 'vector' ? 'linear ' + h.pattern.count + '\u00d7 @ ' + Math.round(h.pattern.dir) + '\u00b0' + (h.pattern.twoWay ? ' two-way' : '')
          + (Array.isArray(h.pattern.skip) && h.pattern.skip.length ? ' skip ' + h.pattern.skip.join(',') : '')
        : h.pattern ? 'pattern ' + h.pattern.rows + 'x' + h.pattern.cols : '';
      var seatTxt = '';
      if (h.seat && h.seat.type === 'cbore') seatTxt = '  · \u2300' + h.seat.dia + ' cbore ' + h.seat.depth;
      else if (h.seat && h.seat.type === 'csink') seatTxt = '  · \u2300' + h.seat.dia + ' csink 90\u00b0';
      var thrTxt = holeThread(h) ? '  · ' + threadCallout(holeThread(h)) : '';
      var detail = 'Dia ' + h.d + '  @ ' + h.x + ', ' + h.y + seatTxt + thrTxt +
        (isSeed ? '  · ' + patTxt :
         h.derived ? '  · from pattern' : '');
      tree.appendChild(row('H', 'Cut' + (i + 1), detail));
    });
  }

  function renderMaterialSelect() {
    var sel = document.getElementById('material');
    sel.innerHTML = '';
    MATERIALS.forEach(function (m) {
      var o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.name;
      o.selected = m.id === part.material;
      sel.appendChild(o);
    });
  }


  function renderEqFields() {
    var box = document.getElementById('eq-fields');
    if (!box) return;
    box.innerHTML = '';
    var eq = part.equations;
    var names = Object.keys(eq.vars);
    var addBtn = document.getElementById('btn-add-var');
    if (addBtn) {
      addBtn.style.display = names.length >= EQ.MAX_VARS ? 'none' : '';
      addBtn.onclick = function () {
        var base = 'var';
        var n = base, k = 1;
        while (Object.prototype.hasOwnProperty.call(eq.vars, n)) { n = base + (++k); }
        eq.vars[n] = 10;
        renderAll();
        toast('Variable "' + n + '" added — set an expression like plateW / 4');
      };
    }
    if (!names.length) {
      var p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'No variables yet. Add one, then type its name into any dimension to drive it by equation.';
      box.appendChild(p);
      return;
    }
    names.forEach(function (name) {
      var wrap = document.createElement('label');
      wrap.className = 'field eq-var';
      var span = document.createElement('span');
      span.textContent = name;
      var input = document.createElement('input');
      input.type = 'text';
      input.value = String(eq.vars[name]);
      input.maxLength = 80;
      input.placeholder = 'number or expression';
      var apply = function () {
        var raw = input.value.trim();
        if (!raw) { delete eq.vars[name]; renderAll(); return; }
        var st = EQ.checkSyntax(raw);
        if (!st.ok) { renderEqHint(); input.className = 'bad'; return; }
        input.className = '';
        eq.vars[name] = raw;
        rebuild();
        refreshBoundInputs();
      };
      input.addEventListener('change', apply);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') apply(); });
      wrap.appendChild(span);
      wrap.appendChild(input);
      var del = document.createElement('button');
      del.className = 'link-danger';
      del.textContent = '×';
      del.title = 'Remove variable (bindings using it will error)';
      del.addEventListener('click', function () { delete eq.vars[name]; renderAll(); toast('Variable "' + name + '" removed'); });
      wrap.appendChild(del);
      box.appendChild(wrap);
    });
    renderEqHint();
  }

  function renderAll() {
    renderSketchFields();
    renderExtrudeFields();
    renderHoleFields();
    renderTree();
    renderMaterialSelect();
    renderEqFields();
    renderMacroPanel();
    rebuild();
    refreshBoundInputs();
    fitView();
  }


  /* ------------------------------------------------------ global equations */

  function normalizeEquations(raw) {
    var vars = {};
    var bindings = {};
    if (raw && typeof raw === 'object') {
      var vin = raw.vars && typeof raw.vars === 'object' && !Array.isArray(raw.vars) ? raw.vars : {};
      var vkeys = Object.keys(vin).slice(0, 20);
      for (var i = 0; i < vkeys.length; i++) {
        var n = String(vkeys[i]);
        if (!EQ.isValidName(n)) continue;
        var v = vin[n];
        vars[n] = typeof v === 'number' && isFinite(v) ? v : String(v == null ? '' : v).slice(0, 80);
      }
      var bin = raw.bindings && typeof raw.bindings === 'object' && !Array.isArray(raw.bindings) ? raw.bindings : {};
      var bkeys = Object.keys(bin).slice(0, 40);
      for (var b = 0; b < bkeys.length; b++) {
        var p = String(bkeys[b]);
        if (!/^[a-z]+(\.[a-z0-9]+){1,2}$/i.test(p)) continue;
        bindings[p] = typeof bin[p] === 'number' && isFinite(bin[p]) ? bin[p] : String(bin[p] == null ? '' : bin[p]).slice(0, 80);
      }
    }
    return { vars: vars, bindings: bindings };
  }

  function eqPart() { return part; }

  /* Paths a binding may target, each with getter/setter on the live part. */
  function eqPaths() {
    var paths = {
      'sketch.width': function (v) { part.sketch.width = v; },
      'sketch.height': function (v) { part.sketch.height = v; },
      'sketch.round': function (v) { part.sketch.round = v; },
      'extrude.depth': function (v) { part.extrude.depth = v; },
      'shell.wall': function (v) { if (part.shell && part.shell.on) part.shell.wall = v; },
      'mirror.angle': function (v) { if (part.mirror && part.mirror.axis === 'line') part.mirror.angle = v; }
    };
    for (var ci3 = 0; ci3 < 4; ci3++) {
      (function (k) {
        paths['sketch.corners.' + k + '.r'] = function (v) {
          if (!Array.isArray(part.sketch.corners) || part.sketch.corners.length !== 4) part.sketch.corners = sanitizeCorners(null);
          part.sketch.corners[k].on = true;
          part.sketch.corners[k].r = v;
        };
      })(ci3);
    }
    for (var i = 0; i < part.holes.length && i < 24; i++) {
      (function (k) {
        paths['holes.' + k + '.x'] = function (v) { part.holes[k].x = v; };
        paths['holes.' + k + '.y'] = function (v) { part.holes[k].y = v; };
        paths['holes.' + k + '.d'] = function (v) { part.holes[k].d = v; };
      })(i);
    }
    return paths;
  }

  /* Resolve vars + bindings, write results into the part, return {ok, errors}. */
  function applyEquations() {
    var eq = part.equations || (part.equations = { vars: {}, bindings: {} });
    var res = EQ.resolveAll(eq.vars, eq.bindings);
    var paths = eqPaths();
    var dims = res.dims || {};
    var keys = Object.keys(dims);
    for (var i = 0; i < keys.length; i++) {
      var path = keys[i];
      var set = paths[path];
      if (set) set(clampDim(path, dims[path]));
    }
    return res;
  }

  function clampDim(path, v) {
    if (path === 'extrude.depth' || path === 'sketch.width' || path === 'sketch.height') return Math.min(2000, Math.max(0.5, v));
    if (path === 'sketch.round') return Math.min(500, Math.max(0, v));
    if (path === 'shell.wall') return Math.min(500, Math.max(0.1, v));
    if (path.indexOf('sketch.corners.') === 0) return Math.min(500, Math.max(0, v));
    if (path === 'mirror.angle') return Math.min(180, Math.max(-180, v));
    return Math.min(1000, Math.max(0.1, v));
  }

  /* Recompute every numberField with an expression binding after an edit. */
  function refreshBoundInputs() {
    var inputs = document.querySelectorAll('input[data-eqpath]');
    var dims = EQ.resolveAll(part.equations.vars, part.equations.bindings).dims || {};
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var path = el.getAttribute('data-eqpath');
      if (el === document.activeElement) continue;
      var hasExpr = part.equations.bindings[path] != null && typeof part.equations.bindings[path] === 'string' && part.equations.bindings[path].length > 0;
      if (dims[path] != null) el.value = Math.round(dims[path] * 1000) / 1000;
      el.disabled = !!hasExpr && dims[path] != null;
      el.style.opacity = hasExpr && dims[path] != null ? '' : '';
      var lbl = el.parentNode && el.parentNode.getAttribute('data-bound');
      el.parentNode.className = 'field' + (hasExpr && dims[path] != null ? ' bound' : '');
    }
    if (inputs.length) renderEqHint();
  }

  function eqStatus() {
    return EQ.resolveAll(part.equations.vars, part.equations.bindings);
  }

  function renderEqHint() {
    var el = document.getElementById('eq-hint');
    if (!el) return;
    var st = eqStatus();
    el.textContent = st.ok ? 'Change a variable — every bound dimension updates.' : st.errors.slice(0, 3).join(' · ');
    el.className = 'hint' + (st.ok ? '' : ' eq-error');
  }

  /* ------------------------------------------------------------------ STL */

  function exportStl() {
    if (!mesh) return;
    var geo = mesh.geometry;
    var pos = geo.attributes.position;
    var index = geo.index;
    var normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);

    var triCount = index ? index.count / 3 : pos.count / 3;
    var buffer = new ArrayBuffer(84 + triCount * 50);
    var dv = new DataView(buffer);
    var header = 'WebSolid parametric part - ' + (part.name || 'part');
    for (var i = 0; i < Math.min(80, header.length); i++) dv.setUint8(i, header.charCodeAt(i));
    dv.setUint32(80, triCount, true);

    var a = new THREE.Vector3();
    var b = new THREE.Vector3();
    var c = new THREE.Vector3();
    var cb = new THREE.Vector3();
    var ab = new THREE.Vector3();
    var n = new THREE.Vector3();
    var offset = 84;

    for (var t = 0; t < triCount; t++) {
      var i0 = index ? index.getX(t * 3) : t * 3;
      var i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      var i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, i1);
      c.fromBufferAttribute(pos, i2);
      cb.subVectors(c, b);
      ab.subVectors(a, b);
      n.crossVectors(cb, ab);
      if (n.lengthSq() > 0) n.normalize(); else n.set(0, 0, 1);

      dv.setFloat32(offset, n.x, true); dv.setFloat32(offset + 4, n.y, true); dv.setFloat32(offset + 8, n.z, true);
      dv.setFloat32(offset + 12, a.x, true); dv.setFloat32(offset + 16, a.y, true); dv.setFloat32(offset + 20, a.z, true);
      dv.setFloat32(offset + 24, b.x, true); dv.setFloat32(offset + 28, b.y, true); dv.setFloat32(offset + 32, b.z, true);
      dv.setFloat32(offset + 36, c.x, true); dv.setFloat32(offset + 40, c.y, true); dv.setFloat32(offset + 44, c.z, true);
      dv.setUint16(offset + 48, 0, true);
      offset += 50;
    }

    var blob = new Blob([buffer], { type: 'model/stl' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = (part.name || 'part').replace(/[^a-z0-9\-_]+/gi, '-').toLowerCase() + '.stl';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    var msg = 'Exported ' + triCount + ' triangles';
    if (printSummary) {
      msg += printSummary.stale ? ' — Printability estimate is stale; run Check again' : (printSummary.ok ? ' — Printability: OK' : ' — Printability: ' + printSummary.fails + ' issue' + (printSummary.fails === 1 ? '' : 's') + ' (see panel)');
    }
    toast(msg);
  }

  /* ------------------------------------------------- printability checks */

  /* Feed the exported triangle soup (world-space, exactly what the STL
     contains) to SolidPrintability and render pass/fail chips. Hole checks
     use the nominal hole list for extruded parts; revolved parts skip it. */
  var printSummary = null;

  function printabilityInputKey() {
    if (!mesh || !mesh.geometry || !mesh.geometry.attributes.position || !window.SolidPrintability) return '';
    var pos = mesh.geometry.attributes.position;
    var th = window.SolidPrintability.thresholds({ printability: part.printability });
    var holes = part.feature === 'extrude'
      ? mirroredHoles().map(function (h) { return num(h.d, 0); }).filter(function (d) { return d > 0; })
      : [];
    var h1 = 2166136261, h2 = 2246822519;
    for (var i = 0; i < pos.array.length; i++) {
      // Coordinates are in mm; quantize below sub-micron precision before hashing.
      var q = Math.round(pos.array[i] * 100000);
      h1 = Math.imul(h1 ^ q, 16777619);
      h2 = Math.imul(h2 ^ q, 3266489917);
    }
    var assumptions = [part.feature, th.profile, th.minWall, th.minHole, th.overhang].concat(holes);
    for (var k = 0; k < assumptions.length; k++) {
      var value = assumptions[k];
      var text = String(value) + '|';
      for (var j = 0; j < text.length; j++) {
        var code = text.charCodeAt(j);
        h1 = Math.imul(h1 ^ code, 16777619);
        h2 = Math.imul(h2 ^ code, 3266489917);
      }
    }
    return (h1 >>> 0).toString(36) + ':' + (h2 >>> 0).toString(36) + ':' + pos.array.length;
  }

  function refreshPrintStaleness() {
    var banner = document.getElementById('print-stale');
    var chips = document.getElementById('print-chips');
    if (!printSummary) {
      if (banner) banner.hidden = true;
      if (chips) chips.removeAttribute('data-stale');
      return false;
    }
    printSummary.stale = printSummary.key !== printabilityInputKey();
    if (banner) {
      banner.hidden = !printSummary.stale;
      banner.textContent = printSummary.stale
        ? 'These estimates are from an earlier part or profile. Run Check again before relying on them.' : '';
    }
    if (chips) {
      if (printSummary.stale) chips.setAttribute('data-stale', 'true');
      else chips.removeAttribute('data-stale');
    }
    return printSummary.stale;
  }

  function runPrintability() {
    if (!mesh || !window.SolidPrintability) return;
    var geo = mesh.geometry;
    var pos = geo.attributes.position;
    var index = geo.index;
    var triCount = index ? index.count / 3 : pos.count / 3;
    var tris = new Float64Array(triCount * 9);
    var a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    var o = 0;
    for (var t = 0; t < triCount; t++) {
      var i0 = index ? index.getX(t * 3) : t * 3;
      var i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      var i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);
      tris[o] = a.x; tris[o + 1] = a.y; tris[o + 2] = a.z;
      tris[o + 3] = b.x; tris[o + 4] = b.y; tris[o + 5] = b.z;
      tris[o + 6] = c.x; tris[o + 7] = c.y; tris[o + 8] = c.z;
      o += 9;
    }
    var th = window.SolidPrintability.thresholds({ printability: part.printability });
    var res = window.SolidPrintability.analyze(tris, th);
    var holeDiams = part.feature === 'extrude'
      ? mirroredHoles().map(function (h) { return num(h.d, 0); }).filter(function (d) { return d > 0; })
      : [];
    var vs = window.SolidPrintability.verdicts(res, th, holeDiams);
    var hints = {
      manifold: 'Mesh-wide topology check: counts edges and connected triangle shells; it does not certify every slicer or machine.',
      wall: 'Global mesh estimate: casts inward from triangle centroids; skipped when the mesh exceeds the analyzer limit. Review the wall-thickness input and feature dimensions.',
      hole: 'Feature-list check: compares nominal hole diameters to the selected minimum; it does not measure arbitrary mesh openings.',
      overhang: 'Global mesh check: compares downward-facing triangle area and angle against the selected threshold; it does not mark a location in the viewport.',
      shell: 'Mesh-wide connectedness and volume check; not a pressure, strength, or manufacturing validation.'
    };
    var nextSteps = {
      manifold: 'If this fails, simplify or revise the sketch and cut features, then rerun Check.',
      wall: 'If below the minimum, review the wall value, sketch size, holes, and material/process setting; results are an estimate.',
      hole: 'If too small, review the relevant hole-diameter fields and target process guidance.',
      overhang: 'If this fails, consider a different part orientation or revise the geometry; no problem region is highlighted.',
      shell: 'If disconnected, review the sketch and hole positions; if volume is absent, rebuild the part before export.'
    };
    var fails = 0;
    var chips = document.getElementById('print-chips');
    if (chips) {
      chips.replaceChildren();
      for (var i = 0; i < vs.length; i++) {
        var v = vs[i];
        if (!v.pass) fails++;
        var card = document.createElement('div');
        card.className = 'print-chip ' + (v.pass ? 'pass' : 'fail');
        var title = document.createElement('b');
        title.textContent = (v.pass ? '✓ ' : '✗ ') + v.label;
        var detail = document.createElement('span');
        detail.className = 'print-detail';
        detail.textContent = v.note + ' — ' + hints[v.id];
        var next = document.createElement('span');
        next.className = 'print-next';
        next.textContent = (v.pass ? 'Review: ' : 'Next: ') + nextSteps[v.id];
        card.appendChild(title);
        card.appendChild(detail);
        card.appendChild(next);
        chips.appendChild(card);
      }
    }
    printSummary = {
      ok: fails === 0, fails: fails, key: printabilityInputKey(), stale: false,
      profile: th.profile, thresholds: th, triangles: triCount,
      checks: vs.map(function (v) { return { id: v.id, label: v.label, pass: v.pass, note: v.note }; })
    };
    var assumptions = document.getElementById('print-assumption-inputs');
    if (assumptions) assumptions.textContent =
      'Current run: ' + fmt(triCount, 0) + ' triangles from the exported mesh; ' +
      (th.profile === 'resin' ? 'resin' : 'FDM') + ' profile; configured thresholds — minimum wall '
      fmt(th.minWall, 2) + ' mm, minimum hole ' + fmt(th.minHole, 2) + ' mm, overhang ' +
      fmt(th.overhang, 0) + '°; ' + holeDiams.length + ' nominal hole diameter' +
      (holeDiams.length === 1 ? '' : 's') + ' considered. Changes to the part or profile require a new Check.';
    var note = document.getElementById('print-note');
    if (note) note.textContent = fails === 0
      ? 'All analyzed checks passed for the ' + th.profile + ' profile. Review these estimates before export; this is not a manufacturing or safety guarantee.'
      : fails + ' check' + (fails === 1 ? '' : 's') + ' need review before export. These estimates do not identify exact viewport locations or certify manufacturability.';
    refreshPrintStaleness();
    return printSummary;
  }

  function currentCheckSummary() {
    refreshPrintStaleness();
    var mat = findMaterial(part.material);
    var pk = num(part.costPrice && part.costPrice[part.material], COST.pricePerKg[part.material]);
    var est = metrics ? computeCostEstimate(part, mat, metrics.volumeMm3, mirroredHoles(), pk) : null;
    var b = est ? est.basis : costBasisFor(part, mat, pk);
    var pf = buildPreflight();
    var ctx = {
      name: part.name || 'Untitled part',
      feature: part.feature,
      metrics: metrics ? { volumeCm3: metrics.volumeCm3, massG: metrics.massG, bbox: metrics.bbox, tris: metrics.tris } : null,
      material: b ? { id: b.materialId, name: b.materialName, density: b.density, pricePerKg: b.pricePerKg, priceSource: b.priceSource, defaultPricePerKg: b.defaultPricePerKg } : null,
      cost: est ? { raw: est.rawMaterialCost, drilling: est.drillingCost, total: est.total, holeCount: est.holeCount } : null,
      print: printSummary ? {
        ran: true, profile: printSummary.profile, ok: printSummary.ok, fails: printSummary.fails,
        stale: Boolean(printSummary.stale), triangles: printSummary.triangles,
        thresholds: printSummary.thresholds, checks: printSummary.checks
      } : { ran: false },
      preflight: pf
    };
    if (window.SolidCheckSummary && window.SolidCheckSummary.buildSummary) {
      return window.SolidCheckSummary.buildSummary(ctx);
    }
    return 'WebSolid check summary\nPart: ' + ctx.name;
  }

  function copyCheckSummary() {
    var txt = currentCheckSummary();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = txt;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      document.body.removeChild(ta);
      toast(ok ? 'Check summary copied to clipboard' : 'Copy failed — clipboard unavailable', !ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast('Check summary copied to clipboard'); }, fallback);
    } else fallback();
  }

  /* -------------------------------------------------------- 2D drawing export */

  /* Orthographic drawing export: project the solid's feature edges (from an
     EdgesGeometry overlay, same threshold as the shaded view) into top / front
     / right views on an A3-landscape SVG sheet with a title block. No BREP
     kernel needed — edges come straight from the triangulated solid. */

  function exportDrawing() {
    if (!mesh) return;
    var geo = mesh.geometry;
    var pos = geo.attributes.position;
    var index = geo.index;
    var mw = mesh.matrixWorld;
    var v = new THREE.Vector3();

    /* world-space triangles for volume + edges */
    var triCount = index ? index.count / 3 : pos.count / 3;
    var vol = 0, tri = [];
    var boxMin = [Infinity, Infinity, Infinity], boxMax = [-Infinity, -Infinity, -Infinity];
    var a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    var ab = new THREE.Vector3(), ac = new THREE.Vector3(), cr = new THREE.Vector3();
    for (var t = 0; t < triCount; t++) {
      var i0 = index ? index.getX(t * 3) : t * 3;
      var i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      var i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(mw);
      b.fromBufferAttribute(pos, i1).applyMatrix4(mw);
      c.fromBufferAttribute(pos, i2).applyMatrix4(mw);
      [a, b, c].forEach(function (pt) {
        var coords = [pt.x, pt.y, pt.z];
        for (var axis = 0; axis < 3; axis++) {
          if (coords[axis] < boxMin[axis]) boxMin[axis] = coords[axis];
          if (coords[axis] > boxMax[axis]) boxMax[axis] = coords[axis];
        }
      });
      vol += a.dot(cr.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a))) / 6;
      tri.push([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z]);
    }
    vol = Math.abs(vol);

    /* feature edges with the same look as the shaded view */
    var eg = new THREE.EdgesGeometry(geo, 25);
    var ep = eg.attributes.position;
    var segs = [];
    for (var e = 0; e < ep.count; e += 2) {
      var p0 = new THREE.Vector3().fromBufferAttribute(ep, e).applyMatrix4(mw);
      var p1 = new THREE.Vector3().fromBufferAttribute(ep, e + 1).applyMatrix4(mw);
      segs.push([p0.x, p0.y, p0.z, p1.x, p1.y, p1.z]);
    }
    eg.dispose();
    if (!segs.length) { toast('Nothing to draw yet — build the part first', true); return; }

    /* views: [name, map(x,y,z) -> [u,v]]  v grows downward on paper */
    var views = [
      { name: 'TOP',   map: function (p) { return [p[0], -p[2]]; } },
      { name: 'FRONT', map: function (p) { return [p[0], -p[1]]; } },
      { name: 'RIGHT', map: function (p) { return [p[2], -p[1]]; } }
    ];

    /* bounds of every projected view, for one shared scale (true ortho) */
    var gmin = [Infinity, Infinity], gmax = [-Infinity, -Infinity];
    var projected = views.map(function (vw) {
      var pts = segs.map(vw.map);
      var mn = [Infinity, Infinity], mx = [-Infinity, -Infinity];
      for (var i = 0; i < pts.length; i++) {
        if (pts[i][0] < mn[0]) mn[0] = pts[i][0]; if (pts[i][0] > mx[0]) mx[0] = pts[i][0];
        if (pts[i][1] < mn[1]) mn[1] = pts[i][1]; if (pts[i][1] > mx[1]) mx[1] = pts[i][1];
      }
      if (mn[0] < gmin[0]) gmin[0] = mn[0]; if (mx[0] > gmax[0]) gmax[0] = mx[0];
      if (mn[1] < gmin[1]) gmin[1] = mn[1]; if (mx[1] > gmax[1]) gmax[1] = mx[1];
      return { pts: pts, mn: mn, mx: mx };
    });
    var gW = Math.max(1e-6, gmax[0] - gmin[0]), gH = Math.max(1e-6, gmax[1] - gmin[1]);

    var W = 900, H = 640, M = 56;              /* sheet + margin */
    var colW = (W - 2 * M) / 2, rowH = (H - 2 * M - 64) / 2;   /* 64 for title block */
    var pad = 18;
    var scale = Math.min((colW - pad) / gW, (rowH - pad) / gH) * 0.92;
    var cells = [[M + colW / 2, M + rowH / 2], [M + colW / 2, M + rowH + rowH / 2], [M + colW + colW / 2, M + rowH + rowH / 2]];

    /* dedupe identical projected segments (shared edges drawn twice) */
    var seen = {}, out = '';
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
    function f(n) { return Math.round(n * 100) / 100; }

    for (var vi = 0; vi < 3; vi++) {
      var vp = projected[vi], cell = cells[vi];
      var cx = (vp.mn[0] + vp.mx[0]) / 2, cy = (vp.mn[1] + vp.mx[1]) / 2;
      out += '<g>';
      for (var i = 0; i < vp.pts.length; i++) {
        var q = vp.pts[i];
        var x1 = f(cell[0] + (q[0] - cx) * scale), y1 = f(cell[1] + (q[1] - cy) * scale);
        var i2 = i + 1; i++;
        var r = vp.pts[i2];
        var x2 = f(cell[0] + (r[0] - cx) * scale), y2 = f(cell[1] + (r[1] - cy) * scale);
        var key = x1 + ',' + y1 + '|' + x2 + ',' + y2;
        var rkey = x2 + ',' + y2 + '|' + x1 + ',' + y1;
        if (seen[key] || seen[rkey]) continue;
        seen[key] = seen[rkey] = 1;
        out += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '"/>';
      }
      var viewWidth = Math.max(0, vp.mx[0] - vp.mn[0]);
      var viewHeight = Math.max(0, vp.mx[1] - vp.mn[1]);
      var labelY = f(cell[1] + rowH / 2 - 10);
      out += '<text class="vw" x="' + f(cell[0]) + '" y="' + labelY + '" text-anchor="middle">' + views[vi].name + '</text>' +
        '<text class="dim" x="' + f(cell[0]) + '" y="' + f(labelY + 13) + '" text-anchor="middle">' + f(viewWidth) + ' × ' + f(viewHeight) + ' mm</text>';
      out += '</g>';
    }

    var date = new Date().toISOString().slice(0, 10);
    var overallW = Math.max(0, boxMax[0] - boxMin[0]);
    var overallH = Math.max(0, boxMax[1] - boxMin[1]);
    var overallD = Math.max(0, boxMax[2] - boxMin[2]);
    var mass = (vol * 1e-9) * (Number(part.material && part.material.density) || 0);
    var svg = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
      '<style>svg{font-family:ui-monospace,Menlo,monospace;background:#fff}' +
      'line{stroke:#111;stroke-width:1;stroke-linecap:round}' +
      '.vw{font-size:11px;fill:#666;text-anchor:middle}' +
      '.dim{font-size:9px;fill:#111;text-anchor:middle}' +
      '.tb{font-size:11px;fill:#111}.tbh{font-size:9px;fill:#888;letter-spacing:.08em}</style>' +
      '<rect width="' + W + '" height="' + H + '" fill="#ffffff"/>' +
      '<rect x="8" y="8" width="' + (W - 16) + '" height="' + (H - 16) + '" fill="none" stroke="#111" stroke-width="1.5"/>' +
      out +
      '<g>' +
      '<line x1="8" y1="' + (H - 64) + '" x2="' + (W - 8) + '" y2="' + (H - 64) + '" stroke="#111" stroke-width="1.5"/>' +
      '<text class="tbh" x="24" y="' + (H - 48) + '">PART</text>' +
      '<text class="tb" x="24" y="' + (H - 32) + '">' + esc(part.name || 'Untitled part') + '</text>' +
      '<text class="tbh" x="330" y="' + (H - 48) + '">VOLUME</text>' +
      '<text class="tb" x="330" y="' + (H - 32) + '">' + f(vol / 1000) + ' cm&sup3;</text>' +
      '<text class="tbh" x="450" y="' + (H - 48) + '">MASS</text>' +
      '<text class="tb" x="450" y="' + (H - 32) + '">' + (mass > 0 ? f(mass) + ' g' : 'n/a') + '</text>' +
      '<text class="tbh" x="570" y="' + (H - 48) + '">DATE</text>' +
      '<text class="tb" x="570" y="' + (H - 32) + '">' + date + '</text>' +
      '<text class="tb" x="' + (W - 24) + '" y="' + (H - 32) + '" text-anchor="end">WebSolid &mdash; parametric part modeler</text>' +
      '<text class="dim" x="24" y="' + (H - 16) + '" text-anchor="start">Scale: ' + f(scale) + ' px/mm · Overall bounds: ' + f(overallW) + ' × ' + f(overallH) + ' × ' + f(overallD) + ' mm · Reference preview only — not a toleranced manufacturing drawing</text>' +
      '</g></svg>';

    var blob = new Blob([svg], { type: 'image/svg+xml' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = (part.name || 'part').replace(/[^a-z0-9\-_]+/gi, '-').toLowerCase() + '-drawing.svg';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast('Exported 2D drawing (top / front / right) as SVG');
  }

  /* ------------------------------------------------------------------ DXF */

  /* DXF R12 ASCII export of the active sketch: outer profile as LINE
     segments, holes as CIRCLEs. Millimetres. Pure client-side. */
  function dxfEntities() {
    var pts = profilePoints(part.sketch);
    var lines = [];
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i];
      var b = pts[(i + 1) % pts.length];
      if (a[0] !== b[0] || a[1] !== b[1]) lines.push([a, b]);
    }
    var circles = [];
    for (var h = 0; h < part.holes.length; h++) {
      circles.push({
        x: num(part.holes[h].x, 0),
        y: num(part.holes[h].y, 0),
        r: holeRadius(part.holes[h])
      });
      var seatD = holeSeat(part.holes[h]);
      if (seatD) {
        circles.push({
          x: num(part.holes[h].x, 0),
          y: num(part.holes[h].y, 0),
          r: seatD.r
        });
      }
    }
    if (part.mirror && part.mirror.axis === 'line') {
      var ang = mirrorAxisAngle();
      var c = Math.cos(ang), s = Math.sin(ang);
      var L = 200;
      lines.push([[-c * L, -s * L], [c * L, s * L]]);
    }
    return { lines: lines, circles: circles };
  }

  function dxfCode(code, value) {
    return code + '\n' + value + '\n';
  }

  /* CSV bill of materials: one row per effective hole (pattern/mirror
     instances included) followed by a part summary row. Values use dot
     decimals and are rounded to 2 places to stay spreadsheet friendly. */

  function csvCell(v) {
    var s2 = String(v == null ? '' : v);
    if (/[",\n;]/.test(s2)) s2 = '"' + s2.replace(/"/g, '""') + '"';
    return s2;
  }

  function csvLine(cells) {
    var out = [];
    for (var i = 0; i < cells.length; i++) out.push(csvCell(cells[i]));
    return out.join(',');
  }

  /* Cost estimate: derived purely from the existing mass properties and
     the effective hole list (pattern + mirror instances included).
     raw material cost  = finished-part volume x density x price per kg
     drilling cost      = per-hole machining cost: a small setup charge plus
                          volume-removed x rate, weighted by hole type
                          (plain 1.0, counterbore 1.6, countersink 1.4).
     Price per kg defaults per material and is user-editable at runtime. */
  var COST = {
    pricePerKg: { steel: 2.5, aluminium: 5.0, brass: 12.0, abs: 3.0, nylon: 4.0 },
    drillBase: 0.1,      /* setup charge per hole */
    drillPerCm3: 0.02,   /* machining cost per cm3 of removed material */
    weight: { plain: 1, cbore: 1.6, csink: 1.4 }
  };

  /* Volume of stock removed by one hole: the through cylinder plus the
     extra material cut by a counterbore seat or countersink cone.
     Analytic, reusing holeSeat() normalization. */
  function holeRemovedVolume(hole, depth) {
    var r = holeRadius(hole);
    var v = Math.PI * r * r * depth;
    var seat = holeSeat(hole);
    if (seat && seat.type === 'cbore') {
      var dpt = Math.min(seat.depth, depth);
      v += Math.PI * (seat.r * seat.r - r * r) * dpt;
    } else if (seat && seat.type === 'csink') {
      /* frustum of the cone beyond the through-cylinder it overlaps */
      var d2 = Math.min(seat.depth, depth);
      var frustum = Math.PI * d2 / 3 * (seat.r * seat.r + seat.r * r + r * r);
      v += Math.max(0, frustum - Math.PI * r * r * d2);
    }
    return v;
  }

  /* Pure estimate. mat is a MATERIALS entry; pricePerKg overrides the
     material default when finite and positive. holes is the effective
     (pattern/mirror-expanded) hole list; volumeMm3 is the finished solid. */
  function computeCostEstimate(partP, mat, volumeMm3, holes, pricePerKg) {
    var depth = Math.max(0.5, num(partP && partP.extrude && partP.extrude.depth, 12));
    var pk = Number(pricePerKg);
    if (!isFinite(pk) || pk <= 0) pk = COST.pricePerKg[(mat && mat.id)] || 0;
    var density = num(mat && mat.density, 1);
    var raw = (volumeMm3 / 1000) * (density / 1000) * pk;
    var drill = 0;
    var breakdown = [];
    var hs = holes || [];
    for (var i = 0; i < hs.length; i++) {
      var h = hs[i];
      var removed = holeRemovedVolume(h, depth);
      var seat = holeSeat(h);
      var w = seat ? (COST.weight[seat.type] || 1) : 1;
      var cost = COST.drillBase + (removed / 1000) * COST.drillPerCm3 * w;
      drill += cost;
      breakdown.push({
        index: i + 1,
        x: num(h.x, 0), y: num(h.y, 0), d: num(h.d, 8),
        seat: seat ? seat.type : 'plain',
        removedMm3: removed,
        cost: cost
      });
    }
    return {
      basis: costBasisFor(partP, mat, pk),
      pricePerKg: pk,
      rawMaterialCost: raw,
      drillingCost: drill,
      total: raw + drill,
      holeCount: hs.length,
      breakdown: breakdown
    };
  }

  /* Testable entry point (like pushPullTestReplay): sanitize a raw part,
     derive an analytic finished volume (profile minus plain through-holes,
     times depth) and run the estimator. No mesh or DOM needed. */
  function testCostEstimate(raw) {
    var p = sanitizePart(raw);
    var pts = profilePoints(p.sketch);
    var area = polygonArea(pts);
    var depth = Math.max(0.5, num(p.extrude.depth, 12));
    var holeArea = 0;
    for (var i = 0; i < p.holes.length; i++) {
      var r = holeRadius(p.holes[i]);
      holeArea += Math.PI * r * r;
    }
    var vol = Math.max(0, area - holeArea) * depth;
    return computeCostEstimate(p, findMaterial(p.material), vol, p.holes, null);
  }

  function csvNum(v) {
    if (!Number.isFinite(Number(v))) return '';
    return (Math.round(Number(v) * 100) / 100).toString();
  }

  function bomRows() {
    var rows = [];
    var holes = mirroredHoles();
    for (var i = 0; i < holes.length; i++) {
      var h = holes[i];
      var seat = holeSeat(h);
      rows.push({
        kind: 'hole',
        index: i + 1,
        x: h.x, y: h.y, d: h.d,
        seat: seat ? seat.type : 'plain',
        seatDia: seat ? seat.dia : '',
        seatDepth: seat ? seat.depth : '',
        thread: threadCallout(holeThread(h)) || 'plain'
      });
    }
    rows.push({ kind: 'part' });
    return rows;
  }

  function exportBom() {
    if (!metrics) { toast('Nothing to export yet — build the part first', true); return; }
    var mat = findMaterial(part.material);
    var rows = bomRows();
    var lines = [];
    lines.push(csvLine(['type', 'index', 'x_mm', 'y_mm', 'dia_mm', 'seat', 'seat_dia_mm', 'seat_depth_mm', 'thread']));
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.kind === 'hole') {
        lines.push(csvLine(['hole', r.index, csvNum(r.x), csvNum(r.y), csvNum(r.d), r.seat, csvNum(r.seatDia), csvNum(r.seatDepth), r.thread]));
      }
    }
    var b = metrics.bbox || [0, 0, 0];
    lines.push('');
    lines.push(csvLine(['part', '', '', '', '', '', '', '', '']));
    lines.push(csvLine(['name', '', '', '', '', '', '', '', part.name || 'part']));
    lines.push(csvLine(['material', '', '', '', '', '', '', '', mat.name]));
    lines.push(csvLine(['volume_mm3', '', '', '', '', '', '', '', csvNum(metrics.volumeMm3)]));
    lines.push(csvLine(['mass_g', '', '', '', '', '', '', '', csvNum(metrics.massG)]));
    lines.push(csvLine(['bbox_mm', '', '', '', '', '', '', '', csvNum(b[0]) + ' x ' + csvNum(b[1]) + ' x ' + csvNum(b[2])]));
    lines.push(csvLine(['holes', '', '', '', '', '', '', '', String(rows.length - 1)]));
    var out = lines.join('\n') + '\n';
    var blob = new Blob([out], { type: 'text/csv' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = (part.name || 'part').replace(/[^a-z0-9\-_]+/gi, '-').toLowerCase() + '-bom.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toast('Bill of materials exported (' + (rows.length - 1) + ' holes)');
  }

  function exportDxf() {
    var e = dxfEntities();
    if (!e.lines.length && !e.circles.length) { toast('Nothing to export in this sketch', true); return; }
    var out = '';
    out += dxfCode(0, 'SECTION') + dxfCode(2, 'HEADER');
    out += dxfCode(9, '$INSUNITS') + dxfCode(70, '4'); /* millimetres */
    out += dxfCode(0, 'ENDSEC');
    out += dxfCode(0, 'SECTION') + dxfCode(2, 'ENTITIES');
    for (var i = 0; i < e.lines.length; i++) {
      var l = e.lines[i];
      out += dxfCode(0, 'LINE')
        + dxfCode(8, 'SKETCH')
        + dxfCode(10, l[0][0].toFixed(4)) + dxfCode(20, l[0][1].toFixed(4)) + dxfCode(30, '0.0')
        + dxfCode(11, l[1][0].toFixed(4)) + dxfCode(21, l[1][1].toFixed(4)) + dxfCode(31, '0.0');
    }
    for (var c = 0; c < e.circles.length; c++) {
      var cir = e.circles[c];
      out += dxfCode(0, 'CIRCLE')
        + dxfCode(8, 'HOLES')
        + dxfCode(10, cir.x.toFixed(4)) + dxfCode(20, cir.y.toFixed(4)) + dxfCode(30, '0.0')
        + dxfCode(40, cir.r.toFixed(4));
    }
    out += dxfCode(0, 'ENDSEC') + dxfCode(0, 'EOF');

    var blob = new Blob([out], { type: 'application/dxf' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = (part.name || 'part').replace(/[^a-z0-9\-_]+/gi, '-').toLowerCase() + '-sketch.dxf';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    var skipped = 0;
    if (part.sketch.corner === 'chamfer' || (num(part.sketch.round, 0) > 0.02 && part.sketch.type === 'rect')) {
      /* fillets/chamfers are already flattened into the profile polygon, so nothing is lost;
         only curved primitive types become dense polylines */
    }
    toast('Exported sketch as DXF R12 — ' + e.lines.length + ' lines, ' + e.circles.length + ' circles (mm)');
  }

  /* ------------------------------------------------------------- persistence */

  function toast(message, isError) {
    var el2 = document.getElementById('toast');
    if (!el2) { console.log(message); return; }
    el2.textContent = message;
    el2.className = 'toast' + (isError ? ' error' : '') + ' show';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { el2.className = 'toast'; }, 2600);
  }

  /* Hole linear pattern: a seed hole may carry pattern {rows, cols, dx, dy,
     centered}. Derived instances become real holes[] entries so they export
     in STL, count in section volume, and accept equations bindings. The
     instance grid is re-derived on every load from the seed spec. */
  function expandPattern(raw) {
    if (!raw || !Array.isArray(raw.holes) || !raw.holes.length) return raw;
    var seed = raw.holes[0] || {};
    var p = seed.pattern;
    if (!p || typeof p !== 'object') return raw;
    var sd = Math.max(0.1, num(seed.d, 8));
    var seedSeat = seed.seat && typeof seed.seat === 'object' ? seed.seat : null;
    var seedThread = holeThread(seed);
    var polarSkip = cleanSkipList(p.skip);
    var vectorSkip = cleanSkipList(p.skip);
    var spec = p.mode === 'polar'
      ? { mode: 'polar', count: Math.min(24, Math.max(1, Math.round(num(p.count, 6)))),
          span: Math.min(360, Math.max(10, num(p.span, 360))),
          radius: Math.max(0, num(p.radius, 0)), cx: num(p.cx, 0), cy: num(p.cy, 0),
          skip: polarSkip || [] }
      : p.mode === 'vector'
      ? { mode: 'vector', count: Math.min(24, Math.max(1, Math.round(num(p.count, 4)))),
          pitch: Math.min(500, Math.max(1, num(p.pitch, 20))),
          dir: Math.min(180, Math.max(-180, num(p.dir, 0))),
          twoWay: !!p.twoWay,
          count2: Math.min(24, Math.max(1, Math.round(num(p.count2, 4)))),
          pitch2: Math.min(500, Math.max(1, num(p.pitch2, 20))),
          skip: vectorSkip || [] }
      : { mode: 'linear', rows: Math.min(10, Math.max(1, Math.round(num(p.rows, 1)))),
          cols: Math.min(10, Math.max(1, Math.round(num(p.cols, 1)))),
          dx: num(p.dx, 20), dy: num(p.dy, 20), centered: !!p.centered };
    var seedHole0 = { x: num(seed.x, 0), y: num(seed.y, 0), d: sd, pattern: spec, mirror: seed.mirror !== false };
    if (seedSeat) seedHole0.seat = seedSeat;
    if (seedThread) seedHole0.thread = seedThread;
    var out = Object.assign({}, raw, { holes: [seedHole0] });
    var inst = patternInstances(spec, { x: out.holes[0].x, y: out.holes[0].y });
    for (var i = 0; i < inst.length && out.holes.length < 24; i++) {
      var ih = { x: inst[i].x, y: inst[i].y, d: sd, derived: true, mirror: seed.mirror !== false };
      if (seedSeat) ih.seat = seedSeat;
      if (seedThread) ih.thread = seedThread;
      out.holes.push(ih);
    }
    return out;
  }

  function sanitizeCorners(src) {
    var arr = Array.isArray(src) ? src.slice(0, 4) : [];
    var out = [];
    for (var i = 0; i < 4; i++) {
      var c = arr[i] && typeof arr[i] === 'object' ? arr[i] : {};
      out.push({
        on: !!c.on,
        r: Math.max(0, Math.min(500, num(c.r, 0))),
        mode: c.mode === 'chamfer' ? 'chamfer' : 'fillet'
      });
    }
    return out;
  }

  function sanitizeCostPrice(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (var i = 0; i < MATERIALS.length; i++) {
      var v = Number(raw[MATERIALS[i].id]);
      if (isFinite(v) && v > 0 && v <= 100000) out[MATERIALS[i].id] = Math.round(v * 100) / 100;
    }
    return out;
  }

  function costBasisFor(partP, mat, pricePerKg) {
    var id = mat && mat.id;
    var def = COST.pricePerKg[id] || 0;
    var ov = partP && partP.costPrice ? Number(partP.costPrice[id]) : NaN;
    var custom = isFinite(ov) && ov > 0;
    return {
      materialId: id, materialName: mat && mat.name, density: num(mat && mat.density, 1),
      defaultPricePerKg: def, pricePerKg: Number(pricePerKg) > 0 ? Number(pricePerKg) : def,
      priceSource: custom ? 'custom' : 'default'
    };
  }

  function sanitizePart(raw) {
    raw = expandPattern(raw);
    var base = defaultPart();
    if (!raw || typeof raw !== 'object') return base;
    var out = {
      name: String(raw.name || 'Untitled part').slice(0, 160),
      material: 'aluminium',
      sketch: {
        type: ['rect', 'circle', 'hex', 'L', 'slot', 'custom'].indexOf(raw.sketch && raw.sketch.type) >= 0 ? raw.sketch.type : 'rect',
        width: num(raw.sketch && raw.sketch.width, base.sketch.width),
        height: num(raw.sketch && raw.sketch.height, base.sketch.height),
        round: num(raw.sketch && raw.sketch.round, base.sketch.round),
        corner: raw.sketch && raw.sketch.corner === 'chamfer' ? 'chamfer' : 'fillet',
        slotAngle: Math.min(90, Math.max(-90, num(raw.sketch && raw.sketch.slotAngle, 0)))
      },
      extrude: { depth: umax(num(raw.extrude && raw.extrude.depth, base.extrude.depth)) },
      feature: raw.feature === 'revolve' ? 'revolve' : 'extrude',
      shell: (function () {
        var on = !!(raw.shell && raw.shell.on);
        var wall = num(raw.shell && raw.shell.wall, 2);
        if (!isFinite(wall)) wall = 2;
        return { on: on, wall: Math.min(500, Math.max(0.1, wall)) };
      })(),
      revolve: { angle: Math.min(360, Math.max(0.5, num(raw.revolve && raw.revolve.angle, 360))) },
      mirror: (function () {
        var ax = (raw.mirror && raw.mirror.axis);
        if (['x', 'y', 'line'].indexOf(ax) < 0) ax = 'none';
        return { axis: ax, angle: Math.min(180, Math.max(-180, num(raw.mirror && raw.mirror.angle, 45))) };
      })(),
      holes: [],
      equations: normalizeEquations(raw.equations),
      macro: [],
      pushPulls: [],
      envelope: (function () {
        var e = (raw && raw.envelope) || {};
        function dim(k, d) { return Math.min(20000, Math.max(1, num(e[k], d))); }
        return { on: !!e.on, x: dim('x', 220), y: dim('y', 220), z: dim('z', 250) };
      })()
    };
    out.sketch.corners = sanitizeCorners(raw.sketch && raw.sketch.corners);
    out.sketch.entities = sanitizeEntities(raw.sketch && raw.sketch.entities);
    out.sketch.dims = sanitizeDims(raw.sketch && raw.sketch.dims, out.sketch.entities);
    out.sketch.constraints = sanitizeConstraints(raw.sketch && raw.sketch.constraints, out.sketch.entities);
    var ppIn = Array.isArray(raw.pushPulls) ? raw.pushPulls.slice(0, 20) : [];
    var replayDepth = out.extrude.depth;
    for (var pi = 0; pi < ppIn.length; pi++) {
      var side = Number(ppIn[pi] && ppIn[pi].side);
      var distance = num(ppIn[pi] && ppIn[pi].distance, 0);
      var nextDepth = replayDepth + distance;
      var sourceMatches = ppIn[pi] && ppIn[pi].sourceKey === pushPullSourceKey(out.pushPulls, out);
      if ((side === 1 || side === -1) && sourceMatches && Math.abs(distance) >= 0.01 && Math.abs(distance) <= 1000 && nextDepth >= 0.5 && nextDepth <= 2000) {
        out.pushPulls.push({ name: 'PushPull' + (out.pushPulls.length + 1), side: side, distance: distance, sourceKey: ppIn[pi].sourceKey });
        replayDepth = nextDepth;
      }
    }
    var macIn = Array.isArray(raw.macro) ? raw.macro.slice(0, 60) : [];
    for (var m = 0; m < macIn.length; m++) {
      var step = macIn[m];
      if (!step || typeof step !== 'object') continue;
      var label = String(step.label || 'edit').slice(0, 120);
      out.macro.push({ label: label });
    }
    for (var i = 0; i < MATERIALS.length; i++) {
      if (MATERIALS[i].id === raw.material) out.material = raw.material;
    }
    out.costPrice = sanitizeCostPrice(raw.costPrice);
    var holes = Array.isArray(raw.holes) ? raw.holes.slice(0, 24) : [];
    for (var h = 0; h < holes.length; h++) {
      var ho = {
        x: num(holes[h].x, 0),
        y: num(holes[h].y, 0),
        d: Math.max(0.1, num(holes[h].d, 8)),
        mirror: holes[h].mirror !== false
      };
      var th0 = holeThread(holes[h]);
      if (th0) ho.thread = th0;
      if (holes[h].seat && typeof holes[h].seat === 'object' &&
          (holes[h].seat.type === 'cbore' || holes[h].seat.type === 'csink')) {
        ho.seat = {
          type: holes[h].seat.type,
          dia: Math.max(0, num(holes[h].seat.dia, 0)),
          depth: Math.max(0, num(holes[h].seat.depth, 0))
        };
      }
      if (h === 0 && holes[h].pattern && typeof holes[h].pattern === 'object') {
        ho.pattern = holes[h].pattern.mode === 'vector'
          ? {
              mode: 'vector',
              count: Math.min(24, Math.max(1, Math.round(num(holes[h].pattern.count, 4)))),
              pitch: Math.min(500, Math.max(1, num(holes[h].pattern.pitch, 20))),
              dir: Math.min(180, Math.max(-180, num(holes[h].pattern.dir, 0))),
              twoWay: !!holes[h].pattern.twoWay,
              count2: Math.min(24, Math.max(1, Math.round(num(holes[h].pattern.count2, 4)))),
              pitch2: Math.min(500, Math.max(1, num(holes[h].pattern.pitch2, 20))),
              skip: cleanSkipList(holes[h].pattern.skip) || []
            }
          : holes[h].pattern.mode === 'polar'
          ? {
              mode: 'polar',
              count: Math.min(24, Math.max(1, Math.round(num(holes[h].pattern.count, 6)))),
              span: Math.min(360, Math.max(10, num(holes[h].pattern.span, 360))),
              radius: Math.max(0, num(holes[h].pattern.radius, 0)),
              cx: num(holes[h].pattern.cx, 0),
              cy: num(holes[h].pattern.cy, 0),
              skip: cleanSkipList(holes[h].pattern.skip) || []
            }
          : {
              mode: 'linear',
              rows: Math.min(10, Math.max(1, Math.round(num(holes[h].pattern.rows, 1)))),
              cols: Math.min(10, Math.max(1, Math.round(num(holes[h].pattern.cols, 1)))),
              dx: num(holes[h].pattern.dx, 20),
              dy: num(holes[h].pattern.dy, 20),
              centered: !!holes[h].pattern.centered
            };
      }
      out.holes.push(ho);
    }
    return out;
  }

  function umax(v) {
    return Math.max(0.5, v);
  }

  function loadPartIntoEditor(p, id) {
    part = sanitizePart(p);
    partId = id || null;
    renderAll();
  }

  /* ------------------------------------------------- session persistence
     The server parts library is optional and may be unavailable, so the
     editor keeps a browser-local snapshot of the part definition on every
     rebuild. The chip in the title bar states which of the two exists; the
     copy never implies an account sync. The snapshot holds the parametric
     definition (features, dimensions, material, equations), not the mesh. */

  var DEVICE_ONLY = 'Saved on this device only — not synced to your account.';
  var SESSION_KEY = 'websolid.sessionSnapshot.v1';
  var SESSION_MAX_BYTES = 400000;
  var sessionArmed = false;          /* false until boot decided about restore */
  var sessionTimer = null;
  var sessionSavedAt = null;         /* Date of the last successful local write */
  var sessionBlocked = false;        /* true when no snapshot can be kept */
  var sessionBlockReason = null;     /* 'size' (too large) or 'write' (browser refused storage) */
  var librarySaved = false;          /* true only right after Save part succeeded */
  var librarySavedKey = null;        /* part JSON that matches the library copy */
  var partFileSaved = false;         /* true when current part matches an exported part file */
  var partFileSavedKey = null;       /* part JSON that matches the exported part file */
  var partFileSavedAt = null;        /* ISO timestamp of the last exported part file */
  var restoredLocalOnly = false;     /* true when active part came from browser-local restore and has no durable copy yet */
  var pendingRestore = null;

  function partKey(p) {
    try { return JSON.stringify(sanitizePart(p)); } catch (e) { return null; }
  }

  function readSession() {
    try {
      var raw = window.localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var snap = JSON.parse(raw);
      if (!snap || snap.v !== 1 || !snap.part || typeof snap.part !== 'object') return null;
      return snap;
    } catch (e) { return null; }
  }

  function formatClock(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return '';
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function formatSnapshotAge(iso, now) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return 'an earlier session';
    var minutes = Math.max(0, Math.floor(((now || Date.now()) - d.getTime()) / 60000));
    var age;
    if (minutes < 1) age = 'just now';
    else if (minutes < 60) age = minutes + (minutes === 1 ? ' minute ago' : ' minutes ago');
    else if (minutes < 1440) {
      var hours = Math.floor(minutes / 60);
      age = hours + (hours === 1 ? ' hour ago' : ' hours ago');
    } else {
      var days = Math.floor(minutes / 1440);
      age = days < 30 ? days + (days === 1 ? ' day ago' : ' days ago') :
        d.toLocaleDateString() + ' at ' + formatClock(iso);
    }
    return age + ' · ' + d.toLocaleString();
  }

  function setSessionStatus(text, state, title) {
    var chip = document.getElementById('session-status');
    if (!chip) return;
    chip.textContent = text;
    chip.setAttribute('data-state', state);
    if (title) chip.setAttribute('title', title);
  }

  function updateLocalOnlyNote() {
    var note = document.getElementById('local-only-note');
    if (!note) return;
    if (!restoredLocalOnly || pendingRestore || librarySaved || (partFileSaved && partFileSavedKey === partKey(part))) {
      note.hidden = true;
      return;
    }
    var detail = document.getElementById('local-only-detail');
    if (detail) {
      detail.textContent = partsLibraryAvailable === false
        ? 'The server parts library is unavailable, so this restored snapshot is the only copy right now. Clearing site data or switching browsers loses it — save a portable file to keep an editable second copy.'
        : 'This restored snapshot is not in the server parts library yet. Clearing site data or switching browsers loses it — save a portable file (or Save part) to keep a durable second copy.';
    }
    note.hidden = false;
  }

  function updateSessionStatus() {
    updateLocalOnlyNote();
    if (pendingRestore) {
      setSessionStatus('Local snapshot found — choose Restore or Discard', 'restore',
        'A part definition from an earlier session is stored in this browser.');
      return;
    }
    var clock = sessionSavedAt ? formatClock(sessionSavedAt) : '';
    if (librarySaved) {
      setSessionStatus('Saved to your library', 'saved',
        'This part is stored in the server-side parts library. Edited since? Save again to update it.');
      return;
    }
    if (partFileSaved && partFileSavedKey === partKey(part)) {
      var fileClock = partFileSavedAt ? formatClock(partFileSavedAt) : '';
      setSessionStatus('Part file saved' + (fileClock ? ' · ' + fileClock : ''), 'exported',
        partsLibraryAvailable === false
          ? 'Exported as a portable .websolid.json part file in this page session only. After a reload, WebSolid cannot tell whether the file still exists on your device. The server parts library is unavailable.'
          : 'Export tracked in this page session only. After a reload, WebSolid cannot tell whether the .websolid.json file still exists on your device. Not in the server parts library unless you also use Save part.');
      return;
    }
    if (sessionBlocked && sessionBlockReason === 'write') {
      setSessionStatus('Not saved — this browser refused storage', 'warning',
        partsLibraryAvailable === false
          ? 'The browser would not keep a local snapshot and the server library is unavailable. Export a part file with Save file.'
          : 'The browser would not keep a local snapshot, so a reload will lose these edits. Export a part file or use Save part.');
      return;
    }
    if (sessionBlocked) {
      setSessionStatus('Not saved — part too large for this browser', 'warning',
        'This part is too large for the browser-local snapshot, so a reload will lose these edits. Export a part file.');
      return;
    }
    if (clock) {
      setSessionStatus('Unsaved changes · ' + clock + ' on this device', 'local',
        partsLibraryAvailable === false
          ? DEVICE_ONLY + ' Server parts library is unavailable — use Save file to keep a portable copy.'
          : DEVICE_ONLY);
      return;
    }
    setSessionStatus('Unsaved changes', 'unsaved',
      'Nothing is stored yet: no browser-local snapshot and no saved library copy for this part.');
  }

  function writeSessionSnapshot(now) {
    if (!sessionArmed || pendingRestore) return;
    var key = partKey(part);
    if (key === null) return;
    if (key.length > SESSION_MAX_BYTES) {
      if (sessionBlocked !== true || sessionBlockReason !== 'size') {
        sessionBlocked = true;
        sessionBlockReason = 'size';
        updateSessionStatus();
      }
      return;
    }
    var stamp = (now || new Date()).toISOString();
    try {
      window.localStorage.setItem(SESSION_KEY, JSON.stringify({ v: 1, savedAt: stamp, part: JSON.parse(key) }));
      sessionSavedAt = stamp;
      sessionBlocked = false;
      sessionBlockReason = null;
    } catch (e) {
      sessionBlocked = true;
      sessionBlockReason = 'write';
      sessionSavedAt = null;
      updateSessionStatus();
      return;
    }
    if (librarySaved && librarySavedKey !== key) librarySaved = false;
    if (partFileSaved && partFileSavedKey !== key) partFileSaved = false;
    updateSessionStatus();
  }

  function scheduleSessionSnapshot() {
    if (!sessionArmed || pendingRestore) return;
    if (sessionTimer) clearTimeout(sessionTimer);
    sessionTimer = setTimeout(function () { sessionTimer = null; writeSessionSnapshot(); }, 700);
  }

  /* A debounce window is exactly when a crash or a quick tab close loses edits,
     so flush the pending write as soon as the page stops being visible. */
  function flushSessionSnapshot() {
    if (!sessionArmed || pendingRestore) return;
    if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = null; }
    writeSessionSnapshot();
  }

  function hideRestoreBanner() {
    var banner = document.getElementById('restore-banner');
    if (banner) banner.hidden = true;
  }

  function discardSessionSnapshot(reason) {
    pendingRestore = null;
    restoredLocalOnly = false;
    try { window.localStorage.removeItem(SESSION_KEY); } catch (e) {}
    sessionSavedAt = null;
    hideRestoreBanner();
    sessionArmed = true;
    if (reason) toast(reason);
    updateSessionStatus();
  }

  function restoreSessionSnapshot() {
    var snap = pendingRestore;
    pendingRestore = null;
    hideRestoreBanner();
    if (!snap) { sessionArmed = true; updateSessionStatus(); return; }
    sessionArmed = true;
    sessionSavedAt = snap.savedAt || null;
    partId = null;
    loadPartIntoEditor(snap.part, null);
    librarySaved = false;
    partFileSaved = false;
    partFileSavedKey = null;
    partFileSavedAt = null;
    restoredLocalOnly = true;
    toast('Restored the browser-local snapshot from ' + (formatClock(snap.savedAt) || 'earlier') +
      (partsLibraryAvailable === false
        ? ' — server library unavailable; use Save file to keep a portable copy'
        : ' — it is not in the parts library yet'));
    writeSessionSnapshot();
  }

  function initSessionSnapshot() {
    var snap = readSession();
    if (!snap) {
      sessionArmed = true;
      updateSessionStatus();
      return;
    }
    /* Never prompt for a device copy that is byte-identical to the part on
       screen: there is nothing to recover and the extra choice is noise. */
    if (partKey(snap.part) === partKey(part)) {
      sessionSavedAt = snap.savedAt || null;
      sessionArmed = true;
      updateSessionStatus();
      return;
    }
    pendingRestore = snap;
    var banner = document.getElementById('restore-banner');
    if (banner) {
      var name = snap.part && snap.part.name ? String(snap.part.name).slice(0, 60) : 'a part';
      document.getElementById('restore-name').textContent = name;
      var when = document.getElementById('restore-when');
      if (when) when.textContent = formatSnapshotAge(snap.savedAt);
      var restoreName = document.getElementById('restore-name');
      if (restoreName) restoreName.textContent = name;
      var activeEl = document.getElementById('restore-active');
      var replaceEl = document.getElementById('restore-replace');
      if (activeEl && replaceEl) {
        var activeName = part && part.name ? String(part.name).slice(0, 60) : '';
        if (!activeName) {
          replaceEl.textContent = 'Restore replaces the part that is open now.';
        } else if (activeName === name) {
          replaceEl.textContent = 'A part with the same name is open now. Restore replaces it with the snapshot version.';
        } else {
          replaceEl.innerHTML = 'Currently open: <b id="restore-active"></b>. Restore replaces it.';
          document.getElementById('restore-active').textContent = activeName;
        }
      }
      banner.hidden = false;
    }
    updateSessionStatus();
  }

  function noteLibrarySave() {
    librarySaved = true;
    librarySavedKey = partKey(part);
    restoredLocalOnly = false;
    /* A clean library save makes the device copy redundant, so drop it: the next
       load must not offer to "restore" a part that is already in the library. */
    if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = null; }
    if (sessionSavedAt || readSession()) {
      try { window.localStorage.removeItem(SESSION_KEY); } catch (e) {}
    }
    sessionSavedAt = null;
    if (sessionBlocked && sessionBlockReason === 'write') { sessionBlocked = false; sessionBlockReason = null; }
    updateSessionStatus();
  }

  var partsLibraryAvailable = null;      /* null = checking, true = ready, false = unavailable */
  var libState = 'checking';
  var libCheckAttempts = 0;
  var libCheckToken = 0;
  var libSlowTimer = null;
  var saveLibraryButtons = ['btn-save', 'btn-save-as'];
  var LIB_STATUS = (typeof window !== 'undefined' && window.WebSolidLibraryStatus) || null;

  /* Storage honesty: the server parts library is only presented as usable once
     /api/parts has actually answered. Three explicit states are shown in the
     Parts library panel (#parts-library-hint): checking, ready, unavailable.
     Save part / Save as stay natively disabled outside the ready state, and
     every non-ready state keeps a reachable retry next to the disclosure so a
     first-time visitor is never left on an indefinite "checking" line. */
  var PARTS_UNAVAILABLE_TEXT = 'Server parts library unavailable — Save part and Save as are disabled. Edits stay in this browser\u2019s local recovery snapshot; Save file keeps an editable copy on this device.';

  function libraryStatusFor(state, opts) {
    if (LIB_STATUS) return LIB_STATUS.statusFor(state, opts);
    var ready = state === 'ready';
    return {
      state: state,
      hintClass: ready ? 'hint hint-ok' : (state === 'checking' ? 'hint' : 'hint hint-warn'),
      hintText: ready
        ? 'Server parts library ready. Save part stores the part in the server library, not in this browser or an account.'
        : (state === 'checking' ? 'Checking server parts library availability\u2026 The modeler works without it: Save file downloads an editable .websolid.json part.' : PARTS_UNAVAILABLE_TEXT),
      retryHidden: ready,
      retryLabel: state === 'checking' ? 'Retry check' : 'Try again',
      fallbackSaveHidden: ready || (state === 'checking' && !(opts && opts.slow)),
      fallbackSaveLabel: 'Save portable .json file instead',
      saveButtonsDisabled: !ready
    };
  }

  function setPartsLibraryAvailability(state, opts) {
    if (typeof state === 'boolean') state = state ? 'ready' : 'unavailable';
    var d = libraryStatusFor(state, opts);
    libState = d.state;
    partsLibraryAvailable = d.state === 'ready' ? true : (d.state === 'unavailable' ? false : null);
    saveLibraryButtons.forEach(function (id) {
      var button = document.getElementById(id);
      if (!button) return;
      button.disabled = d.saveButtonsDisabled;
      button.setAttribute('aria-disabled', d.saveButtonsDisabled ? 'true' : 'false');
      button.classList.toggle('primary', false);
      button.setAttribute('aria-describedby', 'parts-library-hint');
      button.title = d.saveButtonsDisabled
        ? (d.state === 'checking' ? 'Checking server parts library availability' : PARTS_UNAVAILABLE_TEXT)
        : (id === 'btn-save' ? 'Save part to the server-side parts library' : 'Save as a new server-side parts-library entry');
    });
    var hint = document.getElementById('parts-library-hint');
    if (hint) {
      hint.hidden = false;
      hint.className = d.hintClass;
      hint.setAttribute('role', 'status');
      hint.setAttribute('aria-live', 'polite');
      hint.setAttribute('data-library-state', d.state);
      hint.textContent = d.hintText;
    }
    var retry = document.getElementById('btn-parts-retry');
    if (retry) {
      retry.hidden = !!d.retryHidden;
      retry.textContent = d.retryLabel || (d.state === 'checking' ? 'Retry check' : 'Try again');
      retry.title = d.state === 'checking'
        ? 'Check the server parts library again'
        : 'Check again whether the server parts library has come back';
    }
    var fallbackSave = document.getElementById('btn-parts-savefile');
    if (fallbackSave) {
      fallbackSave.hidden = d.fallbackSaveHidden !== undefined ? !!d.fallbackSaveHidden : (d.state !== 'unavailable');
      fallbackSave.textContent = d.fallbackSaveLabel || 'Save portable .json file instead';
      fallbackSave.title = 'Download the editable .websolid.json part definition without needing server library storage';
    }
    var fallbackOpen = document.getElementById('btn-parts-openfile');
    if (fallbackOpen) {
      fallbackOpen.hidden = d.state !== 'unavailable';
      fallbackOpen.title = 'Open an editable .websolid.json part file from this device';
    }
    var handoffSave = document.querySelector('.handoff-save');
    if (handoffSave) {
      handoffSave.innerHTML = d.state === 'ready'
        ? '<strong>Saving:</strong> Save part and the parts library use server-side storage. They are not browser-local or account-synced saves. You can also use <strong>Save file</strong> to export an editable .websolid.json part definition.'
        : d.state === 'checking'
          ? '<strong>Saving:</strong> The editor is still checking whether the server parts library is available (Save part and Save as stay disabled until it answers). In the meantime your edits stay in this browser\u2019s local recovery snapshot, and <strong>Save file</strong> downloads an editable .websolid.json part definition.'
          : '<strong>Saving:</strong> The server parts library is currently unavailable (Save part and Save as are disabled). Your edits stay only in this browser\u2019s local recovery snapshot until you use <strong>Save file</strong> to download an editable .websolid.json part definition.';
    }
    updateSessionStatus();
  }

  function setPartsListMessage(text) {
    var box = document.getElementById('parts-list');
    if (box) box.innerHTML = '<p class="hint">' + escapeHtml(text) + '</p>';
  }

  function refreshPartsList() {
    var box = document.getElementById('parts-list');
    libCheckAttempts += 1;
    libCheckToken += 1;
    var token = libCheckToken;
    setPartsLibraryAvailability('checking', { attempts: libCheckAttempts });
    setPartsListMessage(libCheckAttempts > 1 ? 'Checking saved parts again\u2026' : 'Checking saved parts\u2026');
    if (libSlowTimer) { clearTimeout(libSlowTimer); libSlowTimer = null; }
    libSlowTimer = setTimeout(function () {
      if (token !== libCheckToken) return;
      setPartsLibraryAvailability('checking', { attempts: libCheckAttempts, slow: true });
    }, (LIB_STATUS && LIB_STATUS.SLOW_AFTER_MS) || 4000);

    var controller = (typeof AbortController === 'function') ? new AbortController() : null;
    var giveUpMs = (LIB_STATUS && LIB_STATUS.GIVE_UP_AFTER_MS) || 12000;
    var giveUp = setTimeout(function () {
      if (!finish()) return;
      if (controller) controller.abort();
      setPartsLibraryAvailability('unavailable', { reason: 'timeout' });
      setPartsListMessage('Saved parts could not be loaded.');
    }, giveUpMs);
    var settled = false;

    function finish() {
      if (settled) return false;
      settled = true;
      clearTimeout(giveUp);
      if (token !== libCheckToken) return false;
      if (libSlowTimer) { clearTimeout(libSlowTimer); libSlowTimer = null; }
      return true;
    }

    fetch('/api/parts', controller ? { signal: controller.signal } : undefined)
      .then(function (r) {
        if (!r.ok) {
          var err = new Error('parts library unavailable');
          err.webSolidReason = 'server';
          throw err;
        }
        return r.json();
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.parts)) {
          var err = new Error('Invalid parts list');
          err.webSolidReason = 'server';
          throw err;
        }
        if (!finish()) return;
        libCheckAttempts = 0;
        var parts = data.parts;
        setPartsLibraryAvailability('ready', { count: parts.length });
        if (!box) return;
        box.innerHTML = '';
        if (!parts.length) {
          box.innerHTML = '<p class="hint">No parts are saved in the server library yet.</p>';
          return;
        }
        parts.forEach(function (row) {
          var item = document.createElement('div');
          item.className = 'part-row' + (String(row.id) === String(partId) ? ' active' : '');
          var btn = document.createElement('button');
          btn.className = 'part-load';
          var vol = row.volume_mm3 ? (Number(row.volume_mm3) / 1000).toFixed(1) + ' cm3' : 'unsaved';
          btn.innerHTML = '<b>' + escapeHtml(row.name) + '</b><em>' + vol + '</em>';
          btn.addEventListener('click', function () {
            var pk = row.payload || {};
            restoredLocalOnly = false;
            loadPartIntoEditor(pk, row.id);
            updateSessionStatus();
            toast('Loaded ' + row.name);
          });
          var del = document.createElement('button');
          del.className = 'part-del';
          del.textContent = 'x';
          del.title = 'Delete part';
          del.addEventListener('click', function (ev) {
            ev.stopPropagation();
            fetch('/api/parts/' + row.id, { method: 'DELETE' }).then(function () {
              if (String(row.id) === String(partId)) partId = null;
              refreshPartsList();
              toast('Deleted ' + row.name);
            });
          });
          item.appendChild(btn);
          item.appendChild(del);
          box.appendChild(item);
        });
      })
      .catch(function (err) {
        if (!finish()) return;
        var reason = (err && (err.name === 'AbortError' || err.webSolidReason === 'timeout'))
          ? 'timeout'
          : ((err && err.webSolidReason) || 'network');
        /* One authoritative #parts-library-hint outside this list carries the
           state + retry, so the disclosure is never duplicated. */
        setPartsLibraryAvailability('unavailable', { reason: reason, attempts: libCheckAttempts });
        setPartsListMessage('Saved parts could not be loaded.');
      });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function savePart(forceNew) {
    if (partsLibraryAvailable !== true) {
      toast('Server parts library unavailable. Use Save file to keep your work.', true);
      return;
    }
    var name = part.name && part.name.trim();
    if (!name) { toast('Give the part a name first', true); return; }
    var body = JSON.stringify({
      name: name,
      payload: part,
      volume_mm3: metrics ? metrics.volumeMm3 : null,
      mass_g: metrics ? metrics.massG : null
    });
    var update = partId && !forceNew;
    var url = update ? '/api/parts/' + partId : '/api/parts';
    var method = update ? 'PUT' : 'POST';
    fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: body })
      .then(function (r) {
        if (!r.ok) throw new Error('save failed');
        return r.json();
      })
      .then(function (row) {
        partId = row.id;
        noteLibrarySave();
        toast((update ? 'Updated "' : 'Saved "') + row.name + '" in the server parts library');
        refreshPartsList();
      })
      .catch(function () {
        setPartsLibraryAvailability(false);
        toast('Server parts library unavailable. Use Save file to keep your work.', true);
      });
  }

  /* Portable part file: the editable parametric definition as JSON.
     This is deliberately not a mesh or an account object: it holds only what
     sanitizePart() produces, so it re-opens into the same feature tree and
     cannot carry geometry that the modeler would not build itself. */
  var PART_FILE_VERSION = 1;
  var PART_FILE_MAX_BYTES = 2000000;

  function partFilePayload() {
    return {
      format: 'websolid-part',
      version: PART_FILE_VERSION,
      savedAt: new Date().toISOString(),
      app: 'WebSolid parametric part modeler',
      note: 'Editable part definition only: sketch, features, holes, material, equations. No mesh, no account state.',
      part: sanitizePart(part)
    };
  }

  function notePartFileSave(savedAt) {
    partFileSaved = true;
    partFileSavedKey = partKey(part);
    partFileSavedAt = savedAt || new Date().toISOString();
    restoredLocalOnly = false;
    updateSessionStatus();
  }

  function exportPartFile() {
    var payload = partFilePayload();
    var text = JSON.stringify(payload, null, 2);
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = (part.name || 'part').replace(/[^a-z0-9\-_]+/gi, '-').toLowerCase() + '.websolid.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    notePartFileSave(payload.savedAt);
    toast('Part file saved — editable definition only, no mesh');
  }

  function importPartFile(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { toast('That file is not valid JSON', true); return false; }
    if (!data || typeof data !== 'object' || data.format !== 'websolid-part') {
      toast('That JSON file is not a WebSolid part file', true);
      return false;
    }
    if (!data.part || typeof data.part !== 'object') {
      toast('The part file has no part definition', true);
      return false;
    }
    part = sanitizePart(data.part);
    partId = null;
    librarySaved = false;
    librarySavedKey = null;
    partFileSaved = false;
    partFileSavedKey = null;
    partFileSavedAt = null;
    restoredLocalOnly = false;
    renderAll();
    fitView();
    writeSessionSnapshot();
    toast('Opened ' + (part.name || 'part') +
      (partsLibraryAvailable === false
        ? ' from part file — server library unavailable; use Save file after edits'
        : ' — not in the parts library yet'));
    return true;
  }

  function openPartFile() {
    var input = document.getElementById('file-open');
    if (!input) return;
    input.value = '';
    input.click();
  }

  function readPartFile(input) {
    var file = input.files && input.files[0];
    if (!file) return;
    if (file.size > PART_FILE_MAX_BYTES) { toast('Part files must be smaller than 2 MB', true); return; }
    var reader = new FileReader();
    reader.onerror = function () { toast('Could not read the part file', true); };
    reader.onload = function () { importPartFile(String(reader.result || '')); };
    reader.readAsText(file);
  }

  // Start a fresh design. Clears partId so the next save inserts a new row
  // instead of silently overwriting the part that was open.
  function newPart() {
    part = defaultPart();
    part.name = 'Untitled part';
    partId = null;
    rebuild();
    refreshPartsList();
    fitView();
    document.getElementById('part-name').setAttribute('title', 'Click to rename');
    librarySaved = false;
    librarySavedKey = null;
    partFileSaved = false;
    partFileSavedKey = null;
    partFileSavedAt = null;
    restoredLocalOnly = false;
    writeSessionSnapshot();
    toast(partsLibraryAvailable === false
      ? 'New part - rename it, then use Save file to keep a portable copy'
      : 'New part - rename it, then Save part');
  }

  /* --------------------------------------------------------- undo / redo
     Every committed edit funnels through rebuild(). When the part state
     actually changed we push a sanitized snapshot onto a depth-capped
     stack, clear the forward stack, and update the Undo/Redo buttons.
     Undo/redo restore a snapshot without pushing, so the two stacks walk
     a single linear history. */

  var undoStack = [];
  var redoStack = [];
  var UNDO_MAX = 50;
  var undoGuard = false;
  var lastSnapshot = null;

  function snapshotOf() {
    return JSON.parse(JSON.stringify(sanitizePart(part)));
  }

  function updateUndoButtons() {
    var b1 = document.getElementById('btn-undo');
    var b2 = document.getElementById('btn-redo');
    if (b1) b1.disabled = !undoStack.length;
    if (b2) b2.disabled = !redoStack.length;
  }

  function applySnapshot(state, toastMsg) {
    undoGuard = true;
    try {
      var st = typeof state === 'string' ? JSON.parse(state) : state;
      part = sanitizePart(st);
      lastSnapshot = JSON.stringify(part);
      renderAll();
      refreshPartsList();
      if (toastMsg) toast(toastMsg);
    } finally {
      undoGuard = false;
    }
  }

  function undo() {
    if (!undoStack.length) return;
    var cur = lastSnapshot !== null ? lastSnapshot : JSON.stringify(snapshotOf());
    redoStack.push(cur);
    if (redoStack.length > UNDO_MAX) redoStack.shift();
    applySnapshot(undoStack.pop(), 'Undo');
    updateUndoButtons();
  }

  function redo() {
    if (!redoStack.length) return;
    var cur = lastSnapshot !== null ? lastSnapshot : JSON.stringify(snapshotOf());
    undoStack.push(cur);
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    applySnapshot(redoStack.pop(), 'Redo');
    updateUndoButtons();
  }

  function pushUndo() {
    if (undoGuard) return;
    var snap = snapshotOf();
    var key = JSON.stringify(snap);
    if (key === lastSnapshot) return;
    var first = lastSnapshot === null;
    if (!first) {
      undoStack.push(lastSnapshot);
      if (undoStack.length > UNDO_MAX) undoStack.shift();
    }
    redoStack.length = 0;
    lastSnapshot = key;
    updateUndoButtons();
  }

  /* ----------------------------------------------------------------- boot */

  function wireControls() {
    var viewButtons = document.querySelectorAll('.toolbar .tool[data-view]');
    for (var i = 0; i < viewButtons.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () { setView(btn.getAttribute('data-view')); });
      })(viewButtons[i]);
    }

    document.getElementById('btn-fit').addEventListener('click', fitView);
    document.getElementById('btn-pushpull').addEventListener('click', togglePushPull);
    document.getElementById('btn-measure').addEventListener('click', toggleMeasure);
    document.getElementById('pushpull-distance').addEventListener('input', updatePushPullPreview);
    document.getElementById('pushpull-apply').addEventListener('click', commitPushPull);
    document.getElementById('pushpull-cancel').addEventListener('click', function () { closePushPull(); });
    var orientation = document.getElementById('orientation-strip');
    var orientationClose = document.getElementById('orientation-dismiss');
    var orientationShow = document.getElementById('orientation-show');
    setOrientationVisible(!orientationDismissed);
    if (orientationClose) orientationClose.addEventListener('click', dismissOrientation);
    if (orientationShow) orientationShow.addEventListener('click', function () { setOrientationVisible(true); });
    if (orientation) {
      orientation.querySelectorAll('[data-guide-target]').forEach(function (link) {
        link.addEventListener('click', function (event) {
          event.preventDefault();
          var stepTarget = link.getAttribute('data-guide-target');
          var target = document.getElementById(stepTarget);
          if (stepTarget === 'starter-shape' || stepTarget === 'sketch-dimension') {
            var sketchPanel = document.getElementById('sketch-fields');
            var choices = sketchPanel && sketchPanel.querySelector('.shape-picker');
            var shape = choices && choices.querySelector('button');
            target = stepTarget === 'starter-shape' ? shape : sketchPanel && sketchPanel.querySelector('input');
          }
          orientation.dataset.guideDebug = JSON.stringify({ stepTarget: stepTarget, found: !!target, targetId: target && target.id, tag: target && target.tagName, disabled: target && target.disabled });
          if (!target) return;
          if (target.closest('.panel')) target.closest('.panel').scrollTop = Math.max(0, target.offsetTop - 24);
          target.focus({ preventScroll: true });
          target.classList.add('guide-highlight');
          window.setTimeout(function () { target.classList.remove('guide-highlight'); }, 1100);
        });
      });
    }
    var coachClose = document.getElementById('pushpull-coach-close');
    if (coachClose) coachClose.addEventListener('click', dismissPushPullCoach);
    document.getElementById('btn-stl').addEventListener('click', function () { openExportHandoff('stl', exportStl); });
    var handoffPanel = document.getElementById('handoff-panel');
    var handoffToggle = document.getElementById('btn-handoff');
    var handoffClose = document.getElementById('btn-handoff-close');
    function setHandoffOpen(open) {
      var confirmExport = document.getElementById('btn-handoff-export');
      confirmExport.hidden = true;
      confirmExport.onclick = null;
      document.getElementById('handoff-checklist').replaceChildren();
      document.getElementById('handoff-summary').textContent = 'Choose an export to review its handoff details before downloading.';
      var receiptEl = document.getElementById('artifact-receipt');
      if (receiptEl) receiptEl.textContent = '';
      handoffPanel.hidden = !open;
      handoffToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) handoffClose.focus(); else handoffToggle.focus();
    }
    handoffToggle.addEventListener('click', function () { setHandoffOpen(handoffPanel.hidden); });
    handoffClose.addEventListener('click', function () { setHandoffOpen(false); });
    handoffPanel.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); setHandoffOpen(false); }
    });
    document.getElementById('btn-dxf').addEventListener('click', function () { openExportHandoff('dxf', exportDxf); });
    document.getElementById('btn-drawing').addEventListener('click', function () { openExportHandoff('svg', exportDrawing); });
    document.getElementById('btn-bom').addEventListener('click', function () { openExportHandoff('csv', exportBom); });
    document.getElementById('btn-printability').addEventListener('click', runPrintability);
    var btnCopySummary = document.getElementById('btn-copy-summary');
    if (btnCopySummary) btnCopySummary.addEventListener('click', copyCheckSummary);
    var printProfile = document.getElementById('print-profile');
    if (printProfile) {
      if (part.printability && part.printability.profile) printProfile.value = part.printability.profile;
      printProfile.addEventListener('change', function (e) {
        part.printability = part.printability || {};
        part.printability.profile = e.target.value;
        runPrintability();
      });
    }
    var btnSaveFile = document.getElementById('btn-savefile');
    if (btnSaveFile) btnSaveFile.addEventListener('click', function () { exportPartFile(); });
    var btnOpenFile = document.getElementById('btn-openfile');
    var fileOpen = document.getElementById('file-open');
    if (btnOpenFile) btnOpenFile.addEventListener('click', openPartFile);
    if (fileOpen) fileOpen.addEventListener('change', function () { readPartFile(fileOpen); });
    document.getElementById('btn-save').addEventListener('click', function () {
      if (partsLibraryAvailable !== true) {
        toast('Server parts library unavailable. Use Save file to keep your work.', true);
        return;
      }
      savePart(false);
    });
    document.getElementById('btn-save-as').addEventListener('click', function () {
      if (partsLibraryAvailable !== true) {
        toast('Server parts library unavailable. Use Save file to keep your work.', true);
        return;
      }
      var next = window.prompt('Save as a new part named', (part.name || 'Part') + ' copy');
      if (!next || !next.trim()) return;
      part.name = next.trim().slice(0, 160);
      rebuild();
      savePart(true);
    });
    document.getElementById('btn-new').addEventListener('click', newPart);
    var btnRestore = document.getElementById('btn-restore-session');
    if (btnRestore) btnRestore.addEventListener('click', restoreSessionSnapshot);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushSessionSnapshot();
    });
    window.addEventListener('pagehide', flushSessionSnapshot);
    window.addEventListener('beforeunload', flushSessionSnapshot);
    var btnDiscard = document.getElementById('btn-discard-session');
    if (btnDiscard) btnDiscard.addEventListener('click', function () {
      discardSessionSnapshot('Discarded the browser-local snapshot');
    });
    var btnLocalOnlySave = document.getElementById('btn-local-only-save');
    if (btnLocalOnlySave) btnLocalOnlySave.addEventListener('click', function () {
      exportPartFile();
    });
    var btnLocalOnlyDismiss = document.getElementById('btn-local-only-dismiss');
    if (btnLocalOnlyDismiss) btnLocalOnlyDismiss.addEventListener('click', function () {
      restoredLocalOnly = false;
      updateSessionStatus();
    });
    var btnUndo = document.getElementById('btn-undo');
    var btnRedo = document.getElementById('btn-redo');
    if (btnUndo) btnUndo.addEventListener('click', undo);
    if (btnRedo) btnRedo.addEventListener('click', redo);

    var minWallInput = document.getElementById('min-wall');
    if (minWallInput) {
      minWallInput.value = num(part.minWall, 2);
      minWallInput.addEventListener('change', function (e) {
        var v = parseFloat(e.target.value);
        part.minWall = isFinite(v) && v >= 0 ? v : 2;
        renderAll();
      });
    }

    document.getElementById('btn-add-hole').addEventListener('click', function () {
      part.holes.push({ x: 0, y: 0, d: 6 });
      recordMacro('Add hole - Cut' + part.holes.length + ' Dia 6 mm');
      renderAll();
      toast('Hole added - drag the centre with X / Y');
    });

    document.getElementById('tg-edges').addEventListener('change', function (e) {
      view.edges = e.target.checked;
      if (edgeLines) edgeLines.visible = view.edges && !view.wire;
      needRender = true;
    });
    document.getElementById('tg-grid').addEventListener('change', function (e) {
      gridHelper.visible = e.target.checked;
      axes.visible = e.target.checked;
      needRender = true;
    });
    document.getElementById('tg-sketch').addEventListener('change', function (e) {
      view.sketch = e.target.checked;
      if (metrics) rebuild();
    });
    document.getElementById('tg-wire').addEventListener('change', function (e) {
      view.wire = e.target.checked;
      rebuild();
    });

    document.getElementById('tg-section').addEventListener('change', function (e) {
      view.section = e.target.checked;
      var sc = document.getElementById('sec-controls');
      if (sc) sc.hidden = !e.target.checked;
      rebuild();
    });
    document.getElementById('sec-axis').addEventListener('change', function (e) {
      view.sectionAxis = e.target.value;
      if (view.section) rebuild(); else updateSection();
    });
    document.getElementById('sec-offset').addEventListener('input', function (e) {
      view.sectionOffset = 0.5 + Number(e.target.value) / 300;
      var ov = document.getElementById('sec-offset-val');
      if (ov) ov.textContent = Math.round((0.5 + Number(e.target.value) / 300) * 100) + '%';
      if (view.section) rebuild(); else updateSection();
      needRender = true;
    });

    (function () {
      var inp = document.getElementById('cost-price');
      var rb = document.getElementById('cost-price-reset');
      function setPrice(v) {
        if (!part.costPrice || typeof part.costPrice !== 'object') part.costPrice = {};
        if (v === null) delete part.costPrice[part.material];
        else part.costPrice[part.material] = v;
        recordMacro(v === null ? 'Price default ' + part.material : 'Price ' + part.material + ' ' + v + ' €/kg');
        renderCost();
      }
      if (inp) inp.addEventListener('change', function () {
        var v = Number(inp.value);
        if (inp.value === '' ) { setPrice(null); return; }
        if (!isFinite(v) || v <= 0 || v > 100000) { toast('Enter a rate above 0 and up to 100000 €/kg', true); renderCost(); return; }
        setPrice(Math.round(v * 100) / 100);
      });
      if (rb) rb.addEventListener('click', function () { if (inp) inp.value = ''; setPrice(null); });
    })();

    document.getElementById('material').addEventListener('change', function (e) {
      var prev = part.material;
      part.material = e.target.value;
      if (prev !== part.material) recordMacro('Material ' + part.material);
      renderTree();
      rebuild();
    });

    document.getElementById('part-name').setAttribute('title', 'Click to rename');
    document.getElementById('part-name').addEventListener('click', function () {
      var next = window.prompt('Part name', part.name || '');
      if (next && next.trim()) {
        part.name = next.trim().slice(0, 160);
        rebuild();
        refreshPartsList();
      }
    });
  }

  function resize() {
    var w = host.clientWidth || 800;
    var h = host.clientHeight || 600;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (renderer) {
      renderer.setSize(w, h, false);
    } else if (canvas2d) {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas2d.width = Math.max(1, Math.round(w * dpr));
      canvas2d.height = Math.max(1, Math.round(h * dpr));
      canvas2d.style.width = w + 'px';
      canvas2d.style.height = h + 'px';
    }
    needRender = true;
  }

  /* -------------------------------------------------- software rasteriser
     Painter's-algorithm triangle filler used only when WebGL is missing.
     Gives a real shaded view of the same geometry and camera. */

  function drawSoftware() {
    if (!canvas2d || !mesh) return;
    var ctx = canvas2d.getContext('2d');
    if (!ctx) return;
    var W = canvas2d.width;
    var H = canvas2d.height;

    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    var viewM = camera.matrixWorldInverse;
    var projM = camera.projectionMatrix;
    var worldM = mesh.matrixWorld;

    var geo = mesh.geometry;
    var pos = geo.attributes.position;
    var index = geo.index;
    var triCount = index ? index.count / 3 : pos.count / 3;

    var eye = camera.position;
    var light = new THREE.Vector3(0.42, -0.55, 0.72).normalize();
    var base = findMaterial(part.material);
    var baseCol = new THREE.Color(base.color);

    var v0 = new THREE.Vector3(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3();
    var e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    var nrm = new THREE.Vector3(), mid = new THREE.Vector3(), dir = new THREE.Vector3();
    var sv = new THREE.Vector3();
    var tris = [];

    for (var t = 0; t < triCount; t++) {
      var i0 = index ? index.getX(t * 3) : t * 3;
      var i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      var i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      v0.fromBufferAttribute(pos, i0).applyMatrix4(worldM);
      v1.fromBufferAttribute(pos, i1).applyMatrix4(worldM);
      v2.fromBufferAttribute(pos, i2).applyMatrix4(worldM);

      e1.subVectors(v1, v0);
      e2.subVectors(v2, v0);
      nrm.crossVectors(e1, e2);
      if (nrm.lengthSq() < 1e-12) continue;
      nrm.normalize();

      mid.copy(v0).add(v1).add(v2).multiplyScalar(1 / 3);
      dir.subVectors(mid, eye);
      var depth = dir.length();
      dir.normalize();
      if (nrm.dot(dir) > 0) nrm.negate();

      var sx = [], sy = [], behind = false;
      var verts = [v0, v1, v2];
      for (var k = 0; k < 3; k++) {
        sv.copy(verts[k]).applyMatrix4(viewM);
        if (sv.z > -0.05) { behind = true; break; }
        sv.applyMatrix4(projM);
        sx.push((sv.x * 0.5 + 0.5) * W);
        sy.push((-sv.y * 0.5 + 0.5) * H);
      }
      if (behind) continue;

      var shade = 0.26 + 0.74 * Math.max(0, nrm.dot(light));
      var d0 = eye.distanceTo(v0), d1 = eye.distanceTo(v1), d2 = eye.distanceTo(v2);
      tris.push({ z: depth, x: sx, y: sy, d: [d0, d1, d2], shade: shade });
    }

    tris.sort(function (a, b) { return b.z - a.z; });

    ctx.fillStyle = '#12161c';
    ctx.fillRect(0, 0, W, H);
    if (gridHelper.visible) drawSoftwareGrid(ctx, viewM, projM, W, H);

    for (var q = 0; q < tris.length; q++) {
      var tri = tris[q];
      var r = Math.min(255, Math.round(baseCol.r * 255 * tri.shade));
      var g = Math.min(255, Math.round(baseCol.g * 255 * tri.shade));
      var b = Math.min(255, Math.round(baseCol.b * 255 * tri.shade));
      ctx.beginPath();
      ctx.moveTo(tri.x[0], tri.y[0]);
      ctx.lineTo(tri.x[1], tri.y[1]);
      ctx.lineTo(tri.x[2], tri.y[2]);
      ctx.closePath();
      ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
      ctx.fill();
      // Same-colour stroke closes the hairline seams between adjacent triangles.
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    // Coarse depth buffer so hidden edges are not drawn over the solid.
    var zbuf = buildDepthBuffer(tris, W, H);

    if (view.edges && !view.wire && edgeLines) {
      drawSoftwareEdges(ctx, viewM, projM, W, H, eye, zbuf);
    }
  }

  function buildDepthBuffer(tris, W, H) {
    var S = 3;
    var gw = Math.ceil(W / S), gh = Math.ceil(H / S);
    // Inverse depth: larger value = nearer the camera.
    var buf = new Float32Array(gw * gh);
    for (var i = 0; i < buf.length; i++) buf[i] = 0;
    for (var q = 0; q < tris.length; q++) {
      var t = tris[q];
      var xs = t.x, ys = t.y, ds = t.d;
      var minx = Math.min(xs[0], xs[1], xs[2]), maxx = Math.max(xs[0], xs[1], xs[2]);
      var miny = Math.min(ys[0], ys[1], ys[2]), maxy = Math.max(ys[0], ys[1], ys[2]);
      var gx0 = Math.max(0, Math.floor(minx / S)), gx1 = Math.min(gw - 1, Math.ceil(maxx / S));
      var gy0 = Math.max(0, Math.floor(miny / S)), gy1 = Math.min(gh - 1, Math.ceil(maxy / S));
      var den = (ys[1] - ys[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (ys[0] - ys[2]);
      if (Math.abs(den) < 1e-9) continue;
      for (var gy = gy0; gy <= gy1; gy++) {
        for (var gx = gx0; gx <= gx1; gx++) {
          var px = gx * S + S * 0.5, py = gy * S + S * 0.5;
          var w0 = ((ys[1] - ys[2]) * (px - xs[2]) + (xs[2] - xs[1]) * (py - ys[2])) / den;
          var w1 = ((ys[2] - ys[0]) * (px - xs[2]) + (xs[0] - xs[2]) * (py - ys[2])) / den;
          var w2 = 1 - w0 - w1;
          if (w0 < -0.06 || w1 < -0.06 || w2 < -0.06) continue;
          var inv = w0 / ds[0] + w1 / ds[1] + w2 / ds[2];
          var idx = gy * gw + gx;
          if (inv > buf[idx]) buf[idx] = inv;
        }
      }
    }
    return { buf: buf, gw: gw, gh: gh, S: S };
  }

  function depthAtPoint(zbuf, px, py) {
    var gx = Math.floor(px / zbuf.S), gy = Math.floor(py / zbuf.S);
    if (gx < 0 || gy < 0 || gx >= zbuf.gw || gy >= zbuf.gh) return 0;
    return zbuf.buf[gy * zbuf.gw + gx];
  }

  function drawSoftwareEdges(ctx, viewM, projM, W, H, eye, zbuf) {
    var ep = edgeLines.geometry.attributes.position;
    var ea = new THREE.Vector3(), eb = new THREE.Vector3();
    ctx.strokeStyle = 'rgba(9,14,20,0.72)';
    ctx.lineWidth = 1.15;
    ctx.beginPath();

    for (var i = 0; i + 1 < ep.count; i += 2) {
      ea.fromBufferAttribute(ep, i).applyMatrix4(mesh.matrixWorld);
      eb.fromBufferAttribute(ep, i + 1).applyMatrix4(mesh.matrixWorld);

      var pa = projectPoint(ea, viewM, projM, W, H);
      var pb = projectPoint(eb, viewM, projM, W, H);
      if (!pa || !pb) continue;

      // Hidden-line removal: sample the middle of the segment against the depth buffer.
      var ia = 1 / Math.max(1e-6, eye.distanceTo(ea));
      var ib = 1 / Math.max(1e-6, eye.distanceTo(eb));
      var hidden = 0, samples = 0;
      for (var f = 0.1; f <= 0.91; f += 0.1) {
        var mx = pa[0] + (pb[0] - pa[0]) * f;
        var my = pa[1] + (pb[1] - pa[1]) * f;
        var invd = ia + (ib - ia) * f;
        var zb = depthAtPoint(zbuf, mx, my);
        if (zb <= 0) continue; // background: nothing occludes
        samples++;
        // Only a clearly nearer surface (8%+) counts as occlusion.
        if (invd < zb * 0.92) hidden++;
      }
      if (samples && hidden >= samples * 0.55) continue;

      ctx.moveTo(pa[0], pa[1]);
      ctx.lineTo(pb[0], pb[1]);
    }
    ctx.stroke();
  }

  function projectPoint(vec, viewM, projM, W, H) {
    var tmp = new THREE.Vector3().copy(vec);
    tmp.applyMatrix4(viewM);
    if (tmp.z > -0.05) return null;
    tmp.applyMatrix4(projM);
    return [(tmp.x * 0.5 + 0.5) * W, (-tmp.y * 0.5 + 0.5) * H];
  }

  function drawSoftwareGrid(ctx, viewM, projM, W, H) {
    var step = 60, half = 4;
    var tmp = new THREE.Vector3();
    var a = new THREE.Vector3();
    var b = new THREE.Vector3();
    ctx.strokeStyle = 'rgba(92,122,152,0.28)';
    ctx.lineWidth = 1;

    function project(vec) {
      tmp.copy(vec).applyMatrix4(viewM);
      if (tmp.z > -0.05) return null;
      tmp.applyMatrix4(projM);
      return [(tmp.x * 0.5 + 0.5) * W, (-tmp.y * 0.5 + 0.5) * H];
    }

    for (var i = -half; i <= half; i++) {
      a.set(i * step, -half * step, 0);
      b.set(i * step, half * step, 0);
      var pa = project(a), pb = project(b);
      if (pa && pb) { ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.stroke(); }
      a.set(-half * step, i * step, 0);
      b.set(half * step, i * step, 0);
      pa = project(a); pb = project(b);
      if (pa && pb) { ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.stroke(); }
    }
  }

  function loop() {
    requestAnimationFrame(loop);
    if (!needRender) return;
    needRender = false;
    if (renderer) renderer.render(scene, camera);
    else drawSoftware();
  }

  /* Keyboard-driven dimension entry: hotkeys jump to sketch/extrude dims,
     typing digits while a field is focused is the standard flow, and Tab
     walks the dimension fields in order — the fastest path from idea to
     a dimensioned sketch. Reuses the existing numberField/equations
     pipeline; ignores keystrokes while any text/number input is focused
     except Tab, which must still walk the form. */
  function focusDimension(path) {
    var el = document.querySelector('input[data-eqpath="' + path + '"]');
    if (!el || el.disabled) return false;
    el.focus();
    if (el.select) el.select();
    toast('Dimension: ' + path + ' — type a value, press Enter');
    return true;
  }
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      var kk = String(e.key || '').toLowerCase();
      if (kk === 's') {
        e.preventDefault();
        if (e.shiftKey) { exportPartFile(); return; }
        if (partsLibraryAvailable === true) { savePart(false); return; }
        toast('Server parts library unavailable. Use Save file to keep your work.', true);
        return;
      }
      if (!e.shiftKey && kk === 'z') { e.preventDefault(); undo(); return; }
      if (!e.shiftKey && kk === 'y') { e.preventDefault(); redo(); return; }
    }
    if (e.key === 'Tab') return;
    var t = e.target;
    var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    var k = String(e.key || '').toLowerCase();
    if (k === 'w') { if (focusDimension('sketch.width')) e.preventDefault(); }
    else if (k === 'h') { if (focusDimension('sketch.height')) e.preventDefault(); }
    else if (k === 'f') { if (focusDimension('sketch.round')) e.preventDefault(); }
    else if (k === 'e') { if (focusDimension('extrude.depth')) e.preventDefault(); }
    else if (k === 'd') {
      var n = 0;
      while (n < 24) {
        var hel = document.querySelector('input[data-eqpath="holes.' + n + '.d"]');
        if (hel && !hel.disabled) { if (focusDimension('holes.' + n + '.d')) e.preventDefault(); break; }
        n++;
      }
    }
  });

  wireControls();
  var libraryRetry = document.getElementById('btn-parts-retry');
  if (libraryRetry) libraryRetry.addEventListener('click', refreshPartsList);
  var librarySaveFile = document.getElementById('btn-parts-savefile');
  if (librarySaveFile) librarySaveFile.addEventListener('click', function () { exportPartFile(); });
  var libraryOpenFile = document.getElementById('btn-parts-openfile');
  if (libraryOpenFile) libraryOpenFile.addEventListener('click', openPartFile);
  renderAll();
  resize();
  applyCamera();
  fitView();
  refreshPartsList();
  initSessionSnapshot();
  loop();

  window.addEventListener('resize', function () {
    resize();
    needRender = true;
  });

  // expose a tiny handle so a smoke test can read state
  window.__solid = {
    mode: renderer ? 'webgl' : 'canvas2d',
    redraw: function () { needRender = true; },
    getPart: function () { return JSON.parse(JSON.stringify(part)); },
    partFilePayload: partFilePayload,
    importPartFile: importPartFile,
    holeSpacing: function () {
      var p = holeSpacingPairs();
      return p ? { gap: p.gap, a: p.a, b: p.b, count: p.count } : null;
    },
    getMetrics: function () { return metrics ? JSON.parse(JSON.stringify(metrics)) : null; },
    loadPart: loadPartIntoEditor,
    getMesh: function () { return mesh; },
    testPushPullReplay: pushPullTestReplay,
    undo: undo,
    redo: redo,
    undoDepth: function () { return undoStack.length; },
    exportPartFile: exportPartFile,
    session: function () {
      return {
        armed: sessionArmed,
        savedAt: sessionSavedAt,
        librarySaved: librarySaved,
        partFileSaved: !!(partFileSaved && partFileSavedKey === partKey(part)),
        partFileSavedAt: partFileSavedAt,
        partsLibraryAvailable: partsLibraryAvailable,
        status: (document.getElementById('session-status') || {}).textContent || '',
        title: (document.getElementById('session-status') || {}).getAttribute ? document.getElementById('session-status').getAttribute('title') : null,
        state: (document.getElementById('session-status') || {}).getAttribute ? document.getElementById('session-status').getAttribute('data-state') : null,
        blocked: sessionBlocked,
        blockedReason: sessionBlockReason,
        banner: !!(document.getElementById('restore-banner') && !document.getElementById('restore-banner').hidden),
        localOnlyNote: !!(document.getElementById('local-only-note') && !document.getElementById('local-only-note').hidden),
        restoredLocalOnly: restoredLocalOnly,
        stored: !!readSession()
      };
    },
    restoreSession: restoreSessionSnapshot,
    discardSession: discardSessionSnapshot,
    snapshotNow: function () { writeSessionSnapshot(); return readSession(); },
    flushSession: flushSessionSnapshot,
    redoDepth: function () { return redoStack.length; }
  };
})();
