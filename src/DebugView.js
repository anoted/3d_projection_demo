import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DEBUG_LAYER, updateOffAxisCamera } from './offaxis.js';

/**
 * Picture-in-picture third-person view: the screen, the tracked eye, the webcam,
 * and the off-axis frustum. Rendered into a scissored corner of the main canvas.
 */
export class DebugView {
  constructor(renderer, scene, screen) {
    this.renderer = renderer;
    this.scene = scene;
    this.screen = screen;
    this.enabled = true;
    this.rect = { x: 16, y: 16, w: 360, h: 240 };

    this.camera = new THREE.PerspectiveCamera(40, 1.5, 0.01, 50);
    this.camera.layers.enable(DEBUG_LAYER);
    this.camera.position.set(1.0, 0.45, 0.85);

    // A transparent element over the viewport receives the orbit input.
    this.overlay = document.createElement('div');
    this.overlay.className = 'debug-overlay';
    this.overlay.innerHTML = '<span>Debug view · drag to orbit</span>';
    document.body.appendChild(this.overlay);
    this.controls = new OrbitControls(this.camera, this.overlay);
    this.controls.target.set(0, 0, -0.15);
    this.controls.enableDamping = true;
    this.controls.update();

    // A proxy camera whose far plane stops at the back wall, so the frustum reads well.
    this.frustumCam = new THREE.PerspectiveCamera();
    this.helper = new THREE.CameraHelper(this.frustumCam);
    this.helper.setColors(
      new THREE.Color(0xffd166), new THREE.Color(0xef476f), new THREE.Color(0x06d6a0),
      new THREE.Color(0xffffff), new THREE.Color(0x8a93a6),
    );
    this.eyeMarker = new THREE.Mesh(new THREE.SphereGeometry(0.012, 24, 12), new THREE.MeshBasicMaterial({ color: 0xffd166 }));
    this.webcamMarker = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.012, 0.012), new THREE.MeshBasicMaterial({ color: 0xef476f }));
    for (const o of [this.helper, this.eyeMarker, this.webcamMarker]) {
      o.layers.set(DEBUG_LAYER);
      scene.add(o);
    }
    this.layout();
  }

  layout() {
    const el = this.renderer.domElement;
    const w = Math.round(Math.min(el.clientWidth * 0.34, 520));
    const h = Math.round(w * 0.66);
    this.rect = { x: 16, y: 16, w, h };
    Object.assign(this.overlay.style, { width: `${w}px`, height: `${h}px` });
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix(); // fine here: this is an ordinary camera
  }

  setEnabled(v) {
    this.enabled = v;
    this.overlay.style.display = v ? '' : 'none';
    this.helper.visible = this.eyeMarker.visible = this.webcamMarker.visible = v;
  }

  update(eyeWorld, near, far, webcamWorld) {
    if (!this.enabled) return;
    updateOffAxisCamera(this.frustumCam, this.screen, eyeWorld, near, far);
    this.helper.update();
    this.eyeMarker.position.copy(eyeWorld);
    this.webcamMarker.position.copy(webcamWorld);
    this.screen.getWorldQuaternion(this.webcamMarker.quaternion);
    this.controls.update();
  }

  render() {
    if (!this.enabled) return;
    const r = this.renderer, { x, y, w, h } = this.rect;
    r.setScissorTest(true);
    r.setScissor(x, y, w, h);
    r.setViewport(x, y, w, h);
    r.render(this.scene, this.camera);
    r.setScissorTest(false);
  }
}
