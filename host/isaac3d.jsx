// Isaac3D — ExtendScript host. Loaded by the CEP panel via manifest <ScriptPath>.
// Defines PHY3D.* ; every function takes ONE JSON string and returns a string
// (JSON on success, "ERR: ..." on failure). ES3 only: no map/filter/indexOf.
//
// AE 26.3 gotcha: reading ANY 3-component property value (3D Position, Anchor Point,
// Scale, Orientation, ...) via .value / .valueAtTime throws "invalid numeric result".
// Writes work. So every 3D quantity is read through Slider Controls on a hidden,
// temporary helper null ("__phy3d_helper") whose expressions reference the target
// layer by index (thisComp.layer(IDX)...). The helper is created at the start of
// getScene / sampleTransforms and removed at the end (also on error).

var PHY3D = (function () {
    var VERSION = "0.2.0";
    var HELPER_NAME = "__phy3d_helper";
    var NSLIDERS = 12;

    var J = (typeof JSON !== "undefined" && JSON.stringify && JSON.parse) ? JSON : (function () {
        function q(s) {
            return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
                .replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
        }
        function stringify(v) {
            if (v === null || v === undefined) return "null";
            var t = typeof v;
            if (t === "number") return isFinite(v) ? String(v) : "null";
            if (t === "boolean") return v ? "true" : "false";
            if (t === "string") return q(v);
            var i, a = [];
            if (v instanceof Array) {
                for (i = 0; i < v.length; i++) a.push(stringify(v[i]));
                return "[" + a.join(",") + "]";
            }
            for (var k in v) {
                if (v.hasOwnProperty(k) && typeof v[k] !== "function" && v[k] !== undefined) a.push(q(k) + ":" + stringify(v[k]));
            }
            return "{" + a.join(",") + "}";
        }
        return { stringify: stringify, parse: function (s) { return eval("(" + s + ")"); } };
    })();

    function r4(n) { return Math.round(n * 10000) / 10000; }
    function r4a(arr) { var o = []; for (var i = 0; i < arr.length; i++) o.push(r4(arr[i])); return o; }
    // Significant-digit rounding for world basis vectors: a layer at 0.3% scale (or an FBX, whose cm->m factor AE
    // applies inside the layer transform) has axis lengths ~1e-5 that 4-decimal rounding would flatten to zero.
    function rS(n) { return (n === 0 || !isFinite(n)) ? 0 : parseFloat(n.toPrecision(9)); }
    function rSa(arr) { var o = []; for (var i = 0; i < arr.length; i++) o.push(rS(arr[i])); return o; }
    function num(v, dflt) { return (typeof v === "number" && isFinite(v)) ? v : dflt; }

    function activeComp() {
        var it = app.project.activeItem;
        return (it && it instanceof CompItem) ? it : null;
    }
    function xg(L) { return L.property("ADBE Transform Group"); }
    function tprop(L, match) {
        var g = xg(L); if (!g) return null;
        try { return g.property(match); } catch (e) { return null; }
    }
    function hasKeysOn(L, match) {
        var p = tprop(L, match);
        if (!p) return false;
        try { return p.numKeys > 0; } catch (e) { return false; }
    }
    function hasExprOn(L, match) {
        var p = tprop(L, match);
        if (!p) return false;
        try { return !!(p.expression && p.expression.length); } catch (e) { return false; }
    }

    function isModelLayer(L) {
        try { return (typeof ThreeDModelLayer !== "undefined") && (L instanceof ThreeDModelLayer); } catch (e) { return false; }
    }
    function modelFileOf(L) {
        try { var src = L.source; if (src && src.mainSource && src.mainSource.file) return src.mainSource.file.fsName; } catch (e) { }
        return "";
    }
    function kindOf(L) {
        if (isModelLayer(L)) return "model";
        if (L instanceof ShapeLayer) return "shape";
        if (L instanceof TextLayer) return "text";
        if (L.nullLayer) return "null";
        var src = L.source;
        if (src instanceof CompItem) return "precomp";
        if (src && src.mainSource && (src.mainSource instanceof SolidSource)) return "solid";
        return "footage";
    }

    // ---------- helper null with 12 sliders (3-component read workaround) ----------
    function removeStaleHelpers(comp) {
        for (var i = comp.numLayers; i >= 1; i--) {
            try { if (comp.layer(i).name === HELPER_NAME) comp.layer(i).remove(); } catch (e) { }
        }
    }
    function createHelper(comp) {
        var itemsBefore = app.project.numItems;
        var h = comp.layers.addNull(comp.duration);
        var H = { layer: h, comp: comp, ownSource: null };
        try { if (app.project.numItems > itemsBefore) H.ownSource = h.source; } catch (e0) { }
        h.name = HELPER_NAME;
        try { h.moveToEnd(); } catch (e1) { }          // keep every other layer's index unchanged
        try { h.startTime = 0; } catch (e2) { }
        try { h.enabled = false; } catch (e3) { }
        try { h.shy = true; } catch (e4) { }
        var parade = h.property("ADBE Effect Parade");
        for (var i = 0; i < NSLIDERS; i++) {
            var fx = parade.addProperty("ADBE Slider Control");
            try { fx.name = "s" + i; } catch (e5) { }
        }
        return H;
    }
    function removeHelper(H) {
        if (!H) return;
        try { if (H.layer) H.layer.remove(); } catch (e0) { }
        try {
            var src = H.ownSource;
            if (src && src.usedIn && src.usedIn.length === 0) src.remove();
        } catch (e1) { }
    }
    // Re-fetch every time: property references can go stale when the tree changes.
    function slider(H, i) {
        return H.layer.property("ADBE Effect Parade").property(i + 1).property(1);
    }
    function setExprs(H, exprs) {
        for (var i = 0; i < exprs.length && i < NSLIDERS; i++) {
            var s = slider(H, i);
            s.expression = exprs[i];
        }
    }
    function readSlider(H, i, t) {
        var s = slider(H, i);
        var v = s.valueAtTime(t, false);
        var err = "";
        try { err = s.expressionError; } catch (e) { }
        if (err && err.length) throw new Error("expression on slider " + i + ": " + err);
        return v;
    }
    function readN(H, i0, n, t) {
        var out = [];
        for (var i = 0; i < n; i++) out.push(readSlider(H, i0 + i, t));
        return out;
    }

    // Expressions for the world basis of layer IDX:
    //   sliders 0..2 origin = toWorld(anchor), 3..5 ax, 6..8 ay, 9..11 az.
    function basisExprs(idx, is3D) {
        var pre = "var L=thisComp.layer(" + idx + ");var a=L.transform.anchorPoint;";
        var ex = [], c;
        if (is3D) {
            var o = "L.toWorld(a)";
            var vx = "(L.toWorld(a+[1,0,0])-L.toWorld(a))";
            var vy = "(L.toWorld(a+[0,1,0])-L.toWorld(a))";
            var vz = "(L.toWorld(a+[0,0,1])-L.toWorld(a))";
            for (c = 0; c < 3; c++) ex.push(pre + o + "[" + c + "]");
            for (c = 0; c < 3; c++) ex.push(pre + vx + "[" + c + "]");
            for (c = 0; c < 3; c++) ex.push(pre + vy + "[" + c + "]");
            for (c = 0; c < 3; c++) ex.push(pre + vz + "[" + c + "]");
        } else {
            var pre2 = pre + "var p=[a[0],a[1]];";
            var o2 = "L.toComp(p)";
            var vx2 = "(L.toComp([p[0]+1,p[1]])-L.toComp(p))";
            var vy2 = "(L.toComp([p[0],p[1]+1])-L.toComp(p))";
            for (c = 0; c < 2; c++) ex.push(pre2 + o2 + "[" + c + "]");
            ex.push("0");
            for (c = 0; c < 2; c++) ex.push(pre2 + vx2 + "[" + c + "]");
            ex.push("0");
            for (c = 0; c < 2; c++) ex.push(pre2 + vy2 + "[" + c + "]");
            ex.push("0");
            ex.push("0"); ex.push("0"); ex.push("1");
        }
        return ex;
    }
    // Expressions for the layer's own anchor point (sliders 0..2).
    function anchorExprs(idx, is3D) {
        var pre = "var a=thisComp.layer(" + idx + ").transform.anchorPoint;";
        var ex = [pre + "a[0]", pre + "a[1]"];
        ex.push(is3D ? (pre + "(a.length>2?a[2]:0)") : "0");
        return ex;
    }
    function readBasis(H, L, t) {
        setExprs(H, basisExprs(L.index, !!L.threeDLayer));
        return {
            origin: readN(H, 0, 3, t),
            ax: readN(H, 3, 3, t),
            ay: readN(H, 6, 3, t),
            az: readN(H, 9, 3, t)
        };
    }
    function readAnchor(H, L, t) {
        setExprs(H, anchorExprs(L.index, !!L.threeDLayer));
        return readN(H, 0, 3, t);
    }
    function identityBasis() {
        return { origin: [0, 0, 0], ax: [1, 0, 0], ay: [0, 1, 0], az: [0, 0, 1] };
    }
    function r4Basis(b) {
        return { origin: r4a(b.origin), ax: rSa(b.ax), ay: rSa(b.ay), az: rSa(b.az) };
    }

    // ---------- shape layer geometry (2-component reads are fine) ----------
    function groupXf(g, t) {
        var d = { anchor: [0, 0], position: [0, 0], scale: [100, 100], rotation: 0 };
        var tg = g.property("ADBE Vector Transform Group");
        if (!tg) return d;
        function gv(m, dflt) { var p = tg.property(m); if (!p) return dflt; try { return p.valueAtTime(t, false); } catch (e) { return dflt; } }
        var a = gv("ADBE Vector Anchor", [0, 0]), p = gv("ADBE Vector Position", [0, 0]);
        var s = gv("ADBE Vector Scale", [100, 100]), r = gv("ADBE Vector Rotation", 0);
        return { anchor: [r4(a[0]), r4(a[1])], position: [r4(p[0]), r4(p[1])], scale: [r4(s[0]), r4(s[1])], rotation: r4(r) };
    }
    function val(it, m, t, dflt) { var p = it.property(m); if (!p) return dflt; try { return p.valueAtTime(t, false); } catch (e) { return dflt; } }
    function pathObj(shape, xfChain) {
        var v = [], i = [], o = [], k;
        for (k = 0; k < shape.vertices.length; k++) {
            v.push(r4a(shape.vertices[k]));
            i.push(r4a(shape.inTangents[k]));
            o.push(r4a(shape.outTangents[k]));
        }
        return { type: "path", xf: xfChain, vertices: v, inTangents: i, outTangents: o, closed: shape.closed };
    }
    function walkVectors(container, t, xfChain, out, depth) {
        if (depth > 12) return;
        for (var n = 1; n <= container.numProperties; n++) {
            var it = container.property(n);
            if (!it) continue;
            try { if (it.enabled === false) continue; } catch (e0) { }
            var mn = it.matchName;
            try {
                if (mn === "ADBE Vector Group") {
                    var chain = xfChain.concat([groupXf(it, t)]);
                    var contents = it.property("ADBE Vectors Group");
                    if (contents) walkVectors(contents, t, chain, out, depth + 1);
                } else if (mn === "ADBE Vector Shape - Rect") {
                    out.push({ type: "rect", xf: xfChain,
                        size: r4a(val(it, "ADBE Vector Rect Size", t, [100, 100])),
                        position: r4a(val(it, "ADBE Vector Rect Position", t, [0, 0])),
                        roundness: r4(val(it, "ADBE Vector Rect Roundness", t, 0)) });
                } else if (mn === "ADBE Vector Shape - Ellipse") {
                    out.push({ type: "ellipse", xf: xfChain,
                        size: r4a(val(it, "ADBE Vector Ellipse Size", t, [100, 100])),
                        position: r4a(val(it, "ADBE Vector Ellipse Position", t, [0, 0])) });
                } else if (mn === "ADBE Vector Shape - Star") {
                    out.push({ type: "star", xf: xfChain,
                        starType: val(it, "ADBE Vector Star Type", t, 2),
                        points: val(it, "ADBE Vector Star Points", t, 5),
                        position: r4a(val(it, "ADBE Vector Star Position", t, [0, 0])),
                        rotation: r4(val(it, "ADBE Vector Star Rotation", t, 0)),
                        innerRadius: r4(val(it, "ADBE Vector Star Inner Radius", t, 50)),
                        outerRadius: r4(val(it, "ADBE Vector Star Outer Radius", t, 100)) });
                } else if (mn === "ADBE Vector Shape - Group") {
                    var sp = it.property("ADBE Vector Shape");
                    if (sp) out.push(pathObj(sp.valueAtTime(t, false), xfChain));
                }
            } catch (e) { }
        }
    }
    function shapesOf(L, t) {
        var out = [];
        var root = L.property("ADBE Root Vectors Group");
        if (root) walkVectors(root, t, [], out, 0);
        return out;
    }
    function masksOf(L, t) {
        var out = [];
        var mp = L.property("ADBE Mask Parade");
        if (!mp) return out;
        for (var n = 1; n <= mp.numProperties; n++) {
            var m = mp.property(n);
            try {
                if (m.maskMode === MaskMode.NONE || m.maskMode === MaskMode.SUBTRACT || m.inverted) continue;
                var sp = m.property("ADBE Mask Shape");
                if (sp) out.push(pathObj(sp.valueAtTime(t, false), []));
            } catch (e) { }
        }
        return out;
    }

    // ---------- layer info ----------
    var KEY_PROPS = ["ADBE Position", "ADBE Position_0", "ADBE Position_1", "ADBE Position_2",
        "ADBE Rotate X", "ADBE Rotate Y", "ADBE Rotate Z", "ADBE Orientation"];

    function layerInfo(H, L, t) {
        var info = { index: L.index, id: L.id, name: L.name, enabled: L.enabled, supported: true, reason: "",
            kind: "other", is3D: false, inPoint: r4(L.inPoint), outPoint: r4(L.outPoint) };
        // TextLayer/ShapeLayer fail `instanceof AVLayer` in some ExtendScript builds, so duck-type instead.
        var isCamLight = (L instanceof CameraLayer) || (L instanceof LightLayer);
        var isVisual = !isCamLight && (typeof L.hasVideo !== "undefined") && !!xg(L);
        if (!isVisual) {
            info.supported = false;
            info.reason = isCamLight ? "camera/light layer" : "not a visual layer";
            return info;
        }
        if (!L.hasVideo) { info.supported = false; info.reason = "audio only"; info.kind = "audio"; return info; }
        info.kind = kindOf(L);
        info.is3D = !!L.threeDLayer;
        if (L.adjustmentLayer) { info.supported = false; info.reason = "adjustment layer"; }
        else if (L.locked) { info.supported = false; info.reason = "locked"; }

        // 3-component reads go through the helper sliders.
        var anchor = [0, 0, 0], basis = identityBasis();
        try {
            basis = readBasis(H, L, t);
            anchor = readAnchor(H, L, t);
        } catch (eR) {
            if (info.supported) { info.supported = false; info.reason = "read error: " + eR; }
        }
        info.anchor = r4a(anchor);
        info.world = r4Basis(basis);

        info.hasParent = !!L.parent;
        var hk = false, hx = false, i;
        for (i = 0; i < KEY_PROPS.length; i++) {
            if (hasKeysOn(L, KEY_PROPS[i])) hk = true;
            if (hasExprOn(L, KEY_PROPS[i])) hx = true;
        }
        info.hasKeys = hk;
        info.hasExpression = hx;
        var posP = tprop(L, "ADBE Position");
        var sep = false;
        try { sep = !!(posP && posP.dimensionsSeparated); } catch (eS) { }
        info.dimensionsSeparated = sep;

        var rect = null;
        try { rect = L.sourceRectAtTime(t, true); } catch (e1) { }
        if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
            try { rect = L.sourceRectAtTime(L.inPoint, true); } catch (e2) { }
        }
        if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
            var w = 100, h = 100;
            try { if (L.width && L.height) { w = L.width; h = L.height; } } catch (e3) { }
            rect = { left: 0, top: 0, width: w, height: h };
        }
        info.rect = { left: r4(rect.left), top: r4(rect.top), width: r4(rect.width), height: r4(rect.height) };

        info.shapes = (info.kind === "shape") ? shapesOf(L, t) : [];
        info.masks = (info.kind !== "shape" && info.kind !== "model") ? masksOf(L, t) : [];
        // 3D model layers (glb/gltf/obj/fbx): the panel parses the source file for the real 3D bounds and mesh.
        if (info.kind === "model") info.modelFile = modelFileOf(L);
        return info;
    }

    function captureSelection(comp) {
        var sel = [];
        try { for (var i = 0; i < comp.selectedLayers.length; i++) sel.push(comp.selectedLayers[i]); } catch (e) { }
        return sel;
    }
    function restoreSelection(comp, sel) {
        try { for (var i = 1; i <= comp.numLayers; i++) comp.layer(i).selected = false; } catch (e0) { }
        for (var k = 0; k < sel.length; k++) { try { sel[k].selected = true; } catch (e1) { } }
    }

    function getScene(json) {
        var comp, sel = [], H = null, result;
        try {
            var o = json ? J.parse(json) : {};
            comp = activeComp();
            if (!comp) return "ERR: Open a composition first.";
            var t = (typeof o.time === "number") ? o.time : comp.workAreaStart;

            app.beginUndoGroup("Isaac3D: Read scene");
            try {
                removeStaleHelpers(comp);
                sel = captureSelection(comp);
                var i, layers = [];
                var useSel = sel.length > 0 && !o.all;
                if (useSel) { for (i = 0; i < sel.length; i++) layers.push(sel[i]); }
                else { for (i = 1; i <= comp.numLayers; i++) layers.push(comp.layer(i)); }

                var out = {
                    version: VERSION,
                    comp: { id: comp.id, name: comp.name, width: comp.width, height: comp.height,
                        fps: r4(1 / comp.frameDuration), duration: r4(comp.duration),
                        workAreaStart: r4(comp.workAreaStart), workAreaDuration: r4(comp.workAreaDuration), time: r4(comp.time) },
                    sampleTime: r4(t), fromSelection: useSel, layers: []
                };

                H = createHelper(comp);
                for (i = 0; i < layers.length; i++) {
                    var L = layers[i];
                    try {
                        if (L.name === HELPER_NAME) continue;
                        out.layers.push(layerInfo(H, L, t));
                    } catch (e) {
                        var rec = { index: -1, id: -1, name: "?", kind: "other", is3D: false, supported: false, reason: "read error: " + e };
                        try { rec.index = L.index; rec.id = L.id; rec.name = L.name; } catch (e3) { }
                        out.layers.push(rec);
                    }
                }
                result = J.stringify(out);
            } catch (eIn) {
                result = "ERR: " + eIn;
            }
            removeHelper(H); H = null;
            restoreSelection(comp, sel);
            app.endUndoGroup();
            return result;
        } catch (e2) {
            try { removeHelper(H); } catch (e4) { }
            try { if (comp) restoreSelection(comp, sel); } catch (e5) { }
            try { app.endUndoGroup(); } catch (e6) { }
            return "ERR: " + e2;
        }
    }

    function findLayer(comp, id, index) {
        for (var i = 1; i <= comp.numLayers; i++) { if (comp.layer(i).id === id) return comp.layer(i); }
        if (index >= 1 && index <= comp.numLayers) return comp.layer(index);
        return null;
    }

    function sampleTransforms(json) {
        var comp, sel = [], H = null, result;
        try {
            var o = J.parse(json);
            comp = activeComp();
            if (!comp) return "ERR: Open a composition first.";
            var ids = o.ids || [];
            var count = Math.max(0, Math.round(num(o.count, 0)));
            var fps = num(o.fps, 1 / comp.frameDuration);
            var start = num(o.start, comp.workAreaStart);
            if (!(fps > 0)) fps = 1 / comp.frameDuration;

            app.beginUndoGroup("Isaac3D: Sample transforms");
            try {
                removeStaleHelpers(comp);
                sel = captureSelection(comp);
                var out = { samples: {} };
                H = createHelper(comp);
                for (var i = 0; i < ids.length; i++) {
                    var L = findLayer(comp, ids[i], -1);
                    if (!L || L.name === HELPER_NAME) continue;
                    var os = [], axs = [], ays = [], azs = [];
                    try {
                        setExprs(H, basisExprs(L.index, !!L.threeDLayer));
                        for (var f = 0; f < count; f++) {
                            var t = start + f / fps;
                            os.push(r4a(readN(H, 0, 3, t)));
                            axs.push(rSa(readN(H, 3, 3, t)));
                            ays.push(rSa(readN(H, 6, 3, t)));
                            azs.push(rSa(readN(H, 9, 3, t)));
                        }
                    } catch (eL) {
                        // Pad with identity so the client always gets `count` frames.
                        while (os.length < count) {
                            os.push([0, 0, 0]); axs.push([1, 0, 0]); ays.push([0, 1, 0]); azs.push([0, 0, 1]);
                        }
                    }
                    out.samples[ids[i]] = { o: os, ax: axs, ay: ays, az: azs };
                }
                result = J.stringify(out);
            } catch (eIn) {
                result = "ERR: " + eIn;
            }
            removeHelper(H); H = null;
            restoreSelection(comp, sel);
            app.endUndoGroup();
            return result;
        } catch (e) {
            try { removeHelper(H); } catch (e4) { }
            try { if (comp) restoreSelection(comp, sel); } catch (e5) { }
            try { app.endUndoGroup(); } catch (e6) { }
            return "ERR: " + e;
        }
    }

    // ---------- bake ----------
    function clearKeys(prop, t0, t1) {
        for (var k = prop.numKeys; k >= 1; k--) {
            var kt = prop.keyTime(k);
            if (kt >= t0 && kt <= t1) prop.removeKey(k);
        }
    }
    function zeroTangent(prop) {
        try {
            if (prop.propertyValueType === PropertyValueType.ThreeD_SPATIAL || prop.propertyValueType === PropertyValueType.ThreeD) return [0, 0, 0];
        } catch (e) { }
        return [0, 0];
    }
    function linearize(prop, t0, t1, spatial) {
        var zt = spatial ? zeroTangent(prop) : null;
        for (var k = 1; k <= prop.numKeys; k++) {
            var kt = prop.keyTime(k);
            if (kt < t0 || kt > t1) continue;
            try { prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR); } catch (e1) { }
            if (spatial) {
                try {
                    prop.setSpatialAutoBezierAtKey(k, false);
                    prop.setSpatialContinuousAtKey(k, false);
                    prop.setSpatialTangentsAtKey(k, zt, zt);
                } catch (e2) { }
            }
        }
    }
    function muteExpression(prop) {
        try { if (prop.canSetExpression && prop.expression && prop.expression.length) prop.expressionEnabled = false; } catch (e) { }
    }
    function writeKeys(prop, times, values, t0, t1, o, spatial) {
        muteExpression(prop);
        if (o.clearRange !== false) clearKeys(prop, t0, t1);
        prop.setValuesAtTimes(times, values);
        if (o.linear !== false) linearize(prop, t0, t1, spatial);
    }
    function zeroOrientation(prop, times, t0, t1, o) {
        muteExpression(prop);
        if (o.clearRange !== false) clearKeys(prop, t0, t1);
        var n = 0;
        try { n = prop.numKeys; } catch (e0) { }
        if (n > 0) {
            var zs = [];
            for (var i = 0; i < times.length; i++) zs.push([0, 0, 0]);
            prop.setValuesAtTimes(times, zs);
            if (o.linear !== false) linearize(prop, t0, t1, false);
            return times.length;
        }
        prop.setValue([0, 0, 0]);
        return 0;
    }
    function pushFrame(S, fi, start, fps, bx, by, bz, brx, bry, brz) {
        S.times.push(start + fi / fps);
        S.p3.push([bx[fi], by[fi], bz[fi]]); S.p2.push([bx[fi], by[fi]]);
        S.xs.push(bx[fi]); S.ys.push(by[fi]); S.zs.push(bz[fi]);
        S.rxs.push(brx[fi]); S.rys.push(bry[fi]); S.rzs.push(brz[fi]);
    }
    function arrOr(a, n) {
        if (a && a.length >= n) return a;
        var z = []; for (var i = 0; i < n; i++) z.push((a && typeof a[i] === "number") ? a[i] : 0);
        return z;
    }
    function bakeObj(o) {
        var comp = activeComp();
        if (!comp) return "ERR: Open a composition first.";
        if (!o || !o.bodies) return "ERR: bake payload has no bodies.";
        var fps = num(o.fps, 1 / comp.frameDuration), start = num(o.start, 0), step = Math.max(1, Math.round(o.step || 1));
        if (!(fps > 0)) fps = 1 / comp.frameDuration;
        var baked = 0, keys = 0, errs = [];
        app.beginUndoGroup("Isaac3D: Bake");
        try {
            for (var b = 0; b < o.bodies.length; b++) {
                var body = o.bodies[b];
                var L = findLayer(comp, body.id, body.index);
                if (!L) { errs.push("layer not found: " + body.name); continue; }
                try {
                    var n = body.x.length, f;
                    var bx = arrOr(body.x, n), by = arrOr(body.y, n), bz = arrOr(body.z, n);
                    var brx = arrOr(body.rx, n), bry = arrOr(body.ry, n), brz = arrOr(body.rz || body.r, n);
                    var S = { times: [], p3: [], p2: [], xs: [], ys: [], zs: [], rxs: [], rys: [], rzs: [] };
                    for (f = 0; f < n; f += step) pushFrame(S, f, start, fps, bx, by, bz, brx, bry, brz);
                    if (n > 0 && (n - 1) % step !== 0) pushFrame(S, n - 1, start, fps, bx, by, bz, brx, bry, brz);
                    var times = S.times, p3 = S.p3, p2 = S.p2, xs = S.xs, ys = S.ys, zs = S.zs, rxs = S.rxs, rys = S.rys, rzs = S.rzs;
                    if (!times.length) { errs.push(L.name + ": no frames"); continue; }
                    var t0 = times[0] - 0.5 / fps, t1 = times[times.length - 1] + 0.5 / fps;

                    if (o.unparent !== false && L.parent) L.parent = null;
                    if (o.make3D !== false && !L.threeDLayer) {
                        try { L.threeDLayer = true; } catch (e3d) { errs.push(L.name + ": could not make 3D: " + e3d); }
                    }
                    var is3D = !!L.threeDLayer;
                    var g = xg(L);
                    var pos = g.property("ADBE Position");
                    var sep = false;
                    try { sep = !!pos.dimensionsSeparated; } catch (eS) { }

                    if (is3D) {
                        var ori = g.property("ADBE Orientation");
                        if (ori) keys += zeroOrientation(ori, times, t0, t1, o);
                        if (sep) {
                            writeKeys(g.property("ADBE Position_0"), times, xs, t0, t1, o, false);
                            writeKeys(g.property("ADBE Position_1"), times, ys, t0, t1, o, false);
                            var pz = g.property("ADBE Position_2");
                            if (pz) writeKeys(pz, times, zs, t0, t1, o, false);
                        } else {
                            writeKeys(pos, times, p3, t0, t1, o, true);
                        }
                        keys += times.length;
                        if (o.bakeRotation !== false) {
                            var rx = g.property("ADBE Rotate X"), ry = g.property("ADBE Rotate Y"), rz = g.property("ADBE Rotate Z");
                            if (rx) { writeKeys(rx, times, rxs, t0, t1, o, false); keys += times.length; }
                            if (ry) { writeKeys(ry, times, rys, t0, t1, o, false); keys += times.length; }
                            if (rz) { writeKeys(rz, times, rzs, t0, t1, o, false); keys += times.length; }
                        }
                    } else {
                        if (sep) {
                            writeKeys(g.property("ADBE Position_0"), times, xs, t0, t1, o, false);
                            writeKeys(g.property("ADBE Position_1"), times, ys, t0, t1, o, false);
                        } else {
                            writeKeys(pos, times, p2, t0, t1, o, true);
                        }
                        keys += times.length;
                        if (o.bakeRotation !== false) {
                            var rot = g.property("ADBE Rotate Z");
                            if (rot) { writeKeys(rot, times, rzs, t0, t1, o, false); keys += times.length; }
                        }
                    }
                    baked++;
                } catch (eL) { errs.push(L.name + ": " + eL); }
            }
        } catch (e) { errs.push(String(e)); }
        app.endUndoGroup();
        var msg = "OK: Baked " + baked + " layer(s), " + keys + " keyframes.";
        if (errs.length) msg += " Issues: " + errs.join(" | ");
        return msg;
    }
    function bake(json) {
        try { return bakeObj(J.parse(json)); } catch (e) { return "ERR: " + e; }
    }
    function tempPath() {
        try {
            var dir = new Folder(Folder.temp.fsName + "/isaac3d");
            if (!dir.exists) dir.create();
            return dir.fsName + "/bake.json";
        } catch (e) { return "ERR: " + e; }
    }
    function bakeFromFile(json) {
        try {
            var path = J.parse(json);
            var f = new File(path);
            if (!f.exists) return "ERR: bake file missing: " + path;
            f.encoding = "UTF-8";
            f.open("r");
            var txt = f.read();
            f.close();
            return bakeObj(J.parse(txt));
        } catch (e) { return "ERR: " + e; }
    }

    function selectLayer(json) {
        try {
            var o = J.parse(json);
            var comp = activeComp();
            if (!comp) return "ERR: no comp";
            for (var i = 1; i <= comp.numLayers; i++) comp.layer(i).selected = false;
            var L = findLayer(comp, o.id, o.index);
            if (L) L.selected = true;
            return "OK";
        } catch (e) { return "ERR: " + e; }
    }
    function setTime(json) {
        try {
            var t = J.parse(json);
            var comp = activeComp();
            if (comp) comp.time = t;
            return "OK";
        } catch (e) { return "ERR: " + e; }
    }
    function ping() { return "PHY3D " + VERSION; }

    return {
        version: VERSION,
        ping: ping,
        getScene: getScene,
        sampleTransforms: sampleTransforms,
        bake: bake,
        bakeFromFile: bakeFromFile,
        tempPath: tempPath,
        selectLayer: selectLayer,
        setTime: setTime
    };
})();
