/* Isaac3D — builds a cannon-es world from an AE scene and runs it to per-frame transforms.
   Units: scene is in comp pixels / degrees; physics runs in meters / radians (PPM = pixels per meter).
   Coordinates are AE comp space directly: x right, y down, z into the screen (a right-handed frame), so
   gravity "down" is +y and a positive rotation about z maps +x toward +y = clockwise on screen = AE's
   positive Z rotation. Body quaternions therefore map to AE Rotation X/Y/Z without any sign flips.
   AE composes Rotation as M = Rx * Ry * Rz (Z applied first to the vector, then Y, then X; verified in AE 26.3)
   => EULER_ORDER = 'XYZ'. */
(function (root) {
  'use strict';
  var CANNON = root.CANNON || (typeof require === 'function' ? require('./cannon-es.umd.js') : null);
  var GEO = root.GEO || (typeof require === 'function' ? require('./geometry.js') : null);
  if (!CANNON) throw new Error('cannon-es not loaded');
  if (!GEO) throw new Error('geometry.js not loaded');

  var Vec3 = CANNON.Vec3, Quat = CANNON.Quaternion, DEG = Math.PI / 180, RAD = 180 / Math.PI, TWO_PI = Math.PI * 2;
  var MAX_HULL = 64;          // max outline points of an extruded hull (x2 vertices with the extrusion)
  var GROUP_WORLD = 1, GROUP_DYNAMIC = 2;   // collisionFilterGroup bits
  var GIMBAL_EPS = 1e-7;      // |cos(middle angle)| below this => degenerate Euler (gimbal lock)

  var SIM3D = {};
  SIM3D.version = '0.2.0';
  // Order of the AE rotation matrix product, first letter = outermost (applied last). 'XYZ' => M = Rx*Ry*Rz.
  SIM3D.EULER_ORDER = 'XYZ';

  SIM3D.defaultWorld = function () {
    return { gravity: 9.8, gravityAngle: 90, ppm: 100, substeps: 4, solverIterations: 10, timeScale: 1,
      floor: true, ceiling: false, left: false, right: false, back: false, front: false, depth: 0,
      boundsFriction: 0.5, boundsRestitution: 0.2, boundsOffset: 0, allowSleep: true, cardThickness: 10,
      // dynamics ignore each other: every dynamic/dormant body only collides with static / kinematic bodies and the
      // bounds (props fly off the hero but never jostle each other)
      soloDynamics: false };
  };
  SIM3D.defaultBody = function (info) {
    return { include: !!(info && info.supported && info.kind !== 'null'),
      type: (info && info.hasKeys) ? 'kinematic' : 'dynamic', shape: 'auto',
      density: 1, friction: 0.4, restitution: 0.3, linearDamping: 0.01, angularDamping: 0.05,
      fixedRotation: false, vx: 0, vy: 0, vz: 0, spin: 0, collide: true, thickness: 0,
      // collideWith: 'all' | 'solo' (only static/kinematic + bounds) | 'world' (follow the world's soloDynamics)
      collideWith: 'world',
      // planar: move in x/y and rotate about z only (the 2D panel's behaviour). Default for 2D layers: a thin card
      // standing on its edge is not a stable 3D configuration, so unconstrained 2D cards would topple on landing.
      planar: !(info && info.is3D) };
  };
  SIM3D.defaultBlast = function (frame, x, y, z, radius) {
    return { enabled: true, frame: frame || 0, x: x || 0, y: y || 0, z: z || 0, radius: radius || 500,
      strength: 1500, lift: 400, spin: 360, falloff: 'linear' };
  };

  /* ---------------------------------------------------------------- rotation math ------------- */
  // 3x3 matrices are flat row-major arrays: m[r*3+c].
  function axisIndex(ch) { return ch === 'X' || ch === 'x' ? 0 : (ch === 'Y' || ch === 'y' ? 1 : 2); }
  function rotAxis(axis, rad) {
    var c = Math.cos(rad), s = Math.sin(rad);
    if (axis === 0) return [1, 0, 0, 0, c, -s, 0, s, c];
    if (axis === 1) return [c, 0, s, 0, 1, 0, -s, 0, c];
    return [c, -s, 0, s, c, 0, 0, 0, 1];
  }
  function mmul(a, b) {
    var o = new Array(9);
    for (var r = 0; r < 3; r++) for (var c = 0; c < 3; c++)
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    return o;
  }
  function quatToMat(q) {
    var x = q.x, y = q.y, z = q.z, w = q.w;
    var xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
    return [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy),
            2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx),
            2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)];
  }
  // Shepperd's method (numerically stable for every rotation)
  function matToQuat(m) {
    var m00 = m[0], m01 = m[1], m02 = m[2], m10 = m[3], m11 = m[4], m12 = m[5], m20 = m[6], m21 = m[7], m22 = m[8];
    var t = m00 + m11 + m22, s, x, y, z, w;
    if (t > 0) {
      s = Math.sqrt(t + 1) * 2; w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
    } else if (m00 > m11 && m00 > m22) {
      s = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
    } else if (m11 > m22) {
      s = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
    } else {
      s = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
    }
    var q = new Quat(x, y, z, w); q.normalize(); return q;
  }
  function vlen(v) { return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]); }
  function vnorm(v) { var l = vlen(v); return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : null; }
  function vcross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function unwrap(a, ref) { return a + TWO_PI * Math.round((ref - a) / TWO_PI); }
  function isCyclic(i, j, k) { return (j === (i + 1) % 3) && (k === (i + 2) % 3); }

  // AE Rotation X/Y/Z (degrees) -> unit quaternion, honouring SIM3D.EULER_ORDER.
  SIM3D.aeToQuat = function (rx, ry, rz) {
    var ang = [(rx || 0) * DEG, (ry || 0) * DEG, (rz || 0) * DEG], order = SIM3D.EULER_ORDER, q = new Quat(0, 0, 0, 1);
    for (var n = 0; n < 3; n++) {
      var a = axisIndex(order.charAt(n)), qa = new Quat();
      qa.setFromAxisAngle(new Vec3(a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0), ang[a]);
      q = q.mult(qa);
    }
    q.normalize();
    return q;
  };
  // Quaternion -> AE Rotation [rx, ry, rz] (degrees). `prev` = previous frame's [rx,ry,rz] (deg) for continuity:
  // both Euler solutions are unwrapped towards prev and the nearest one wins, so consecutive frames never
  // jump by ~360 or flip by 180 at the gimbal-lock (|middle angle| = 90) configurations.
  SIM3D.quatToAE = function (q, prev) {
    var m = quatToMat(q), order = SIM3D.EULER_ORDER;
    var i = axisIndex(order.charAt(0)), j = axisIndex(order.charAt(1)), k = axisIndex(order.charAt(2));
    var eps = isCyclic(i, j, k) ? 1 : -1;
    var pr = [0, 0, 0];
    if (prev) pr = [(prev[0] || 0) * DEG, (prev[1] || 0) * DEG, (prev[2] || 0) * DEG];
    var sb = Math.max(-1, Math.min(1, eps * m[i * 3 + k]));
    var cb = Math.sqrt(Math.max(0, 1 - sb * sb));
    var cands = [], ta, tb, tc;
    if (cb > GIMBAL_EPS) {
      tb = Math.asin(sb);
      ta = Math.atan2(-eps * m[j * 3 + k], m[k * 3 + k]);
      tc = Math.atan2(-eps * m[i * 3 + j], m[i * 3 + i]);
      cands.push([ta, tb, tc]);
      cands.push([ta + Math.PI, Math.PI - tb, tc + Math.PI]);
    } else {
      // Gimbal lock: axes i and k coincide. Keep the previous inner angle and put the rest into the outer one.
      tb = sb > 0 ? Math.PI / 2 : -Math.PI / 2;
      tc = pr[k];
      var N = mmul(mmul(m, rotAxis(k, -tc)), rotAxis(j, -tb));   // = pure rotation about axis i
      var p = (i + 1) % 3, qq = (i + 2) % 3;
      ta = Math.atan2(N[qq * 3 + p], N[p * 3 + p]);
      cands.push([ta, tb, tc]);
    }
    var best = null, bestD = Infinity;
    for (var n = 0; n < cands.length; n++) {
      var c = cands[n], e = [0, 0, 0];
      e[i] = unwrap(c[0], pr[i]); e[j] = unwrap(c[1], pr[j]); e[k] = unwrap(c[2], pr[k]);
      var d = Math.abs(e[0] - pr[0]) + Math.abs(e[1] - pr[1]) + Math.abs(e[2] - pr[2]);
      if (d < bestD) { bestD = d; best = e; }
    }
    return [best[0] * RAD, best[1] * RAD, best[2] * RAD];
  };
  // World-space basis (layer +x/+y/+z directions, any length) -> unit quaternion of the pure rotation.
  // Scale is dropped, shear is removed (x kept, y made orthogonal, z = x cross y) so a mirrored basis still yields a rotation.
  SIM3D.matrixToQuat = function (ax, ay, az) {
    var x = vnorm(ax), y = vnorm(ay), z = vnorm(az) || [0, 0, 1];
    if (!x && !y) return new Quat(0, 0, 0, 1);
    if (!x) x = vnorm(vcross(y, z)) || [1, 0, 0];
    var zz = y ? vnorm(vcross(x, y)) : null;
    if (!zz) {                       // y missing or parallel to x: fall back to z
      var yy = vnorm(vcross(z, x));
      if (!yy) return new Quat(0, 0, 0, 1);
      y = yy; zz = vnorm(vcross(x, y));
    } else y = vcross(zz, x);
    return matToQuat([x[0], y[0], zz[0], x[1], y[1], zz[1], x[2], y[2], zz[2]]);
  };
  SIM3D.quatToMatrix = quatToMat;   // exposed for previews (row-major 3x3)

  /* ---------------------------------------------------------------- geometry ------------------ */
  function axisScale(info, key, fallbackIdx) {
    if (info.world && info.world[key]) { var l = vlen(info.world[key]); if (l > 1e-6) return l; }
    if (info.scale && typeof info.scale[fallbackIdx] === 'number') return Math.max(1e-3, Math.abs(info.scale[fallbackIdx]) / 100);
    return 1;
  }
  // layer space -> body space (px relative to anchor, world scale applied, NO rotation: rotation becomes the body quaternion)
  function layerMatrix(info, sx, sy) {
    var a = info.anchor || [0, 0, 0];
    return GEO.multiply(GEO.scale(sx, sy), GEO.translate(-(a[0] || 0), -(a[1] || 0)));
  }
  function chainMatrix(xf) {
    var m = GEO.identity();
    for (var i = 0; i < (xf || []).length; i++) m = GEO.multiply(m, GEO.trs(xf[i].anchor, xf[i].position, xf[i].scale, xf[i].rotation));
    return m;
  }
  // Collect the outline points of one primitive (in body space) into allPts; returns a sphere descriptor when
  // the primitive is a circle under a uniform scale (used by 'auto' for single-circle shape layers).
  function primitivePoints(prim, F, allPts) {
    var pts, sphere = null, i;
    if (prim.type === 'rect') {
      pts = GEO.applyAll(F, GEO.roundedRect(prim.position[0], prim.position[1], Math.abs(prim.size[0]), Math.abs(prim.size[1]), prim.roundness, 3));
    } else if (prim.type === 'ellipse') {
      var rx = Math.abs(prim.size[0]) / 2, ry = Math.abs(prim.size[1]) / 2, s = GEO.uniformScale(F, 1e-3);
      if (s !== null && Math.abs(rx - ry) < 1e-3 * Math.max(1, rx)) {
        var c = GEO.apply(F, prim.position);
        sphere = { cx: c[0], cy: c[1], r: rx * s };
      }
      pts = GEO.applyAll(F, GEO.ellipsePoly(prim.position[0], prim.position[1], rx, ry, 24));
    } else if (prim.type === 'star') {
      pts = GEO.applyAll(F, GEO.starPoly(prim.position[0], prim.position[1], prim.points, prim.outerRadius, prim.innerRadius, prim.rotation, prim.starType));
    } else if (prim.type === 'path') {
      pts = GEO.applyAll(F, GEO.sampleShape(prim, 6));
    } else return null;
    for (i = 0; i < pts.length; i++) allPts.push(pts[i]);
    return sphere;
  }
  function decimate(pts, max) {
    if (pts.length <= max) return pts;
    var out = [], step = pts.length / max;
    for (var i = 0; i < max; i++) out.push(pts[Math.floor(i * step)]);
    return out;
  }
  function boxShape(L, rcx, rcy, w, h, sx, sy, hz, zOff) {
    var c = GEO.apply(L, [rcx, rcy]);
    return { kind: 'box', half: [Math.max(0.5, Math.abs(w * sx) / 2), Math.max(0.5, Math.abs(h * sy) / 2), hz], offset: [c[0], c[1], zOff] };
  }

  /* 3D model layers (glb/gltf/obj/fbx). info.model comes from models.js in MODEL UNITS (already in AE's axis
     convention). px-per-unit is calibrated against the layer's sourceRect, which AE computes from the same mesh
     (1 unit = 512 px in AE 26; FBX in cm lands 100x bigger and calibrates away). The rect stays authoritative for the
     x/y placement; the file supplies the depth, the convex hull and the preview wireframe. */
  function modelGeometry(info, cfg, L, sx, sy, sz, anchorZ, mode, rect) {
    var M = info.model, size = M.size;
    var s = (size[0] > 1e-9 && rect.width > 0) ? rect.width / size[0]
          : ((size[1] > 1e-9 && rect.height > 0) ? rect.height / size[1] : 512);
    var fcx = (M.min[0] + M.max[0]) / 2 * s, fcy = (M.min[1] + M.max[1]) / 2 * s;
    var dx = (rect.left + rect.width / 2) - fcx, dy = (rect.top + rect.height / 2) - fcy;   // ~0 unless AE re-pivots
    function toBody(p) { var q = GEO.apply(L, [p[0] * s + dx, p[1] * s + dy]); return [q[0], q[1], (p[2] * s - anchorZ) * sz]; }
    var half = [Math.max(0.5, size[0] * s * Math.abs(sx) / 2), Math.max(0.5, size[1] * s * Math.abs(sy) / 2), Math.max(0.5, size[2] * s * Math.abs(sz) / 2)];
    var center = toBody([(M.min[0] + M.max[0]) / 2, (M.min[1] + M.max[1]) / 2, (M.min[2] + M.max[2]) / 2]);
    var shapes, i;
    if (mode === 'sphere') {
      shapes = [{ kind: 'sphere', r: Math.max(half[0], half[1], half[2]), offset: center }];
    } else if ((mode === 'hull' || mode === 'auto') && M.hull && M.hull.verts.length >= 4) {
      var hv = [];
      for (i = 0; i < M.hull.verts.length; i++) hv.push(toBody(M.hull.verts[i]));
      shapes = [{ kind: 'hull3d', verts: hv, faces: M.hull.faces, offset: center, half: half }];
    } else {
      shapes = [{ kind: 'box', half: half, offset: center }];      // 'box' and 'cube' both mean the real 3D bounds
    }
    var wire = null;
    if (M.mesh && M.mesh.verts && M.mesh.verts.length) {
      var wv = [];
      for (i = 0; i < M.mesh.verts.length; i++) wv.push(toBody(M.mesh.verts[i]));
      wire = { verts: wv, edges: M.mesh.edges || [] };
    }
    var kind = shapes[0].kind;
    return { shapes: shapes, mode: kind === 'hull3d' ? 'hull' : kind, mesh: wire,
      model: { pxPerUnit: s, size: [size[0] * s * Math.abs(sx), size[1] * s * Math.abs(sy), size[2] * s * Math.abs(sz)], shift: [dx, dy] } };
  }

  // Returns { shapes: [ {kind:'box',half,offset} | {kind:'sphere',r,offset} | {kind:'hull',pts,outline,hz,offset}
  //                     | {kind:'hull3d',verts,faces,offset,half} ], mode, mesh? }
  // in body space: layer space translated so the anchor is the origin, world scale applied, no rotation.
  SIM3D.buildGeometry = function (info, cfg, world) {
    world = world || SIM3D.defaultWorld();
    var sx = axisScale(info, 'ax', 0), sy = axisScale(info, 'ay', 1), sz = axisScale(info, 'az', 2);
    var L = layerMatrix(info, sx, sy), i;
    var anchorZ = (info.anchor && info.anchor.length > 2) ? (info.anchor[2] || 0) : 0;
    var zOff = -anchorZ * sz;
    var thick = (cfg && cfg.thickness > 0) ? cfg.thickness : (world.cardThickness > 0 ? world.cardThickness : 10);
    var hz = Math.max(0.5, thick / 2);
    var mode = (cfg && cfg.shape) || 'auto';
    var rect = info.rect || { left: 0, top: 0, width: 100, height: 100 };
    var rcx = rect.left + rect.width / 2, rcy = rect.top + rect.height / 2;
    if (info.kind === 'model') {
      if (info.model && info.model.ok) return modelGeometry(info, cfg, L, sx, sy, sz, anchorZ, mode, rect);
      // file not parsed (yet / failed): a solid block as deep as its smaller side, never a thin card
      if (!(cfg && cfg.thickness > 0)) hz = Math.max(0.5, Math.min(Math.abs(rect.width * sx), Math.abs(rect.height * sy)) / 2);
      if (mode === 'sphere') {
        var cS = GEO.apply(L, [rcx, rcy]);
        return { shapes: [{ kind: 'sphere', r: Math.max(0.5, Math.min(Math.abs(rect.width * sx), Math.abs(rect.height * sy)) / 2), offset: [cS[0], cS[1], zOff] }], mode: 'sphere' };
      }
      return { shapes: [boxShape(L, rcx, rcy, rect.width, rect.height, sx, sy, hz, zOff)], mode: 'box' };
    }
    var prims = (info.shapes && info.shapes.length) ? info.shapes : ((info.masks && info.masks.length) ? info.masks : null);
    // 'cube': a solid block as deep as its smaller side (square cards behave like crates instead of thin cards).
    // Sized from the shape outline when there is one (sourceRect includes strokes/padding); from rect otherwise.
    var cube = (mode === 'cube');
    if (cube && !prims) { hz = Math.max(0.5, Math.min(Math.abs(rect.width * sx), Math.abs(rect.height * sy)) / 2); mode = 'box'; }

    if (mode === 'sphere') {
      var s = GEO.uniformScale(L, 1e-3), c = GEO.apply(L, [rcx, rcy]);
      var r = (s !== null) ? Math.min(rect.width, rect.height) / 2 * s
                           : Math.min(rect.width * Math.abs(L.a), rect.height * Math.abs(L.d)) / 2;
      return { shapes: [{ kind: 'sphere', r: Math.max(r, 0.5), offset: [c[0], c[1], zOff] }], mode: mode };
    }
    if (mode === 'box' || !prims) {
      return { shapes: [boxShape(L, rcx, rcy, rect.width, rect.height, sx, sy, hz, zOff)], mode: prims ? mode : 'box' };
    }
    var allPts = [], sphere = null;
    for (i = 0; i < prims.length; i++) {
      var F = GEO.multiply(L, chainMatrix(prims[i].xf));
      var sp = primitivePoints(prims[i], F, allPts);
      if (i === 0) sphere = sp; else sphere = null;
    }
    if (cube && allPts.length >= 2) {
      var bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (i = 0; i < allPts.length; i++) { var q = allPts[i]; if (q[0] < bx0) bx0 = q[0]; if (q[0] > bx1) bx1 = q[0]; if (q[1] < by0) by0 = q[1]; if (q[1] > by1) by1 = q[1]; }
      var bw = Math.max(1, bx1 - bx0), bh = Math.max(1, by1 - by0);
      return { shapes: [{ kind: 'box', half: [bw / 2, bh / 2, Math.min(bw, bh) / 2], offset: [(bx0 + bx1) / 2, (by0 + by1) / 2, zOff] }], mode: 'box' };
    }
    if (mode === 'auto' && sphere && prims.length === 1) {
      return { shapes: [{ kind: 'sphere', r: Math.max(sphere.r, 0.5), offset: [sphere.cx, sphere.cy, zOff] }], mode: 'sphere' };
    }
    var hull = allPts.length >= 3 ? GEO.convexHull(GEO.dedupe(allPts, 0.25)) : [];
    if (hull.length < 3 || Math.abs(GEO.area(hull)) < 1) {
      return { shapes: [boxShape(L, rcx, rcy, rect.width, rect.height, sx, sy, hz, zOff)], mode: 'box' };
    }
    hull = decimate(hull, MAX_HULL);
    var pts = [], cen = GEO.centroid(hull);
    for (i = 0; i < hull.length; i++) pts.push([hull[i][0], hull[i][1], zOff - hz]);
    for (i = 0; i < hull.length; i++) pts.push([hull[i][0], hull[i][1], zOff + hz]);
    return { shapes: [{ kind: 'hull', pts: pts, outline: hull, hz: hz, offset: [cen[0], cen[1], zOff] }], mode: 'hull' };
  };

  /* ---------------------------------------------------------------- cannon shapes ------------- */
  // Extruded convex outline -> ConvexPolyhedron. `pts` are [x,y,z] in meters, already relative to the body origin;
  // the first n points are the z- cap and the next n the z+ cap in the same order.
  function makePrism(pts) {
    var n = pts.length / 2, verts = [], i, cx = 0, cy = 0, cz = 0;
    for (i = 0; i < pts.length; i++) { verts.push(new Vec3(pts[i][0], pts[i][1], pts[i][2])); cx += pts[i][0]; cy += pts[i][1]; cz += pts[i][2]; }
    var cen = new Vec3(cx / pts.length, cy / pts.length, cz / pts.length);
    var faces = [], bottom = [], top = [];
    for (i = 0; i < n; i++) { bottom.push(i); top.push(n + i); }
    faces.push(bottom); faces.push(top);
    for (i = 0; i < n; i++) { var j = (i + 1) % n; faces.push([i, j, n + j, n + i]); }
    // cannon wants faces wound CCW seen from outside; fix winding against the centroid
    for (i = 0; i < faces.length; i++) {
      var f = faces[i], a = verts[f[0]], b = verts[f[1]], c = verts[f[2]];
      var ab = new Vec3(), bc = new Vec3(), nrm = new Vec3(), rel = new Vec3();
      b.vsub(a, ab); c.vsub(b, bc); ab.cross(bc, nrm); a.vsub(cen, rel);
      if (nrm.dot(rel) < 0) f.reverse();
    }
    return new CANNON.ConvexPolyhedron({ vertices: verts, faces: faces });
  }
  // Volume of a closed polyhedron (faces are fans of triangles): sum of signed tetrahedra against the first vertex.
  function polyVolume(verts, faces) {
    var V = 0, o = verts[0];
    for (var i = 0; i < faces.length; i++) {
      var f = faces[i];
      for (var k = 1; k + 1 < f.length; k++) {
        var a = verts[f[0]], b = verts[f[k]], c = verts[f[k + 1]];
        var ax = a[0] - o[0], ay = a[1] - o[1], az = a[2] - o[2], bx = b[0] - o[0], by = b[1] - o[1], bz = b[2] - o[2], cx = c[0] - o[0], cy = c[1] - o[1], cz = c[2] - o[2];
        V += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
      }
    }
    return Math.abs(V) / 6;
  }
  function shapeVolume(sh) {
    if (sh.kind === 'box') return 8 * sh.half[0] * sh.half[1] * sh.half[2];
    if (sh.kind === 'sphere') return 4 / 3 * Math.PI * sh.r * sh.r * sh.r;
    if (sh.kind === 'hull3d') { var v = polyVolume(sh.verts, sh.faces); return v > 1e-6 ? v : 8 * sh.half[0] * sh.half[1] * sh.half[2]; }
    return Math.abs(GEO.area(sh.outline)) * 2 * sh.hz;
  }
  // Convex hull of a 3D model -> ConvexPolyhedron. `verts` in meters relative to the body origin; faces CCW from outside.
  function makeHull3D(verts, faces) {
    var vs = [], fs = [], i;
    for (i = 0; i < verts.length; i++) vs.push(new Vec3(verts[i][0], verts[i][1], verts[i][2]));
    for (i = 0; i < faces.length; i++) fs.push(faces[i].slice());
    return new CANNON.ConvexPolyhedron({ vertices: vs, faces: fs });
  }
  // Volume-weighted centroid of the body-space shapes (px) => becomes the body origin (center of mass).
  function geomCentroid(shapes) {
    var x = 0, y = 0, z = 0, V = 0;
    for (var i = 0; i < shapes.length; i++) {
      var v = Math.max(1e-6, shapeVolume(shapes[i])), o = shapes[i].offset;
      x += o[0] * v; y += o[1] * v; z += o[2] * v; V += v;
    }
    return V > 0 ? [x / V, y / V, z / V] : [0, 0, 0];
  }

  /* ---------------------------------------------------------------- world ---------------------- */
  function hash01(n) { var x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); }
  // Radial impulse: every dynamic/dormant body inside `radius` gets a velocity kick of `strength` px/s (scaled by
  // falloff) away from the blast point, `lift` px/s upwards (-y), plus a deterministic pseudo-random tumble of up
  // to `spin` deg/s about a pseudo-random axis.
  function applyBlast(bl, bodies, ppm, bi) {
    var cx = (bl.x || 0) / ppm, cy = (bl.y || 0) / ppm, cz = (bl.z || 0) / ppm, R = Math.max(1, bl.radius || 1) / ppm;
    for (var i = 0; i < bodies.length; i++) {
      var b = bodies[i];
      if (b.type !== 'dynamic' && b.type !== 'dormant') continue;
      var body = b.body, p = body.position;
      var dx = p.x - cx, dy = p.y - cy, dz = p.z - cz, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > R) continue;
      var nx = 0, ny = -1, nz = 0;
      if (d > 1e-6) { nx = dx / d; ny = dy / d; nz = dz / d; }
      var t = d / R, fall = (bl.falloff === 'none') ? 1 : (bl.falloff === 'inverse') ? 1 / (1 + 8 * t * t) : (1 - t);
      if (!(body.mass > 0)) continue;
      body.wakeUp();
      // cannon-es masks forces/torques/solver impulses with linearFactor/angularFactor but NOT direct velocity
      // writes (pos.z += velo.z*dt is unmasked), so scale the kicks ourselves or planar bodies leave the comp plane.
      var lf = body.linearFactor, af = body.angularFactor;
      var dv = (bl.strength || 0) / ppm * fall, lift = (bl.lift || 0) / ppm * fall;
      body.velocity.x += nx * dv * lf.x; body.velocity.y += (ny * dv - lift) * lf.y; body.velocity.z += nz * dv * lf.z;
      if (bl.spin && !body.fixedRotation) {
        var seed = b.index * 7.31 + bi * 13.7;
        var rnd = hash01(seed) * 2 - 1;
        var ax = hash01(seed + 1.7) * 2 - 1, ay = hash01(seed + 2.9) * 2 - 1, az = hash01(seed + 4.3) * 2 - 1;
        var al = Math.sqrt(ax * ax + ay * ay + az * az);
        if (al < 1e-6) { ax = 0; ay = 0; az = 1; al = 1; }
        var mag = rnd * (bl.spin || 0) * DEG * fall / al;
        body.angularVelocity.x += ax * mag * af.x; body.angularVelocity.y += ay * mag * af.y; body.angularVelocity.z += az * mag * af.z;
      }
    }
  }

  function planeBody(world, mat, px, py, pz, nx, ny, nz) {
    var body = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC, material: mat, position: new Vec3(px, py, pz) });
    body.addShape(new CANNON.Plane());
    body.quaternion.setFromVectors(new Vec3(0, 0, 1), new Vec3(nx, ny, nz));
    body.userData = { bounds: true };
    world.addBody(body);
    return body;
  }
  function addBounds(world, scene, w, mat) {
    var ppm = w.ppm, W = scene.comp.width / ppm, H = scene.comp.height / ppm, off = (w.boundsOffset || 0) / ppm;
    var D = ((w.depth > 0) ? w.depth : scene.comp.width) / ppm;
    var out = [];
    if (w.floor)   out.push(planeBody(world, mat, W / 2, H - off, 0, 0, -1, 0));
    if (w.ceiling) out.push(planeBody(world, mat, W / 2, off, 0, 0, 1, 0));
    if (w.left)    out.push(planeBody(world, mat, off, H / 2, 0, 1, 0, 0));
    if (w.right)   out.push(planeBody(world, mat, W - off, H / 2, 0, -1, 0, 0));
    if (w.back)    out.push(planeBody(world, mat, W / 2, H / 2, D - off, 0, 0, -1));
    if (w.front)   out.push(planeBody(world, mat, W / 2, H / 2, -D + off, 0, 0, 1));
    return out;
  }

  // Materials: one per distinct (friction, restitution); contact pairs mix like Box2D (geometric mean / max).
  function materialPool(world) {
    var mats = {}, list = [];
    return {
      get: function (friction, restitution) {
        var f = (typeof friction === 'number' && friction >= 0) ? friction : 0.4;
        var r = (typeof restitution === 'number' && restitution >= 0) ? restitution : 0.3;
        var key = f.toFixed(4) + '/' + r.toFixed(4);
        if (mats[key]) return mats[key];
        var m = new CANNON.Material(key); m.friction = f; m.restitution = r;
        for (var i = 0; i < list.length; i++) {
          var o = list[i];
          world.addContactMaterial(new CANNON.ContactMaterial(m, o, { friction: Math.sqrt(f * o.friction), restitution: Math.max(r, o.restitution) }));
        }
        world.addContactMaterial(new CANNON.ContactMaterial(m, m, { friction: f, restitution: r }));
        mats[key] = m; list.push(m);
        return m;
      }
    };
  }

  function sampleAt(kin, f) {
    if (!kin || !kin.o || !kin.o.length) return null;
    var n = kin.o.length, j = Math.min(Math.max(f, 0), n - 1);
    return { o: kin.o[j], ax: kin.ax ? kin.ax[j] : null, ay: kin.ay ? kin.ay[j] : null, az: kin.az ? kin.az[j] : null };
  }
  function basisQuat(ax, ay, az) {
    return SIM3D.matrixToQuat(ax || [1, 0, 0], ay || [0, 1, 0], az || [0, 0, 1]);
  }
  // Place a body so that its anchor (not its center of mass) is at world point o (px) with orientation q.
  function placeBody(b, o, q, ppm) {
    var body = b.body, tmp = new Vec3();
    body.quaternion.copy(q);
    body.quaternion.vmult(b.anchorLocal, tmp);
    body.position.set(o[0] / ppm - tmp.x, o[1] / ppm - tmp.y, (o[2] || 0) / ppm - tmp.z);
    body.aabbNeedsUpdate = true;
  }

  // opts: { world, start, count, fps, bodies: {id: cfg}, kinematic: {id: {o:[[x,y,z]..], ax:[..], ay:[..], az:[..]}},
  //         blasts: [ { frame (relative to start), x, y, z, radius, strength (px/s), lift (px/s), spin (deg/s), falloff, enabled } ] }
  SIM3D.run = function (scene, opts) {
    opts = opts || {};
    var w = opts.world || SIM3D.defaultWorld(), ppm = w.ppm || 100;
    var fps = opts.fps || scene.comp.fps || 30, count = Math.max(1, opts.count | 0);
    var dt = (1 / fps) * (w.timeScale || 1), sub = Math.max(1, w.substeps | 0), sdt = dt / sub;
    var ga = (typeof w.gravityAngle === 'number' ? w.gravityAngle : 90) * DEG, g = w.gravity || 0;
    var blasts = opts.blasts || [];
    var allowSleep = w.allowSleep !== false;

    var world = new CANNON.World({ gravity: new Vec3(Math.cos(ga) * g, Math.sin(ga) * g, 0), allowSleep: allowSleep });
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.solver.iterations = Math.max(1, (w.solverIterations | 0) || 10);
    world.defaultContactMaterial.friction = 0.4;
    world.defaultContactMaterial.restitution = 0.3;
    var pool = materialPool(world);
    addBounds(world, scene, w, pool.get(w.boundsFriction, w.boundsRestitution));

    var bodies = [], i, k;
    for (i = 0; i < scene.layers.length; i++) {
      var info = scene.layers[i];
      if (!info.supported) continue;
      var cfg = (opts.bodies && opts.bodies[info.id]) || SIM3D.defaultBody(info);
      if (!cfg.include) continue;
      var geom = SIM3D.buildGeometry(info, cfg, w);
      if (!geom.shapes.length) continue;
      var isDyn = cfg.type === 'dynamic' || cfg.type === 'dormant';
      var kin = (cfg.type === 'kinematic' && opts.kinematic) ? opts.kinematic[info.id] : null;
      var cen = geomCentroid(geom.shapes);
      var anchorLocal = new Vec3(-cen[0] / ppm, -cen[1] / ppm, -cen[2] / ppm);

      var volume = 0;
      for (k = 0; k < geom.shapes.length; k++) volume += shapeVolume(geom.shapes[k]) / (ppm * ppm * ppm);
      var density = cfg.density > 0 ? cfg.density : 1;
      var mass = isDyn ? Math.max(1e-4, density * volume) : 0;

      var body = new CANNON.Body({
        mass: mass,
        type: isDyn ? CANNON.Body.DYNAMIC : (cfg.type === 'kinematic' ? CANNON.Body.KINEMATIC : CANNON.Body.STATIC),
        material: pool.get(cfg.friction, cfg.restitution),
        linearDamping: (typeof cfg.linearDamping === 'number') ? cfg.linearDamping : 0.01,
        angularDamping: (typeof cfg.angularDamping === 'number') ? cfg.angularDamping : 0.05,
        fixedRotation: !!cfg.fixedRotation,
        allowSleep: allowSleep || cfg.type === 'dormant'
      });
      // collision groups: 1 = static / kinematic / bounds planes (cannon default), 2 = dynamic & dormant
      body.collisionFilterGroup = isDyn ? GROUP_DYNAMIC : GROUP_WORLD;
      var solo = cfg.collideWith === 'solo' || (cfg.collideWith !== 'all' && w.soloDynamics);
      if (isDyn && solo) body.collisionFilterMask = GROUP_WORLD;
      if (cfg.collide === false) body.collisionFilterMask = 0;
      var planar = (cfg.planar === undefined) ? !info.is3D : !!cfg.planar;
      if (planar && isDyn) { body.linearFactor.set(1, 1, 0); body.angularFactor.set(0, 0, 1); }
      body.userData = { id: info.id };

      var wb = info.world || {};
      var q0 = wb.ax ? basisQuat(wb.ax, wb.ay, wb.az) : SIM3D.aeToQuat(0, 0, info.rotation || 0);
      var o0 = wb.origin || (info.position ? [info.position[0], info.position[1], info.position[2] || 0] : [0, 0, 0]);
      var rec = { id: info.id, index: info.index, name: info.name, type: cfg.type, is3D: !!info.is3D, body: body, geom: geom, kin: kin,
        anchorLocal: anchorLocal, prevEuler: null,
        x: new Array(count), y: new Array(count), z: new Array(count), rx: new Array(count), ry: new Array(count), rz: new Array(count) };
      placeBody(rec, o0, q0, ppm);   // orientation first: cannon approximates inertia from the world AABB at addShape time

      for (k = 0; k < geom.shapes.length; k++) {
        var sh = geom.shapes[k], off = new Vec3((sh.offset[0] - cen[0]) / ppm, (sh.offset[1] - cen[1]) / ppm, (sh.offset[2] - cen[2]) / ppm);
        if (sh.kind === 'box') body.addShape(new CANNON.Box(new Vec3(sh.half[0] / ppm, sh.half[1] / ppm, sh.half[2] / ppm)), off);
        else if (sh.kind === 'sphere') body.addShape(new CANNON.Sphere(sh.r / ppm), off);
        else if (sh.kind === 'hull3d') {
          var hv = [];
          for (var hvi = 0; hvi < sh.verts.length; hvi++) hv.push([(sh.verts[hvi][0] - cen[0]) / ppm, (sh.verts[hvi][1] - cen[1]) / ppm, (sh.verts[hvi][2] - cen[2]) / ppm]);
          try { body.addShape(makeHull3D(hv, sh.faces)); }
          catch (e) { body.addShape(new CANNON.Box(new Vec3(sh.half[0] / ppm, sh.half[1] / ppm, sh.half[2] / ppm)), off); }
        }
        else {
          var mp = [];
          for (var v = 0; v < sh.pts.length; v++) mp.push([(sh.pts[v][0] - cen[0]) / ppm, (sh.pts[v][1] - cen[1]) / ppm, (sh.pts[v][2] - cen[2]) / ppm]);
          try { body.addShape(makePrism(mp)); } catch (e) { /* degenerate piece */ }
        }
      }
      if (!body.shapes.length) continue;
      // direct velocity writes are not masked by cannon-es (see applyBlast): apply the body factors here too
      body.velocity.set((cfg.vx || 0) / ppm * body.linearFactor.x, (cfg.vy || 0) / ppm * body.linearFactor.y, (cfg.vz || 0) / ppm * body.linearFactor.z);
      body.angularVelocity.set(0, 0, (cfg.spin || 0) * DEG * body.angularFactor.z);
      world.addBody(body);
      if (cfg.type === 'dormant') body.sleep();
      bodies.push(rec);
    }

    function applyKinematic(b, f, withVelocity) {
      var cur = sampleAt(b.kin, f);
      if (!cur) return;
      var q = basisQuat(cur.ax, cur.ay, cur.az);
      placeBody(b, cur.o, q, ppm);
      if (!withVelocity) return;
      var nxt = sampleAt(b.kin, f + 1);
      var body = b.body;
      if (!nxt || nxt === cur) { body.velocity.set(0, 0, 0); body.angularVelocity.set(0, 0, 0); return; }
      var qn = basisQuat(nxt.ax, nxt.ay, nxt.az);
      // anchor moves o->o'; the body origin (center of mass) follows: p' = o'/ppm - qn*anchorLocal
      var t1 = new Vec3(); qn.vmult(b.anchorLocal, t1);
      var px = nxt.o[0] / ppm - t1.x, py = nxt.o[1] / ppm - t1.y, pz = (nxt.o[2] || 0) / ppm - t1.z;
      body.velocity.set((px - body.position.x) / dt, (py - body.position.y) / dt, (pz - body.position.z) / dt);
      var dq = new Quat(); qn.mult(q.conjugate(), dq); dq.normalize();
      var axis = new Vec3(), aa = dq.toAxisAngle(axis), ang = aa[1];
      if (ang > Math.PI) ang -= TWO_PI;
      body.angularVelocity.set(axis.x * ang / dt, axis.y * ang / dt, axis.z * ang / dt);
    }

    var tmp = new Vec3();
    for (var f = 0; f < count; f++) {
      for (i = 0; i < bodies.length; i++) {
        var b = bodies[i];
        if (b.type === 'kinematic') applyKinematic(b, f, f < count - 1);
        var body = b.body, q = body.quaternion;
        q.vmult(b.anchorLocal, tmp);
        b.x[f] = (body.position.x + tmp.x) * ppm; b.y[f] = (body.position.y + tmp.y) * ppm; b.z[f] = (body.position.z + tmp.z) * ppm;
        var e = SIM3D.quatToAE(q, b.prevEuler);
        b.rx[f] = e[0]; b.ry[f] = e[1]; b.rz[f] = e[2]; b.prevEuler = e;
      }
      if (f === count - 1) break;
      for (i = 0; i < blasts.length; i++) if (blasts[i].enabled !== false && Math.round(blasts[i].frame) === f) applyBlast(blasts[i], bodies, ppm, i);
      for (var s = 0; s < sub; s++) world.step(sdt);
    }

    var out = { count: count, fps: fps, start: opts.start || 0, ppm: ppm, bodyCount: bodies.length, bodies: [] };
    for (i = 0; i < bodies.length; i++) {
      var bb = bodies[i];
      out.bodies.push({ id: bb.id, index: bb.index, name: bb.name, type: bb.type, is3D: bb.is3D, geom: bb.geom,
        x: bb.x, y: bb.y, z: bb.z, rx: bb.rx, ry: bb.ry, rz: bb.rz });
    }
    return out;
  };

  root.SIM3D = SIM3D;
  if (typeof module !== 'undefined' && module.exports) module.exports = SIM3D;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
