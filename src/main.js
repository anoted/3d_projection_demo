import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import GUI from 'lil-gui';
import { OffAxisScreen, updateOffAxisCamera } from './offaxis.js';
import { AlignmentBox } from './AlignmentBox.js';
import { DebugView } from './DebugView.js';
import { HeadFilter } from './HeadFilter.js';
import { ModelStage, TEST_OBJECTS } from './ModelStage.js';
import { MouseTracker } from './eye/mouse.js';
import { AutoTracker } from './eye/orbit.js';
import { FaceTracker } from './eye/face.js';
import { openCalibration } from './Calibration.js';
import { DEFAULTS, loadSettings, readSaved, readSavedImage, saveCalibration, saveImage, saveSettings } from './settings.js';

const settings = loadSettings();

// ---------------------------------------------------------------- models
// Every .glb under /models is picked up automatically.
const modelUrls = import.meta.glob('../models/**/*.glb', { query: '?url', import: 'default', eager: true });
const models = Object.entries(modelUrls)
  .map(([path, url]) => {
    const file = path.split('/').pop().replace(/\.glb$/i, '');
    const label = file.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    return { key: path.replace('../models/', ''), url, label: label[0].toUpperCase() + label.slice(1) };
  })
  .sort((a, b) => a.label.localeCompare(b.label));
const modelOptions = Object.fromEntries([...models.map((m) => [m.label, m.key]), ['Depth test objects', TEST_OBJECTS]]);
if (!Object.values(modelOptions).includes(settings.model)) {
  settings.model = (models.find((m) => /panda/i.test(m.key)) ?? models[0])?.key ?? TEST_OBJECTS;
}

// ---------------------------------------------------------------- renderer & scene
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false; // updated once per frame, not once per viewport
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d12); // solid colour: a skybox would show no parallax
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;

const screenObj = new OffAxisScreen();
scene.add(screenObj);

const room = new AlignmentBox();
screenObj.add(room);

const stage = new ModelStage();
screenObj.add(stage);

const hemi = new THREE.HemisphereLight(0xffffff, 0x3a3228, 0.7);
screenObj.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.002;
screenObj.add(sun, sun.target);

// The off-axis camera lives at the scene root; its projection is written by hand every frame.
const camera = new THREE.PerspectiveCamera();

const debugView = new DebugView(renderer, scene, screenObj);
const headFilter = new HeadFilter();

// ---------------------------------------------------------------- physical sizing
const mmPerCssPx = () => (settings.mmPerDevicePx ? settings.mmPerDevicePx * devicePixelRatio : 25.4 / 96);

function roomDims() {
  return { width: screenObj.width, height: screenObj.height, depth: settings.roomDepthMm / 1000 };
}

let cImageSize = null; // GUI controller, only meaningful for the endless back wall

function applyLayout() {
  if (settings.autoSize) {
    settings.screenWidthMm = +(canvas.clientWidth * mmPerCssPx()).toFixed(1);
    settings.screenHeightMm = +(canvas.clientHeight * mmPerCssPx()).toFixed(1);
  }
  screenObj.setSize(settings.screenWidthMm / 1000, settings.screenHeightMm / 1000);
  const dims = roomDims();
  room.visible = settings.showRoom;
  room.update(dims.width, dims.height, dims.depth, {
    blackWalls: settings.blackWalls,
    sideGrid: settings.grid,
    back: settings.backWall,
    image: backWallImage?.texture ?? null,
    imageFit: settings.backWallFit,
    imageSize: settings.backWallImageSize,
  });
  cImageSize?.enable(settings.blackWalls);
  stage.layout(dims, settings);

  // key light: above and in front of the opening, aimed at the middle of the floor
  const { width: w, height: h, depth: D } = dims;
  sun.position.set(w * 0.3, h / 2 + 0.35, 0.35);
  sun.target.position.set(0, -h / 2, -D / 2);
  const ext = Math.max(w, h, D) * 1.2;
  Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 0.05, far: 3 });
  sun.shadow.camera.updateProjectionMatrix(); // shadow cameras are independent of the view camera
}

function onResize() {
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  debugView.layout();
  applyLayout(); // screen size changes; the next frame recomputes the frustum
}
window.addEventListener('resize', onResize);
document.addEventListener('fullscreenchange', onResize);

