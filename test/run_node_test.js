/* Headless smoke test: parse 3D model files with client/models.js, drop them onto a floor with client/sim3d.js.
   Usage:  node test/run_node_test.js [model files...]      (defaults to test/models/mushroom.glb)
   Prints parsed bounds / hull / wireframe stats and the resting position of every body after 5 seconds. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const C = path.join(__dirname, '..', 'client') + path.sep;
global.window = globalThis; global.self = globalThis; global.require = require;
for (const f of ['cannon-es.umd.js', 'geometry.js', 'vendor/three.min.js', 'vendor/fflate.min.js', 'vendor/NURBSUtils.js',
  'vendor/NURBSCurve.js', 'vendor/ConvexHull.js', 'vendor/GLTFLoader.js', 'vendor/OBJLoader.js', 'vendor/FBXLoader.js',
  'models.js', 'sim3d.js']) vm.runInThisContext(fs.readFileSync(C + f, 'utf8'), { filename: f });
const warn = console.warn; console.warn = () => {};

const files = process.argv.slice(2);
if (!files.length) files.push(path.join(__dirname, 'models', 'mushroom.glb'));

function modelLayer(id, file, x) {
  // a model layer as the host would report it: rect is filled in from the parsed bounds (AE draws 1 unit = 512 px)
  return { index: id, id, name: path.basename(file), supported: true, kind: 'model', is3D: true, anchor: [0, 0, 0],
    world: { origin: [x, 500, 0], ax: [0.3, 0, 0], ay: [0, 0.3, 0], az: [0, 0, 0.3] }, rect: null, shapes: [], masks: [], modelFile: file };
}
function shapeLayer(id, name, w, h, origin) {
  return { index: id, id, name, supported: true, kind: 'shape', is3D: true, anchor: [0, 0, 0],
    world: { origin, ax: [1, 0, 0], ay: [0, 1, 0], az: [0, 0, 1] }, rect: { left: -w / 2, top: -h / 2, width: w, height: h },
    shapes: [{ type: 'rect', xf: [], size: [w, h], position: [0, 0], roundness: 0 }], masks: [] };
}
const scene = { comp: { width: 1920, height: 1080, fps: 25, duration: 10 }, layers: [] };
files.forEach((f, i) => scene.layers.push(modelLayer(i + 1, path.resolve(f), 300 + i * 450)));
scene.layers.push(shapeLayer(99, 'Floor', 2600, 30, [960, 1065, 0]));

MODELS.prepare(scene, () => {
  let failed = 0;
  scene.layers.filter(l => l.kind === 'model').forEach(l => {
    const M = l.model;
    if (!M.ok) { failed++; console.log('FAIL', l.name, M.error); return; }
    const s = 512, sc = 300 / (M.size[1] * s);   // layer scale so every model stands ~300 px tall (FBX in cm is 100x)
    l.rect = { left: M.min[0] * s, top: M.min[1] * s, width: M.size[0] * s, height: M.size[1] * s };
    l.world = { origin: l.world.origin, ax: [sc, 0, 0], ay: [0, sc, 0], az: [0, 0, sc] };
    console.log('OK  ', l.name, `${M.format} · ${M.vertexCount} verts / ${M.triCount} tris · size ${M.size.map(v => v.toFixed(3)).join(' x ')} units` +
      ` · hull ${M.hull ? M.hull.verts.length + 'v/' + M.hull.faces.length + 'f' : '-'} · preview ${M.mesh.verts.length}v/${M.mesh.edges.length}e${M.mesh.clustered ? ' (clustered)' : ''}`);
  });
  const cfgs = {};
  scene.layers.forEach(l => { cfgs[l.id] = SIM3D.defaultBody(l); if (l.kind === 'shape') cfgs[l.id].type = 'static'; });
  const t0 = Date.now();
  const r = SIM3D.run(scene, { world: SIM3D.defaultWorld(), start: 0, count: 125, fps: 25, bodies: cfgs, kinematic: {}, blasts: [] });
  console.log(`sim: ${r.bodyCount} bodies, 125 frames, ${Date.now() - t0} ms`);
  r.bodies.filter(b => b.type === 'dynamic').forEach(b => {
    const f = 124;
    console.log(`  ${b.name}: rest at ${[b.x[f], b.y[f], b.z[f]].map(Math.round).join(', ')}  rot ${[b.rx[f], b.ry[f], b.rz[f]].map(Math.round).join(', ')}  body ${b.geom.mode}`);
  });
  process.exit(failed ? 1 : 0);
});
setTimeout(() => { console.log('timeout'); process.exit(1); }, 60000);
