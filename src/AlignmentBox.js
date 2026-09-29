import * as THREE from 'three';

const CELL = 0.02; // grid cell size in meters (2 cm)
const EXTENDED_SIZE = 40; // meters: the back wall's edges can't come into view from any sane eye position
const TILE = CELL * 5; // one repeating grid tile (one major + four minor cells)
const PLAIN_COLORS = { back: 0xcfc8bd, left: 0xc4bdb2, right: 0xc4bdb2, top: 0xe2ddd5, bottom: 0x7d6b58 };

/**
 * Open box behind the screen: back wall, floor, ceiling and two side walls.
 * The open face coincides with the screen rectangle (z = 0), so when the
 * projection is correct its edges stay glued to the display bezel.
 */
export class AlignmentBox extends THREE.Group {
  constructor() {
    super();
    this.name = 'AlignmentBox';
    this.faces = {};
    this.materials = {};
    this._gridTextures = {};
    const geo = new THREE.PlaneGeometry(1, 1);
    for (const key of Object.keys(PLAIN_COLORS)) {
      this.materials[key] = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
      const mesh = new THREE.Mesh(geo, this.materials[key]);
      mesh.name = `box-${key}`;
      mesh.receiveShadow = true;
      this.faces[key] = mesh;
      this.add(mesh);
    }
    // PlaneGeometry faces +Z; turn each face so it looks into the box.
    this.faces.top.rotation.x = Math.PI / 2;
    this.faces.bottom.rotation.x = -Math.PI / 2;
    this.faces.left.rotation.y = Math.PI / 2;
    this.faces.right.rotation.y = -Math.PI / 2;
    this._key = '';
  }

  /**
   * look = {
   *   blackWalls: bool,              no floor, ceiling or side walls: only a huge back wall
   *                                  whose edges never come into view (the rest stays black)
   *   sideGrid: bool,                grid (else plain) on the other faces when they're shown
   *   back: 'grid' | 'plain' | 'image',
   *   image: THREE.Texture | null,   owned by the caller, never disposed here
   *   imageFit: 'cover' | 'stretch',
   * }
   */
  update(width, height, depth, look) {
    const f = this.faces;
    const extend = look.blackWalls;
    f.back.position.set(0, 0, -depth);
    f.back.scale.set(extend ? EXTENDED_SIZE : width, extend ? EXTENDED_SIZE : height, 1);
    f.bottom.position.set(0, -height / 2, -depth / 2);
    f.bottom.scale.set(width, depth, 1);
    f.top.position.set(0, height / 2, -depth / 2);
    f.top.scale.set(width, depth, 1);
    f.left.position.set(-width / 2, 0, -depth / 2);
    f.left.scale.set(depth, height, 1);
    f.right.position.set(width / 2, 0, -depth / 2);
    f.right.scale.set(depth, height, 1);

    const key = [width, height, depth].map((v) => v.toFixed(4)).join('|') + JSON.stringify({ ...look, image: look.image?.uuid });
    if (key === this._key) return;
    this._key = key;

    for (const [name, mesh] of Object.entries(f)) {
      const isBack = name === 'back';
      // Any wall in front would hide the extended back wall, so the others go away entirely.
      mesh.visible = isBack || !extend;
      if (!mesh.visible) continue;
      const mat = this.materials[name];
      let mode = isBack ? look.back : look.sideGrid ? 'grid' : 'plain';
      if (mode === 'image' && !look.image) mode = 'grid';
      if (mode === 'image') {
        mat.map = look.image;
        fitImage(look.image, mesh.scale.x, mesh.scale.y, width, height, look.imageFit);
      } else if (mode === 'grid') {
        mat.map = isBack && extend ? this._tile() : this._grid(name, mesh.scale.x, mesh.scale.y);
      } else {
        mat.map = null;
      }
      mat.color.set(mode === 'plain' ? PLAIN_COLORS[name] : 0xffffff);
      mat.needsUpdate = true;
    }
  }