/** Webcam position in screen-local meters (the screen being the canvas). */
const webcamLocal = new THREE.Vector3();
function computeWebcamLocal() {
  const mm = mmPerCssPx() / 1000;
  let cx = 0, cy = 0, displayH = screenObj.height;
  if (settings.compensateWindow && !document.fullscreenElement) {
    // Canvas centre relative to the physical display centre (approximate: assumes all
    // browser chrome sits above the page).
    const s = window.screen;
    const left = window.screenX - (s.left ?? s.availLeft ?? 0);
    const top = window.screenY - (s.top ?? s.availTop ?? 0);
    const canvasCx = left + (window.outerWidth - window.innerWidth) / 2 + canvas.clientWidth / 2;
    const canvasCy = top + (window.outerHeight - window.innerHeight) + canvas.clientHeight / 2;
    cx = -(canvasCx - s.width / 2) * mm;
    cy = (canvasCy - s.height / 2) * mm;
    displayH = s.height * mm;
  }
  webcamLocal.set(
    cx + settings.webcamOffsetXMm / 1000,
    cy + displayH / 2 + settings.webcamBezelMm / 1000,
    settings.webcamOffsetZMm / 1000,
  );
}

// ---------------------------------------------------------------- back-wall image
/** { blob, texture } – the blob is kept so Save can store it. */
let backWallImage = null;

async function setBackWallImage(blob) {
  let next = null;
  if (blob) {
    const url = URL.createObjectURL(blob);
    try {
      const texture = await new THREE.TextureLoader().loadAsync(url);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      next = { blob, texture };
    } catch (err) {
      console.warn('Could not read that image:', err);
      return false;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  backWallImage?.texture.dispose();
  backWallImage = next;
  applyLayout();
  return true;
}

function chooseBackWallImage() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file || !(await setBackWallImage(file))) return;
    settings.backWall = 'image';
    refreshGui();
    applyLayout();
    markDirty();
  });
  input.click();
}

// ---------------------------------------------------------------- trackers
const trackers = {
  mouse: new MouseTracker(canvas, screenObj),
  auto: new AutoTracker(screenObj),
  face: new FaceTracker(),
};
let tracker = trackers.mouse;

function setTracker(mode) {
  tracker.stop?.();
  tracker = trackers[mode] ?? trackers.mouse;
  tracker.start?.().catch((err) => console.warn('Tracker failed to start:', err));
}

// ---------------------------------------------------------------- model selection
function showModel(key) {
  const m = models.find((x) => x.key === key);
  stage.show(key, m?.url, m?.label ?? 'Depth test objects');
}

function stepModel(dir) {
  const keys = Object.values(modelOptions);
  const i = keys.indexOf(settings.model);
  settings.model = keys[(i + dir + keys.length) % keys.length];
  showModel(settings.model);
}

// ---------------------------------------------------------------- GUI
const gui = new GUI({ title: 'Off-axis projection' });
gui.onChange(() => markDirty());
const refreshGui = () => gui.controllersRecursive().forEach((c) => c.updateDisplay());

const fModel = gui.addFolder('Model');
fModel.add(settings, 'model', modelOptions).name('View').onChange(showModel);
fModel.add(settings, 'modelFill', 0.2, 1.5, 0.01).name('Size').onChange(applyLayout);
fModel.add(settings, 'modelDepth', -0.5, 1, 0.01).name('Depth (0 glass, 1 back)').onChange(applyLayout);
fModel.add(settings, 'modelLiftMm', 0, 200, 1).name('Lift (mm)').onChange(applyLayout);
fModel.add(settings, 'modelYaw', -180, 180, 1).name('Rotate (°)');
fModel.add(settings, 'modelSpin').name('Spin');

const fTrack = gui.addFolder('Head tracking');
fTrack.add(settings, 'tracker', { 'Mouse (x/y, wheel = z)': 'mouse', 'Auto orbit': 'auto', 'Webcam face': 'face' }).name('Source').onChange(setTracker);
fTrack.add(settings, 'mouseGain', 0.5, 4, 0.1).name('Mouse gain');
fTrack.add(settings, 'autoAmplitude', 0, 1.5, 0.01).name('Orbit amplitude');
fTrack.add(settings, 'autoSpeed', 0, 3, 0.01).name('Orbit speed');
const fCam = fTrack.addFolder('Webcam').close();
fCam.add(settings, 'hfovDeg', 30, 110, 0.5).name('Horizontal FOV (°)');
fCam.add(settings, 'ipdMm', 50, 75, 0.5).name('Your IPD (mm)');
fCam.add(settings, 'webcamOffsetXMm', -400, 400, 1).name('Offset X (mm)');
fCam.add(settings, 'webcamBezelMm', -100, 150, 1).name('Above top edge (mm)');
fCam.add(settings, 'webcamOffsetZMm', -100, 100, 1).name('Offset Z (mm)');
fCam.add(settings, 'webcamTiltDeg', -30, 30, 0.5).name('Tilt down (°)');

