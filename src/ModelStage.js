import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const TEST_OBJECTS = '__test__';

/**
 * Shows exactly one model at a time inside the room, standing on the floor,
 * uniformly scaled to fit the room at any yaw.
 */
export class ModelStage extends THREE.Group {
  constructor() {
    super();
    this.name = 'ModelStage';
    this.turntable = new THREE.Group(); // sits on the floor, carries yaw
    this.add(this.turntable);
    this.loader = new GLTFLoader();
    this.wrapper = null; // holds the loaded scene; scaled to fit
    this.nativeBox = new THREE.Box3();
    this.isTest = false;
    this.token = 0;
    this.status = '';
    this.progress = null;
    this.spin = 0;
    this.room = null;
    this._testKey = '';
  }

  async show(key, url, label) {
    const token = ++this.token;
    this._clear();
    if (key === TEST_OBJECTS) {
      this.isTest = true;
      this.status = label;
      if (this.room) this.layout(this.room, this.settings);
      return;
    }
    this.isTest = false;
    this.status = `loading ${label}`;
    this.progress = 0;
    try {
      const gltf = await this.loader.loadAsync(url, (e) => {
        if (token === this.token && e.total) this.progress = e.loaded / e.total;
      });
      if (token !== this.token) return disposeObject(gltf.scene);
      const wrapper = new THREE.Group();
      wrapper.add(gltf.scene);
      gltf.scene.traverse((o) => {
        if (o.isMesh) o.castShadow = o.receiveShadow = true;
      });
      wrapper.updateMatrixWorld(true);
      this.nativeBox.setFromObject(wrapper);
      this.wrapper = wrapper;
      this.turntable.add(wrapper);
      this.status = label;
      if (this.room) this.layout(this.room, this.settings);
    } catch (err) {
      if (token === this.token) this.status = `failed to load ${label}: ${err.message || err}`;
      console.error(err);
    } finally {
      if (token === this.token) this.progress = null;
    }
  }

  /** room = { width, height, depth } in meters. */
  layout(room, s) {
    this.room = room;
    this.settings = s;
    const { width: w, height: h, depth: D } = room;

    if (this.isTest) {
      const key = `${w}|${h}|${D}`;
      if (key !== this._testKey) {
        this._clear();
        this.isTest = true;
        this._testKey = key;
        this.wrapper = buildTestObjects(w, h, D);
        this.turntable.add(this.wrapper);
      }
      this.turntable.position.set(0, 0, 0);
      this.turntable.rotation.set(0, 0, 0);
      return;
    }
    if (!this.wrapper) return;

    const size = this.nativeBox.getSize(new THREE.Vector3());
    const center = this.nativeBox.getCenter(new THREE.Vector3());
    const footprint = Math.hypot(size.x, size.z) || 1e-6; // fits at any yaw
    const scale = s.modelFill * Math.min(Math.min(w, D) / footprint, h / (size.y || 1e-6));
    this.wrapper.scale.setScalar(scale);
    this.wrapper.position.set(-center.x * scale, -this.nativeBox.min.y * scale, -center.z * scale);
    this.turntable.position.set(0, -h / 2 + s.modelLiftMm / 1000, -D * s.modelDepth);
    this._applyYaw(s);
  }

  tick(dt, s) {
    if (this.isTest || !this.wrapper) return;
    if (s.modelSpin) this.spin += dt * 0.35;
    this._applyYaw(s);
  }

  _applyYaw(s) {
    this.turntable.rotation.y = THREE.MathUtils.degToRad(s.modelYaw) + this.spin;
  }

  _clear() {
    if (this.wrapper) {
      this.turntable.remove(this.wrapper);
      disposeObject(this.wrapper);
    }
    this.wrapper = null;
    this._testKey = '';
  }
}

function disposeObject(root) {
  root.traverse((o) => {
    o.geometry?.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
      m.dispose();
    }
  });
}

/** Milestone-1 content: objects at many depths, plus one that pokes out of the glass. */
function buildTestObjects(w, h, D) {
  const g = new THREE.Group();
  const floor = -h / 2;
  const u = Math.min(w, h, D); // size unit
  const mat = (color, rough = 0.5, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
  const add = (geo, m, x, y, z) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    g.add(mesh);
    return mesh;
  };

  // pillars receding into the room
  const pillarH = h * 0.55;
  [0.15, 0.4, 0.65, 0.9].forEach((f, i) => {
    const side = i % 2 ? 1 : -1;
    add(new THREE.BoxGeometry(u * 0.08, pillarH, u * 0.08), mat(0x3a86ff, 0.6), side * w * 0.36, floor + pillarH / 2, -D * f);
  });

  // spheres floating at different depths
  [[0.1, 0x06d6a0], [0.35, 0xffd166], [0.6, 0xef476f], [0.85, 0x8338ec]].forEach(([f, c], i) => {
    add(new THREE.SphereGeometry(u * 0.07, 32, 16), mat(c, 0.35), (i - 1.5) * w * 0.14, floor + h * (0.3 + 0.12 * i), -D * f);
  });

  // centrepiece on the floor
  const knot = add(new THREE.TorusKnotGeometry(u * 0.11, u * 0.035, 160, 20), mat(0xdddddd, 0.2, 0.9), 0, floor + u * 0.2, -D * 0.5);
  knot.rotation.x = Math.PI / 2;

  // pops out in front of the glass: only visible when the near plane isn't clamped
  add(new THREE.OctahedronGeometry(u * 0.06), mat(0xff9f1c, 0.4), w * 0.25, -h * 0.1, u * 0.12);
  return g;
}
