/* AE Physics — 2D geometry helpers. Runs in the CEP panel and in Node (tests). */
(function (root) {
  'use strict';
  var GEO = {};
  var DEG = Math.PI / 180;

  // Affine matrix {a,b,c,d,tx,ty}:  x' = a*x + c*y + tx ; y' = b*x + d*y + ty  (y-down, AE convention)
  GEO.identity = function () { return { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }; };
  GEO.translate = function (x, y) { return { a: 1, b: 0, c: 0, d: 1, tx: x, ty: y }; };
  GEO.scale = function (sx, sy) { return { a: sx, b: 0, c: 0, d: sy, tx: 0, ty: 0 }; };
  GEO.rotate = function (deg) {
    var r = deg * DEG, cs = Math.cos(r), sn = Math.sin(r);
    return { a: cs, b: sn, c: -sn, d: cs, tx: 0, ty: 0 };
  };
  // m ∘ n : apply n first, then m
  GEO.multiply = function (m, n) {
    return {
      a: m.a * n.a + m.c * n.b,
      b: m.b * n.a + m.d * n.b,
      c: m.a * n.c + m.c * n.d,
      d: m.b * n.c + m.d * n.d,
      tx: m.a * n.tx + m.c * n.ty + m.tx,
      ty: m.b * n.tx + m.d * n.ty + m.ty
    };
  };
  // AE transform order: T(position) · R(rotation) · S(scale%) · T(-anchor)
  GEO.trs = function (anchor, position, scalePct, rotationDeg) {
    var m = GEO.translate(position[0], position[1]);
    m = GEO.multiply(m, GEO.rotate(rotationDeg || 0));
    m = GEO.multiply(m, GEO.scale((scalePct ? scalePct[0] : 100) / 100, (scalePct ? scalePct[1] : 100) / 100));
    m = GEO.multiply(m, GEO.translate(-anchor[0], -anchor[1]));
    return m;
  };
  GEO.apply = function (m, p) { return [m.a * p[0] + m.c * p[1] + m.tx, m.b * p[0] + m.d * p[1] + m.ty]; };
  GEO.applyAll = function (m, pts) { var out = []; for (var i = 0; i < pts.length; i++) out.push(GEO.apply(m, pts[i])); return out; };
  // If m is rotation + uniform scale (no shear/non-uniform), return the scale factor; else null.
  GEO.uniformScale = function (m, eps) {
    eps = eps || 1e-3;
    var s1 = Math.sqrt(m.a * m.a + m.b * m.b), s2 = Math.sqrt(m.c * m.c + m.d * m.d);
    if (Math.abs(s1 - s2) > eps * Math.max(1, s1)) return null;
    if (Math.abs(m.a * m.c + m.b * m.d) > eps * Math.max(1, s1 * s1)) return null;
    return s1;
  };

  GEO.bezierPoint = function (p0, p1, p2, p3, t) {
    var u = 1 - t, uu = u * u, tt = t * t, a = uu * u, b = 3 * uu * t, c = 3 * u * tt, d = tt * t;
    return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
  };
  // AE Shape: vertices + in/out tangents relative to their vertex.
  GEO.sampleShape = function (shape, segs) {
    var v = shape.vertices, it = shape.inTangents || [], ot = shape.outTangents || [];
    var closed = shape.closed !== false, n = v.length, pts = [];
    if (n === 0) return pts;
    if (n === 1) return [[v[0][0], v[0][1]]];
    segs = segs || 6;
    var segCount = closed ? n : n - 1;
    for (var k = 0; k < segCount; k++) {
      var k2 = (k + 1) % n, p0 = v[k], p3 = v[k2];
      var o = ot[k] || [0, 0], i2 = it[k2] || [0, 0];
      pts.push([p0[0], p0[1]]);
      var straight = (Math.abs(o[0]) + Math.abs(o[1]) + Math.abs(i2[0]) + Math.abs(i2[1])) < 1e-6;
      if (!straight) {
        var p1 = [p0[0] + o[0], p0[1] + o[1]], p2 = [p3[0] + i2[0], p3[1] + i2[1]];
        for (var s = 1; s < segs; s++) pts.push(GEO.bezierPoint(p0, p1, p2, p3, s / segs));
      }
    }
    if (!closed) pts.push([v[n - 1][0], v[n - 1][1]]);
    return pts;
  };

  GEO.dedupe = function (pts, eps) {
    eps = eps || 0.25;
    var out = [];
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i], dup = false;
      for (var j = 0; j < out.length; j++) {
        if (Math.abs(out[j][0] - p[0]) < eps && Math.abs(out[j][1] - p[1]) < eps) { dup = true; break; }
      }
      if (!dup) out.push(p);
    }
    return out;
  };
  // Andrew's monotone chain. Returns hull (CCW in y-up math coords).
  GEO.convexHull = function (points) {
    var pts = points.slice().sort(function (p, q) { return p[0] === q[0] ? p[1] - q[1] : p[0] - q[0]; });
    var n = pts.length;
    if (n < 3) return pts;
    function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
    var lower = [], upper = [], i;
    for (i = 0; i < n; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
      lower.push(pts[i]);
    }
    for (i = n - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
      upper.push(pts[i]);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  };
  GEO.area = function (pts) {
    var a = 0;
    for (var i = 0, n = pts.length; i < n; i++) { var j = (i + 1) % n; a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]; }
    return a / 2;
  };
  GEO.bounds = function (pts) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    }
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY, width: maxX - minX, height: maxY - minY };
  };
  GEO.centroid = function (pts) {
    var x = 0, y = 0;
    for (var i = 0; i < pts.length; i++) { x += pts[i][0]; y += pts[i][1]; }
    return [x / pts.length, y / pts.length];
  };

  GEO.rectPoly = function (cx, cy, w, h) {
    var hw = w / 2, hh = h / 2;
    return [[cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh]];
  };
  GEO.roundedRect = function (cx, cy, w, h, r, segs) {
    r = Math.min(Math.abs(r || 0), w / 2, h / 2);
    if (r < 0.5) return GEO.rectPoly(cx, cy, w, h);
    segs = segs || 4;
    var hw = w / 2, hh = h / 2, pts = [];
    var corners = [[cx + hw - r, cy - hh + r, -90], [cx + hw - r, cy + hh - r, 0], [cx - hw + r, cy + hh - r, 90], [cx - hw + r, cy - hh + r, 180]];
    for (var c = 0; c < 4; c++) {
      var ox = corners[c][0], oy = corners[c][1], a0 = corners[c][2] * DEG;
      for (var s = 0; s <= segs; s++) {
        var a = a0 + (s / segs) * (Math.PI / 2);
        pts.push([ox + Math.cos(a) * r, oy + Math.sin(a) * r]);
      }
    }
    return pts;
  };
  GEO.ellipsePoly = function (cx, cy, rx, ry, n) {
    n = n || 24;
    var pts = [];
    for (var i = 0; i < n; i++) { var a = (i / n) * Math.PI * 2; pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]); }
    return pts;
  };
  // AE polystar: type 1 = star, 2 = polygon. Rotation 0 puts the first point straight up.
  GEO.starPoly = function (cx, cy, points, outerR, innerR, rotDeg, starType) {
    var pts = [], n = Math.max(3, Math.round(points || 5)), step = (Math.PI * 2) / n, base = -Math.PI / 2 + (rotDeg || 0) * DEG;
    for (var i = 0; i < n; i++) {
      var a = base + i * step;
      pts.push([cx + Math.cos(a) * outerR, cy + Math.sin(a) * outerR]);
      if (starType === 1 || starType === "1") {
        var a2 = a + step / 2;
        pts.push([cx + Math.cos(a2) * innerR, cy + Math.sin(a2) * innerR]);
      }
    }
    return pts;
  };
  // Fan-split a convex polygon into pieces of at most maxV vertices (Box2D limit).
  GEO.chunkConvex = function (hull, maxV) {
    maxV = maxV || 8;
    if (hull.length <= maxV) return [hull];
    var out = [], first = hull[0], i = 1;
    while (i < hull.length - 1) {
      var piece = [first].concat(hull.slice(i, i + maxV - 1));
      if (piece.length < 3) break;
      out.push(piece);
      i += maxV - 2;
    }
    return out;
  };

  root.GEO = GEO;
  if (typeof module !== 'undefined' && module.exports) module.exports = GEO;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