const fFilter = gui.addFolder('Filter').close();
fFilter.add(settings, 'minCutoff', 0.05, 10, 0.05).name('Min cutoff (Hz)');
fFilter.add(settings, 'depthCutoffScale', 0.05, 1, 0.05).name('Depth cutoff ×');
fFilter.add(settings, 'beta', 0, 60, 0.5).name('Speed coefficient β');
fFilter.add(settings, 'holdTime', 0, 3, 0.05).name('Hold on loss (s)');
fFilter.add(settings, 'returnRate', 0.2, 10, 0.1).name('Return speed');
fFilter.add(settings, 'defaultEyeZMm', 200, 1500, 10).name('Default eye dist (mm)');

const fScreen = gui.addFolder('Screen');
fScreen.add(settings, 'autoSize').name('Size from calibration').onChange(() => {
  syncScreenControls();
  applyLayout();
});
const cW = fScreen.add(settings, 'screenWidthMm', 50, 3000, 0.5).name('Width (mm)').onChange(applyLayout).listen();
const cH = fScreen.add(settings, 'screenHeightMm', 50, 2000, 0.5).name('Height (mm)').onChange(applyLayout).listen();
fScreen.add({ calibrate }, 'calibrate').name('Calibrate with a card…');
fScreen.add(settings, 'compensateWindow').name('Compensate window position');
function syncScreenControls() {
  cW.disable(settings.autoSize);
  cH.disable(settings.autoSize);
}
syncScreenControls();

const fProj = gui.addFolder('Projection').close();
fProj.add(settings, 'clampNear').name('Clamp near to glass');
fProj.add(settings, 'near', 0.001, 0.5, 0.001).name('Near (m, unclamped)');
fProj.add(settings, 'far', 1, 100, 1).name('Far (m)');

const fRoom = gui.addFolder('Room');
fRoom.add(settings, 'showRoom').name('Show room').onChange(applyLayout);
fRoom.add(settings, 'blackWalls').name('Black walls (endless back wall)').onChange(applyLayout);
fRoom.add(settings, 'grid').name('Grid on other walls').onChange(applyLayout);
fRoom.add(settings, 'backWall', { Grid: 'grid', Plain: 'plain', Image: 'image' }).name('Back wall').onChange((v) => {
  if (v === 'image' && !backWallImage) chooseBackWallImage();
  applyLayout();
});
fRoom.add({ chooseBackWallImage }, 'chooseBackWallImage').name('Choose back-wall image…');
fRoom.add(settings, 'backWallFit', { 'Cover (crop)': 'cover', Stretch: 'stretch' }).name('Image fit').onChange(applyLayout);
cImageSize = fRoom.add(settings, 'backWallImageSize', 1, 8, 0.1).name('Image size (× window)').onChange(applyLayout);
cImageSize.enable(settings.blackWalls);
fRoom.add(settings, 'roomDepthMm', 50, 1500, 5).name('Depth (mm)').onChange(applyLayout);

const fView = gui.addFolder('View');
fView.add(settings, 'debugView').name('Debug view (D)').onChange((v) => debugView.setEnabled(v));
fView.add(settings, 'showHud').name('HUD (H)');
fView.add(settings, 'showPreview').name('Webcam view (W)');
fView.add({ toggleFullscreen }, 'toggleFullscreen').name('Fullscreen (F)');

// Settings live-apply as you change them; only Save persists them.
// There is one saved instance, plus the built-in defaults.
const fSave = gui.addFolder('Settings');
fSave.add({ save: saveCurrent }, 'save').name('Save');
fSave.add({ load: loadSaved }, 'load').name('Revert to saved');
fSave.add({ reset: resetSettings }, 'reset').name('Reset to defaults');
let dirty = false;
function markDirty() {
  dirty = true;
  updateSaveTitle();
}
function updateSaveTitle(note) {
  fSave.title(note ?? (dirty ? 'Settings · unsaved changes' : readSaved() ? 'Settings · saved' : 'Settings · defaults'));
}
updateSaveTitle();

async function calibrate() {
  const value = await openCalibration(mmPerCssPx());
  if (value) {
    settings.mmPerDevicePx = value;
    settings.autoSize = true;
    syncScreenControls();
    refreshGui();
    applyLayout();
    saveCalibration(value); // kept even if the rest isn't saved
    updateSaveTitle();
  }
}

async function saveCurrent() {
  const ok = saveSettings(settings);
  await saveImage(backWallImage?.blob ?? null);
  dirty = !ok;
  updateSaveTitle(ok ? undefined : 'Settings · could not save (storage blocked)');
}

async function loadSaved() {
  await applySettings({ ...DEFAULTS, ...readSaved() }, await readSavedImage());
  dirty = false;
  updateSaveTitle();
}

