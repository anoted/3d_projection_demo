import * as THREE from 'three';
// Self-hosted MediaPipe runtime (bundled by Vite) – no CDN version drift.
import wasmLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';

const MODEL_URL = `${import.meta.env.BASE_URL}face_landmarker.task`;
// Eye corners (canthi) in the 478-point mesh. Unlike the iris or eyelid points they
// don't move when you blink or look around, so a still head gives a still eye.
const EYE_A = [33, 133]; // outer, inner corner of one eye
const EYE_B = [362, 263]; // inner, outer corner of the other
// Points on rigid parts of the face (eye corners, nose, forehead, cheek edges): no eyelids,
// brows or mouth. Their spread measures the face's size in the image far more steadily
// than a single eye-to-eye distance, because the noise of ~20 points averages out.
const RIGID = [33, 133, 362, 263, 168, 6, 197, 195, 5, 4, 98, 327, 10, 151, 9, 127, 356, 234, 454];
// A blink is the eyeBlink blendshape score rising this far above its usual level for this
// face. Relative, because narrow eyes or looking down at a screen already raise the score.
const BLINK_RISE = 0.25;
const BLINK_BASE_TAU = 2; // s: how quickly the usual (open-eye) level follows
const BLINK_MAX = 0.5; // s: blinks are shorter than this
const BLINK_SETTLE = 0.12; // s to keep holding after the eyes reopen (the mesh takes a moment to settle)
const RATIO_TAU = 3; // s: how slowly the eye-separation / face-spread ratio is learned
const LOCK_RADIUS = 0.15; // normalised image distance to keep the same face
const LOCK_PATIENCE = 12; // frames the locked face may be missing before re-acquiring
const X_AXIS = new THREE.Vector3(1, 0, 0);

/**
 * Webcam head tracker (MediaPipe Face Landmarker).
 * Eye = midpoint of the two eye centres (each the middle of its corners).
 * Depth: the face's size in the image (spread of rigid landmarks), converted to an
 * eye separation with a slowly learned ratio, then to meters via your IPD.
 * Frames during a blink are skipped: the last pose is held instead.
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
    this.ratio = 0; // eye separation / rigid spread, learned per face
    this.ratioAge = 0; // s of samples in `ratio` (0 = relearn from the next frame)
    this.blinkHold = 0; // s left to hold the pose after a blink
    this.blinkBase = 0; // usual eyeBlink score of the open eyes
    this.blinkFor = 0; // s the current blink has lasted

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
          outputFaceBlendshapes: true, // for blink detection
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
    this.ratioAge = 0;
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
    const frameDt = THREE.MathUtils.clamp(this.video.currentTime - this.lastVideoTime, 1 / 120, 0.5);
    this.lastVideoTime = this.video.currentTime;

    const W = this.video.videoWidth, H = this.video.videoHeight;
    const res = this.landmarker.detectForVideo(this.video, performance.now());
    this.candidates = res.faceLandmarks.map((lm, i) => {
      const a = midpoint(lm, EYE_A), b = midpoint(lm, EYE_B);
      return {
        u: (a.x + b.x) / 2, // normalised image coords
        v: (a.y + b.y) / 2,
        // z is on the same scale as x, so including it keeps sizes steady when
        // the head turns instead of reading a turn as moving away.
        eyeSepPx: Math.hypot((a.x - b.x) * W, (a.y - b.y) * H, (a.z - b.z) * W),
        spreadPx: rigidSpread(lm, W, H),
        blink: blinkScore(res.faceBlendshapes?.[i]),
        a, b,
      };
    });

    this.chosen = this._choose();
    const c = this.chosen;
    if (c && this.ratioAge === 0) this.blinkBase = c.blink; // new face
    if (c && c.blink > this.blinkBase + BLINK_RISE) {
      this.blinkHold = BLINK_SETTLE;
      // Longer than any blink: it's the new normal (e.g. looking down), not a blink.
      if ((this.blinkFor += frameDt) > BLINK_MAX) this.blinkBase = c.blink;
    } else {
      this.blinkFor = 0;
      this.blinkHold = Math.max(0, this.blinkHold - frameDt);
      if (c) this.blinkBase += (c.blink - this.blinkBase) * (1 - Math.exp(-frameDt / BLINK_BASE_TAU));
    }

    if (c && this.blinkHold > 0) {
      // Eyelids distort the mesh around the eyes: keep the last pose (no new sample).
      this.isTracking = this.sampleId > 0;
      this.status = 'tracking (blink: holding)';
    } else if (c) {
      // Learn how the eye separation relates to the face's rigid spread, slowly,
      // so single-frame noise in the eye corners doesn't reach the depth.
      // Running mean for the first RATIO_TAU seconds, then a moving average.
      this.ratioAge += frameDt;
      this.ratio += (c.eyeSepPx / c.spreadPx - this.ratio) * (frameDt / Math.min(this.ratioAge, RATIO_TAU));
      const ipdPx = c.spreadPx * this.ratio;
      const f = (W / 2) / Math.tan(THREE.MathUtils.degToRad(settings.hfovDeg) / 2);
      const z = (f * (settings.ipdMm / 1000)) / ipdPx;
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
    this.lock = list.reduce((m, c) => (c.spreadPx > m.spreadPx ? c : m));
    this.missed = 0;
    this.ratioAge = 0; // possibly a different person: relearn their proportions
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
      ctx.fillStyle = !on ? '#8a93a6' : this.blinkHold > 0 ? '#ffb703' : '#06d6a0'; // amber = blink hold
      for (const p of [c.a, c.b]) {
        ctx.beginPath();
        ctx.arc((1 - p.x) * cv.width, p.y * cv.height, on ? 3 : 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

/** RMS distance of the rigid landmarks from their centroid, in pixels (rotation-invariant). */
function rigidSpread(lm, W, H) {
  let cx = 0, cy = 0, cz = 0;
  for (const i of RIGID) (cx += lm[i].x), (cy += lm[i].y), (cz += lm[i].z);
  cx /= RIGID.length; cy /= RIGID.length; cz /= RIGID.length;
  let sum = 0;
  for (const i of RIGID) sum += ((lm[i].x - cx) * W) ** 2 + ((lm[i].y - cy) * H) ** 2 + ((lm[i].z - cz) * W) ** 2;
  return Math.sqrt(sum / RIGID.length);
}

function blinkScore(blendshapes) {
  let score = 0;
  for (const c of blendshapes?.categories ?? []) {
    if (c.categoryName === 'eyeBlinkLeft' || c.categoryName === 'eyeBlinkRight') score = Math.max(score, c.score);
  }
  return score;
}

function midpoint(lm, [i, j]) {
  const p = lm[i], q = lm[j];
  return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, z: (p.z + q.z) / 2 };
}
