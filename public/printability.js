/* WebSolid printability checks — pure triangulated-mesh analysis.
   No BREP claims: everything below is computed from the exported triangle
   soup so the results match what a slicer actually sees. UMD-style so the
   same file unit-tests under Node and runs in the browser. */
(function (root) {
  'use strict';

  var EPS = 1e-9;
  var DEDUP = 4; /* vertex-identity rounding, decimals */

  function thresholds(part) {
    var p = (part && part.printability) || {};
    return {
      profile: p.profile === 'resin' ? 'resin' : 'fdm',
      minWall: pos(p.minWall, 1.2),
      minHole: pos(p.minHole, 2.5),
      overhang: deg(p.overhang, 45)
    };
  }
  function pos(v, d) { v = Number(v); return isFinite(v) && v > 0 ? v : d; }
  function deg(v, d) { v = Number(v); return isFinite(v) ? Math.min(89, Math.max(1, v)) : d; }

  /* tris: flat array of triangle vertices, 9 numbers per triangle. */
  function analyze(tris, th) {
    th = th || {};
    var triCount = Math.floor(tris.length / 9);
    var res = {
      tris: triCount,
      openEdges: 0, nonManifoldEdges: 0, components: 0,
      volumeMm3: 0, minWallMm: null, minHoleMm: null,
      overhangDeg: 0, downwardAreaMm2: 0
    };
    if (!triCount) return res;

    var t, i;
    var nx = new Float64Array(triCount), ny = new Float64Array(triCount), nz = new Float64Array(triCount);
    var cx = new Float64Array(triCount), cy = new Float64Array(triCount), cz = new Float64Array(triCount);
    var area = new Float64Array(triCount);
    var minZ = Infinity, maxZ = -Infinity;

    for (t = 0; t < triCount; t++) {
      var o = t * 9;
      var ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
      var bx = tris[o + 3], by = tris[o + 4], bz = tris[o + 5];
      var gx = tris[o + 6], gy = tris[o + 7], gz = tris[o + 8];
      var ux = bx - ax, uy = by - ay, uz = bz - az;
      var vx = gx - ax, vy = gy - ay, vz = gz - az;
      var wx = uy * vz - uz * vy, wy = uz * vx - ux * vz, wz = ux * vy - uy * vx;
      var len = Math.sqrt(wx * wx + wy * wy + wz * wz);
      area[t] = len / 2;
      if (len > EPS) { nx[t] = wx / len; ny[t] = wy / len; nz[t] = wz / len; }
      cx[t] = (ax + bx + gx) / 3; cy[t] = (ay + by + gy) / 3; cz[t] = (az + bz + gz) / 3;
      if (az < minZ) minZ = az; if (az > maxZ) maxZ = az;
      if (bz < minZ) minZ = bz; if (bz > maxZ) maxZ = bz;
      if (gz < minZ) minZ = gz; if (gz > maxZ) maxZ = gz;
      var c1 = by * gz - bz * gy, c2 = bz * gx - bx * gz, c3 = bx * gy - by * gx;
      res.volumeMm3 += ax * c1 + ay * c2 + az * c3;
    }
    res.volumeMm3 = Math.abs(res.volumeMm3) / 6;
    var spanZ = maxZ - minZ;

    /* ---- edge census: manifold check + connected components ---- */
    resetVertexCache();
    var edges = Object.create(null);
    var parent = new Int32Array(triCount);
    for (t = 0; t < triCount; t++) parent[t] = t;
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    for (t = 0; t < triCount; t++) {
      var o2 = t * 9;
      var idx = [vid(tris, o2), vid(tris, o2 + 3), vid(tris, o2 + 6)];
      for (var e = 0; e < 3; e++) {
        var a = idx[e], b = idx[(e + 1) % 3];
        if (a === b) continue;
        var k = a < b ? a + '_' + b : b + '_' + a;
        var slot = edges[k];
        if (slot === undefined) { edges[k] = { n: 1, a: t, b: -1 }; }
        else {
          slot.n++;
          if (slot.b < 0) slot.b = t;
          var ra = find(slot.a), rb = find(t);
          if (ra !== rb) parent[ra] = rb;
        }
      }
    }
    var roots = Object.create(null);
    for (t = 0; t < triCount; t++) roots[find(t)] = 1;
    for (var r in roots) res.components++;
    for (var k2 in edges) {
      if (edges[k2].n === 1) res.openEdges++;
      else if (edges[k2].n > 2) res.nonManifoldEdges++;
    }

    /* ---- min wall thickness: cast each triangle centroid inward ---- */
    if (triCount <= 4000) {
      var best = Infinity;
      for (t = 0; t < triCount; t++) {
        if (area[t] < EPS) continue;
        var hit = raycast(tris, triCount, cx[t], cy[t], cz[t], -nx[t], -ny[t], -nz[t], t);
        if (hit !== null && hit > EPS && hit < best) best = hit;
      }
      if (isFinite(best)) res.minWallMm = best;
    }

    /* ---- overhang: downward faces steeper than the threshold, off the bed ---- */
    var sinLimit = Math.sin(th.overhang * Math.PI / 180);
    var worst = 0, downArea = 0;
    for (t = 0; t < triCount; t++) {
      if (area[t] < EPS) continue;
      if (nz[t] < -sinLimit) {
        var bedLift = cz[t] - minZ;
        if (bedLift > Math.max(0.05, spanZ * 0.005)) {
          var ang = Math.acos(Math.min(1, Math.max(-1, -nz[t]))) * 180 / Math.PI;
          if (ang > worst) worst = ang;
          downArea += area[t];
        }
      }
    }
    res.overhangDeg = worst;
    res.downwardAreaMm2 = downArea;
    return res;
  }

  var vcache = null, vcacheCount = 0;
  function resetVertexCache() { vcache = Object.create(null); vcacheCount = 0; }
  function vid(tris, off) {
    var k = tris[off].toFixed(DEDUP) + ',' + tris[off + 1].toFixed(DEDUP) + ',' + tris[off + 2].toFixed(DEDUP);
    var id = vcache[k];
    if (id === undefined) { id = vcacheCount++; vcache[k] = id; }
    return id;
  }

  /* Moller-Trumbore; skip the originating triangle. */
  function raycast(tris, triCount, ox, oy, oz, dx, dy, dz, skip) {
    var best = null;
    for (var t = 0; t < triCount; t++) {
      if (t === skip) continue;
      var o = t * 9;
      var ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
      var bx = tris[o + 3], by = tris[o + 4], bz = tris[o + 5];
      var gx = tris[o + 6], gy = tris[o + 7], gz = tris[o + 8];
      var e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      var e2x = gx - ax, e2y = gy - ay, e2z = gz - az;
      var px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      var det = e1x * px + e1y * py + e1z * pz;
      if (det > -EPS && det < EPS) continue;
      var inv = 1 / det;
      var tx = ox - ax, ty = oy - ay, tz = oz - az;
      var u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      var qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      var v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      var dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (dist > EPS && (best === null || dist < best)) best = dist;
    }
    return best;
  }

  /* Verdicts against thresholds. Slicing the part model would give exact hole
     diameters; from a triangle soup we get the *nominal* diameters via the
     hole list, so the caller passes holes = [{d}] in mm and revolve/sweep
     parts pass []. Hole check therefore skips cleanly when unknown. */
  function verdicts(res, th, holeDiams) {
    holeDiams = holeDiams || [];
    var out = [];
    var manifoldOk = res.tris > 0 && res.openEdges === 0 && res.nonManifoldEdges === 0 && res.components === 1;
    out.push({
      id: 'manifold', label: 'Watertight & manifold',
      pass: manifoldOk,
      note: manifoldOk ? res.tris + ' tris, 1 shell' :
        (res.openEdges + ' open / ' + res.nonManifoldEdges + ' non-manifold edges, ' + res.components + ' shell(s)')
    });
    if (res.minWallMm !== null) {
      var wallOk = res.minWallMm >= th.minWall;
      out.push({
        id: 'wall', label: 'Min wall thickness',
        pass: wallOk,
        note: fmt(res.minWallMm) + ' mm vs ' + th.minWall + ' mm min' + (th.profile === 'resin' ? ' (resin)' : '')
      });
    } else {
      out.push({ id: 'wall', label: 'Min wall thickness', pass: true, note: 'skipped — mesh too dense to raycast in time' });
    }
    var holesKnown = holeDiams.length > 0;
    var minHole = holesKnown ? Math.min.apply(null, holeDiams) : null;
    if (holesKnown) {
      var holeOk = minHole >= th.minHole;
      out.push({
        id: 'hole', label: 'Hole diameters',
        pass: holeOk,
        note: 'smallest ' + fmt(minHole) + ' mm vs ' + th.minHole + ' mm min (' + holeDiams.length + ' hole' + (holeDiams.length === 1 ? '' : 's') + ')'
      });
    } else {
      out.push({ id: 'hole', label: 'Hole diameters', pass: true, note: 'revolved / swept features — no circular cut list' });
    }
    var overhangOk = res.overhangDeg <= th.overhang;
    out.push({
      id: 'overhang', label: 'Overhang angle',
      pass: overhangOk,
      note: res.overhangDeg > 0 ? 'worst ' + fmt(res.overhangDeg, 0) + '° from vertical vs ' + th.overhang + '° max' : 'no unsupported overhangs'
    });
    var solidOk = res.components <= 1 && res.volumeMm3 > 0;
    out.push({
      id: 'shell', label: 'Solid / connected',
      pass: solidOk,
      note: solidOk ? 'one connected shell, ' + fmt(res.volumeMm3 / 1000, 2) + ' cm3' : (res.components > 1 ? res.components + ' disconnected shells' : 'no closed volume')
    });
    return out;
  }

  function fmt(n, d) {
    if (d === undefined) d = 2;
    if (!isFinite(n)) return '-';
    return Number(n).toLocaleString('en', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  var api = { analyze: analyze, verdicts: verdicts, thresholds: thresholds };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SolidPrintability = api;
})(this);