async function resetSettings() {
  // calibration describes the hardware, so defaults keep it
  await applySettings({ ...DEFAULTS, mmPerDevicePx: settings.mmPerDevicePx }, null);
  markDirty();
}

/** Apply a whole settings object (plus back-wall image) to the running app. */
async function applySettings(next, imageBlob) {
  const prev = { ...settings };
  Object.assign(settings, next);
  if (!Object.values(modelOptions).includes(settings.model)) settings.model = prev.model;
  refreshGui();
  syncScreenControls();
  debugView.setEnabled(settings.debugView);
  if (settings.tracker !== prev.tracker) setTracker(settings.tracker);
  if (settings.model !== prev.model) showModel(settings.model);
  if (imageBlob !== backWallImage?.blob) await setBackWallImage(imageBlob);
  applyLayout();
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
}

window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'f') toggleFullscreen();
  else if (k === 'd') debugView.setEnabled((settings.debugView = !settings.debugView));
  else if (k === 'h') settings.showHud = !settings.showHud;
  else if (k === 'w') settings.showPreview = !settings.showPreview;
  else if (k === 'g') gui.show(gui._hidden);
  else if (k === 'c') calibrate();
  else if (k === '[') stepModel(-1);
  else if (k === ']') stepModel(1);
  else if (k === '1' || k === '2' || k === '3') {
    settings.tracker = ['mouse', 'auto', 'face'][+k - 1];
    setTracker(settings.tracker);
  } else return;
  refreshGui();
  markDirty();
});

// ---------------------------------------------------------------- HUD
const hud = document.getElementById('hud');
let hudTimer = 1; // draw on the first frame
const cm = (v) => (v * 100).toFixed(1).padStart(6);
function updateHud(dt, near) {
  hud.hidden = !settings.showHud;
  if ((hudTimer += dt) < 0.12 || hud.hidden) return;
  hudTimer = 0;
  const e = headFilter.eye;
  const calib = settings.mmPerDevicePx ? 'calibrated' : 'uncalibrated · press C';
  const loading = stage.progress != null ? ` · ${Math.round(stage.progress * 100)}%` : '';
  hud.innerHTML = [
    ['Tracker', `${settings.tracker} · ${tracker.status ?? ''} · ${headFilter.state}`],
    ['Eye', `x${cm(e.x)}  y${cm(e.y)}  z${cm(e.z)} cm`],
    ['Screen', `${settings.screenWidthMm.toFixed(0)} × ${settings.screenHeightMm.toFixed(0)} mm · ${settings.autoSize ? calib : 'manual'}`],
    ['Near', settings.clampNear ? `clamped to glass (${cm(near)} cm)` : `${cm(near)} cm · pop-out allowed`],
    ['Model', `${stage.status}${loading}`],
  ].map(([k, v]) => `<div><b>${k}</b><span>${v}</span></div>`).join('')
    + '<div class="keys">[ ] model · 1 2 3 tracker · C calibrate · F fullscreen · D debug · W webcam · G panel</div>';
}

// ---------------------------------------------------------------- frame loop
const timer = new THREE.Timer();
timer.connect(document);
const eyeWorld = new THREE.Vector3();
const webcamWorld = new THREE.Vector3();

function frame(timestamp) {
  timer.update(timestamp);
  const dt = Math.min(timer.getDelta(), 0.1);

  computeWebcamLocal();
  tracker.update(dt, { settings, webcamPos: webcamLocal });
  const eye = headFilter.update(tracker, dt, settings);

  screenObj.updateMatrixWorld();
  eyeWorld.copy(eye);
  screenObj.localToWorld(eyeWorld);
  const near = settings.clampNear ? Math.max(eye.z - 0.0005, 0.001) : settings.near;
  updateOffAxisCamera(camera, screenObj, eyeWorld, near, Math.max(settings.far, near + 0.01));

  stage.tick(dt, settings);

  if (settings.debugView) {
    webcamWorld.copy(webcamLocal);
    screenObj.localToWorld(webcamWorld);
    debugView.update(eyeWorld, near, eye.z + settings.roomDepthMm / 1000, webcamWorld);
  }

  renderer.shadowMap.needsUpdate = true;
  renderer.setViewport(0, 0, canvas.clientWidth, canvas.clientHeight);
  renderer.render(scene, camera);
  debugView.render();

  updateHud(dt, near);
}

// ---------------------------------------------------------------- start
onResize();
debugView.setEnabled(settings.debugView);
showModel(settings.model);
setTracker(settings.tracker);
renderer.setAnimationLoop(frame);
readSavedImage().then((blob) => blob && setBackWallImage(blob));
