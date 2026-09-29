import * as THREE from 'three';

/** Objects on this layer only show up in the debug view, never through the "window". */
export const DEBUG_LAYER = 1;

/**
 * The physical display, as a rectangle in world space.
 * Origin at the display centre, +X right, +Y up, +Z toward the viewer.
 * Units are meters. Never scale this object; use setSize() instead.
 */
export class OffAxisScreen extends THREE.Object3D {
  constructor(width = 0.344, height = 0.194) {
    super();
    this.name = 'OffAxisScreen';
    this.width = width;
    this.height = height;

    const outlineGeo = new THREE.BufferGeometry();
    outlineGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(15), 3));
    this.outline = new THREE.Line(outlineGeo, new THREE.LineBasicMaterial({ color: 0x4cc9f0 }));
    this.normalLine = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 0.1, 0x4cc9f0, 0.02, 0.012);
    this.add(this.outline, this.normalLine);
    this.outline.traverse((o) => o.layers.set(DEBUG_LAYER));
    this.normalLine.traverse((o) => o.layers.set(DEBUG_LAYER));

    this.setSize(width, height);
  }

  setSize(width, height) {
    this.width = width;
    this.height = height;
    const w = width / 2, h = height / 2;
    const pos = this.outline.geometry.attributes.position;
    pos.array.set([-w, -h, 0, w, -h, 0, w, h, 0, -w, h, 0, -w, -h, 0]);
    pos.needsUpdate = true;
    this.outline.geometry.computeBoundingSphere();
  }
}

const eyeL = new THREE.Vector3();

/**
 * Kooima's generalized perspective projection.
 * Writes the camera's world transform and an asymmetric frustum whose apex is
 * the eye and whose sides pass through the four screen corners.
 *
 * Never call camera.updateProjectionMatrix() afterwards – it would overwrite this.
 */
export function updateOffAxisCamera(camera, screen, eyeWorld, near = 0.01, far = 100) {
  screen.updateMatrixWorld();
  eyeL.copy(eyeWorld);
  screen.worldToLocal(eyeL); // eye in screen space
  const d = Math.max(eyeL.z, 1e-4); // eye → plane distance
  const k = near / d;
  const { width: w, height: h } = screen;

  const l = (-w / 2 - eyeL.x) * k, r = (w / 2 - eyeL.x) * k;
  const b = (-h / 2 - eyeL.y) * k, t = (h / 2 - eyeL.y) * k;

  camera.position.copy(eyeWorld);
  screen.getWorldQuaternion(camera.quaternion); // face perpendicular to the screen
  camera.updateMatrixWorld();

  camera.near = near;
  camera.far = far;
  camera.projectionMatrix.makePerspective(l, r, t, b, near, far, camera.coordinateSystem);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  return d;
}
