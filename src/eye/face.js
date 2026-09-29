import * as THREE from 'three';
// Self-hosted MediaPipe runtime (bundled by Vite) – no CDN version drift.
import wasmLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';

const MODEL_URL = `${import.meta.env.BASE_URL}face_landmarker.task`;
const IRIS_A = 468; // iris centre landmarks in the 478-point mesh
const IRIS_B = 473;
const LOCK_RADIUS = 0.15; // normalised image distance to keep the same face
const LOCK_PATIENCE = 12; // frames the locked face may be missing before re-acquiring
const X_AXIS = new THREE.Vector3(1, 0, 0);

/**
 * Webcam head tracker (MediaPipe Face Landmarker).
 * Eye = midpoint of the two iris centres; depth from interpupillary distance.
 * Output in screen-local meters.
 */
export class FaceTracker {
  constructor() {
    this.eye = new THREE.Vector3();
    this.isTracking = false;
    this.sampleId = 0;
    this.status = 'idle';
    this.running = false;
    this.generation = 0;
    this.lock = null;
    this.missed = 0;
    this.candidates = [];
    this.chosen = null;
    this.lastVideoTime = -1;

    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;

    this.preview = document.createElement('canvas');
    this.preview.className = 'webcam-preview';
    this.preview.width = 240;
    this.preview.height = 135;
    this.preview.hidden = true;
    document.body.appendChild(this.preview);
    this._v = new THREE.Vector3();
  }

  async start() {
    const gen = ++this.generation;
    const stale = () => gen !== this.generation;
    try {
      this.status = 'loading face model…';
      if (!this.landmarker) {
        const { FaceLandmarker } = await import('@mediapipe/tasks-vision');
        const fileset = { wasmLoaderPath: wasmLoaderUrl, wasmBinaryPath: wasmBinaryUrl };
        const make = (delegate) => FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate },
          runningMode: 'VIDEO',
          numFaces: 4,
        });
        this.landmarker = await make('GPU').catch(() => make('CPU'));
      }
      if (stale()) return;
      this.status = 'waiting for camera permission…';
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      if (stale()) return stream.getTracks().forEach((t) => t.stop());
      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play();
      this.running = true;
      this.status = 'looking for a face';
    } catch (err) {
      if (!stale()) this.status = `error: ${err.message || err}`;
      throw err;
    }
  }

  stop() {
    this.generation++;
    this.running = false;
    this.isTracking = false;
    this.lock = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.preview.hidden = true;
    this.status = 'stopped';
  }

  update(dt, { settings, webcamPos }) {
    this.preview.hidden = !(this.running && settings.showPreview);
    if (!this.running || this.video.readyState < 2) return;
    if (this.video.currentTime === this.lastVideoTime) return; // no new frame yet
    this.lastVideoTime = this.video.currentTime;

    const W = this.video.videoWidth, H = this.video.videoHeight;
    const res = this.landmarker.detectForVideo(this.video, performance.now());
    this.candidates = res.faceLandmarks.map((lm) => {
      const a = lm[IRIS_A], b = lm[IRIS_B];
      return {
        u: (a.x + b.x) / 2, // normalised image coords
        v: (a.y + b.y) / 2,
        ipdPx: Math.hypot((a.x - b.x) * W, (a.y - b.y) * H),
        a, b,
      };
    });

    this.chosen = this._choose();
    if (this.chosen) {
      const c = this.chosen;
      const f = (W / 2) / Math.tan(THREE.MathUtils.degToRad(settings.hfovDeg) / 2);
      const z = (f * (settings.ipdMm / 1000)) / c.ipdPx;
      const xc = ((c.u * W - W / 2) * z) / f;
      const yc = (-(c.v * H - H / 2) * z) / f;
      // Camera looks at the viewer, so its image is mirrored relative to the screen.
      this._v.set(-xc, yc, z).applyAxisAngle(X_AXIS, THREE.MathUtils.degToRad(settings.webcamTiltDeg));
      this.eye.copy(this._v).add(webcamPos);
      this.isTracking = true;
      this.sampleId++;
      this.status = `tracking${this.candidates.length > 1 ? ` (1 of ${this.candidates.length} faces)` : ''}`;
    } else {
      this.isTracking = false;
      this.status = 'no face';
    }
    if (!this.preview.hidden) this._drawPreview();
  }

  /** Lock onto the largest (closest) face and keep it until it has been gone for a while. */
  _choose() {
    const list = this.candidates;
    if (this.lock) {
      let best = null, bestD = LOCK_RADIUS;
      for (const c of list) {
        const d = Math.hypot(c.u - this.lock.u, c.v - this.lock.v);
        if (d < bestD) (best = c), (bestD = d);
      }
      if (best) {
        this.missed = 0;
        this.lock = best;
        return best;
      }
      if (++this.missed < LOCK_PATIENCE) return null;
      this.lock = null;
    }
    if (!list.length) return null;
    this.lock = list.reduce((m, c) => (c.ipdPx > m.ipdPx ? c : m));
    this.missed = 0;
    return this.lock;
  }

  _drawPreview() {
    const cv = this.preview, ctx = cv.getContext('2d');
    const W = this.video.videoWidth, H = this.video.videoHeight;
    const ch = Math.round((cv.width * H) / W);
    if (cv.height !== ch) cv.height = ch;
    ctx.save();
    ctx.translate(cv.width, 0);
    ctx.scale(-1, 1); // mirror, like looking in a mirror
    ctx.drawImage(this.video, 0, 0, cv.width, cv.height);
    ctx.restore();
    for (const c of this.candidates) {
      const on = c === this.chosen;
      ctx.fillStyle = on ? '#06d6a0' : '#8a93a6';
      for (const p of [c.a, c.b]) {
        ctx.beginPath();
        ctx.arc((1 - p.x) * cv.width, p.y * cv.height, on ? 3 : 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
