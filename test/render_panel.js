/* Render the panel headlessly (no After Effects): loads client/index.html in Chromium with a mocked CEP host that
   serves a synthetic scene (models + a floor + a ramp), then screenshots the panel while stepping the frame slider.
   Used for the README/website demo and for eyeballing UI changes without AE.
   Usage: node test/render_panel.js <outDir> [puppeteer-core dir] [chromium exe]
   Needs puppeteer-core somewhere on disk and a Chromium/Edge binary. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const outDir = process.argv[2] || path.join(__dirname, 'out');
const ppDir = process.argv[3] || 'C:/Users/Mickey/volt-tracker/node_modules/puppeteer-core';
const exe = process.argv[4] || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const C = path.join(__dirname, '..', 'client') + path.sep;
fs.mkdirSync(outDir, { recursive: true });

// ---- 1. parse the sample models in Node so the page does not need file access
global.window = globalThis; global.self = globalThis; global.require = require;
for (const f of ['cannon-es.umd.js', 'geometry.js', 'vendor/three.min.js', 'vendor/fflate.min.js', 'vendor/NURBSUtils.js',
  'vendor/NURBSCurve.js', 'vendor/ConvexHull.js', 'vendor/GLTFLoader.js', 'vendor/OBJLoader.js', 'vendor/FBXLoader.js', 'models.js'])
  vm.runInThisContext(fs.readFileSync(C + f, 'utf8'), { filename: f });
const w0 = console.warn; console.warn = () => {};

const MODEL_FILES = [
  ['Mushroom (glb)', path.join(__dirname, 'models', 'mushroom.glb'), [300, 250, 0], 0.3, [0, 0, 25]],
  ['Teapot (obj)', 'C:/Users/Mickey/Desktop/JamProject/JUCE/extras/AudioPluginHost/Builds/Android/app/src/main/assets/teapot.obj', [1450, 400, 200], 0.022, [15, 30, 0]],
  ['Mushroom (fbx)', 'C:/Users/Mickey/ae-mcp/mushroom.fbx', [800, 150, 250], 0.003, [0, 40, 10]],
].filter(m => fs.existsSync(m[1]));

function basis(scale, rot) {
  const d = Math.PI / 180, [rx, ry, rz] = rot.map(a => a * d);
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  // M = Rx * Ry * Rz (AE order); columns are the transformed axes
  const m = [
    [cy * cz, -cy * sz, sy],
    [sx * sy * cz + cx * sz, -sx * sy * sz + cx * cz, -sx * cy],
    [-cx * sy * cz + sx * sz, cx * sy * sz + sx * cz, cx * cy]];
  const col = i => [m[0][i] * scale, m[1][i] * scale, m[2][i] * scale];
  return { ax: col(0), ay: col(1), az: col(2) };
}
function shapeLayer(id, name, w, h, origin, rotZ) {
  const b = basis(1, [0, 0, rotZ || 0]);
  return { index: id, id, name, enabled: true, supported: true, reason: '', kind: 'shape', is3D: true, inPoint: 0, outPoint: 6, anchor: [0, 0, 0],
    world: { origin, ...b }, hasParent: false, hasKeys: false, hasExpression: false, dimensionsSeparated: false,
    rect: { left: -w / 2, top: -h / 2, width: w, height: h },
    shapes: [{ type: 'rect', xf: [{ anchor: [0, 0], position: [0, 0], scale: [100, 100], rotation: 0 }], size: [w, h], position: [0, 0], roundness: 0 }], masks: [] };
}
const scene = { version: '0.2.0', comp: { id: 1, name: 'Isaac3D demo', width: 1920, height: 1080, fps: 25, duration: 6, workAreaStart: 0, workAreaDuration: 6, time: 0 },
  sampleTime: 0, fromSelection: false, layers: [] };
const models = {};
let id = 1;
const pending = MODEL_FILES.map(([name, file, origin, scale, rot]) => new Promise(res => MODELS.load(file, r => {
  models[file] = r;
  const s = 512, rect = r.ok ? { left: r.min[0] * s, top: r.min[1] * s, width: r.size[0] * s, height: r.size[1] * s } : { left: -50, top: -50, width: 100, height: 100 };
  scene.layers.push({ index: 0, id: 0, name, enabled: true, supported: true, reason: '', kind: 'model', is3D: true, inPoint: 0, outPoint: 6, anchor: [0, 0, 0],
    world: { origin, ...basis(scale, rot) }, hasParent: false, hasKeys: false, hasExpression: false, dimensionsSeparated: false, rect, shapes: [], masks: [], modelFile: file });
  res();
})));

Promise.all(pending).then(async () => {
  scene.layers.push(shapeLayer(0, 'Ramp [STATIC]', 800, 36, [520, 700, 0], 16));
  scene.layers.push(shapeLayer(0, 'Floor [STATIC]', 2600, 30, [960, 1065, 0], 0));
  scene.layers.forEach((l, i) => { l.index = i + 1; l.id = 100 + i; });
  console.warn = w0;
  console.log('scene:', scene.layers.map(l => l.name).join(', '));

  // ---- 2. drive the panel in headless Chromium
  const puppeteer = require(ppDir);
  const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--allow-file-access-from-files', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 480, height: 940, deviceScaleFactor: 2 });
  page.on('pageerror', e => console.log('PAGE ERROR', e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
  await page.evaluateOnNewDocument((scene, models) => {
    window.__adobe_cep__ = {
      evalScript: function (script, cb) {
        setTimeout(function () {
          if (window.MODELS && !window.MODELS.__mocked) {
            window.MODELS.__mocked = true;
            window.MODELS.load = function (p, cb2) { cb2(models[p] || { ok: false, error: 'not in mock' }); };
          }
          if (/^PHY3D\.ping/.test(script)) return cb('PHY3D 0.2.0');
          if (/^PHY3D\.getScene/.test(script)) return cb(JSON.stringify(scene));
          if (/^PHY3D\.sampleTransforms/.test(script)) return cb(JSON.stringify({ samples: {} }));
          if (/^PHY3D\.tempPath/.test(script)) return cb('ERR: no temp in mock');
          if (/^PHY3D\.bake/.test(script)) return cb('OK: Baked 0 layer(s), 0 keyframes (mock).');
          cb('OK');
        }, 0);
      }
    };
  }, scene, models);
  await page.goto('file:///' + C.replace(/\\/g, '/') + 'index.html');
  await page.waitForFunction(() => /frames · \d+ bodies/.test(document.querySelector('#status').textContent), { timeout: 30000 });
  // statics + a nicer default: 3D view for the hero shot
  await page.evaluate(() => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    return (async () => {
      for (const nm of ['Floor', 'Ramp']) {
        const row = Array.from(document.querySelectorAll('.body-row')).find(r => r.querySelector('.name').textContent.startsWith(nm));
        if (!row) continue;
        const sel = row.querySelector('select[data-type]'); sel.value = 'static'; sel.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(50);
      }
    })();
  });
  await page.waitForFunction(() => /frames · \d+ bodies/.test(document.querySelector('#status').textContent), { timeout: 30000 });
  await new Promise(r => setTimeout(r, 600));
  console.log('status:', await page.evaluate(() => document.querySelector('#status').textContent));

  const setFrame = f => page.evaluate(f => { const s = document.querySelector('#frameSlider'); s.value = f; s.dispatchEvent(new Event('input', { bubbles: true })); }, f);
  const setView = v => page.evaluate(v => document.querySelector('[data-view="' + v + '"]').click(), v);

  // hero still: everything open, front view mid-fall, the glb mushroom selected so its model detail shows
  await page.setViewport({ width: 480, height: 1330, deviceScaleFactor: 2 });
  await setView('front'); await setFrame(45);
  await page.evaluate(() => { const row = Array.from(document.querySelectorAll('.body-row')).find(r => r.querySelector('.name .txt').textContent === 'Mushroom (glb)'); if (row) row.click(); });
  await new Promise(r => setTimeout(r, 300));
  await page.screenshot({ path: path.join(outDir, 'hero.png') });

  // demo sequence: World + Blasts collapsed so preview, bodies and bake fit in one panel height
  await page.evaluate(() => { const row = Array.from(document.querySelectorAll('.body-row')).find(r => r.querySelector('.name .txt').textContent === 'Mushroom (glb)'); if (row) row.click(); });
  await page.evaluate(() => ['worldCard', 'blastCard'].forEach(id => document.getElementById(id).classList.add('collapsed')));
  await page.setViewport({ width: 480, height: 1010, deviceScaleFactor: 2 });
  await new Promise(r => setTimeout(r, 300));
  let n = 0;
  for (const [view, step] of [['front', 2], ['side', 4]]) {
    await setView(view);
    for (let f = 0; f <= 149; f += step) {
      await setFrame(f);
      await page.screenshot({ path: path.join(outDir, 'f_' + String(n++).padStart(4, '0') + '.png') });
    }
  }
  console.log('frames:', n, '->', outDir);
  await browser.close();
}).catch(e => { console.error(e); process.exit(1); });
