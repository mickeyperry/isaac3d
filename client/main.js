/* Isaac3D — panel controller: reads the AE scene, runs cannon-es (SIM3D), previews it (orthographic Front/Top/Side + orbitable 3D perspective), bakes XYZ keyframes. */
(function () {
  'use strict';
  var isCEP = !!(window.__adobe_cep__ && window.__adobe_cep__.evalScript);
  var hasFS = !!(window.cep && window.cep.fs && window.cep.fs.writeFile);
  var COLORS = { dynamic: '#4fc3f7', static: '#9e9e9e', kinematic: '#ffb74d', dormant: '#ce93d8' };
  var VIEWS = ['front', 'top', 'side', '3d'];
  var NEAR = 4;   // perspective near plane (comp px); anything at depth <= NEAR is culled / clipped

  // Orbit camera for the 3D view. dist 0 / target null = "not resolved yet" -> defaults from the comp (1.8 x width, comp center).
  function defaultView3d() { return { yaw: -30, pitch: 25, dist: 0, target: null, fov: 50 }; }

  var state = {
    scene: null, cfgs: {}, world: SIM3D.defaultWorld(),
    range: { startFrame: 0, endFrame: 0 },
    bake: { unparent: true, clearRange: true, linear: true, rotation: true, make3D: true, step: 1 },
    blasts: [], selectedBlast: -1, view: null, viewMode: '3d', view3d: defaultView3d(),
    result: null, frame: 0, playing: false, selectedId: null, simTimer: null, playTimer: null, busy: false
  };

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return [].slice.call((r || document).querySelectorAll(s)); }
  var statusEl = $('#status'), canvas = $('#cv'), ctx = canvas.getContext('2d');

  function setStatus(text, kind) { statusEl.textContent = text; statusEl.className = 'status-bar' + (kind ? ' ' + kind : ''); }
  function num(v, d) { v = parseFloat(v); return isFinite(v) ? v : d; }

  // ---------- host bridge ----------
  function host(fn, arg, cb) {
    var script = 'PHY3D.' + fn + '(' + (arg === undefined ? '' : JSON.stringify(JSON.stringify(arg))) + ')';
    if (!isCEP) { console.log('[host]', script); if (cb) cb('ERR: not running inside After Effects'); return; }
    window.__adobe_cep__.evalScript(script, function (res) { if (cb) cb(res); });
  }
  function parseResult(res) {
    if (typeof res !== 'string') return { err: 'No response from After Effects.' };
    if (res.indexOf('ERR:') === 0) return { err: res.substring(4).trim() };
    if (res === 'EvalScript error.') return { err: 'Host script error (isaac3d.jsx). Reopen the panel.' };
    try { return { data: JSON.parse(res) }; } catch (e) { return { text: res }; }
  }

  // ---------- persistence ----------
  function storeKey() { return state.scene ? 'isaac3d:' + state.scene.comp.id : null; }
  function persist() {
    var k = storeKey(); if (!k) return;
    try { localStorage.setItem(k, JSON.stringify({ world: state.world, cfgs: state.cfgs, range: state.range, bake: state.bake, blasts: state.blasts, viewMode: state.viewMode, view3d: state.view3d })); } catch (e) { }
  }
  var persistTimer = null;
  function persistLater() { clearTimeout(persistTimer); persistTimer = setTimeout(persist, 300); }
  function restore() {
    var k = storeKey(); if (!k) return null;
    try { var s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }

  // ---------- scene ----------
  function fps() { return state.scene ? state.scene.comp.fps : 24; }
  function refreshScene(keepRange) {
    if (state.busy) return;
    state.busy = true;
    setStatus('Reading layers from After Effects…', 'busy');
    var opts = {};
    if (keepRange && state.scene) opts.time = state.range.startFrame / fps();
    host('getScene', opts, function (res) {
      state.busy = false;
      var r = parseResult(res);
      if (r.err || !r.data) { setStatus(r.err || 'Could not read scene.', 'err'); return; }
      var prevCompId = state.scene ? state.scene.comp.id : null;
      state.scene = r.data;
      var saved = (prevCompId !== state.scene.comp.id) ? restore() : null;
      if (prevCompId !== state.scene.comp.id) state.view3d = defaultView3d();
      if (saved) {
        state.world = extend(SIM3D.defaultWorld(), saved.world || {});
        state.bake = extend(state.bake, saved.bake || {});
        if (saved.range) state.range = saved.range;
        if (saved.cfgs) for (var id in saved.cfgs) {
          state.cfgs[id] = extend(SIM3D.defaultBody({}), saved.cfgs[id]);
          // configs saved before `planar` existed: leave it undefined so the sim resolves it from the layer's is3D
          if (saved.cfgs[id].planar === undefined) state.cfgs[id].planar = undefined;
        }
        state.blasts = saved.blasts || [];
        state.selectedBlast = -1;
        if (VIEWS.indexOf(saved.viewMode) >= 0) state.viewMode = saved.viewMode;
        if (saved.view3d) state.view3d = extend(defaultView3d(), saved.view3d);
      }
      var f = fps(), c = state.scene.comp;
      if (!keepRange && !saved) {
        state.range.startFrame = Math.round(c.workAreaStart * f);
        state.range.endFrame = Math.round((c.workAreaStart + c.workAreaDuration) * f) - 1;
      }
      state.range.endFrame = Math.max(state.range.startFrame, Math.min(state.range.endFrame, Math.round(c.duration * f) - 1));
      state.scene.layers.forEach(function (info) {
        if (!state.cfgs[info.id]) state.cfgs[info.id] = SIM3D.defaultBody(info);
        else if (!info.supported) state.cfgs[info.id].include = false;
      });
      $('#compLabel').textContent = c.name + ' · ' + c.width + '×' + c.height + ' · ' + f + 'fps · ' +
        (state.scene.fromSelection ? state.scene.layers.length + ' selected' : 'all ' + state.scene.layers.length + ' layers');
      renderWorld(); renderBodies(); renderBake(); renderBlasts(); renderViewButtons();
      scheduleSim();
      loadModels();
    });
  }
  // 3D model layers: parse their source files (glb/gltf/obj/fbx) for real bounds + mesh, then simulate again.
  function loadModels() {
    if (!state.scene || typeof MODELS === 'undefined') return;
    var n = MODELS.prepare(state.scene, function (loaded) {
      var failed = state.scene.layers.filter(function (i) { return i.kind === 'model' && i.model && !i.model.ok; });
      if (failed.length) setStatus('Model file not parsed: ' + failed.map(function (i) { return i.name + ' (' + i.model.error + ')'; }).join(' · '), 'err');
      renderBodies();
      scheduleSim();
    });
    if (n) setStatus('Parsing ' + n + ' model file' + (n > 1 ? 's' : '') + '…', 'busy');
  }
  function extend(a, b) { for (var k in b) if (b.hasOwnProperty(k)) a[k] = b[k]; return a; }

  // ---------- world UI ----------
  function renderWorld() {
    $$('[data-w]').forEach(function (el) {
      var k = el.getAttribute('data-w');
      if (el.type === 'checkbox') el.checked = !!state.world[k]; else el.value = state.world[k];
    });
    syncSliders();
    $('#startFrame').value = state.range.startFrame;
    $('#endFrame').value = state.range.endFrame;
  }
  // slider + number pairs: the range is a convenience for the useful span, the number box accepts anything
  function paintSlider(r) {
    var mn = num(r.min, 0), mx = num(r.max, 1), v = num(r.value, mn);
    r.style.setProperty('--p', (mx > mn ? Math.max(0, Math.min(1, (v - mn) / (mx - mn))) * 100 : 0) + '%');
  }
  function syncSliders() {
    $$('[data-ws]').forEach(function (r) {
      var v = state.world[r.getAttribute('data-ws')];
      if (typeof v === 'number') r.value = v;
      paintSlider(r);
    });
  }
  $$('[data-ws]').forEach(function (r) {
    r.addEventListener('input', function () {
      var k = r.getAttribute('data-ws'), n = $('[data-w="' + k + '"]');
      paintSlider(r);
      if (!n) return;
      n.value = r.value;
      n.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
  // frame slider progress fill
  $('#frameSlider').addEventListener('input', function () { paintSlider(this); });
  $$('[data-w]').forEach(function (el) {
    el.addEventListener('change', function () {
      var k = el.getAttribute('data-w');
      state.world[k] = (el.type === 'checkbox') ? el.checked : num(el.value, state.world[k]);
      if (k === 'ppm' && state.world.ppm < 1) state.world.ppm = 1;
      if (k === 'substeps') state.world.substeps = Math.max(1, Math.round(state.world.substeps));
      if (k === 'solverIterations') state.world.solverIterations = Math.max(1, Math.round(state.world.solverIterations));
      if (k === 'depth' && state.world.depth < 0) state.world.depth = 0;
      if (k === 'cardThickness' && state.world.cardThickness <= 0) state.world.cardThickness = 1;
      if (k === 'depth' || k === 'cardThickness' || k === 'solverIterations') el.value = state.world[k];
      syncSliders();
      persist(); scheduleSim(); draw();
    });
  });
  // collapsible cards (clicks on chips inside the header don't collapse)
  $$('.card-head[data-collapse]').forEach(function (head) {
    head.addEventListener('click', function (e) {
      if (e.target.closest('[data-nocollapse]')) return;
      var card = document.getElementById(head.getAttribute('data-collapse'));
      if (card) card.classList.toggle('collapsed');
    });
  });
  function setRange(s, e) {
    var f = fps(), maxF = state.scene ? Math.round(state.scene.comp.duration * f) - 1 : 0;
    s = Math.max(0, Math.min(Math.round(s), maxF)); e = Math.max(s, Math.min(Math.round(e), maxF));
    var startChanged = s !== state.range.startFrame;
    state.range.startFrame = s; state.range.endFrame = e;
    $('#startFrame').value = s; $('#endFrame').value = e;
    persist();
    if (startChanged) refreshScene(true); else scheduleSim();
  }
  $('#startFrame').addEventListener('change', function () { setRange(num(this.value, 0), state.range.endFrame); });
  $('#endFrame').addEventListener('change', function () { setRange(state.range.startFrame, num(this.value, 0)); });
  $('#rangeWork').addEventListener('click', function () {
    if (!state.scene) return; var c = state.scene.comp, f = fps();
    setRange(Math.round(c.workAreaStart * f), Math.round((c.workAreaStart + c.workAreaDuration) * f) - 1);
  });
  $('#rangeComp').addEventListener('click', function () {
    if (!state.scene) return; setRange(0, Math.round(state.scene.comp.duration * fps()) - 1);
  });

  // ---------- bodies UI ----------
  var TYPES = ['dynamic', 'static', 'kinematic', 'dormant'], SHAPES = ['auto', 'box', 'cube', 'sphere', 'hull'];
  function optionList(list, cur) {
    return list.map(function (v) { return '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + v + '</option>'; }).join('');
  }
  function modelBadge(info) {
    if (info.kind !== 'model' || !info.model || info.model.ok) return '';
    return '<span class="badge" style="color:#ffb74d;border-color:#ffb74d" title="' + escapeHtml(info.model.error || 'model file not parsed') + '">!</span>';
  }
  function badge3D(info) { return '<span class="badge' + (info.is3D ? ' is3d' : '') + '">' + (info.is3D ? '3D' : '2D') + '</span>'; }
  function renderBodies() {
    var list = $('#bodyList'); list.innerHTML = '';
    if (!state.scene) return;
    var included = 0;
    state.scene.layers.forEach(function (info) {
      var cfg = state.cfgs[info.id];
      if (cfg.include) included++;
      var row = document.createElement('div');
      row.className = 'body-row' + (cfg.include ? '' : ' excluded') + (info.supported ? '' : ' unsupported') + (state.selectedId === info.id ? ' selected' : '');
      row.setAttribute('data-id', info.id);
      row.title = info.supported ? (info.kind + (info.is3D ? ' · 3D layer' : ' · 2D layer') + (info.hasParent ? ' · parented' : '') + (info.hasKeys ? ' · animated' : '')) : info.reason;
      row.innerHTML =
        '<label class="toggle-switch mini"><input type="checkbox" data-inc' + (cfg.include ? ' checked' : '') + (info.supported ? '' : ' disabled') + '><span class="toggle-slider"></span></label>' +
        '<div class="swatch t-' + cfg.type + '"></div>' +
        '<div class="name"><span class="txt">' + escapeHtml(info.name) + '</span><small>' + info.kind + '</small>' + badge3D(info) + modelBadge(info) + '</div>' +
        '<select class="sel t-' + cfg.type + '" data-type>' + optionList(TYPES, cfg.type) + '</select>' +
        '<select class="sel" data-shape>' + optionList(SHAPES, cfg.shape) + '</select>' +
        '<div class="caret">' + (state.selectedId === info.id ? '&#9662;' : '&#9656;') + '</div>';
      list.appendChild(row);
    });
    $('#bodyCount').textContent = included + ' / ' + state.scene.layers.length;
    renderDetail();
  }
  function baseName(p) { p = String(p || ''); var i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i >= 0 ? p.substring(i + 1) : p; }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function infoById(id) { for (var i = 0; i < state.scene.layers.length; i++) if (state.scene.layers[i].id === id) return state.scene.layers[i]; return null; }

  $('#bodyList').addEventListener('change', function (e) {
    var row = e.target.closest('.body-row'); if (!row) return;
    var id = parseInt(row.getAttribute('data-id'), 10), cfg = state.cfgs[id];
    if (e.target.hasAttribute('data-inc')) cfg.include = e.target.checked;
    else if (e.target.hasAttribute('data-type')) cfg.type = e.target.value;
    else if (e.target.hasAttribute('data-shape')) cfg.shape = e.target.value;
    persist(); renderBodies(); scheduleSim();
  });
  $('#bodyList').addEventListener('click', function (e) {
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' || e.target.tagName === 'OPTION' || e.target.closest('.toggle-switch')) return;
    var row = e.target.closest('.body-row'); if (!row) return;
    var id = parseInt(row.getAttribute('data-id'), 10);
    state.selectedId = (state.selectedId === id) ? null : id;
    renderBodies(); draw();
  });
  $('#bodyList').addEventListener('dblclick', function (e) {
    var row = e.target.closest('.body-row'); if (!row) return;
    var id = parseInt(row.getAttribute('data-id'), 10), info = infoById(id);
    if (info) host('selectLayer', { id: id, index: info.index });
  });
  $$('[data-setall]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var t = btn.getAttribute('data-setall');
      for (var id in state.cfgs) if (state.cfgs[id].include) state.cfgs[id].type = t;
      persist(); renderBodies(); scheduleSim();
    });
  });

  var DETAIL_FIELDS = [
    ['density', 'Density', 0.1], ['friction', 'Friction', 0.05], ['restitution', 'Bounce', 0.05],
    ['linearDamping', 'Lin. damp', 0.05], ['angularDamping', 'Ang. damp', 0.05], ['spin', 'Spin °/s', 10],
    ['vx', 'Vel X px/s', 10], ['vy', 'Vel Y px/s', 10], ['vz', 'Vel Z px/s', 10],
    ['thickness', 'Thickness', 1]
  ];
  function renderDetail() {
    var box = $('#bodyDetail');
    if (state.selectedId === null || !state.cfgs[state.selectedId]) { box.className = 'body-detail hidden'; return; }
    var cfg = state.cfgs[state.selectedId], info = infoById(state.selectedId);
    box.className = 'body-detail';
    var html = '<div class="title"><div class="swatch t-' + cfg.type + '" style="width:10px;height:10px;border-radius:2px"></div>' +
      escapeHtml(info ? info.name : '') + (info ? badge3D(info) : '') + '<span class="spacer"></span>' +
      '<button class="btn small" data-selectae>Select in AE</button></div><div class="grid">';
    DETAIL_FIELDS.forEach(function (f) {
      var v = cfg[f[0]] === undefined ? 0 : cfg[f[0]];
      var title = f[0] === 'thickness' ? ' title="Depth of the body in px (0 = world card thickness)"' : '';
      html += '<label' + title + '>' + f[1] + ' <input type="number" data-d="' + f[0] + '" step="' + f[2] + '" value="' + v + '"></label>';
    });
    html += '</div><div class="row wrap">' +
      '<label class="chk"><input type="checkbox" data-d="fixedRotation"' + (cfg.fixedRotation ? ' checked' : '') + '> lock rotation</label>' +
      '<label class="chk" title="Move in X/Y and rotate about Z only (like the 2D panel). Default on for 2D layers."><input type="checkbox" data-d="planar"' + ((cfg.planar === undefined ? !(info && info.is3D) : cfg.planar) ? ' checked' : '') + '> lock to comp plane</label>' +
      '<label class="chk"><input type="checkbox" data-d="collide"' + (cfg.collide !== false ? ' checked' : '') + '> collides</label>' +
      '<label class="chk" title="all: hits everything · solo: only static / kinematic bodies and the walls · world: follow the World toggle">collides with <select data-d="collideWith">' +
      optionList(['world', 'all', 'solo'], cfg.collideWith || 'world') + '</select></label>' +
      '</div>';
    if (info && !info.is3D) html += '<div class="row muted">2D layer — it is simulated as a card at z = 0' + (state.bake.make3D ? ' and will be made 3D when baked.' : '; only Position XY and Rotation Z will be baked.') + '</div>';
    if (info && info.kind === 'model') {
      var M = info.model;
      if (!M) html += '<div class="row muted">3D model layer — parsing ' + escapeHtml(baseName(info.modelFile)) + '…</div>';
      else if (!M.ok) html += '<div class="row muted">3D model ' + escapeHtml(baseName(info.modelFile)) + ' could not be parsed (' + escapeHtml(M.error || '?') + ') — simulated as a block sized from its AE bounds.</div>';
      else {
        var g = null; try { g = SIM3D.buildGeometry(info, cfg, state.world); } catch (e) { }
        var sz = g && g.model ? g.model.size.map(function (v) { return Math.round(v); }).join(' × ') + ' px' : '?';
        html += '<div class="row muted">3D model ' + escapeHtml(baseName(info.modelFile)) + ' (' + M.format + ') · ' + sz +
          ' · ' + M.triCount.toLocaleString() + ' tris' + (M.mesh && M.mesh.clustered ? ' (preview ' + M.mesh.tris + ')' : '') +
          ' · body: ' + (g ? g.mode : '?') + (M.hull ? ' (hull ' + M.hull.verts.length + ' pts)' : '') + '</div>';
      }
    }
    if (info && info.hasParent) html += '<div class="row muted">Parented layer — it will be unparented when baked (if "unparent" is on).</div>';
    if (info && info.hasExpression) html += '<div class="row muted">Has a Position/Rotation expression — it will be disabled when baked.</div>';
    box.innerHTML = html;
  }
  $('#bodyDetail').addEventListener('change', function (e) {
    var k = e.target.getAttribute('data-d'); if (!k) return;
    var cfg = state.cfgs[state.selectedId];
    cfg[k] = (e.target.type === 'checkbox') ? e.target.checked : (e.target.tagName === 'SELECT' ? e.target.value : num(e.target.value, cfg[k]));
    if (k === 'thickness' && cfg.thickness < 0) { cfg.thickness = 0; e.target.value = 0; }
    persist(); scheduleSim();
  });
  $('#bodyDetail').addEventListener('click', function (e) {
    if (e.target.hasAttribute('data-selectae')) { var info = infoById(state.selectedId); if (info) host('selectLayer', { id: info.id, index: info.index }); }
  });

  // ---------- bake UI ----------
  function renderBake() {
    $$('[data-b]').forEach(function (el) {
      var k = el.getAttribute('data-b');
      if (el.type === 'checkbox') el.checked = !!state.bake[k]; else el.value = state.bake[k];
    });
  }
  $$('[data-b]').forEach(function (el) {
    el.addEventListener('change', function () {
      var k = el.getAttribute('data-b');
      state.bake[k] = (el.type === 'checkbox') ? el.checked : Math.max(1, Math.round(num(el.value, 1)));
      persist();
      if (k === 'make3D') renderDetail();
    });
  });

  // ---------- simulation ----------
  function scheduleSim() {
    clearTimeout(state.simTimer);
    state.simTimer = setTimeout(runSim, 120);
  }
  function runSim() {
    if (!state.scene) return;
    var f = fps(), start = state.range.startFrame / f, count = state.range.endFrame - state.range.startFrame + 1;
    var kinIds = [];
    state.scene.layers.forEach(function (info) {
      var cfg = state.cfgs[info.id];
      if (info.supported && cfg.include && cfg.type === 'kinematic') kinIds.push(info.id);
    });
    setStatus('Simulating…', 'busy');
    var proceed = function (samples) {
      var t0 = Date.now();
      try {
        var rel = state.blasts.map(function (b) { var o = extend({}, b); o.frame = Math.round(b.frame) - state.range.startFrame; return o; });
        state.result = SIM3D.run(state.scene, { world: state.world, start: start, count: count, fps: f, bodies: state.cfgs, kinematic: samples || {}, blasts: rel });
      } catch (e) { state.result = null; setStatus('Simulation error: ' + (e.message || e), 'err'); draw(); return; }
      if (state.frame > count - 1) state.frame = 0;
      updateTransport(); draw();
      setStatus(count + ' frames · ' + state.result.bodyCount + ' bodies · ' + (Date.now() - t0) + ' ms', 'ok');
    };
    if (kinIds.length && isCEP) {
      host('sampleTransforms', { ids: kinIds, start: start, count: count, fps: f }, function (res) {
        var r = parseResult(res);
        if (r.err) setStatus('Kinematic sampling failed: ' + r.err, 'err');
        proceed(r.data ? r.data.samples : {});
      });
    } else proceed({});
  }

  // ---------- 3D helpers ----------
  // Rotate vector v=[x,y,z] by quaternion q ({x,y,z,w}; works for CANNON.Quaternion or a plain object).
  function rotateVec(q, v) {
    var qx = q.x, qy = q.y, qz = q.z, qw = q.w, x = v[0], y = v[1], z = v[2];
    var ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
    return [ix * qw + iw * -qx + iy * -qz - iz * -qy,
            iy * qw + iw * -qy + iz * -qx - ix * -qz,
            iz * qw + iw * -qz + ix * -qy - iy * -qx];
  }
  function bodyQuat(b, f) {
    try { return SIM3D.aeToQuat(b.rx[f] || 0, b.ry[f] || 0, b.rz[f] || 0); } catch (e) { return { x: 0, y: 0, z: 0, w: 1 }; }
  }
  function worldDepth() {
    var d = state.world.depth;
    return (d > 0) ? d : (state.scene ? state.scene.comp.width : 1000);
  }
  // Orthographic views. u = screen-right, v = screen-down (both in px, comp units).
  //  front: u=x, v=y  (viewer at -z)      top: u=x, v=-z (viewer above, far = up)     side: u=z, v=y (viewer at +x)
  function toView(p) {
    var m = state.viewMode;
    if (m === 'top') return [p[0], -p[2]];
    if (m === 'side') return [p[2], p[1]];
    return [p[0], p[1]];
  }
  // depth coordinate: larger = nearer to the viewer (drawn last)
  function viewDepth(p) {
    var m = state.viewMode;
    if (m === 'top') return -p[1];
    if (m === 'side') return p[0];
    return -p[2];
  }
  function viewExtent() {
    var c = state.scene ? state.scene.comp : { width: 16, height: 9 }, d = worldDepth(), m = state.viewMode;
    if (m === 'top') return { w: c.width, h: 2 * d, u0: 0, v0: -d };
    if (m === 'side') return { w: 2 * d, h: c.height, u0: -d, v0: 0 };
    if (m === '3d') return { w: c.width, h: Math.max(c.height, c.width * 0.65), u0: 0, v0: 0 };   // aspect only; a bit taller so the floor fits
    return { w: c.width, h: c.height, u0: 0, v0: 0 };
  }
  function viewLabel() {
    var m = state.viewMode;
    if (m === 'top') return 'TOP  x →  z ↑';
    if (m === 'side') return 'SIDE  z →  y ↓';
    if (m === '3d') return 'PERSPECTIVE  yaw ' + Math.round(state.view3d.yaw) + '°  pitch ' + Math.round(state.view3d.pitch) + '°';
    return 'FRONT  x →  y ↓';
  }
  function renderViewButtons() {
    $$('[data-view]').forEach(function (b) { b.className = 'chip' + (b.getAttribute('data-view') === state.viewMode ? ' active' : ''); });
    var is3d = state.viewMode === '3d', hint = $('#viewHint'), hint3d = $('#viewHint3d');
    if (hint) hint.textContent = is3d ? 'click sets X,Y on the blast’s Z plane' : (state.viewMode === 'front' ? 'click sets X,Y' : (state.viewMode === 'top' ? 'click sets X,Z' : 'click sets Z,Y'));
    if (hint3d) hint3d.className = 'view-row hint' + (is3d ? '' : ' hidden');
    updateCursor();
  }
  function updateCursor() {
    var is3d = state.viewMode === '3d', place = $('#blastPlace').checked;
    canvas.className = is3d ? ('orbit' + (drag.active ? ' dragging' : '') + (place && !drag.active ? ' place' : '')) : '';
  }
  function setViewMode(v) {
    if (VIEWS.indexOf(v) < 0) return;
    state.viewMode = v; persist(); renderViewButtons(); draw();
  }
  $$('[data-view]').forEach(function (b) {
    b.addEventListener('click', function () { setViewMode(b.getAttribute('data-view')); });
  });
  $('#blastPlace').addEventListener('change', updateCursor);

  // ---------- 3D camera ----------
  function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm3(v) { var l = Math.sqrt(dot3(v, v)); return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : null; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  // Fill in the comp-dependent defaults (distance, target) once a scene is known.
  function ensureView3d() {
    var v = state.view3d, c = state.scene.comp;
    if (!(v.dist > 0)) v.dist = Math.round(c.width * 1.8);
    if (!v.target) v.target = [c.width / 2, c.height / 2, 0];
    v.pitch = clamp(v.pitch, -89, 89);
    return v;
  }
  // Orbit camera in AE axes (x right, y down, z into the screen). yaw 0 / pitch 0 puts the camera on the viewer side (-z)
  // looking at +z, like AE's default camera; positive pitch raises the camera (smaller y) so it looks down at the floor.
  // Returns basis: f = forward, r = screen-right, d = screen-down (all unit, world space), focal in canvas px.
  function camera3d(W, H) {
    var v = ensureView3d();
    var yaw = v.yaw * Math.PI / 180, pitch = v.pitch * Math.PI / 180, cp = Math.cos(pitch), sp = Math.sin(pitch);
    var dir = [Math.sin(yaw) * cp, -sp, -Math.cos(yaw) * cp];   // target -> camera
    var pos = [v.target[0] + dir[0] * v.dist, v.target[1] + dir[1] * v.dist, v.target[2] + dir[2] * v.dist];
    var f = [-dir[0], -dir[1], -dir[2]];
    var r = norm3(cross3(f, [0, -1, 0])) || [1, 0, 0];   // world up is -y
    var d = cross3(f, r);                                  // = +y at yaw 0 / pitch 0: screen-down stays down
    var focal = (H / 2) / Math.tan((v.fov || 50) * Math.PI / 360);
    return { pos: pos, f: f, r: r, d: d, focal: focal, cx: W / 2, cy: H / 2, dist: v.dist };
  }
  // world point -> camera space [right, down, depth]
  function toCam(p) {
    var cam = state.view.cam, v = [p[0] - cam.pos[0], p[1] - cam.pos[1], p[2] - cam.pos[2]];
    return [dot3(v, cam.r), dot3(v, cam.d), dot3(v, cam.f)];
  }
  function camToScreen(cv) {
    var cam = state.view.cam, k = cam.focal / cv[2];
    return { x: cam.cx + cv[0] * k, y: cam.cy + cv[1] * k, depth: cv[2], scale: k, ok: cv[2] > NEAR };
  }
  // Shared projection for all views: world [x,y,z] -> { x, y (canvas px), depth (larger = farther), scale (px per comp px), ok }
  function project(p) {
    var v = state.view;
    if (v.mode === '3d') return camToScreen(toCam(p));
    var uv = toView(p);
    return { x: v.ox + (uv[0] - v.u0) * v.s, y: v.oy + (uv[1] - v.v0) * v.s, depth: -viewDepth(p), scale: v.s, ok: true };
  }
  // Polygon (ordered world points) -> canvas points, clipped against the near plane in 3D. null when fully behind the camera.
  function polyScreen(pts) {
    if (state.view.mode !== '3d') return pts.map(function (p) { var s = project(p); return [s.x, s.y]; });
    var cv = pts.map(toCam), out = [], n = cv.length;
    for (var i = 0; i < n; i++) {
      var a = cv[i], b = cv[(i + 1) % n], ain = a[2] > NEAR, bin = b[2] > NEAR;
      if (ain) out.push(a);
      if (ain !== bin) { var t = (NEAR - a[2]) / (b[2] - a[2]); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]); }
    }
    if (out.length < 2) return null;
    return out.map(function (q) { var s = camToScreen(q); return [s.x, s.y]; });
  }
  function strokePath(pts2, close) {
    if (!pts2 || pts2.length < 2) return false;
    ctx.beginPath();
    for (var i = 0; i < pts2.length; i++) { if (i === 0) ctx.moveTo(pts2[i][0], pts2[i][1]); else ctx.lineTo(pts2[i][0], pts2[i][1]); }
    if (close) ctx.closePath();
    return true;
  }
  function fillPoly3(pts3, fill, stroke, lw) {
    if (!strokePath(polyScreen(pts3), true)) return;
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke(); }
  }
  function line3(a, b, stroke, lw) {
    if (!strokePath(polyScreen([a, b]), false)) return;
    ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke();
  }
  function niceStep(v) {
    var p = Math.pow(10, Math.floor(Math.log(v) / Math.LN10)), f = v / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  }
  // Canvas px -> world point on the plane z = zPlane (or y = yPlane when given). null when the ray misses.
  function unproject3d(mx, my, plane) {
    var cam = state.view.cam, k = 1 / cam.focal, dx = (mx - cam.cx) * k, dy = (my - cam.cy) * k;
    var dir = [cam.f[0] + cam.r[0] * dx + cam.d[0] * dy, cam.f[1] + cam.r[1] * dx + cam.d[1] * dy, cam.f[2] + cam.r[2] * dx + cam.d[2] * dy];
    var axis = plane.axis, den = dir[axis];
    if (Math.abs(den) < 1e-6) return null;
    var t = (plane.value - cam.pos[axis]) / den;
    if (t <= 0) return null;
    var hit = [cam.pos[0] + dir[0] * t, cam.pos[1] + dir[1] * t, cam.pos[2] + dir[2] * t];
    hit[axis] = plane.value;
    return hit;
  }

  // ---------- preview ----------
  function fitCanvas() {
    var wrap = canvas.parentNode, W = wrap.clientWidth - 12;
    var ex = viewExtent();
    var H = Math.max(80, Math.min(Math.round(W * ex.h / ex.w), Math.round(window.innerHeight * 0.4)));
    var dpr = window.devicePixelRatio || 1;
    canvas.style.height = H + 'px';
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    return { W: W, H: H, dpr: dpr };
  }
  // comp-space point -> canvas px (orthographic views only; 3D goes through project())
  function sx(p) { var v = state.view, uv = toView(p); return v.ox + (uv[0] - v.u0) * v.s; }
  function sy(p) { var v = state.view, uv = toView(p); return v.oy + (uv[1] - v.v0) * v.s; }
  function line(ax, ay, bx, by) { ctx.moveTo(ax, ay); ctx.lineTo(bx, by); }
  function draw() {
    var m = fitCanvas(), dpr = m.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0f0f0f'; ctx.fillRect(0, 0, m.W, m.H);
    if (!state.scene) return;
    if (state.viewMode === '3d') drawScene3d(m); else drawSceneOrtho(m);
    drawBlasts();
    drawBodies();
  }
  // ---- 3D perspective: floor grid, walls, comp rectangle, axes gizmo ----
  function drawScene3d(m) {
    var c = state.scene.comp, w = state.world, off = w.boundsOffset || 0, d = worldDepth();
    state.view = { mode: '3d', cam: camera3d(m.W, m.H) };
    var X0 = off, X1 = c.width - off, Y0 = off, Y1 = c.height - off, ZB = d - off, ZF = -d + off;
    var wallFill = 'rgba(120,120,120,0.10)', wallStroke = '#6d6d6d', i, k;
    // floor: translucent quad + light grid
    if (w.floor) {
      fillPoly3([[0, Y1, -d], [c.width, Y1, -d], [c.width, Y1, d], [0, Y1, d]], 'rgba(120,120,120,0.07)', null);
      var step = niceStep(c.width / 8), grid = 'rgba(255,255,255,0.07)';
      for (k = step; k < c.width; k += step) line3([k, Y1, -d], [k, Y1, d], grid, 1);
      for (k = 0; k < d; k += step) { line3([0, Y1, k], [c.width, Y1, k], grid, 1); if (k > 0) line3([0, Y1, -k], [c.width, Y1, -k], grid, 1); }
      fillPoly3([[0, Y1, -d], [c.width, Y1, -d], [c.width, Y1, d], [0, Y1, d]], null, wallStroke, 1.5);
    }
    if (w.ceiling) fillPoly3([[0, Y0, -d], [c.width, Y0, -d], [c.width, Y0, d], [0, Y0, d]], wallFill, wallStroke, 1.5);
    if (w.left) fillPoly3([[X0, 0, -d], [X0, 0, d], [X0, c.height, d], [X0, c.height, -d]], wallFill, wallStroke, 1.5);
    if (w.right) fillPoly3([[X1, 0, -d], [X1, 0, d], [X1, c.height, d], [X1, c.height, -d]], wallFill, wallStroke, 1.5);
    if (w.back) fillPoly3([[0, 0, ZB], [c.width, 0, ZB], [c.width, c.height, ZB], [0, c.height, ZB]], wallFill, wallStroke, 1.5);
    if (w.front) fillPoly3([[0, 0, ZF], [c.width, 0, ZF], [c.width, c.height, ZF], [0, c.height, ZF]], wallFill, wallStroke, 1.5);
    // comp bounds at z = 0
    ctx.save(); ctx.setLineDash([4, 4]);
    fillPoly3([[0, 0, 0], [c.width, 0, 0], [c.width, c.height, 0], [0, c.height, 0]], 'rgba(255,171,64,0.04)', '#8a7a5a', 1);
    ctx.restore();
    // axes gizmo (bottom-left): world x red, y green, z blue, rotated by the camera only
    var cam = state.view.cam, gx = 26, gy = m.H - 26, L = 16;
    var axes = [[[1, 0, 0], '#ff6b6b', 'x'], [[0, 1, 0], '#7bd88f', 'y'], [[0, 0, 1], '#6aa8ff', 'z']];
    axes.sort(function (a, b) { return dot3(b[0], cam.f) - dot3(a[0], cam.f); });   // farthest first
    ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (i = 0; i < axes.length; i++) {
      var a = axes[i][0], ex = dot3(a, cam.r) * L, ey = dot3(a, cam.d) * L;
      ctx.strokeStyle = axes[i][1]; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx + ex, gy + ey); ctx.stroke();
      ctx.fillStyle = axes[i][1]; ctx.fillText(axes[i][2], gx + ex * 1.45, gy + ey * 1.45);
    }
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#555'; ctx.font = '9px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(viewLabel(), 6, 12);
  }
  // ---- orthographic Front / Top / Side ----
  function drawSceneOrtho(m) {
    var c = state.scene.comp, ex = viewExtent(), s = Math.min(m.W / ex.w, m.H / ex.h) * 0.96;
    var ox = (m.W - ex.w * s) / 2, oy = (m.H - ex.h * s) / 2;
    state.view = { ox: ox, oy: oy, s: s, u0: ex.u0, v0: ex.v0, mode: state.viewMode };
    var w = state.world, off = w.boundsOffset || 0, d = worldDepth(), mode = state.viewMode;
    // world extent (this view)
    ctx.fillStyle = '#1b1b1b'; ctx.fillRect(ox, oy, ex.w * s, ex.h * s);
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1; ctx.strokeRect(ox + 0.5, oy + 0.5, ex.w * s, ex.h * s);
    // comp plane (z = 0) as a dashed line in top/side views
    if (mode !== 'front') {
      ctx.save(); ctx.setLineDash([3, 5]); ctx.strokeStyle = '#3a3a3a'; ctx.lineWidth = 1; ctx.beginPath();
      if (mode === 'top') line(ox, sy([0, 0, 0]) + 0.5, ox + ex.w * s, sy([0, 0, 0]) + 0.5);
      else line(sx([0, 0, 0]) + 0.5, oy, sx([0, 0, 0]) + 0.5, oy + ex.h * s);
      ctx.stroke(); ctx.restore();
    }
    // active walls (only the ones that are lines in this view)
    ctx.strokeStyle = '#6d6d6d'; ctx.lineWidth = 2; ctx.beginPath();
    var X0 = off, X1 = c.width - off, Y0 = off, Y1 = c.height - off, ZB = d - off, ZF = -d + off;
    if (mode === 'front') {
      if (w.floor) line(sx([0, Y1, 0]), sy([0, Y1, 0]), sx([c.width, Y1, 0]), sy([c.width, Y1, 0]));
      if (w.ceiling) line(sx([0, Y0, 0]), sy([0, Y0, 0]), sx([c.width, Y0, 0]), sy([c.width, Y0, 0]));
      if (w.left) line(sx([X0, 0, 0]), sy([X0, 0, 0]), sx([X0, c.height, 0]), sy([X0, c.height, 0]));
      if (w.right) line(sx([X1, 0, 0]), sy([X1, 0, 0]), sx([X1, c.height, 0]), sy([X1, c.height, 0]));
    } else if (mode === 'top') {
      if (w.left) line(sx([X0, 0, -d]), sy([X0, 0, -d]), sx([X0, 0, d]), sy([X0, 0, d]));
      if (w.right) line(sx([X1, 0, -d]), sy([X1, 0, -d]), sx([X1, 0, d]), sy([X1, 0, d]));
      if (w.back) line(sx([0, 0, ZB]), sy([0, 0, ZB]), sx([c.width, 0, ZB]), sy([c.width, 0, ZB]));
      if (w.front) line(sx([0, 0, ZF]), sy([0, 0, ZF]), sx([c.width, 0, ZF]), sy([c.width, 0, ZF]));
    } else {
      if (w.floor) line(sx([0, Y1, -d]), sy([0, Y1, -d]), sx([0, Y1, d]), sy([0, Y1, d]));
      if (w.ceiling) line(sx([0, Y0, -d]), sy([0, Y0, -d]), sx([0, Y0, d]), sy([0, Y0, d]));
      if (w.back) line(sx([0, 0, ZB]), sy([0, 0, ZB]), sx([0, c.height, ZB]), sy([0, c.height, ZB]));
      if (w.front) line(sx([0, 0, ZF]), sy([0, 0, ZF]), sx([0, c.height, ZF]), sy([0, c.height, ZF]));
    }
    ctx.stroke();
    // walls that face the viewer (whole plane) -> hatched hint in the corner label
    var facing = [];
    if (mode === 'front') { if (w.back) facing.push('back'); if (w.front) facing.push('front'); }
    else if (mode === 'top') { if (w.floor) facing.push('floor'); if (w.ceiling) facing.push('ceiling'); }
    else { if (w.left) facing.push('left'); if (w.right) facing.push('right'); }
    ctx.fillStyle = '#555'; ctx.font = '9px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(viewLabel() + (facing.length ? '   (' + facing.join(', ') + ' wall' + (facing.length > 1 ? 's' : '') + ' facing you)' : ''), 6, 12);
  }
  // ---- bodies (all views, via project()) ----
  function drawBodies() {
    if (!state.result) return;
    var f = Math.min(state.frame, state.result.count - 1), is3d = state.view.mode === '3d';
    // painter's order: far bodies first
    var order = state.result.bodies.slice().sort(function (a, b) {
      return project([b.x[f], b.y[f], b.z[f]]).depth - project([a.x[f], a.y[f], a.z[f]]).depth;
    });
    order.forEach(function (b) {
      var pos = [b.x[f], b.y[f], b.z[f]], q = bodyQuat(b, f);
      var col = COLORS[b.type] || '#fff', sel = b.id === state.selectedId;
      var fill = hexA(col, sel ? 0.55 : 0.32), stroke = sel ? '#fff' : col, lw = sel ? 2 : 1;
      ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = lw;
      var shapes = (b.geom && b.geom.shapes) || [];
      var mesh = b.geom && b.geom.mesh;
      if (mesh) {
        // model layer: the collision shape as a faint outline, the actual mesh as a wireframe on top
        fill = hexA(col, sel ? 0.12 : 0.06);
        ctx.fillStyle = fill;
      }
      shapes.forEach(function (sh) {
        if (sh.kind === 'sphere') {
          var oc = sh.offset || [0, 0, 0], cw = add3(pos, rotateVec(q, oc)), pc = project(cw);
          if (!pc.ok) return;
          var R = Math.max(1, sh.r * pc.scale);
          ctx.beginPath(); ctx.arc(pc.x, pc.y, R, 0, Math.PI * 2);
          // rotation tick: body +x axis
          var tip = project(add3(cw, rotateVec(q, [sh.r, 0, 0])));
          if (tip.ok) { ctx.moveTo(pc.x, pc.y); ctx.lineTo(tip.x, tip.y); }
          ctx.fill(); ctx.stroke();
        } else if (sh.kind === 'box' && is3d) {
          drawBoxFaces(boxCorners(sh).map(function (p) { return add3(pos, rotateVec(q, p)); }), fill, stroke, lw);
        } else if (sh.kind === 'hull3d' && is3d) {
          drawHullFaces(sh, pos, q, fill, stroke, lw);
        } else {
          var pts3 = (sh.kind === 'box') ? boxCorners(sh) : (sh.pts || sh.verts || []);
          var pts2 = [];
          for (var i = 0; i < pts3.length; i++) { var pp = project(add3(pos, rotateVec(q, pts3[i]))); if (pp.ok) pts2.push([pp.x, pp.y]); }
          var hull = pts2.length >= 3 ? GEO.convexHull(pts2) : pts2;
          if (strokePath(hull, true)) { ctx.fill(); ctx.stroke(); }
        }
      });
      if (mesh) drawWireframe(mesh, pos, q, sel ? '#fff' : col, sel ? 0.9 : 0.6);
      if (sel || state.result.bodies.length <= 24) {
        var pl = project(pos);
        if (pl.ok) {
          ctx.fillStyle = '#ddd'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
          ctx.fillText(b.name.length > 18 ? b.name.substring(0, 17) + '…' : b.name, pl.x, pl.y - 4);
        }
      }
    });
  }
  // 8 world-space corners (boxCorners bit order: 1 = +x, 2 = +y, 4 = +z) -> 6 faces, far faces first
  var BOX_FACES = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]];
  function drawBoxFaces(corners, fill, stroke, lw) {
    var cam = state.view.cam, faces = [];
    for (var i = 0; i < BOX_FACES.length; i++) {
      var idx = BOX_FACES[i], pts = [corners[idx[0]], corners[idx[1]], corners[idx[2]], corners[idx[3]]], depth = 0;
      for (var j = 0; j < 4; j++) depth += dot3([pts[j][0] - cam.pos[0], pts[j][1] - cam.pos[1], pts[j][2] - cam.pos[2]], cam.f);
      faces.push({ pts: pts, depth: depth });
    }
    faces.sort(function (a, b) { return b.depth - a.depth; });
    for (i = 0; i < faces.length; i++) fillPoly3(faces[i].pts, fill, stroke, lw);
  }
  // convex hull faces (3D view): painter-sorted, far first, like drawBoxFaces
  function drawHullFaces(sh, pos, q, fill, stroke, lw) {
    var cam = state.view.cam, world = [], faces = [], i, j;
    for (i = 0; i < sh.verts.length; i++) world.push(add3(pos, rotateVec(q, sh.verts[i])));
    for (i = 0; i < sh.faces.length; i++) {
      var f = sh.faces[i], pts = [], depth = 0;
      for (j = 0; j < f.length; j++) { var p = world[f[j]]; pts.push(p); depth += dot3([p[0] - cam.pos[0], p[1] - cam.pos[1], p[2] - cam.pos[2]], cam.f); }
      faces.push({ pts: pts, depth: depth / f.length });
    }
    faces.sort(function (a, b) { return b.depth - a.depth; });
    for (i = 0; i < faces.length; i++) fillPoly3(faces[i].pts, fill, stroke, lw * 0.5);
  }
  // decimated triangle wireframe of a model layer's real mesh (all views)
  function drawWireframe(mesh, pos, q, color, alpha) {
    var pts = new Array(mesh.verts.length), i;
    for (i = 0; i < mesh.verts.length; i++) pts[i] = project(add3(pos, rotateVec(q, mesh.verts[i])));
    ctx.save();
    ctx.strokeStyle = color; ctx.globalAlpha = alpha; ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (i = 0; i < mesh.edges.length; i++) {
      var e = mesh.edges[i], a = pts[e[0]], b = pts[e[1]];
      if (!a.ok || !b.ok) continue;
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    ctx.restore();
  }
  function add3(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function boxCorners(sh) {
    var h = sh.half || [1, 1, 1], o = sh.offset || [0, 0, 0], out = [];
    for (var i = 0; i < 8; i++) out.push([o[0] + (i & 1 ? h[0] : -h[0]), o[1] + (i & 2 ? h[1] : -h[1]), o[2] + (i & 4 ? h[2] : -h[2])]);
    return out;
  }
  function hexA(hex, a) {
    var n = parseInt(hex.substring(1), 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // ---------- blasts ----------
  function absFrame() { return state.range.startFrame + state.frame; }
  function blastPos(b) { return [b.x || 0, b.y || 0, b.z || 0]; }
  function blastLabel(b, i) {
    return 'Blast ' + (i + 1) + '<small>f ' + Math.round(b.frame) + ' · ' + Math.round(b.x) + ',' + Math.round(b.y) + ',' + Math.round(b.z || 0) + ' · R' + Math.round(b.radius) + ' · ' + Math.round(b.strength) + '</small>';
  }
  function renderBlasts() {
    var list = $('#blastList'); list.innerHTML = '';
    state.blasts.forEach(function (b, i) {
      var row = document.createElement('div');
      row.className = 'blast-row' + (b.enabled === false ? ' off' : '') + (state.selectedBlast === i ? ' selected' : '');
      row.setAttribute('data-i', i);
      row.innerHTML = '<label class="toggle-switch mini"><input type="checkbox" data-on' + (b.enabled !== false ? ' checked' : '') + '><span class="toggle-slider"></span></label><div class="swatch"></div>' +
        '<div class="name">' + blastLabel(b, i) + '</div><div class="del" data-del title="Remove">&times;</div>';
      list.appendChild(row);
    });
    $('#blastCount').textContent = state.blasts.length ? String(state.blasts.length) : '';
    renderBlastDetail();
  }
  var BLAST_FIELDS = [['frame', 'Frame', 1], ['x', 'X', 10], ['y', 'Y', 10], ['z', 'Z', 10], ['radius', 'Radius', 10], ['strength', 'Strength px/s', 50], ['lift', 'Lift px/s', 50], ['spin', 'Spin °/s', 30]];
  function renderBlastDetail() {
    var box = $('#blastDetail'), b = state.blasts[state.selectedBlast];
    if (!b) { box.className = 'body-detail hidden'; return; }
    box.className = 'body-detail';
    var html = '<div class="title"><div class="swatch" style="width:10px;height:10px;border-radius:50%;background:#ff5252"></div>Blast ' + (state.selectedBlast + 1) +
      '<span class="spacer"></span><button class="btn small" data-bframe title="Set the blast frame to the preview frame">Use frame ' + absFrame() + '</button>' +
      '<button class="btn small" data-bcenter title="Move to comp center (z = 0)">Center</button></div><div class="grid">';
    BLAST_FIELDS.forEach(function (f) { html += '<label>' + f[1] + ' <input type="number" data-bl="' + f[0] + '" step="' + f[2] + '" value="' + (b[f[0]] === undefined ? 0 : b[f[0]]) + '"></label>'; });
    html += '<label>Falloff <select data-bl="falloff">' + optionList(['linear', 'inverse', 'none'], b.falloff || 'linear') + '</select></label></div>' +
      '<div class="row muted">Tip: turn on "place by click" and click the preview to position it — the click sets the two axes of the current view (switch to Top/Side to set Z; in 3D it lands on the blast’s Z plane). Dormant bodies sleep until a blast hits them.</div>';
    box.innerHTML = html;
  }
  $('#blastAdd').addEventListener('click', function () {
    if (!state.scene) return;
    var c = state.scene.comp;
    state.blasts.push(SIM3D.defaultBlast(absFrame(), Math.round(c.width / 2), Math.round(c.height / 2), 0, Math.round(c.width / 4)));
    state.selectedBlast = state.blasts.length - 1;
    persist(); renderBlasts(); draw(); scheduleSim();
  });
  $('#blastList').addEventListener('change', function (e) {
    var row = e.target.closest('.blast-row'); if (!row) return;
    var i = parseInt(row.getAttribute('data-i'), 10);
    if (e.target.hasAttribute('data-on')) state.blasts[i].enabled = e.target.checked;
    persist(); renderBlasts(); draw(); scheduleSim();
  });
  $('#blastList').addEventListener('click', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.closest('.toggle-switch')) return;
    var row = e.target.closest('.blast-row'); if (!row) return;
    var i = parseInt(row.getAttribute('data-i'), 10), del = e.target.hasAttribute('data-del');
    if (del) { state.blasts.splice(i, 1); state.selectedBlast = -1; }
    else state.selectedBlast = (state.selectedBlast === i) ? -1 : i;
    persist(); renderBlasts(); draw(); if (del) scheduleSim();
  });
  $('#blastDetail').addEventListener('change', function (e) {
    var k = e.target.getAttribute('data-bl'), b = state.blasts[state.selectedBlast]; if (!k || !b) return;
    b[k] = (k === 'falloff') ? e.target.value : num(e.target.value, b[k]);
    if (k === 'frame') b.frame = Math.round(b.frame);
    if (k === 'radius') b.radius = Math.max(1, b.radius);
    persist(); renderBlasts(); draw(); scheduleSim();
  });
  $('#blastDetail').addEventListener('click', function (e) {
    var b = state.blasts[state.selectedBlast]; if (!b) return;
    if (e.target.hasAttribute('data-bframe')) b.frame = absFrame();
    else if (e.target.hasAttribute('data-bcenter') && state.scene) { b.x = Math.round(state.scene.comp.width / 2); b.y = Math.round(state.scene.comp.height / 2); b.z = 0; }
    else return;
    persist(); renderBlasts(); draw(); scheduleSim();
  });
  // canvas px -> the two comp coordinates visible in the current view; writes them into obj
  function applyClick(obj, u, v) {
    var m = state.viewMode;
    if (m === 'top') { obj.x = Math.round(u); obj.z = Math.round(-v); }
    else if (m === 'side') { obj.z = Math.round(u); obj.y = Math.round(v); }
    else { obj.x = Math.round(u); obj.y = Math.round(v); }
  }
  // Place a blast from a canvas click. Ortho: the two visible axes. 3D: ray hit on the plane z = blast.z, or the floor
  // plane (y = floor, or z = 0 without a floor) when no blast is explicitly selected. Returns false when the ray misses.
  function placeByClick(b, mx, my, hadSelection) {
    var v = state.view;
    if (v.mode !== '3d') { applyClick(b, (mx - v.ox) / v.s + v.u0, (my - v.oy) / v.s + v.v0); return true; }
    var plane;
    if (hadSelection) plane = { axis: 2, value: b.z || 0 };
    else if (state.world.floor) plane = { axis: 1, value: state.scene.comp.height - (state.world.boundsOffset || 0) };
    else plane = { axis: 2, value: 0 };
    var hit = unproject3d(mx, my, plane);
    if (!hit) return false;
    b.x = Math.round(hit[0]); b.y = Math.round(hit[1]); b.z = Math.round(hit[2]);
    return true;
  }
  canvas.addEventListener('click', function (e) {
    if (!state.scene || !state.view) return;
    if (drag.moved) return;   // end of an orbit / pan drag, not a click
    var r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    if ($('#blastPlace').checked) {
      var hadSelection = !!state.blasts[state.selectedBlast];
      var b = state.blasts[state.selectedBlast] || state.blasts[state.blasts.length - 1];
      if (!b) { var c = state.scene.comp; b = SIM3D.defaultBlast(absFrame(), Math.round(c.width / 2), Math.round(c.height / 2), 0, Math.round(c.width / 4)); state.blasts.push(b); state.selectedBlast = state.blasts.length - 1; }
      if (!placeByClick(b, mx, my, hadSelection)) { setStatus('Click misses the blast plane — orbit a little and try again.', 'err'); return; }
      persist(); renderBlasts(); draw(); scheduleSim();
      return;
    }
    // plain click: select the blast whose ring contains the click (nearest center wins, in canvas space)
    var best = -1, bestD = Infinity;
    state.blasts.forEach(function (bl, i) {
      var p = project(blastPos(bl)); if (!p.ok) return;
      var d = Math.sqrt((p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my));
      if (d <= bl.radius * p.scale && d < bestD) { bestD = d; best = i; }
    });
    if (best >= 0) { state.selectedBlast = best; renderBlasts(); draw(); }
  });

  // ---------- 3D orbit / pan / zoom ----------
  var drag = { active: false, moved: false, mode: null, x: 0, y: 0 };
  canvas.addEventListener('mousedown', function (e) {
    drag.moved = false;
    if (state.viewMode !== '3d' || !state.scene) return;
    drag.active = true; drag.x = e.clientX; drag.y = e.clientY;
    drag.mode = (e.button === 2 || e.button === 1 || e.shiftKey) ? 'pan' : 'orbit';
    updateCursor();
    e.preventDefault();
  });
  window.addEventListener('mousemove', function (e) {
    if (!drag.active) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    drag.moved = true; drag.x = e.clientX; drag.y = e.clientY;
    var v = ensureView3d(), cam = state.view && state.view.mode === '3d' ? state.view.cam : null;
    if (drag.mode === 'orbit') {
      // "grab the scene": drag right turns the scene right (camera goes left), drag down tilts it down (camera goes up)
      v.yaw = ((v.yaw - dx * 0.4 + 180) % 360 + 360) % 360 - 180;
      v.pitch = clamp(v.pitch + dy * 0.4, -89, 89);
    } else if (cam) {
      var k = cam.dist / cam.focal, t = v.target;
      v.target = [t[0] - (cam.r[0] * dx + cam.d[0] * dy) * k, t[1] - (cam.r[1] * dx + cam.d[1] * dy) * k, t[2] - (cam.r[2] * dx + cam.d[2] * dy) * k];
    }
    draw();
  });
  window.addEventListener('mouseup', function () {
    if (!drag.active) return;
    drag.active = false; updateCursor();
    if (drag.moved) persist();
  });
  canvas.addEventListener('contextmenu', function (e) { if (state.viewMode === '3d') e.preventDefault(); });
  canvas.addEventListener('wheel', function (e) {
    if (state.viewMode !== '3d' || !state.scene) return;
    e.preventDefault();
    var v = ensureView3d(), W = state.scene.comp.width;
    var delta = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;   // lines -> ~px
    v.dist = clamp(v.dist * Math.exp(delta * 0.0012), W * 0.05, W * 20);
    draw(); persistLater();
  }, { passive: false });
  canvas.addEventListener('dblclick', function (e) {
    if (state.viewMode !== '3d' || !state.scene || $('#blastPlace').checked) return;
    e.preventDefault();
    state.view3d = defaultView3d(); persist(); draw();
  });

  function drawBlasts() {
    var cur = absFrame(), is3d = state.view.mode === '3d';
    state.blasts.forEach(function (b, i) {
      var sel = i === state.selectedBlast, on = b.enabled !== false, p = blastPos(b), pr = project(p);
      if (!pr.ok) return;
      var px = pr.x, py = pr.y, R = Math.max(2, b.radius * pr.scale);
      var age = cur - Math.round(b.frame);
      ctx.save();
      ctx.setLineDash([4, 4]); ctx.lineWidth = sel ? 1.5 : 1;
      ctx.strokeStyle = on ? (sel ? 'rgba(255,120,120,0.9)' : 'rgba(255,82,82,0.45)') : 'rgba(150,150,150,0.35)';
      ctx.beginPath(); ctx.arc(px, py, R, 0, Math.PI * 2); ctx.stroke();
      if (is3d) {
        // sphere hint: the blast's equator (circle in the plane y = blast.y) in perspective
        var ring = [];
        for (var k = 0; k < 32; k++) { var a = k / 32 * Math.PI * 2; ring.push([p[0] + Math.cos(a) * b.radius, p[1], p[2] + Math.sin(a) * b.radius]); }
        ctx.globalAlpha = 0.6;
        if (strokePath(polyScreen(ring), true)) ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.setLineDash([]);
      // shockwave for ~10 frames after detonation
      if (on && age >= 0 && age < 10) {
        var k = age / 10;
        ctx.strokeStyle = 'rgba(255,' + Math.round(200 - 120 * k) + ',80,' + (1 - k) + ')'; ctx.lineWidth = 3 * (1 - k) + 1;
        ctx.beginPath(); ctx.arc(px, py, R * (0.15 + 0.85 * k), 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = 'rgba(255,200,80,' + (0.35 * (1 - k)) + ')'; ctx.beginPath(); ctx.arc(px, py, R * 0.15 * (1 - k) + 3, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = on ? '#ff5252' : '#777'; ctx.beginPath(); ctx.arc(px, py, sel ? 4 : 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = sel ? '#fff' : '#ff8a80'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('✹ ' + (i + 1) + ' @f' + Math.round(b.frame), px, py - 8);
      ctx.restore();
    });
  }

  // ---------- transport ----------
  var slider = $('#frameSlider');
  function updateTransport() {
    var count = state.result ? state.result.count : 0;
    slider.max = Math.max(0, count - 1); slider.value = state.frame;
    var t = state.scene ? ((state.range.startFrame + state.frame) / fps()) : 0;
    $('#frameLabel').textContent = (state.range.startFrame + state.frame) + ' / ' + (state.range.endFrame) + ' · ' + t.toFixed(2) + 's';
    paintSlider(slider);
    $('#playBtn').innerHTML = state.playing ? '&#10074;&#10074;' : '&#9654;';
    var bf = $('[data-bframe]'); if (bf) bf.textContent = 'Use frame ' + absFrame();
  }
  function setFrame(f, fromUser) {
    state.frame = Math.max(0, Math.min(f, state.result ? state.result.count - 1 : 0));
    updateTransport(); draw();
    if (fromUser && $('#syncTime').checked) host('setTime', (state.range.startFrame + state.frame) / fps());
  }
  slider.addEventListener('input', function () { setFrame(parseInt(slider.value, 10), true); });
  function play(on) {
    state.playing = on; clearInterval(state.playTimer);
    if (on) state.playTimer = setInterval(function () {
      if (!state.result) return;
      setFrame(state.frame + 1 >= state.result.count ? 0 : state.frame + 1, false);
    }, 1000 / fps());
    updateTransport();
  }
  $('#playBtn').addEventListener('click', function () { play(!state.playing); });
  $('#stopBtn').addEventListener('click', function () { play(false); setFrame(0, true); });
  $('#refreshBtn').addEventListener('click', function () { refreshScene(true); });
  window.addEventListener('resize', draw);
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); play(!state.playing); }
    else if (e.key === '1' || e.key === '2' || e.key === '3' || e.key === '4') setViewMode(VIEWS[parseInt(e.key, 10) - 1]);
  });

  // ---------- bake ----------
  function round3(arr) { var o = new Array(arr.length); for (var i = 0; i < arr.length; i++) o[i] = Math.round(arr[i] * 1000) / 1000; return o; }
  function bake() {
    if (!state.result || state.busy) return;
    var bodies = [];
    state.result.bodies.forEach(function (b) {
      if (b.type === 'dynamic' || b.type === 'dormant') bodies.push({
        id: b.id, index: b.index, name: b.name, is3D: !!b.is3D,
        x: round3(b.x), y: round3(b.y), z: round3(b.z), rx: round3(b.rx), ry: round3(b.ry), rz: round3(b.rz)
      });
    });
    if (!bodies.length) { setStatus('Nothing to bake — no dynamic bodies.', 'err'); return; }
    var payload = { start: state.result.start, fps: state.result.fps, count: state.result.count, step: state.bake.step,
      unparent: state.bake.unparent, clearRange: state.bake.clearRange, linear: state.bake.linear, bakeRotation: state.bake.rotation,
      make3D: state.bake.make3D, bodies: bodies };
    var json = JSON.stringify(payload);
    state.busy = true; $('#bakeBtn').disabled = true;
    setStatus('Baking ' + bodies.length + ' layers × ' + state.result.count + ' frames…', 'busy');
    var done = function (res) {
      state.busy = false; $('#bakeBtn').disabled = false;
      var r = parseResult(res);
      if (r.err) setStatus('Bake failed: ' + r.err, 'err');
      else setStatus((r.text || res).replace(/^OK:\s*/, ''), 'ok');
    };
    if (hasFS && json.length > 60000) {
      host('tempPath', undefined, function (p) {
        if (!p || p.indexOf('ERR:') === 0) { host('bake', payload, done); return; }
        var w = window.cep.fs.writeFile(p, json, window.cep.encoding.UTF8);
        if (w && w.err === 0) host('bakeFromFile', p, done); else host('bake', payload, done);
      });
    } else host('bake', payload, done);
  }
  $('#bakeBtn').addEventListener('click', bake);

  // debug hook (DevTools on the .debug port): window.__isaac3d.state.result holds the last simulation
  window.__isaac3d = { state: state, version: SIM3D.version };

  // ---------- boot ----------
  renderWorld(); renderBake(); renderBlasts(); renderViewButtons(); draw();
  if (isCEP) {
    host('ping', undefined, function (res) {
      if (typeof res === 'string' && res.indexOf('PHY3D') === 0) refreshScene(false);
      else setStatus('Host script not loaded (' + res + '). Reopen the panel.', 'err');
    });
  } else {
    setStatus('Not running inside After Effects — preview only.', 'err');
  }
})();
