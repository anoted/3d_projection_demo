import * as THREE from 'three';

/** Hands-free demo: the eye orbits along a Lissajous path in front of the screen. */
export class AutoTracker {
  constructor(screen) {
    this.screen = screen;
    this.eye = new THREE.Vector3(0, 0, 0.6);
    this.isTracking = true;
    this.sampleId = 0;
    this.status = 'orbiting';
    this.t = 0;
  }

  update(dt, { settings }) {
    this.t += dt * settings.autoSpeed;
    const a = settings.autoAmplitude;
    const z0 = settings.defaultEyeZMm / 1000;
    this.eye.set(
      Math.sin(this.t) * this.screen.width * a,
      Math.sin(this.t * 0.63) * this.screen.height * a * 0.8,
      z0 + Math.sin(this.t * 0.37) * z0 * 0.25,
    );
    this.sampleId++;
  }
}
