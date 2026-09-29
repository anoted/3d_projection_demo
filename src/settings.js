const KEY = 'offaxis.settings.v1';

export const DEFAULTS = {
  // model
  model: '',
  modelFill: 0.8,
  modelYaw: 0,
  modelSpin: false,
  modelDepth: 0.5, // 0 = at the glass, 1 = at the back wall, < 0 = in front of the glass
  modelLiftMm: 0,

  // tracking
  tracker: 'mouse',
  mouseGain: 1.5,
  autoAmplitude: 0.45,
  autoSpeed: 0.6,
  hfovDeg: 60,
  ipdMm: 63,
  webcamOffsetXMm: 0,
  webcamBezelMm: 10, // camera centre above the top edge of the display
  webcamOffsetZMm: 0,
  webcamTiltDeg: 0,
  showPreview: true,

  // filter
  minCutoff: 0.6,
  beta: 8,
  depthCutoffScale: 0.4, // depth (z) uses minCutoff × this
  holdTime: 0.6,
  returnRate: 2.5,
  defaultEyeZMm: 600,

  // screen
  autoSize: true,
  screenWidthMm: 344,
  screenHeightMm: 194,
  mmPerDevicePx: null, // null = uncalibrated (assume 96 dpi)
  compensateWindow: false,

  // projection
  clampNear: true,
  near: 0.02,
  far: 20,

  // room
  showRoom: true,
  blackWalls: true, // floor, ceiling and side walls black; back wall keeps its own look
  grid: true, // grid on floor/ceiling/side walls when they aren't black
  backWall: 'grid', // 'grid' | 'plain' | 'image'
  backWallFit: 'cover', // 'cover' | 'stretch'
  // Endless back wall: one image copy spans this many window-sizes before it mirror-repeats.
  // ~3× covers everything visible from normal viewing positions.
  backWallImageSize: 3,
  roomDepthMm: 400,

  // view
  debugView: true,
  showHud: true,
};

/** The single saved instance, or null. */
export function readSaved() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Startup settings: defaults, then the saved instance, then URL overrides (e.g. ?tracker=auto). */
export function loadSettings() {
  const s = { ...DEFAULTS, ...readSaved() };
  for (const [k, v] of new URLSearchParams(location.search)) {
    if (!(k in DEFAULTS)) continue;
    const type = typeof DEFAULTS[k];
    s[k] = type === 'number' ? +v : type === 'boolean' ? v !== 'false' && v !== '0' : v;
  }
  return s;
}

/** Overwrites the saved instance. Returns false if storage is unavailable. */
export function saveSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

/**
 * Calibration is a measurement of the hardware, not a preference, so it is written
 * straight into the saved instance without saving anything else.
 */
export function saveCalibration(mmPerDevicePx) {
  saveSettings({ ...(readSaved() ?? {}), mmPerDevicePx });
}

// ---------------------------------------------------------------- back-wall image (IndexedDB: too big for localStorage)
const DB = 'offaxis';
const STORE = 'blobs';

function withStore(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => (db.close(), resolve(req?.result));
      tx.onerror = () => (db.close(), reject(tx.error));
    };
  });
}

export async function readSavedImage() {
  try {
    return (await withStore('readonly', (s) => s.get('backWall'))) ?? null;
  } catch {
    return null;
  }
}

export async function saveImage(blob) {
  try {
    await withStore('readwrite', (s) => (blob ? s.put(blob, 'backWall') : s.delete('backWall')));
  } catch (err) {
    console.warn('Could not store the back-wall image:', err);
  }
}