  /** Grid textures are cached per face and regenerated only when that face's size changes. */
  _grid(name, w, h) {
    const k = `${w.toFixed(4)}x${h.toFixed(4)}`;
    const cached = this._gridTextures[name];
    if (cached?.k === k) return cached.tex;
    cached?.tex.dispose();
    const tex = makeGridTexture(w, h);
    this._gridTextures[name] = { k, tex };
    return tex;
  }

  /** Repeating grid for the extended wall: same metric spacing, lines still centred on the room. */
  _tile() {
    if (!this._tileTex) {
      const tex = makeGridTexture(TILE, TILE, { border: false, cross: false });
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.setScalar(EXTENDED_SIZE / TILE);
      tex.offset.setScalar(0.5); // the tile's major line is at its centre; put one on x = 0
      this._tileTex = tex;
    }
    return this._tileTex;
  }
}

/**
 * Sizes one copy of the image to the room's back-wall rectangle (rectW × rectH):
 * 'cover' keeps its aspect and overfills, 'stretch' matches exactly. When the plane
 * is bigger than that rectangle, the image mirror-repeats outward so there are no seams.
 */
function fitImage(tex, planeW, planeH, rectW, rectH, fit) {
  const img = tex.image;
  let iw = rectW, ih = rectH; // size of one image copy, meters
  if (fit === 'cover' && img?.width) {
    const imgAspect = img.width / img.height;
    if (imgAspect > rectW / rectH) iw = rectH * imgAspect;
    else ih = rectW / imgAspect;
  }
  tex.repeat.set(planeW / iw, planeH / ih);
  tex.offset.set(0.5 - tex.repeat.x / 2, 0.5 - tex.repeat.y / 2); // image centred on the room
  const wrap = planeW > rectW ? THREE.MirroredRepeatWrapping : THREE.ClampToEdgeWrapping;
  if (tex.wrapS !== wrap) {
    tex.wrapS = tex.wrapT = wrap;
    tex.needsUpdate = true;
  }
}

/** Metric grid (2 cm cells, 10 cm majors) centred on the face, with a white border. */
function makeGridTexture(wm, hm, { border = true, cross = true } = {}) {
  const ppm = Math.min(2048 / Math.max(wm, hm), 6000); // pixels per meter
  const cw = Math.max(64, Math.round(wm * ppm));
  const ch = Math.max(64, Math.round(hm * ppm));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#15181e';
  ctx.fillRect(0, 0, cw, ch);

  const step = CELL * ppm;
  const line = (major, horizontal, p) => {
    ctx.strokeStyle = major ? '#56627a' : '#2b313d';
    ctx.lineWidth = Math.max(1, ppm * (major ? 0.0012 : 0.0006));
    ctx.beginPath();
    if (horizontal) { ctx.moveTo(0, p); ctx.lineTo(cw, p); } else { ctx.moveTo(p, 0); ctx.lineTo(p, ch); }
    ctx.stroke();
  };
  for (const [size, horizontal] of [[cw, false], [ch, true]]) {
    const n = Math.ceil(size / 2 / step);
    for (let i = -n; i <= n; i++) {
      const p = size / 2 + i * step;
      if (p > 0 && p < size) line(i % 5 === 0, horizontal, p);
    }
  }

  if (cross) {
    const c = 0.012 * ppm;
    ctx.strokeStyle = '#4cc9f0';
    ctx.lineWidth = Math.max(2, ppm * 0.0015);
    ctx.beginPath();
    ctx.moveTo(cw / 2 - c, ch / 2); ctx.lineTo(cw / 2 + c, ch / 2);
    ctx.moveTo(cw / 2, ch / 2 - c); ctx.lineTo(cw / 2, ch / 2 + c);
    ctx.stroke();
  }

  if (border) {
    // white border (≈4 mm)
    const bw = Math.max(3, ppm * 0.004);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = bw;
    ctx.strokeRect(bw / 2, bw / 2, cw - bw, ch - bw);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
