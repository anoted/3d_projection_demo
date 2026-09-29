import * as THREE from 'three';

/**
 * Eye follows the pointer across the canvas (x/y); the wheel moves it closer/further (z).
 * Output in screen-local meters. Not tracking while the pointer is off the canvas.
 */
export class MouseTracker {
  constructor(element, screen) {
    this.screen = screen;
    this.eye = new THREE.Vector3(0, 0, 0.6);
    this.isTracking = false;
    this.sampleId = 0;
    this.status = 'move the pointer over the view';
    this.nx = 0;
    this.ny = 0;
    this.z = 0.6;

    element.addEventListener('pointermove', (e) => {
      const r = element.getBoundingClientRect();
      this.nx = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.ny = -(((e.clientY - r.top) / r.height) * 2 - 1);
      this.inside = true;
    });
    element.addEventListener('pointerleave', () => (this.inside = false));
    element.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.z = THREE.MathUtils.clamp(this.z * Math.exp(e.deltaY * 0.001), 0.1, 3);
    }, { passive: false });
  }

  update(dt, { settings }) {
    this.isTracking = !!this.inside;
    if (!this.isTracking) return;
    const g = settings.mouseGain;
    this.eye.set((this.nx * this.screen.width / 2) * g, (this.ny * this.screen.height / 2) * g, this.z);
    this.sampleId++;
  }
}
