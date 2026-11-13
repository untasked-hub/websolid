// WebSolid SVG path import: convert an SVG path "d" string into custom sketch entities.
// Supports M/m, L/l, H/h, V/v, A/a (already 2D arcs), C/c + Q/q + S/s/T/t (flattened to polyline segments).
// Z/z closes. Coordinates are transformed by (scale, -scale, tx, ty) since SVG y goes down and CAD y goes up.
(function () {
  'use strict';

  function parsePath(d) {
    var tokens = [];
    var re = /([MmLlHhVvAaCcQqSsTtZz])|(-?\d*\.?\d+(?:e[+-]?\d+)?)/gi;
    var m;
    while ((m = re.exec(d)) !== null) {
      if (m[1]) tokens.push(m[1]);
      else tokens.push(parseFloat(m[2]));
    }
    return tokens;
  }

  // Flatten a cubic bezier into n line segments, return intermediate points (excluding start).
  function flattenCubic(x0, y0, x1, y1, x2, y2, x3, y3, n) {
    var pts = [];
    for (var i = 1; i <= n; i++) {
      var t = i / n, mt = 1 - t;
      var a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, dd = t * t * t;
      pts.push([a * x0 + b * x1 + c * x2 + dd * x3, a * y0 + b * y1 + c * y2 + dd * y3]);
    }
    return pts;
  }

  function flattenQuad(x0, y0, x1, y1, x2, y2, n) {
    var pts = [];
    for (var i = 1; i <= n; i++) {
      var t = i / n, mt = 1 - t;
      pts.push([mt * mt * x0 + 2 * mt * t * x1 + t * t * x2,
        mt * mt * y0 + 2 * mt * t * y1 + t * t * y2]);
    }
    return pts;
  }

  // Convert path data to entities in a local coordinate frame; caller applies scale/offset.
  // opts: { tol } tolerance for collapsing collinear points (default 1e-6).
  function pathToEntities(d, opts) {
    opts = opts || {};
    var tol = opts.tol || 1e-6;
    var segs = 12; // segments per curve
    var tokens = parsePath(d);
    var ents = [];
    var cx = 0, cy = 0, sx = 0, sy = 0; // current point, subpath start
    var haveStart = false;
    var prevC = null, prevQ = null; // reflection control points
    var cmd = null, i = 0;

    function nextNum() { var v = tokens[i++]; if (typeof v !== 'number') throw new Error('SVG path: expected number'); return v; }
    function addLine(x0, y0, x1, y1) {
      if (Math.hypot(x1 - x0, y1 - y0) < tol) return;
      ents.push({ type: 'line', x1: x0, y1: y0, x2: x1, y2: y1 });
    }
    // Try to represent a chain of collinear points by merging: caller flattens curves then merges.

    while (i < tokens.length) {
      if (typeof tokens[i] === 'string') { cmd = tokens[i++]; }
      switch (cmd) {
        case 'M': case 'm': {
          var x = nextNum(), y = nextNum();
          if (cmd === 'm') { x += cx; y += cy; }
          cx = x; cy = y;
          if (!haveStart) { sx = x; sy = y; haveStart = true; }
          else { sx = x; sy = y; } // new subpath
          // implicit lineto follows
          cmd = (cmd === 'M') ? 'L' : 'l';
          break;
        }
        case 'L': case 'l': {
          do {
            var x = nextNum(), y = nextNum();
            if (cmd === 'l') { x += cx; y += cy; }
            addLine(cx, cy, x, y);
            cx = x; cy = y;
          } while (i < tokens.length && typeof tokens[i] === 'number');
          break;
        }
        case 'H': case 'h': {
          do {
            var x = nextNum(); if (cmd === 'h') x += cx;
            addLine(cx, cy, x, cy); cx = x;
          } while (i < tokens.length && typeof tokens[i] === 'number');
          break;
        }
        case 'V': case 'v': {
          do {
            var y = nextNum(); if (cmd === 'v') y += cy;
            addLine(cx, cy, cx, y); cy = y;
          } while (i < tokens.length && typeof tokens[i] === 'number');
          break;
        }
        case 'A': case 'a': {
          do {
            var rx = nextNum(), ry = nextNum(), rot = nextNum(), laf = nextNum(), sf = nextNum();
            var x = nextNum(), y = nextNum();
            if (cmd === 'a') { x += cx; y += cy; }
            // Convert SVG endpoint arc to center parameterization, then emit arc entity.
            var arc = svgArcToCenter(cx, cy, rx, ry, rot, laf, sf, x, y);
            ents.push({ type: 'arc', cx: arc.cx, cy: arc.cy, r: arc.r, a0: arc.a0, a1: arc.a1, ccw: sf === 1 });
            cx = x; cy = y;
          } while (i < tokens.length && typeof tokens[i] === 'number');
          break;
        }
        case 'C': case 'c': case 'S': case 's': {
          do {
            var x1, y1;
            if (cmd === 'C' || cmd === 'c') { x1 = nextNum(); y1 = nextNum(); if (cmd === 'c') { x1 += cx; y1 += cy; } }
            else { // S reflects previous control
              if (prevC) { x1 = 2 * cx - prevC[0]; y1 = 2 * cy - prevC[1]; } else { x1 = cx; y1 = cy; }
            }
            var x2 = nextNum(), y2 = nextNum();
            if (cmd === 'c') { x2 += cx; y2 += cy; }
            else if (cmd === 's') { x2 += cx; y2 += cy; }
            var x = nextNum(), y = nextNum();
            if (cmd === 'c' || cmd === 's') { x += cx; y += cy; }
            prevC = [x2, y2];
            var pts = flattenCubic(cx, cy, x1, y1, x2, y2, x, y, segs);
            for (var p = 0; p < pts.length; p++) {
              addLine(cx, cy, pts[p][0], pts[p][1]);
              cx = pts[p][0]; cy = pts[p][1];
            }
          } while (i < tokens.length && typeof tokens[i] === 'number');
          break;
        }
        case 'Q': case 'q': case 'T': case 't': {
          do {
            var x1, y1;
            if (cmd === 'Q' || cmd === 'q') { x1 = nextNum(); y1 = nextNum(); if (cmd === 'q') { x1 += cx; y1 += cy; } }
            else {
              if (prevQ) { x1 = 2 * cx - prevQ[0]; y1 = 2 * cy - prevQ[1]; } else { x1 = cx; y1 = cy; }
            }
            var x = nextNum(), y = nextNum();
            if (cmd === 'q' || cmd === 't') { x += cx; y += cy; }
            prevQ = [x1, y1];
            var pts = flattenQuad(cx, cy, x1, y1, x, y, segs);
            for (var p = 0; p < pts.length; p++) {
              addLine(cx, cy, pts[p][0], pts[p][1]);
              cx = pts[p][0]; cy = pts[p][1];
            }
          } while (i < tokens.length && typeof tokens[i] === 'number');
          break;
        }
        case 'Z': case 'z': {
          addLine(cx, cy, sx, sy);
          cx = sx; cy = sy;
          break;
        }
        default:
          throw new Error('SVG path: unsupported command ' + cmd);
      }
    }
    return mergeCollinear(ents, tol);
  }

  // Merge consecutive line segments that are collinear (curve flattening artifacts).
  function mergeCollinear(ents, tol) {
    var out = [];
    for (var k = 0; k < ents.length; k++) {
      var e = ents[k];
      if (e.type !== 'line') { out.push(e); continue; }
      var prev = out.length ? out[out.length - 1] : null;
      if (prev && prev.type === 'line'
          && Math.hypot(prev.x2 - e.x1, prev.y2 - e.y1) <= tol) {
        // only merge when the previous segment ends where this one starts (same subpath)
        // direction vectors
        var d1x = prev.x2 - prev.x1, d1y = prev.y2 - prev.y1;
        var d2x = e.x2 - e.x1, d2y = e.y2 - e.y1;
        var l1 = Math.hypot(d1x, d1y), l2 = Math.hypot(d2x, d2y);
        if (l1 > 0 && l2 > 0) {
          var cross = d1x * d2y - d1y * d2x;
          var dot = d1x * d2x + d1y * d2y;
          if (dot <= 0) { out.push(e); continue; }
          if (Math.abs(cross) <= tol * l1 * l2 && dot > 0) {
            // collinear and same direction: extend prev
            prev.x2 = e.x2; prev.y2 = e.y2;
            continue;
          }
        }
      }
      out.push(e);
    }
    return out;
  }

  // SVG endpoint->center arc conversion (per SVG spec appendix F.6.5), returning angles in radians.
  // Angles: a0 = start angle, a1 = end angle measured in standard math convention AFTER y-flip handled by caller.
  // We emit angles in the coordinate frame where the arc actually lies (SVG frame, y down); the caller flips
  // y by negating cy and swapping angle direction via ccw flag.
  function svgArcToCenter(x1, y1, rx, ry, phiDeg, laf, sf, x2, y2) {
    var phi = phiDeg * Math.PI / 180;
    var cosP = Math.cos(phi), sinP = Math.sin(phi);
    var dx2 = (x1 - x2) / 2, dy2 = (y1 - y2) / 2;
    var x1p = cosP * dx2 + sinP * dy2;
    var y1p = -sinP * dx2 + cosP * dy2;
    rx = Math.abs(rx); ry = Math.abs(ry);
    var lambda = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry);
    if (lambda > 1) { var s = Math.sqrt(lambda); rx *= s; ry *= s; }
    var sign = (laf !== sf) ? 1 : -1;
    var num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    var den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    var co = sign * Math.sqrt(Math.max(0, num / den));
    var cxp = co * rx * y1p / ry;
    var cyp = -co * ry * x1p / rx;
    var cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
    var cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
    function ang(ux, uy, vx, vy) {
      var dot = ux * vx + uy * vy;
      var len = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
      var a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
      if (ux * vy - uy * vx < 0) a = -a;
      return a;
    }
    var a0 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    var a1 = ang(1, 0, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    // Per SVG spec F.6.5: adjust based on the sign of the sweep delta, not a1 itself.
    var delta = a1 - a0;
    if (sf === 0 && delta > 0) a1 -= 2 * Math.PI;
    if (sf === 1 && delta < 0) a1 += 2 * Math.PI;
    // r for entity: use max radius; store ellipse rx/ry via r=rx and note. WebSolid entities are circular:
    // approximate ellipse by r=ry when rx!=ry? Emit r as rx/ry mean; circles are the common case.
    var r = (Math.abs(rx - ry) < 1e-9) ? rx : (rx + ry) / 2;
    return { cx: cx, cy: cy, r: r, a0: a0, a1: a1 };
  }

  // Full import: pathData -> entities scaled/positioned into CAD coordinates.
  // opts: { scale, offsetX, offsetY } scale applied to SVG units; y is flipped.
  function importPath(d, opts) {
    opts = opts || {};
    var scale = opts.scale || 1;
    var tx = opts.offsetX || 0, ty = opts.offsetY || 0;
    var ents = pathToEntities(d, opts);
    return ents.map(function (e) {
      if (e.type === 'line') {
        return { type: 'line', x1: e.x1 * scale + tx, y1: -e.y1 * scale + ty, x2: e.x2 * scale + tx, y2: -e.y2 * scale + ty };
      }
      // arc: flip y around ty and mirror angle direction
      var cy2 = -e.cy * scale + ty;
      var a0 = -e.a1, a1 = -e.a0; // y-flip reverses sweep
      return { type: 'arc', cx: e.cx * scale + tx, cy: cy2, r: e.r * scale, a0: a0, a1: a1, ccw: !e.ccw };
    });
  }

  var UNIT_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 1 };

  // Parse a numeric SVG length with an optional unit. Unitless values and px are
  // interpreted in the SVG user coordinate system and scaled to millimetres by the caller.
  function parseLength(value, fallbackUnit) {
    if (typeof value === 'number') return { value: value, unit: fallbackUnit || 'px' };
    var match = new RegExp('^\\s*([+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?)\\s*(mm|cm|in|pt|pc|px)?\\s*$', 'i').exec(value || '');
    if (!match) throw new Error('Invalid SVG length: ' + value);
    return { value: parseFloat(match[1]), unit: (match[2] || fallbackUnit || 'px').toLowerCase() };
  }

  function lengthToMm(value, fallbackUnit) {
    var length = parseLength(value, fallbackUnit);
    return length.value * (UNIT_MM[length.unit] || 1);
  }

  function parseNumberList(value) {
    if (!value) return [];
    var matches = String(value).match(new RegExp('[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?', 'gi'));
    return matches ? matches.map(Number) : [];
  }

  function pointsAttribute(value) {
    var numbers = parseNumberList(value);
    if (numbers.length % 2) throw new Error('SVG points must contain x/y pairs');
    var points = [];
    for (var i = 0; i < numbers.length; i += 2) points.push([numbers[i], numbers[i + 1]]);
    return points;
  }

  function lineEntities(points, close) {
    var entities = [];
    for (var i = 1; i < points.length; i++) {
      if (Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]) > 1e-9) {
        entities.push({ type: 'line', x1: points[i - 1][0], y1: points[i - 1][1], x2: points[i][0], y2: points[i][1] });
      }
    }
    if (close && points.length > 2) {
      var first = points[0], last = points[points.length - 1];
      if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 1e-9) {
        entities.push({ type: 'line', x1: last[0], y1: last[1], x2: first[0], y2: first[1] });
      }
    }
    return entities;
  }

  // Browser implementation uses DOMParser; the injectable Document option keeps
  // this routine straightforward to exercise with a small test DOM.
  function parseSvgDocument(source, DocumentParser) {
    if (!source || !String(source).trim()) throw new Error('Choose an SVG file first');
    if (String(source).length > 2000000) throw new Error('SVG files must be smaller than 2 MB');
    var Parser = DocumentParser || (typeof DOMParser !== 'undefined' ? DOMParser : null);
    if (!Parser) throw new Error('SVG document parsing requires a browser DOMParser');
    var doc = new Parser().parseFromString(String(source), 'image/svg+xml');
    if (doc.querySelector('parsererror')) throw new Error('The selected file is not valid SVG/XML');
    var svg = doc.documentElement;
    if (!svg || String(svg.localName).toLowerCase() !== 'svg') throw new Error('The selected file does not contain an SVG root element');
    return svg;
  }

  // Return a stable, human-readable summary for the import preview before any
  // geometry is committed to the current sketch.
  function summarizeEntities(entities) {
    var lines = 0, arcs = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    function include(x, y) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    (entities || []).forEach(function (e) {
      if (e.type === 'line') { lines++; include(e.x1, e.y1); include(e.x2, e.y2); }
      else if (e.type === 'arc') {
        arcs++; include(e.cx - e.r, e.cy - e.r); include(e.cx + e.r, e.cy + e.r);
      }
    });
    return {
      lines: lines, arcs: arcs, total: lines + arcs,
      width: lines + arcs ? maxX - minX : 0, height: lines + arcs ? maxY - minY : 0,
      bounds: lines + arcs ? { minX: minX, minY: minY, maxX: maxX, maxY: maxY } : null
    };
  }

  function svgToPathData(svg) {
    var paths = [];
    function numAttr(el, name, fallback) { var n = parseFloat(el.getAttribute(name)); return isFinite(n) ? n : fallback; }
    function fmt(n) { return Math.round(n * 1000000) / 1000000; }
    function add(d) { if (d) paths.push(d); }
    var elements = svg.querySelectorAll('path,rect,circle,ellipse,line,polyline,polygon');
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i], tag = el.localName.toLowerCase();
      // This first release imports untransformed geometry; report transforms rather
      // than silently producing wrong coordinates.
      var node = el;
      while (node && node !== svg) {
        if (node.getAttribute && node.getAttribute('transform')) throw new Error('SVG transforms are not supported yet; bake transforms before importing');
        node = node.parentNode;
      }
      if (tag === 'path') add(el.getAttribute('d'));
      else if (tag === 'rect') {
        var x = numAttr(el, 'x', 0), y = numAttr(el, 'y', 0), w = numAttr(el, 'width', 0), h = numAttr(el, 'height', 0);
        if (w > 0 && h > 0) add('M'+fmt(x)+' '+fmt(y)+'H'+fmt(x+w)+'V'+fmt(y+h)+'H'+fmt(x)+'Z');
      } else if (tag === 'circle' || tag === 'ellipse') {
        var cx = numAttr(el, 'cx', 0), cy = numAttr(el, 'cy', 0);
        var rx = tag === 'circle' ? numAttr(el, 'r', 0) : numAttr(el, 'rx', 0);
        var ry = tag === 'circle' ? rx : numAttr(el, 'ry', 0);
        if (rx > 0 && ry > 0) add('M'+fmt(cx-rx)+' '+fmt(cy)+'A'+fmt(rx)+' '+fmt(ry)+' 0 1 0 '+fmt(cx+rx)+' '+fmt(cy)+'A'+fmt(rx)+' '+fmt(ry)+' 0 1 0 '+fmt(cx-rx)+' '+fmt(cy)+'Z');
      } else if (tag === 'line') {
        add('M'+numAttr(el,'x1',0)+' '+numAttr(el,'y1',0)+'L'+numAttr(el,'x2',0)+' '+numAttr(el,'y2',0));
      } else {
        var pts = pointsAttribute(el.getAttribute('points'));
        if (pts.length > 1) {
          var d = 'M'+pts[0][0]+' '+pts[0][1];
          for (var j = 1; j < pts.length; j++) d += 'L'+pts[j][0]+' '+pts[j][1];
          if (tag === 'polygon') d += 'Z';
          add(d);
        }
      }
    }
    return paths;
  }

  function svgDocumentToEntities(source, opts, DocumentParser) {
    opts = opts || {};
    var svg = parseSvgDocument(source, DocumentParser);
    var viewBox = parseNumberList(svg.getAttribute('viewBox'));
    var widthAttr = svg.getAttribute('width'), heightAttr = svg.getAttribute('height');
    var units = (opts.units || 'auto').toLowerCase();
    var userScale = opts.scale == null ? 1 : Number(opts.scale);
    if (!(userScale > 0) || !isFinite(userScale)) throw new Error('Scale must be a positive number');
    var scale = userScale;
    if (units === 'auto') {
      var unitLength = widthAttr ? parseLength(widthAttr) : (heightAttr ? parseLength(heightAttr) : null);
      var viewWidth = viewBox.length === 4 ? viewBox[2] : NaN;
      if (unitLength && unitLength.unit !== 'px' && viewWidth > 0) scale = UNIT_MM[unitLength.unit] * unitLength.value / viewWidth;
      else if (unitLength && unitLength.unit !== 'px' && !(viewWidth > 0)) scale = UNIT_MM[unitLength.unit];
      else if (viewWidth > 0 && widthAttr && heightAttr) scale = lengthToMm(widthAttr) / viewWidth;
    } else {
      if (!UNIT_MM[units]) throw new Error('Unsupported SVG unit: ' + units);
      scale *= UNIT_MM[units];
    }
    var paths = svgToPathData(svg);
    if (!paths.length) throw new Error('No supported SVG shapes found (path, rect, circle, ellipse, line, polyline, polygon)');
    var offsetX = viewBox.length === 4 ? viewBox[0] : 0, offsetY = viewBox.length === 4 ? viewBox[1] : 0;
    var entities = [];
    for (var i = 0; i < paths.length; i++) {
      var local = importPath(paths[i], { scale: scale, offsetX: -offsetX * scale, offsetY: offsetY * scale });
      entities = entities.concat(local);
    }
    if (!entities.length) throw new Error('SVG shapes did not produce usable sketch entities');
    return { entities: entities, scale: scale, pathCount: paths.length, summary: summarizeEntities(entities) };
  }

  var api = { parsePath: parsePath, pathToEntities: pathToEntities, svgArcToCenter: svgArcToCenter, importPath: importPath,
    UNIT_MM: UNIT_MM, parseLength: parseLength, lengthToMm: lengthToMm, parseNumberList: parseNumberList,
    pointsAttribute: pointsAttribute, lineEntities: lineEntities, parseSvgDocument: parseSvgDocument, summarizeEntities: summarizeEntities,
    svgToPathData: svgToPathData, svgDocumentToEntities: svgDocumentToEntities };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SvgImport = api;
})();
