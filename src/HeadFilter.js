import * as THREE from 'three';

/** One-Euro filter (Casiez et al. 2012): low jitter at rest, low lag when moving. */
class OneEuro {
  constructor() {
    this.x = null;
    this.dx = 0;
  }
  reset(x) {
    this.x = x;
    this.dx = 0;
  }
  filter(x, dt, minCutoff, beta, dCutoff = 1) {
    if (this.x === null) return this.reset(x), x;
    const dx = (x - this.x) / dt;
    this.dx += alpha(dCutoff, dt) * (dx - this.dx);
    const cutoff = minCutoff + beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }
}

function alpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

/**
 * Smooths tracker output and handles tracking loss:
 * tracking → One-Euro filtered; lost → hold the last pose for `holdTime`,
 * then ease back to the default on-axis eye.
 */
export class HeadFilter {
  constructor() {
    this.eye = new THREE.Vector3(0, 0, 0.6);
    this.state = 'returning';
    this.filters = [new OneEuro(), new OneEuro(), new OneEuro()];
    this.lostFor = Infinity;
    this.lastSample = -1;
    this.lastSampleTime = 0;
    this.time = 0;
    this._default = new THREE.Vector3();
  }

  update(tracker, dt, s) {
    this.time += dt;
    if (tracker.isTracking) {
      if (this.state !== 'tracking') {
        // resume from wherever we are now, so there is no jump
        this.filters.forEach((f, i) => f.reset(this.eye.getComponent(i)));
        this.lastSampleTime = this.time;
      }
      this.state = 'tracking';
      this.lostFor = 0;
      if (tracker.sampleId !== this.lastSample) {
        const sdt = Math.max(this.time - this.lastSampleTime, 1e-3);
        this.lastSample = tracker.sampleId;
        this.lastSampleTime = this.time;
        for (let i = 0; i < 3; i++) {
          // Depth comes from a ~100 px eye separation, so it is far noisier than x/y: smooth it harder.
          const minCutoff = i === 2 ? s.minCutoff * s.depthCutoffScale : s.minCutoff;
          this.eye.setComponent(i, this.filters[i].filter(tracker.eye.getComponent(i), sdt, minCutoff, s.beta));
        }
      }
    } else {
      this.lostFor += dt;
      if (this.lostFor < s.holdTime) {
        this.state = 'holding';
      } else {
        this.state = 'returning';
        this._default.set(0, 0, s.defaultEyeZMm / 1000);
        this.eye.lerp(this._default, 1 - Math.exp(-s.returnRate * dt));
      }
    }
    this.eye.z = Math.max(this.eye.z, 0.05); // never let the eye reach the glass
    return this.eye;
  }
}
