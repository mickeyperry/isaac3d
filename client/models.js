/* Isaac3D — 3D model layers (glb / gltf / obj / fbx).
   The host reports a model layer's source file (info.modelFile); this module parses that file with the three.js
   loaders in vendor/ and produces, in MODEL UNITS:
     - the axis-aligned bounds (min/max/size),
     - a convex hull (verts + CCW faces) for the physics body,
     - a decimated wireframe (verts + tris) for the preview.
   Coordinates are converted from three's y-up right-handed frame to AE layer space (x right, y down, z into the
   screen): AE = (x, -y, -z). That is a rotation, not a reflection, so face winding survives.
   sim3d.js calibrates px-per-unit against the layer's sourceRect (AE draws 1 unit = 512 px; an FBX exported in cm
   comes out 100x bigger, and the calibration absorbs that automatically).
   Textures are never loaded: glTF materials/images are stripped from the JSON before parsing, FBX texture loads are
   stubbed. External glTF buffers (.bin) are inlined as data: URIs because fetch() cannot read file:// in Chromium. */
(function (root) {
  'use strict';
  var MODELS = { version: '0.2.0' };
  var cache = {};      // path -> result
  var pending = {};    // path -> [cb]
  var MAX_HULL_VERTS = 64;     // hull vertices handed to cannon (ConvexPolyhedron cost grows fast)
  var MAX_TRIS = 1500;         // wireframe triangles kept for the preview (denser meshes are vertex-clustered down)

  function T() { return root.THREE || null; }
  function nodeFs() {
    try { var n = root.cep_node, r = (n && n.require) || root.require; return r ? r('fs') : null; } catch (e) { return null; }
  }
  function readBuffer(path) {
    var fs = nodeFs();
    if (fs) { var b = fs.readFileSync(path); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
    if (root.cep && root.cep.fs) {
      var r = root.cep.fs.readFile(path, root.cep.encoding.Base64);
      if (r.err !== 0) throw new Error('cep.fs read error ' + r.err);
      var bin = atob(r.data), u8 = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return u8.buffer;
    }
    throw new Error('no file access (Node disabled?)');
  }
  function bufToText(ab) { return new TextDecoder('utf-8').decode(new Uint8Array(ab)); }
  function b64(ab) {
    var u8 = new Uint8Array(ab), s = '', CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }
  function ext(path) { var m = /\.([a-z0-9]+)$/i.exec(path || ''); return m ? m[1].toLowerCase() : ''; }
  function dirOf(path) { var i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')); return i >= 0 ? path.substring(0, i + 1) : ''; }
  MODELS.isModelFile = function (path) { return /^(glb|gltf|obj|fbx)$/.test(ext(path)); };

  // ---------- glTF: strip everything texture/material related; inline external buffers ----------
  function stripGltfJson(json) {
    delete json.images; delete json.textures; delete json.samplers; delete json.materials;
    (json.meshes || []).forEach(function (m) { (m.primitives || []).forEach(function (p) { delete p.material; }); });
    var req = json.extensionsRequired || [];
    if (req.indexOf('KHR_draco_mesh_compression') >= 0) throw new Error('Draco-compressed glTF is not supported (re-export without Draco)');
    if (req.indexOf('EXT_meshopt_compression') >= 0) throw new Error('meshopt-compressed glTF is not supported');
    json.extensionsRequired = req.filter(function (e) { return !/texture|material/i.test(e); });
    if (json.extensionsUsed) json.extensionsUsed = json.extensionsUsed.filter(function (e) { return !/texture|material/i.test(e); });
    return json;
  }
  function rebuildGlb(ab) {
    var dv = new DataView(ab);
    if (ab.byteLength < 20 || dv.getUint32(0, true) !== 0x46546C67) return null;   // 'glTF' magic
    var len = Math.min(dv.getUint32(8, true), ab.byteLength), off = 12, jsonChunk = null, binChunk = null;
    while (off + 8 <= len) {
      var cl = dv.getUint32(off, true), ct = dv.getUint32(off + 4, true), data = ab.slice(off + 8, off + 8 + cl);
      if (ct === 0x4E4F534A) jsonChunk = data; else if (ct === 0x004E4942) binChunk = data;
      off += 8 + cl;
    }
    if (!jsonChunk) throw new Error('glb has no JSON chunk');
    var json = stripGltfJson(JSON.parse(bufToText(jsonChunk)));
    var jt = JSON.stringify(json); while (jt.length % 4) jt += ' ';
    var je = new TextEncoder().encode(jt);
    var binLen = binChunk ? binChunk.byteLength : 0, binPad = (4 - binLen % 4) % 4;
    var total = 12 + 8 + je.length + (binChunk ? 8 + binLen + binPad : 0);
    var out = new ArrayBuffer(total), o = new DataView(out), u8 = new Uint8Array(out);
    o.setUint32(0, 0x46546C67, true); o.setUint32(4, 2, true); o.setUint32(8, total, true);
    o.setUint32(12, je.length, true); o.setUint32(16, 0x4E4F534A, true); u8.set(je, 20);
    if (binChunk) {
      var p = 20 + je.length;
      o.setUint32(p, binLen + binPad, true); o.setUint32(p + 4, 0x004E4942, true); u8.set(new Uint8Array(binChunk), p + 8);
    }
    return out;
  }
  function manager(basePath) {
    var m = new (T().LoadingManager)();
    m.setURLModifier(function (url) {
      if (/^(data:|blob:)/i.test(url)) return url;
      var p = String(url).replace(/^file:\/\/\/?/i, '');
      try { p = decodeURIComponent(p); } catch (e) { }
      if (!/^([a-z]:|\\\\|\/)/i.test(p)) p = basePath + p;
      try { return 'data:application/octet-stream;base64,' + b64(readBuffer(p)); }
      catch (e) { console.warn('[models] cannot read external resource', p, e); return url; }
    });
    return m;
  }
  // FBX: materials reference textures; make texture loads no-ops for the duration of the parse.
  function withoutTextures(fn) {
    var TL = T().TextureLoader.prototype, orig = TL.load;
    TL.load = function () { return new (T().Texture)(); };
    try { return fn(); } finally { TL.load = orig; }
  }

  // ---------- geometry extraction ----------
  // 1. every vertex to world space (AE axes) once, into flat Float32Arrays per mesh; bounds + axis-extreme vertices
  // 2. preview mesh: the whole mesh when it is small, otherwise vertex-clustering decimation to <= MAX_TRIS coherent
  //    triangles (snap vertices to a grid, merge, drop degenerate/duplicate triangles) -> unique edge list
  // 3. convex hull from the decimated vertices (spatially uniform) plus the extreme vertices, capped to MAX_HULL_VERTS
  function extract(object3d) {
    var THREE = T();
    object3d.updateMatrixWorld(true);
    var meshes = [];
    object3d.traverse(function (o) {
      if (o.isMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.position && o.geometry.attributes.position.count) meshes.push(o);
    });
    var v = new THREE.Vector3(), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    var ext = [null, null, null, null, null, null];   // vertices at min x, max x, min y, max y, min z, max z
    var parts = [], total = 0, triTotal = 0;
    meshes.forEach(function (m) {
      var g = m.geometry, pos = g.attributes.position, n = pos.count, W = new Float32Array(n * 3), mw = m.matrixWorld, i;
      for (i = 0; i < n; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mw);
        var x = v.x, y = -v.y, z = -v.z;
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) { W[i * 3] = NaN; W[i * 3 + 1] = NaN; W[i * 3 + 2] = NaN; continue; }
        W[i * 3] = x; W[i * 3 + 1] = y; W[i * 3 + 2] = z;
        if (x < min[0]) { min[0] = x; ext[0] = [x, y, z]; } if (x > max[0]) { max[0] = x; ext[1] = [x, y, z]; }
        if (y < min[1]) { min[1] = y; ext[2] = [x, y, z]; } if (y > max[1]) { max[1] = y; ext[3] = [x, y, z]; }
        if (z < min[2]) { min[2] = z; ext[4] = [x, y, z]; } if (z > max[2]) { max[2] = z; ext[5] = [x, y, z]; }
      }
      var idx = g.index, tn = Math.floor((idx ? idx.count : n) / 3);
      parts.push({ W: W, n: n, idx: idx, tn: tn });
      total += n; triTotal += tn;
    });
    if (!total) throw new Error('no mesh geometry in file');
    if (!isFinite(min[0])) throw new Error('mesh has no finite vertices');
    var wire = (triTotal <= MAX_TRIS) ? fullMesh(parts) : clusterMesh(parts, min, max, MAX_TRIS);
    var hullPts = wire.verts.slice();
    for (var e = 0; e < 6; e++) if (ext[e]) hullPts.push(ext[e]);
    var hull = convexHull(hullPts);
    if (!hull) {   // degenerate (flat) mesh: fall back to the bound corners
      for (var c = 0; c < 8; c++) hullPts.push([c & 1 ? max[0] : min[0], c & 2 ? max[1] : min[1], c & 4 ? max[2] : min[2]]);
      hull = convexHull(hullPts);
    }
    return {
      min: min, max: max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      hull: hull, mesh: { verts: wire.verts, edges: wire.edges, tris: wire.tris.length, clustered: wire.clustered },
      vertexCount: total, triCount: triTotal, meshCount: meshes.length
    };
  }
  function triIndex(p, t, k) { var i = t * 3 + k; return p.idx ? p.idx.getX(i) : i; }
  function edgesOf(tris, nVerts) {
    var seen = new Set(), edges = [];
    for (var i = 0; i < tris.length; i++) {
      var t = tris[i];
      for (var k = 0; k < 3; k++) {
        var a = t[k], b = t[(k + 1) % 3], lo = a < b ? a : b, hi = a < b ? b : a, key = lo * nVerts + hi;
        if (seen.has(key)) continue;
        seen.add(key); edges.push([lo, hi]);
      }
    }
    return edges;
  }
  // small meshes: keep everything (drop non-finite vertices and the triangles that use them)
  function fullMesh(parts) {
    var verts = [], tris = [];
    parts.forEach(function (p) {
      var map = new Int32Array(p.n), i;
      for (i = 0; i < p.n; i++) { if (isNaN(p.W[i * 3])) { map[i] = -1; continue; } map[i] = verts.length; verts.push([p.W[i * 3], p.W[i * 3 + 1], p.W[i * 3 + 2]]); }
      for (i = 0; i < p.tn; i++) {
        var a = map[triIndex(p, i, 0)], b = map[triIndex(p, i, 1)], c = map[triIndex(p, i, 2)];
        if (a < 0 || b < 0 || c < 0 || a === b || b === c || a === c) continue;
        tris.push([a, b, c]);
      }
    });
    return { verts: verts, tris: tris, edges: edgesOf(tris, verts.length), clustered: false };
  }
  // vertex clustering: grid resolution `res` along the longest side; triangle count ~ res^2 for surfaces, so one or
  // two re-tries with a rescaled resolution land near the target
  function clusterMesh(parts, min, max, target) {
    var res = 40, best = null;
    for (var attempt = 0; attempt < 6; attempt++) {
      var r = clusterAt(parts, min, max, res);
      best = r;
      if (r.tris.length <= target || res <= 6) break;
      res = Math.max(6, Math.floor(res * Math.sqrt(target / r.tris.length) * 0.92));
    }
    return best;
  }
  function clusterAt(parts, min, max, res) {
    var size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]], longest = Math.max(size[0], size[1], size[2], 1e-12);
    var inv = res / longest;
    var ny = Math.floor(size[1] * inv) + 2, nz = Math.floor(size[2] * inv) + 2;
    var cellMap = new Map(), sums = [], counts = [], i;
    parts.forEach(function (p) {
      var cl = new Int32Array(p.n); p.cl = cl;
      for (i = 0; i < p.n; i++) {
        var x = p.W[i * 3], y = p.W[i * 3 + 1], z = p.W[i * 3 + 2];
        if (isNaN(x)) { cl[i] = -1; continue; }
        var key = (Math.floor((x - min[0]) * inv) * ny + Math.floor((y - min[1]) * inv)) * nz + Math.floor((z - min[2]) * inv);
        var c = cellMap.get(key);
        if (c === undefined) { c = counts.length; cellMap.set(key, c); sums.push(0, 0, 0); counts.push(0); }
        cl[i] = c; sums[c * 3] += x; sums[c * 3 + 1] += y; sums[c * 3 + 2] += z; counts[c]++;
      }
    });
    var N = counts.length, triSet = new Set(), tris = [];
    parts.forEach(function (p) {
      for (i = 0; i < p.tn; i++) {
        var a = p.cl[triIndex(p, i, 0)], b = p.cl[triIndex(p, i, 1)], c = p.cl[triIndex(p, i, 2)];
        if (a < 0 || b < 0 || c < 0 || a === b || b === c || a === c) continue;
        var lo = Math.min(a, b, c), hi = Math.max(a, b, c), mid = a + b + c - lo - hi, key = (lo * N + mid) * N + hi;
        if (triSet.has(key)) continue;
        triSet.add(key); tris.push([a, b, c]);
      }
      p.cl = null;
    });
    // compact: only clusters used by a kept triangle become vertices
    var remap = new Int32Array(N).fill(-1), verts = [];
    for (i = 0; i < tris.length; i++) {
      var t = tris[i];
      for (var k = 0; k < 3; k++) {
        var c2 = t[k];
        if (remap[c2] < 0) { remap[c2] = verts.length; verts.push([sums[c2 * 3] / counts[c2], sums[c2 * 3 + 1] / counts[c2], sums[c2 * 3 + 2] / counts[c2]]); }
        t[k] = remap[c2];
      }
    }
    return { verts: verts, tris: tris, edges: edgesOf(tris, verts.length), clustered: true, res: res };
  }
  function convexHull(pts) {
    var THREE = T();
    if (!THREE.ConvexHull || pts.length < 4) return null;
    var res = hullOf(pts);
    // too many hull vertices -> re-hull a subsample of the hull's own vertices (keeps the silhouette, bounds the cost)
    var guard = 0;
    while (res && res.verts.length > MAX_HULL_VERTS && guard++ < 6) {
      var keep = Math.max(8, Math.floor(res.verts.length * 0.6)), sub = [], step = res.verts.length / keep;
      for (var i = 0; i < keep; i++) sub.push(res.verts[Math.floor(i * step)]);
      var r2 = hullOf(sub);
      if (!r2 || r2.verts.length >= res.verts.length) break;
      res = r2;
    }
    return res;
  }
  function hullOf(pts) {
    var THREE = T(), vs = [], i;
    for (i = 0; i < pts.length; i++) vs.push(new THREE.Vector3(pts[i][0], pts[i][1], pts[i][2]));
    var hull;
    try { hull = new THREE.ConvexHull().setFromPoints(vs); } catch (e) { return null; }
    if (!hull.faces || hull.faces.length < 4) return null;
    var verts = [], faces = [], map = new Map();
    for (i = 0; i < hull.faces.length; i++) {
      var f = hull.faces[i], e = f.edge, idxs = [], n = 0;
      do {
        var p = e.head().point, k = map.get(p);
        if (k === undefined) { k = verts.length; map.set(p, k); verts.push([p.x, p.y, p.z]); }
        idxs.push(k); e = e.next;
      } while (e !== f.edge && ++n < 64);
      if (idxs.length >= 3) faces.push(idxs);
    }
    return faces.length >= 4 ? { verts: verts, faces: faces } : null;
  }

  // ---------- loading ----------
  function finish(path, fmt, object3d) {
    var r = extract(object3d);
    r.ok = true; r.file = path; r.format = fmt;
    return r;
  }
  function fail(path, fmt, err) {
    return { ok: false, file: path, format: fmt, error: (err && err.message) ? err.message : String(err) };
  }
  function start(path, done) {
    var fmt = ext(path);
    if (!T()) { done(fail(path, fmt, new Error('three.js not loaded'))); return; }
    var THREE = T();
    try {
      var ab = readBuffer(path), base = dirOf(path);
      if (fmt === 'glb' || fmt === 'gltf') {
        if (!THREE.GLTFLoader) throw new Error('GLTFLoader not loaded');
        var data;
        if (fmt === 'glb') { data = rebuildGlb(ab); if (!data) data = JSON.stringify(stripGltfJson(JSON.parse(bufToText(ab)))); }
        else data = JSON.stringify(stripGltfJson(JSON.parse(bufToText(ab))));
        new THREE.GLTFLoader(manager(base)).parse(data, base,
          function (gltf) { try { done(finish(path, fmt, gltf.scene || gltf.scenes[0])); } catch (e) { done(fail(path, fmt, e)); } },
          function (err) { done(fail(path, fmt, err)); });
      } else if (fmt === 'obj') {
        if (!THREE.OBJLoader) throw new Error('OBJLoader not loaded');
        done(finish(path, fmt, new THREE.OBJLoader().parse(bufToText(ab))));
      } else if (fmt === 'fbx') {
        if (!THREE.FBXLoader) throw new Error('FBXLoader not loaded');
        var grp = withoutTextures(function () { return new THREE.FBXLoader(manager(base)).parse(ab, base); });
        done(finish(path, fmt, grp));
      } else throw new Error('unsupported model format .' + fmt);
    } catch (e) { done(fail(path, fmt, e)); }
  }
  // cache key includes mtime + size so a re-exported file is re-parsed on the next refresh
  function cacheKey(path) {
    var fs = nodeFs();
    if (fs) { try { var st = fs.statSync(path); return path + '|' + st.mtimeMs + '|' + st.size; } catch (e) { } }
    return path;
  }
  // MODELS.load(path, cb(result)); results are cached per file version for the panel's lifetime.
  MODELS.load = function (path, cb) {
    if (!path) { cb({ ok: false, error: 'layer has no source file' }); return; }
    var key = cacheKey(path);
    if (cache[key]) { cb(cache[key]); return; }
    if (pending[key]) { pending[key].push(cb); return; }
    pending[key] = [cb];
    start(path, function (res) {
      cache[key] = res;
      var cbs = pending[key]; delete pending[key];
      for (var i = 0; i < cbs.length; i++) { try { cbs[i](res); } catch (e) { console.error('[models]', e); } }
    });
  };
  MODELS.forget = function () { cache = {}; };
  MODELS.cached = function (path) { return cache[cacheKey(path)] || null; };

  // Attach parsed model data to every model layer of a scene (info.model), then call cb(loadedCount).
  // cb fires once, after all files are done; layers whose file was already cached are filled in synchronously.
  MODELS.prepare = function (scene, cb) {
    var todo = [], i;
    for (i = 0; i < scene.layers.length; i++) {
      var info = scene.layers[i];
      if (info.kind !== 'model') continue;
      var c = info.modelFile ? cache[cacheKey(info.modelFile)] : null;
      if (c) info.model = c; else todo.push(info);
    }
    if (!todo.length) { if (cb) cb(0); return 0; }
    var left = todo.length;
    todo.forEach(function (info) {
      MODELS.load(info.modelFile, function (res) {
        info.model = res;
        if (--left === 0 && cb) cb(todo.length);
      });
    });
    return todo.length;
  };

  root.MODELS = MODELS;
  if (typeof module !== 'undefined' && module.exports) module.exports = MODELS;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
