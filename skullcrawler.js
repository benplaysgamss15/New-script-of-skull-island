import * as THREE from 'three';

// ============================================================================
// 1. MATH, SPLINES, KEYFRAME HELPERS, IK & PROCEDURAL NOISE
// ============================================================================
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0 || 1e-8), 0, 1);
  return t * t * (3 - 2 * t);
};
const smootherstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0 || 1e-8), 0, 1);
  return t * t * t * (10 + t * (-15 + 6 * t));
};
const UP_AXIS = new THREE.Vector3(0, 1, 0);

function normalizeAngle(a) {
  let y = a % (Math.PI * 2);
  if (y > Math.PI) y -= Math.PI * 2;
  if (y <= -Math.PI) y += Math.PI * 2;
  if (Math.abs(y) < 1e-9) y = 0;
  if (Math.abs(Math.abs(y) - Math.PI) < 1e-9) y = Math.PI;
  return y;
}

function evalSpline(xs, ys, x) {
  if (x <= xs[0]) return ys[0];
  const n = xs.length;
  if (x >= xs[n - 1]) return ys[n - 1];
  let i = 0;
  while (i < n - 2 && x > xs[i + 1]) i++;
  const t = (x - xs[i]) / (xs[i + 1] - xs[i]), t2 = t * t, t3 = t2 * t;
  const y0 = ys[Math.max(0, i - 1)], y1 = ys[i], y2 = ys[i + 1], y3 = ys[Math.min(n - 1, i + 2)];
  return 0.5 * ((2 * y1) + (-y0 + y2) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (-y0 + 3 * y1 - 3 * y2 + y3) * t3);
}

// Ergonomic animation curve helpers for ANIMATIONS entries
const splineKeys = (ts, ys, u) => evalSpline(ts, ys, u);
function stepKeys(keys, u) {
  if (u <= keys[0][0]) return keys[0][1];
  if (u >= keys[keys.length - 1][0]) return keys[keys.length - 1][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, v0] = keys[i], [t1, v1] = keys[i + 1];
    if (u <= t1) return lerp(v0, v1, smoothstep(t0, t1, u));
  }
  return keys[keys.length - 1][1];
}
const bell = (u, a, b, pow = 1) => Math.sin(clamp((u - a) / (b - a || 1e-8), 0, 1) * Math.PI) ** pow;

function computeBoneMatrix(origin, target, pole) {
  const yUp = new THREE.Vector3().subVectors(origin, target).normalize();
  const zP = pole.clone().addScaledVector(yUp, -pole.dot(yUp));
  if (zP.lengthSq() < 1e-6) zP.set(0, 0, -1);
  zP.normalize();
  const xL = new THREE.Vector3().crossVectors(yUp, zP).normalize();
  const zO = new THREE.Vector3().crossVectors(xL, yUp).normalize();
  return new THREE.Matrix4().makeBasis(xL, yUp, zO).setPosition(origin);
}

function solveTwoBoneIK(S, W, pole, L1, L2) {
  const dVec = new THREE.Vector3().subVectors(W, S);
  const dist = dVec.length();
  const d = clamp(dist, Math.abs(L1 - L2) + 0.02, (L1 + L2) * 0.99);
  const dir = dist > 1e-6 ? dVec.divideScalar(dist) : new THREE.Vector3(0, -1, 0);
  const cosA = clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
  const a = L1 * cosA;
  const h = L1 * Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const perp = pole.clone().addScaledVector(dir, -pole.dot(dir));
  if (perp.lengthSq() < 1e-6) perp.set(0, 0, -1).addScaledVector(dir, dir.z);
  perp.normalize();
  return {
    E: S.clone().addScaledVector(dir, a).addScaledVector(perp, h),
    W: S.clone().addScaledVector(dir, d),
    perp,
  };
}

const hash2 = (ix, iy) => {
  const n = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453;
  return n - Math.floor(n);
};
const pNoise = (u, v, p) => {
  const gx = u * p, gy = v * p, ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const i0 = ((ix % p) + p) % p, j0 = ((iy % p) + p) % p, i1 = (i0 + 1) % p, j1 = (j0 + 1) % p;
  return lerp(lerp(hash2(i0, j0), hash2(i1, j0), ux), lerp(hash2(i0, j1), hash2(i1, j1), ux), uy);
};
const pFbm = (u, v, p = 8) => 0.55 * pNoise(u, v, p) + 0.30 * pNoise(u, v, p * 2) + 0.15 * pNoise(u, v, p * 4);

// ============================================================================
// 2. ANATOMY & RIG CONFIGURATION (Single Source of Truth)
// ============================================================================
const ANATOMY = {
  spine: {
    ctrlS: [0, 0.12, 0.25, 0.40, 0.55, 0.68, 0.78, 0.87, 0.94, 1.0],
    ctrlZ: [-6.5, -5.0, -3.55, -2.35, -1.35, -0.55, 0.02, 0.54, 0.94, 1.30],
    ctrlY: [0.60, 0.46, 0.54, 0.86, 1.30, 1.74, 1.92, 1.82, 1.79, 1.78],
    stationS: [0.02, 0.11, 0.22, 0.34, 0.46, 0.57, 0.67, 0.78, 0.88, 0.95, 1.00],
    boneNames: ['tail6', 'tail5', 'tail4', 'tail3', 'tail2', 'tail1', 'pelvis', 'chest', 'neck1', 'neck2', 'headBase'],
    pelvisIndex: 6,
    chestIndex: 7,
    tailOrder: ['tail1', 'tail2', 'tail3', 'tail4', 'tail5', 'tail6'],
    tailMinWorldY: 0.16,
  },
  torsoMesh: {
    nAx: 92,
    nRd: 32,
    socket: { i0: 67, i1: 75, j0: 4, j1: 12 },
  },
  limb: {
    L1: 0.88,
    L2: 1.52,
    shoulderOffset: new THREE.Vector3(0.48, -0.05, 0),
    wristRest: new THREE.Vector3(0.82, 0.09, 0.06),
    elbowPole: new THREE.Vector3(0.68, 0.44, -0.76),
    digits: [
      { ang: -0.76, len: 0.28, rad: 0.050, xo: -0.080, zo: 0.148 },
      { ang: -0.25, len: 0.56, rad: 0.062, xo: -0.038, zo: 0.184 },
      { ang:  0.15, len: 0.64, rad: 0.066, xo:  0.024, zo: 0.186 },
      { ang:  0.58, len: 0.52, rad: 0.058, xo:  0.084, zo: 0.170 },
    ],
  },
  tongue: {
    basePos: [0, 0.026, 0.14],
    shaftLength: 0.42,
    prongAnchorZ: 0.38,
    boneZs: [0, 0.063, 0.126, 0.190, 0.253, 0.316, 0.380],
    prongs: [
      { x: 0, len: 0.66, up: 0.22, r: 0.036, spreadSign: 0 },
      { x: 0.14, len: 0.45, up: 0.16, r: 0.026, spreadSign: 1 },
      { x: -0.14, len: 0.45, up: 0.16, r: 0.026, spreadSign: -1 },
    ],
    prongJointTs: [0, 0.33, 0.67, 1.0],
  },
  locomotion: {
    pivotLocalZ: -0.85,
    walkSpeed: 2.35,
    runSpeed: 6.90,
  },
};

// ============================================================================
// 3. PROCEDURAL TEXTURES & MATERIALS
// ============================================================================
function buildNormalMap(hBuf, size, strength) {
  const nc = document.createElement('canvas');
  nc.width = nc.height = size;
  const nCtx = nc.getContext('2d'), nImg = nCtx.createImageData(size, size);
  for (let py = 0; py < size; py++) {
    const pyU = (py - 1 + size) % size, pyD = (py + 1) % size;
    for (let px = 0; px < size; px++) {
      const hL = hBuf[py * size + ((px - 1 + size) % size)];
      const hR = hBuf[py * size + ((px + 1) % size)];
      const hU = hBuf[pyU * size + px];
      const hD = hBuf[pyD * size + px];
      const nx = -(hR - hL) * strength, ny = (hD - hU) * strength, nz = 1.0;
      const inv = 1 / Math.hypot(nx, ny, nz), i = (py * size + px) * 4;
      nImg.data[i] = Math.round((nx * inv * 0.5 + 0.5) * 255);
      nImg.data[i + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
      nImg.data[i + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
      nImg.data[i + 3] = 255;
    }
  }
  nCtx.putImageData(nImg, 0, 0);
  return nc;
}

function createReptileTextures(size = 512, anisotropy = 4) {
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = size; return [c, c.getContext('2d')]; };
  const [dc, dCtx] = mk(), [rc, rCtx] = mk();
  const dImg = dCtx.createImageData(size, size), rImg = rCtx.createImageData(size, size);
  const hBuf = new Float32Array(size * size);
  const cells = 22, pts = [];
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      pts.push({ x: cx + 0.16 + 0.68 * hash2(cx, cy), y: cy + 0.16 + 0.68 * hash2(cx + 97, cy + 53) });
    }
  }
  for (let py = 0; py < size; py++) {
    const v = py / size;
    for (let px = 0; px < size; px++) {
      const u = px / size;
      const m1 = pFbm(u, v, 6), m2 = pFbm(u + 0.37, v + 0.61, 22);
      const uw = ((u + (m1 - 0.5) * 0.028) % 1 + 1) % 1;
      const vw = ((v + (m2 - 0.5) * 0.020) % 1 + 1) % 1;
      const gx = uw * cells, gy = vw * cells, icx = Math.floor(gx), icy = Math.floor(gy);
      let d1 = 9e9, d2 = 9e9;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const wx = (icx + ox + cells) % cells, wy = (icy + oy + cells) % cells, pt = pts[wy * cells + wx];
          const dist = Math.hypot((pt.x + (icx + ox - wx)) - gx, (pt.y + (icy + oy - wy)) - gy);
          if (dist < d1) { d2 = d1; d1 = dist; } else if (dist < d2) d2 = dist;
        }
      }
      const edge = clamp((d2 - d1) * 2.1, 0, 1);
      const dome = Math.pow(edge, 0.42), crevice = 1 - smoothstep(0.0, 0.28, edge);
      const fold = 0.5 + 0.5 * Math.sin(u * Math.PI * 16 + m1 * 5.0);
      const idxP = py * size + px, i = idxP * 4;
      hBuf[idxP] = clamp(0.56 * dome + 0.22 * m2 + 0.14 * fold + 0.08 * m1 - 0.24 * crevice, 0, 1);

      const tone = clamp(0.90 + 0.12 * dome + 0.12 * (m1 - 0.5) + 0.08 * (m2 - 0.5) - 0.34 * crevice - 0.06 * (1 - fold), 0.48, 1.04);
      dImg.data[i] = Math.round(clamp(tone * (0.97 + 0.04 * m1), 0, 1) * 255);
      dImg.data[i + 1] = Math.round(clamp(tone * (0.99 + 0.03 * m2), 0, 1) * 255);
      dImg.data[i + 2] = Math.round(clamp(tone * (0.91 + 0.04 * m1), 0, 1) * 255);
      dImg.data[i + 3] = 255;

      const rough = clamp(0.62 + 0.28 * crevice + 0.14 * (1 - dome) + 0.10 * (m2 - 0.5), 0.52, 0.98);
      rImg.data[i] = rImg.data[i + 1] = rImg.data[i + 2] = Math.round(rough * 255);
      rImg.data[i + 3] = 255;
    }
  }
  dCtx.putImageData(dImg, 0, 0);
  rCtx.putImageData(rImg, 0, 0);
  const nc = buildNormalMap(hBuf, size, 4.2);
  const tx = (c, srgb) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(3, 3);
    t.anisotropy = anisotropy;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return { map: tx(dc, true), normalMap: tx(nc, false), roughnessMap: tx(rc, false) };
}

function createBoneTextures(size = 384, anisotropy = 4) {
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = size; return [c, c.getContext('2d')]; };
  const [dc, dCtx] = mk(), [rc, rCtx] = mk();
  const dImg = dCtx.createImageData(size, size), rImg = rCtx.createImageData(size, size);
  const hBuf = new Float32Array(size * size);
  for (let py = 0; py < size; py++) {
    const v = py / size;
    for (let px = 0; px < size; px++) {
      const u = px / size;
      const b1 = pFbm(u + 0.13, v + 0.41, 6), b2 = pFbm(u + 0.23, v + 0.71, 24);
      const cNoise = pNoise(u + b1 * 0.06, v + b2 * 0.06, 8);
      const crack = Math.pow(clamp(1 - Math.abs(cNoise - 0.5) * 18, 0, 1), 2.2);
      const pore = smoothstep(0.75, 0.93, pNoise(u + 0.5, v + 0.2, 40));
      const idxP = py * size + px, i = idxP * 4;
      hBuf[idxP] = clamp(0.62 + 0.18 * b2 + 0.10 * b1 - 0.38 * crack - 0.28 * pore, 0, 1);

      const tone = clamp(0.95 + 0.08 * (b1 - 0.5) + 0.05 * (b2 - 0.5) - 0.28 * crack - 0.20 * pore, 0.55, 1.0);
      dImg.data[i] = Math.round(tone * 255);
      dImg.data[i + 1] = Math.round(tone * 0.98 * 255);
      dImg.data[i + 2] = Math.round(tone * 0.93 * 255);
      dImg.data[i + 3] = 255;

      const rough = clamp(0.64 + 0.22 * (1 - b2) + 0.25 * crack + 0.20 * pore, 0.56, 0.98);
      rImg.data[i] = rImg.data[i + 1] = rImg.data[i + 2] = Math.round(rough * 255);
      rImg.data[i + 3] = 255;
    }
  }
  dCtx.putImageData(dImg, 0, 0);
  rCtx.putImageData(rImg, 0, 0);
  const nc = buildNormalMap(hBuf, size, 2.6);
  const tx = (c, srgb) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(2, 2);
    t.anisotropy = anisotropy;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return { map: tx(dc, true), normalMap: tx(nc, false), roughnessMap: tx(rc, false) };
}

function createCreatureMaterials(maxAnisotropy = 4) {
  const tx = createReptileTextures(512, maxAnisotropy);
  const bTx = createBoneTextures(384, maxAnisotropy);
  return {
    skinMat: new THREE.MeshStandardMaterial({
      vertexColors: true, map: tx.map, normalMap: tx.normalMap,
      normalScale: new THREE.Vector2(1.25, 1.25), roughnessMap: tx.roughnessMap,
      roughness: 0.95, metalness: 0.03,
    }),
    boneMat: new THREE.MeshStandardMaterial({
      vertexColors: true, map: bTx.map, normalMap: bTx.normalMap,
      normalScale: new THREE.Vector2(0.85, 0.85), roughnessMap: bTx.roughnessMap,
      roughness: 0.92, metalness: 0.02,
    }),
    toothMat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.05 }),
    wetMat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.20, metalness: 0.02 }),
  };
}

// ============================================================================
// 4. AUDIO SYNTHESIZER
// ============================================================================
export class RoarSynth {
  constructor() { this.ctx = null; this.on = true; this.last = -10; }
  unlock() {
    if (!this.on) return;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }
  setEnabled(v) {
    this.on = v;
    if (v) this.unlock();
  }
  trigger() {
    if (!this.on || !this.ctx) return;
    const now = this.ctx.currentTime;
    if (now - this.last < 2.6) return;
    this.last = now;
    const dur = 2.3, master = this.ctx.createGain();
    master.gain.setValueAtTime(0.001, now);
    master.gain.exponentialRampToValueAtTime(0.32, now + 0.18);
    master.gain.setValueAtTime(0.30, now + 1.2);
    master.gain.exponentialRampToValueAtTime(0.001, now + dur);
    master.connect(this.ctx.destination);
    const o1 = this.ctx.createOscillator(), o2 = this.ctx.createOscillator();
    const lfo = this.ctx.createOscillator(), lg = this.ctx.createGain(), f = this.ctx.createBiquadFilter();
    o1.type = 'sawtooth'; o2.type = 'square';
    lfo.frequency.value = 26; lg.gain.value = 38;
    lfo.connect(lg); lg.connect(o1.frequency);
    o1.frequency.setValueAtTime(210, now); o1.frequency.exponentialRampToValueAtTime(480, now + 0.30); o1.frequency.exponentialRampToValueAtTime(135, now + dur);
    o2.frequency.setValueAtTime(98, now); o2.frequency.exponentialRampToValueAtTime(185, now + 0.28); o2.frequency.exponentialRampToValueAtTime(64, now + dur);
    f.type = 'bandpass'; f.Q.value = 2.4;
    f.frequency.setValueAtTime(750, now); f.frequency.exponentialRampToValueAtTime(1450, now + 0.35); f.frequency.exponentialRampToValueAtTime(420, now + dur);
    const buf = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * dur), this.ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    const ns = this.ctx.createBufferSource(), nf = this.ctx.createBiquadFilter(), ng = this.ctx.createGain();
    ns.buffer = buf; nf.type = 'bandpass'; nf.frequency.value = 1800; nf.Q.value = 1.2; ng.gain.value = 0.25;
    o1.connect(f); o2.connect(f); f.connect(master); ns.connect(nf); nf.connect(ng); ng.connect(master);
    lfo.start(now); o1.start(now); o2.start(now); ns.start(now);
    lfo.stop(now + dur); o1.stop(now + dur); o2.stop(now + dur); ns.stop(now + dur);
  }
}

// ============================================================================
// 5. GEOMETRY SCULPTING & MESH BUILDERS
// ============================================================================
function createTubeGeometry(nL, nR, fn) {
  const pos = [], col = [], idx = [];
  for (let i = 0; i < nL; i++) {
    const s = fn(i / (nL - 1));
    for (let j = 0; j < nR; j++) {
      const a = (j / nR) * Math.PI * 2;
      pos.push(s.x + s.r * Math.cos(a), s.y + s.r * 0.75 * Math.sin(a), s.z);
      col.push(...s.col);
    }
  }
  for (let i = 0; i < nL - 1; i++) {
    for (let j = 0; j < nR; j++) {
      const jn = (j + 1) % nR, a = i * nR + j, b = (i + 1) * nR + j, c = (i + 1) * nR + jn, d = i * nR + jn;
      idx.push(a, c, b, a, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function createSkinnedTubeGeometry(nL, nR, boneOffsets, fn, coordFn = (t, s) => s.z) {
  const pos = [], col = [], si = [], sw = [], idx = [];
  const lastBone = boneOffsets.length - 1;
  for (let i = 0; i < nL; i++) {
    const t = i / (nL - 1);
    const s = fn(t);
    const coord = coordFn(t, s);
    let b0 = 0, b1 = 0, w0 = 1, w1 = 0;
    if (coord >= boneOffsets[lastBone]) {
      b0 = b1 = lastBone;
    } else if (coord > boneOffsets[0]) {
      for (let k = 0; k < lastBone; k++) {
        if (coord >= boneOffsets[k] && coord <= boneOffsets[k + 1]) {
          b0 = k; b1 = k + 1;
          w1 = (coord - boneOffsets[k]) / (boneOffsets[k + 1] - boneOffsets[k] || 1e-8);
          w0 = 1 - w1;
          break;
        }
      }
    }
    for (let j = 0; j < nR; j++) {
      const a = (j / nR) * Math.PI * 2;
      pos.push(s.x + s.r * Math.cos(a), s.y + s.r * 0.75 * Math.sin(a), s.z);
      col.push(...s.col);
      si.push(b0, b1, 0, 0);
      sw.push(w0, w1, 0, 0);
    }
  }
  for (let i = 0; i < nL - 1; i++) {
    for (let j = 0; j < nR; j++) {
      const jn = (j + 1) % nR, a = i * nR + j, b = (i + 1) * nR + j, c = (i + 1) * nR + jn, d = i * nR + jn;
      idx.push(a, c, b, a, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function relaxVertices(verts, idx, canonOf, relaxWt, passes = 4) {
  const nbrs = Array.from({ length: verts.length }, () => new Set());
  for (let t = 0; t < idx.length; t += 3) {
    const ca = canonOf[idx[t]], cb = canonOf[idx[t + 1]], cc = canonOf[idx[t + 2]];
    if (ca !== cb) { nbrs[ca].add(cb); nbrs[cb].add(ca); }
    if (cb !== cc) { nbrs[cb].add(cc); nbrs[cc].add(cb); }
    if (cc !== ca) { nbrs[cc].add(ca); nbrs[ca].add(cc); }
  }
  for (let pass = 0; pass < passes; pass++) {
    const next = verts.map(v => v.clone());
    for (let v = 0; v < verts.length; v++) {
      if (relaxWt[v] > 0 && canonOf[v] === v && nbrs[v].size > 0) {
        const avg = new THREE.Vector3();
        nbrs[v].forEach(nb => avg.add(verts[nb]));
        avg.divideScalar(nbrs[v].size);
        next[v].lerp(avg, relaxWt[v]);
      }
    }
    for (let v = 0; v < verts.length; v++) {
      verts[v] = canonOf[v] === v ? next[v] : next[canonOf[v]].clone();
    }
  }
}

function computeWeldedNormals(verts, idx, canonOf) {
  const normArr = new Float32Array(verts.length * 3);
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3();
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    e1.subVectors(verts[b], verts[a]);
    e2.subVectors(verts[c], verts[a]);
    fn.crossVectors(e1, e2);
    for (const v of [canonOf[a], canonOf[b], canonOf[c]]) {
      normArr[v * 3] += fn.x;
      normArr[v * 3 + 1] += fn.y;
      normArr[v * 3 + 2] += fn.z;
    }
  }
  for (let v = 0; v < verts.length; v++) {
    if (canonOf[v] === v) {
      const nx = normArr[v * 3], ny = normArr[v * 3 + 1], nz = normArr[v * 3 + 2];
      const len = Math.hypot(nx, ny, nz) || 1e-8;
      normArr[v * 3] = nx / len;
      normArr[v * 3 + 1] = ny / len;
      normArr[v * 3 + 2] = nz / len;
    }
  }
  for (let v = 0; v < verts.length; v++) {
    const c = canonOf[v];
    if (c !== v) {
      normArr[v * 3] = normArr[c * 3];
      normArr[v * 3 + 1] = normArr[c * 3 + 1];
      normArr[v * 3 + 2] = normArr[c * 3 + 2];
    }
  }
  return normArr;
}

// --- Torso / Spine Cross-Section Sculpting ---
function evalTorsoVertex(iVal, jVal) {
  const { ctrlS, ctrlZ, ctrlY } = ANATOMY.spine;
  const { nAx, nRd, socket: { i0, i1, j0: j0L, j1: j1L } } = ANATOMY.torsoMesh;
  const dI = i1 - i0, dJ = j1L - j0L;
  const iMid = 0.5 * (i0 + i1), jMidL = 0.5 * (j0L + j1L);

  const sideJ = jVal <= nRd * 0.5 ? jVal : nRd - jVal;
  const di = (iVal - iMid) / (0.5 * dI), dj = (sideJ - jMidL) / (0.5 * dJ);
  const boxD = Math.max(Math.abs(di), Math.abs(dj));
  let iEff = iVal, jEff = jVal;
  if (Math.abs(di) <= 1.75 && Math.abs(dj) <= 1.75 && (Math.abs(di) > 0.01 || Math.abs(dj) > 0.01)) {
    const rEuclid = Math.hypot(di, dj);
    const wRound = smoothstep(1.75, 1.0, boxD) * smoothstep(0.45, 1.0, boxD);
    const scale = lerp(1.0, boxD / Math.max(rEuclid, 1e-6), 0.85 * wRound);
    iEff = iMid + di * scale * (0.5 * dI);
    const sideJNew = jMidL + dj * scale * (0.5 * dJ);
    jEff = jVal <= nRd * 0.5 ? sideJNew : nRd - sideJNew;
  }

  const sEff = clamp(iEff / (nAx - 1), 0, 1);
  const zC = evalSpline(ctrlS, ctrlZ, sEff), yC = evalSpline(ctrlS, ctrlY, sEff);
  const ds = 0.5 / (nAx - 1);
  const dz = evalSpline(ctrlS, ctrlZ, Math.min(1, sEff + ds)) - evalSpline(ctrlS, ctrlZ, Math.max(0, sEff - ds));
  const dy = evalSpline(ctrlS, ctrlY, Math.min(1, sEff + ds)) - evalSpline(ctrlS, ctrlY, Math.max(0, sEff - ds));
  const tLen = Math.hypot(dz, dy) || 1e-8, nz = -dy / tLen, ny = dz / tLen;

  const tTail = smoothstep(0, 0.72, sEff), hump = Math.exp(-0.5 * ((sEff - 0.76) / 0.095) ** 2), neckT = smoothstep(0.84, 1.0, sEff);
  const rx = (0.018 + 0.36 * tTail ** 1.35 + 0.12 * hump) * (1 - 0.36 * neckT);
  const ryU = (0.022 + 0.36 * tTail ** 1.25 + 0.18 * hump) * (1 - 0.42 * neckT);
  const ryD = (0.018 + 0.27 * tTail ** 1.30 + 0.06 * hump) * (1 - 0.34 * neckT);
  const crestH = (0.038 + 0.088 * hump + 0.028 * Math.exp(-0.5 * ((sEff - 0.35) / 0.18) ** 2))
    * smoothstep(0.05, 0.18, sEff) * (1 - smoothstep(0.88, 0.98, sEff));
  const ridgeW = 0.5 + 0.5 * Math.sin(sEff * Math.PI * 48);
  const ribEnv = Math.exp(-0.5 * ((sEff - 0.73) / 0.09) ** 2);
  const ribW = Math.sin(sEff * Math.PI * 64);
  const barb = smoothstep(0.08, 0.015, sEff);

  const th = (jEff / nRd) * Math.PI * 2, sT = Math.sin(th), cT = Math.cos(th);
  let lx = rx * sT * (1 - 0.36 * (Math.max(0, (cT - 0.55) / 0.45) ** 1.5));
  const topPin = Math.max(0, (cT - 0.86) / 0.14) ** 2.2;
  const flank = Math.exp(-0.5 * ((Math.abs(sT) - 0.80) / 0.28) ** 2) * smoothstep(-0.5, 0.5, cT);
  const shMask = Math.exp(-0.5 * (((iEff - iMid) / (0.85 * dI)) ** 2 + ((sideJ - jMidL) / (0.75 * dJ)) ** 2));
  const rib = 0.026 * ribEnv * ribW * flank * (1 - 0.90 * shMask);
  let ln = (cT >= 0 ? ryU * cT : ryD * cT) + crestH * (0.42 + 0.58 * ridgeW) * topPin + 0.35 * rib * cT;
  lx += Math.sign(sT) * rib;
  ln += 0.045 * Math.exp(-0.5 * ((sEff - 0.56) / 0.08) ** 2) * Math.max(0, -cT);
  if (barb > 0 && cT > 0.65) ln += 0.065 * barb * ((cT - 0.65) / 0.35) ** 1.4;

  // Shoulder flare around arm socket
  const shFlare = Math.exp(-0.5 * (((iEff - iMid) / (1.25 * dI)) ** 2 + ((sideJ - jMidL) / (0.90 * dJ)) ** 2));
  if (Math.abs(sT) > 0.05) {
    lx += Math.sign(sT) * 0.145 * shFlare;
    ln -= 0.032 * shFlare * smoothstep(0.0, 0.75, cT);
    if (iEff > iMid) ln -= 0.018 * shFlare * smoothstep(0, 1, (iEff - iMid) / (0.85 * dI)) * smoothstep(0.3, -0.5, cT);
  }

  const p = new THREE.Vector3(lx, yC + ln * ny, zC + ln * nz);
  let cr = lerp(0.20, 0.54, 0.68 * topPin), cg = lerp(0.22, 0.52, 0.68 * topPin), cb = lerp(0.18, 0.42, 0.68 * topPin);
  const ribHi = Math.max(0, ribW) * ribEnv * flank * (1 - 0.90 * shMask);
  cr = lerp(cr, 0.62, 0.52 * ribHi); cg = lerp(cg, 0.60, 0.52 * ribHi); cb = lerp(cb, 0.49, 0.52 * ribHi);
  const sh = 1 - 0.25 * (0.5 + 0.5 * Math.sin(sEff * Math.PI * 40)) * (1 - smoothstep(0.15, 0.60, sEff));
  cr *= sh; cg *= sh; cb *= sh;
  if (cT < 0) { cr = lerp(cr, 0.14, -0.5 * cT); cg = lerp(cg, 0.15, -0.5 * cT); cb = lerp(cb, 0.13, -0.5 * cT); }
  if (sEff < 0.045 && cT > 0.3) {
    const it = (0.045 - sEff) / 0.045;
    cr = lerp(cr, 0.80, it); cg = lerp(cg, 0.77, it); cb = lerp(cb, 0.67, it);
  }
  return { p, c: [clamp(cr, 0, 1), clamp(cg, 0, 1), clamp(cb, 0, 1)] };
}

// --- Arm Centerline, Shoulder Socket Mapping & Sculpting Profiles ---
function buildArmCenterlineAndFrames(side, loopPts, loopIJ, gridPos, chestW) {
  const { nRd, socket: { i0, i1, j0: j0L, j1: j1L } } = ANATOMY.torsoMesh;
  const { L1, L2, shoulderOffset, wristRest, elbowPole } = ANATOMY.limb;
  const dI = i1 - i0, dJ = j1L - j0L;
  const iMid = 0.5 * (i0 + i1), jMidL = 0.5 * (j0L + j1L);

  const shLocal = new THREE.Vector3(side * shoulderOffset.x, shoulderOffset.y, shoulderOffset.z);
  const S0 = chestW.clone().add(shLocal);
  const W0 = new THREE.Vector3(side * wristRest.x, wristRest.y, wristRest.z);
  const pole = new THREE.Vector3(side * elbowPole.x, elbowPole.y, elbowPole.z);
  const ik = solveTwoBoneIK(S0, W0, pole, L1, L2);
  const E0Ctrl = ik.E.clone().addScaledVector(ik.perp, 0.055);
  const P0 = new THREE.Vector3();
  loopPts.forEach(p => P0.add(p));
  P0.divideScalar(loopPts.length);

  const nSOrig = 46, kB = 14, kJoin = 38;
  const tArm0 = new THREE.Vector3(side * 0.92, -0.16, -0.10).normalize();
  let ptsOrig = Array.from({ length: nSOrig }, (_, k) => {
    const s = k / (nSOrig - 1);
    if (s <= 0.44) {
      const u = s / 0.44;
      const c1 = P0.clone().addScaledVector(tArm0, 0.28);
      const c2 = E0Ctrl.clone().addScaledVector(E0Ctrl.clone().sub(P0), -0.30);
      const m = 1 - u;
      return new THREE.Vector3()
        .addScaledVector(P0, m * m * m).addScaledVector(c1, 3 * m * m * u)
        .addScaledVector(c2, 3 * m * u * u).addScaledVector(E0Ctrl, u * u * u);
    }
    return new THREE.Vector3().lerpVectors(E0Ctrl, W0, (s - 0.44) / 0.56);
  });
  for (let pass = 0; pass < 16; pass++) {
    const nx = ptsOrig.map(p => p.clone());
    for (let k = 3; k < nSOrig - 3; k++) {
      nx[k].copy(ptsOrig[k - 1]).multiplyScalar(0.25).addScaledVector(ptsOrig[k], 0.5).addScaledVector(ptsOrig[k + 1], 0.25);
    }
    ptsOrig = nx;
  }
  ptsOrig[0].copy(P0);
  ptsOrig[nSOrig - 1].copy(W0);

  // Wrist-to-knuckle palm spline
  const nW = 16, nH = 13;
  const P_w0 = ptsOrig[kJoin].clone();
  const tanFore = ptsOrig[kJoin + 1].clone().sub(ptsOrig[kJoin - 1]).normalize();
  const P_w1 = new THREE.Vector3(side * 0.822, 0.078, 0.116);
  const tanPalm = new THREE.Vector3(side * 0.02, -0.12, 0.993).normalize();
  const P_knuckle = new THREE.Vector3(side * 0.826, 0.056, 0.272);
  const B0 = P_w0, B1 = P_w0.clone().addScaledVector(tanFore, 0.245);
  const B2 = P_w1.clone().addScaledVector(tanPalm, -0.210), B3 = P_w1;

  const pts = ptsOrig.slice(0, kJoin + 1);
  for (let i = 1; i <= nW; i++) {
    const u = i / nW, m = 1 - u;
    pts.push(new THREE.Vector3()
      .addScaledVector(B0, m * m * m).addScaledVector(B1, 3 * m * m * u)
      .addScaledVector(B2, 3 * m * u * u).addScaledVector(B3, u * u * u));
  }
  for (let i = 1; i <= nH; i++) pts.push(new THREE.Vector3().lerpVectors(P_w1, P_knuckle, i / nH));
  const nTot = pts.length;

  // Shoulder socket exit tangents (edit here when tuning shoulder/back-of-arm socket transitions)
  const jMidS = side === 1 ? jMidL : (nRd - jMidL);
  const loopTans = loopIJ.map(([i, j], m) => {
    const gi = i - iMid, gj = j - jMidS;
    const gl = Math.max(Math.abs(gi / (0.5 * dI)), Math.abs(gj / (0.5 * dJ)), 1e-6);
    const pOut = evalTorsoVertex(i + 0.7 * gi / gl, j + 0.7 * gj / gl).p;
    const tVec = gridPos[i][j].clone().sub(pOut);
    const rHat = loopPts[m].clone().sub(P0);
    rHat.x = 0;
    if (rHat.lengthSq() > 1e-12) {
      rHat.normalize();
      const inward = tVec.dot(rHat);
      if (inward < 0) tVec.addScaledVector(rHat, -inward);
    }
    tVec.divideScalar(tVec.length() || 1e-6).multiplyScalar(0.50).addScaledVector(tArm0, 0.50).normalize();
    return tVec;
  });

  // Parallel-transport frames along arm & palm
  const tans = pts.map((_, k) => (
    k === 0 ? pts[1].clone().sub(pts[0]) : (k === nTot - 1 ? pts[k].clone().sub(pts[k - 1]) : pts[k + 1].clone().sub(pts[k - 1]))
  ).normalize());
  const outDs = new Array(nTot), latDs = new Array(nTot);
  for (let k = 0; k < 36; k++) {
    const tan = tans[k];
    const outD = ik.perp.clone().addScaledVector(tan, -ik.perp.dot(tan)).normalize();
    outDs[k] = outD;
    latDs[k] = new THREE.Vector3().crossVectors(tan, outD).normalize();
  }
  const stepQ = new THREE.Quaternion();
  for (let k = 36; k < nTot; k++) {
    stepQ.setFromUnitVectors(tans[k - 1], tans[k]);
    const tan = tans[k];
    const outD = outDs[k - 1].clone().applyQuaternion(stepQ);
    outD.addScaledVector(tan, -outD.dot(tan)).normalize();
    outDs[k] = outD;
    latDs[k] = new THREE.Vector3().crossVectors(tan, outD).normalize();
  }
  const tanEnd = tans[nTot - 1];
  const handDown = new THREE.Vector3(0, -1, 0).addScaledVector(tanEnd, tanEnd.y).normalize();
  const rollCross = new THREE.Vector3().crossVectors(outDs[nTot - 1], handDown);
  const rollErr = Math.atan2(rollCross.dot(tanEnd), outDs[nTot - 1].dot(handDown));
  for (let k = 36; k < nTot; k++) {
    const uRoll = smoothstep(35, kJoin + nW, k);
    outDs[k].applyAxisAngle(tans[k], rollErr * uRoll).normalize();
    latDs[k].crossVectors(tans[k], outDs[k]).normalize();
  }

  const uCoords = new Array(nTot);
  for (let k = 0; k <= kJoin; k++) uCoords[k] = (k / (nSOrig - 1)) * 2.1;
  for (let k = kJoin + 1; k < nTot; k++) uCoords[k] = uCoords[k - 1] + pts[k].distanceTo(pts[k - 1]) * 0.79;

  const outB = outDs[kB], latB = latDs[kB];
  const phis = loopPts.map(p => { const d = p.clone().sub(P0); return Math.atan2(d.dot(latB), d.dot(outB)); });
  for (let m = 1; m < loopPts.length; m++) {
    let diff = phis[m] - phis[m - 1];
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    phis[m] = phis[m - 1] + diff;
  }
  const signDir = (phis[loopPts.length - 1] - phis[0]) > 0 ? 1 : -1;

  return { pts, tans, outDs, latDs, uCoords, phis, signDir, loopTans, P0, nSOrig, kB, kJoin, nTot };
}

function sculptArmCrossSection(s, cT, sT, center, outD, latD) {
  const delt = 0.056 * Math.exp(-0.5 * ((s - 0.16) / 0.09) ** 2);
  const bicep = 0.036 * Math.exp(-0.5 * ((s - 0.30) / 0.085) ** 2);
  const foreB = 0.035 * Math.exp(-0.5 * ((s - 0.56) / 0.10) ** 2);
  const rO = 0.04 + 0.185 * (1 - 0.50 * s) + delt + bicep + foreB;
  const rL = 0.04 + 0.175 * (1 - 0.48 * s) + delt * 0.9 + bicep * 0.8 + foreB * 0.7;
  const spurRidge = Math.exp(-0.5 * ((s - 0.44) / 0.042) ** 2);
  const fEnv = smoothstep(0.48, 0.58, s) * (1 - smoothstep(0.76, 0.88, s));
  const sW = Math.sin(s * Math.PI * 56);
  const ridge = spurRidge * (Math.max(0, (cT - 0.45) / 0.55) ** 1.8);
  const innerTuck = 1 - 0.14 * Math.exp(-0.5 * ((s - 0.44) / 0.075) ** 2) * Math.max(0, -cT);
  const ro = rO * cT * innerTuck + 0.11 * ridge + 0.022 * fEnv * sW * Math.max(0, cT);
  const rl = rL * sT * (1 - 0.35 * ridge);
  const p = center.clone().addScaledVector(outD, ro).addScaledVector(latD, rl);
  const bt = fEnv > 0 && cT > -0.15 ? Math.max(0, sW) * fEnv * Math.max(0, (cT + 0.15) / 1.15) : 0;
  return { p, c: [lerp(0.21, 0.50, 0.68 * bt), lerp(0.23, 0.48, 0.68 * bt), lerp(0.19, 0.39, 0.68 * bt)] };
}

function sculptHandCrossSection(uHand, sOrig, side, cT, sT, center, tan, outD, latD) {
  const handBell = smoothstep(0.32, 0.72, uHand) * (1 - 0.18 * smoothstep(0.82, 0.96, uHand));
  const tipU = clamp((uHand - 0.88) / 0.12, 0, 1);
  const tipScale = Math.sqrt(Math.max(0.03, 1 - 0.94 * (tipU ** 2)));
  const rD = (lerp(0.1469, 0.104, smoothstep(0, 0.42, uHand)) - lerp(0, 0.048, smoothstep(0.42, 0.92, uHand))) * tipScale;
  const rP = (lerp(0.1469, 0.078, smoothstep(0, 0.44, uHand)) - lerp(0, 0.030, smoothstep(0.44, 0.92, uHand))) * tipScale;
  const rL = (lerp(0.1441, 0.118, smoothstep(0, 0.36, uHand)) + 0.036 * handBell) * tipScale;

  const fEnv = smoothstep(0.48, 0.58, sOrig) * (1 - smoothstep(0.76, 0.88, sOrig)), sW = Math.sin(sOrig * Math.PI * 56);
  const dors = Math.max(0, -cT), xRel = side * sT;
  const dorsFactor = 1 + 0.06 * smoothstep(0.30, 0.62, uHand) * (1 - sT * sT);
  const tendonEnv = smoothstep(0.38, 0.58, uHand) * (1 - smoothstep(0.88, 1.0, uHand)) * (dors ** 1.15);
  const tendon =
    Math.exp(-0.5 * ((xRel + 0.62) / 0.13) ** 2) + Math.exp(-0.5 * ((xRel + 0.22) / 0.13) ** 2) +
    Math.exp(-0.5 * ((xRel - 0.18) / 0.13) ** 2) + Math.exp(-0.5 * ((xRel - 0.60) / 0.13) ** 2);
  const palmArch = 1 - 0.08 * Math.exp(-0.5 * ((uHand - 0.74) / 0.10) ** 2) * (1 - sT * sT);

  let ro = (cT >= 0 ? rP * cT * palmArch : rD * cT * dorsFactor) - 0.011 * tendonEnv * tendon;
  ro += 0.022 * fEnv * sW * Math.max(0, cT);
  const rl = rL * sT;
  const archU = smoothstep(0.68, 0.98, uHand);
  const zArch = (0.012 * (1 - sT * sT) - 0.028 * (Math.max(0, -xRel) ** 1.4) - 0.014 * (Math.max(0, xRel) ** 1.4)) * archU;
  const tipPush = 0.016 * smoothstep(0.88, 1.0, uHand) * Math.sqrt(Math.max(0, 1 - 0.5 * sT * sT - 0.5 * cT * cT));
  const p = center.clone().addScaledVector(outD, ro).addScaledVector(latD, rl).addScaledVector(tan, zArch + tipPush);

  const bt = fEnv > 0 && cT > -0.15 ? Math.max(0, sW) * fEnv * Math.max(0, (cT + 0.15) / 1.15) : 0;
  let cr = lerp(0.21, 0.50, 0.68 * bt), cg = lerp(0.23, 0.48, 0.68 * bt), cb = lerp(0.19, 0.39, 0.68 * bt);
  const tdHi = clamp(tendonEnv * tendon * 0.26, 0, 0.34);
  cr = lerp(cr, 0.43, tdHi); cg = lerp(cg, 0.42, tdHi); cb = lerp(cb, 0.34, tdHi);
  const palmDark = smoothstep(0.32, 0.60, uHand) * Math.max(0, cT);
  cr = lerp(cr, 0.15, 0.50 * palmDark); cg = lerp(cg, 0.16, 0.50 * palmDark); cb = lerp(cb, 0.14, 0.50 * palmDark);
  return { p, c: [cr, cg, cb] };
}

function buildBodyAndLimbsGeometry(chestW) {
  const { ctrlS, ctrlZ, ctrlY, stationS } = ANATOMY.spine;
  const { nAx, nRd, socket: { i0, i1, j0: j0L, j1: j1L } } = ANATOMY.torsoMesh;
  const j0R = nRd - j1L, j1R = nRd - j0L;
  const dI = i1 - i0, dJ = j1L - j0L;
  const iMid = 0.5 * (i0 + i1), jMidL = 0.5 * (j0L + j1L);

  const gridPos = Array.from({ length: nAx }, () => Array(nRd));
  const gridCol = Array.from({ length: nAx }, () => Array(nRd));
  const verts = [], cols = [], uvs = [], si = [], sw = [], idx = [];
  const canonOf = [], relaxWt = [];
  const vid = Array.from({ length: nAx }, () => Array(nRd + 1).fill(-1));
  const insideQuad = (i, j) => (i >= i0 && i < i1 && j >= j0L && j < j1L) || (i >= i0 && i < i1 && j >= j0R && j < j1R);
  const strictlyInside = (i, j) => (i > i0 && i < i1 && j > j0L && j < j1L) || (i > i0 && i < i1 && j > j0R && j < j1R);

  const addVert = (p, c, u, v, bones, weights, canon = -1, rWt = 0) => {
    const id = verts.length;
    verts.push(p.clone()); cols.push(c); uvs.push(u, v);
    si.push(bones[0], bones[1], bones[2], bones[3]);
    sw.push(weights[0], weights[1], weights[2], weights[3]);
    canonOf.push(canon >= 0 ? canon : id);
    relaxWt.push(rWt);
    return id;
  };

  for (let i = 0; i < nAx; i++) {
    const sRaw = i / (nAx - 1);
    let b0 = 0, b1 = 0, w0 = 1, w1 = 0;
    if (sRaw >= stationS[stationS.length - 1]) b0 = b1 = stationS.length - 1;
    else if (sRaw > stationS[0]) {
      for (let k = 0; k < stationS.length - 1; k++) {
        if (sRaw >= stationS[k] && sRaw <= stationS[k + 1]) {
          b0 = k; b1 = k + 1;
          const t = (sRaw - stationS[k]) / (stationS[k + 1] - stationS[k]);
          w1 = t * t * (3 - 2 * t); w0 = 1 - w1;
          break;
        }
      }
    }
    for (let j = 0; j < nRd; j++) {
      const pt = evalTorsoVertex(i, j);
      gridPos[i][j] = pt.p; gridCol[i][j] = pt.c;
      if (strictlyInside(i, j)) continue;
      const sideJ = j <= nRd * 0.5 ? j : nRd - j;
      const diAbs = Math.max(0, Math.abs(i - iMid) - 0.5 * dI), djAbs = Math.max(0, Math.abs(sideJ - jMidL) - 0.5 * dJ);
      const dBox = Math.hypot(diAbs, djAbs);
      const rWt = (dBox <= 2.2 && sideJ >= 3 && sideJ <= 13) ? 0.45 * smoothstep(2.4, 0, dBox) : 0;
      vid[i][j] = addVert(pt.p, pt.c, sRaw * 6, j / nRd, [b0, b1, 0, 0], [w0, w1, 0, 0], -1, rWt);
    }
    vid[i][nRd] = addVert(gridPos[i][0], gridCol[i][0], sRaw * 6, 1.0, [b0, b1, 0, 0], [w0, w1, 0, 0], vid[i][0], 0);
  }

  for (let i = 0; i < nAx - 1; i++) {
    for (let j = 0; j < nRd; j++) {
      if (insideQuad(i, j)) continue;
      const a = vid[i][j], b = vid[i + 1][j], c = vid[i + 1][j + 1], d = vid[i][j + 1];
      idx.push(a, b, c, a, c, d);
    }
  }

  // Tail tip & neck end caps
  const tip = addVert(new THREE.Vector3(0, evalSpline(ctrlS, ctrlY, 0), evalSpline(ctrlS, ctrlZ, 0) - 0.06), [0.80, 0.77, 0.67], 0, 0.5, [0, 0, 0, 0], [1, 0, 0, 0]);
  for (let j = 0; j < nRd; j++) idx.push(tip, vid[0][j], vid[0][j + 1]);
  const nCap = addVert(new THREE.Vector3(0, evalSpline(ctrlS, ctrlY, 1), evalSpline(ctrlS, ctrlZ, 1)), [0.18, 0.19, 0.16], 6, 0.5, [stationS.length - 1, 0, 0, 0], [1, 0, 0, 0]);
  for (let j = 0; j < nRd; j++) idx.push(nCap, vid[nAx - 1][j + 1], vid[nAx - 1][j]);

  // Stitch Left & Right arms onto torso sockets
  for (let sIdx = 0; sIdx < 2; sIdx++) {
    const side = sIdx === 0 ? 1 : -1;
    const j0 = side === 1 ? j0L : j0R, j1 = side === 1 ? j1L : j1R;
    const loopIJ = [];
    for (let i = i0; i < i1; i++) loopIJ.push([i, j0]);
    for (let j = j0; j < j1; j++) loopIJ.push([i1, j]);
    for (let i = i1; i > i0; i--) loopIJ.push([i, j1]);
    for (let j = j1; j > j0; j--) loopIJ.push([i0, j]);
    const loopVids = loopIJ.map(([i, j]) => vid[i][j]);
    const loopPts = loopVids.map(v => verts[v].clone());
    const nR = loopVids.length;

    const arm = buildArmCenterlineAndFrames(side, loopPts, loopIJ, gridPos, chestW);
    const { pts, tans, outDs, latDs, uCoords, phis, signDir, loopTans, nSOrig, kB, kJoin, nTot } = arm;

    const shBone = 11 + sIdx * 3, elBone = shBone + 1, wrBone = shBone + 2;
    const ring0Arm = loopVids.map((vt, m) => {
      const b = [si[vt * 4], si[vt * 4 + 1], si[vt * 4 + 2], si[vt * 4 + 3]];
      const w = [sw[vt * 4], sw[vt * 4 + 1], sw[vt * 4 + 2], sw[vt * 4 + 3]];
      return addVert(verts[vt], cols[vt], 0, (m / nR) * (2 / 3), b, w, vt, 0);
    });
    const v0 = ring0Arm[0];
    ring0Arm.push(addVert(verts[v0], cols[v0], 0, 2 / 3, [si[v0 * 4], si[v0 * 4 + 1], si[v0 * 4 + 2], si[v0 * 4 + 3]], [sw[v0 * 4], sw[v0 * 4 + 1], sw[v0 * 4 + 2], sw[v0 * 4 + 3]], loopVids[0], 0));
    let prevRing = ring0Arm;

    for (let k = 1; k < nTot; k++) {
      const sOrig = k / (nSOrig - 1);
      const uHand = clamp((k - kJoin) / (nTot - 1 - kJoin), 0, 1);
      const uCoord = uCoords[k], curRing = [];
      for (let m = 0; m < nR; m++) {
        const thUni = phis[0] + signDir * (m / nR) * Math.PI * 2;
        const th = lerp(phis[m], thUni, smoothstep(0.05, 0.44, sOrig));
        const cT = Math.cos(th), sT = Math.sin(th);
        const sculpted = k <= kJoin
          ? sculptArmCrossSection(sOrig, cT, sT, pts[k], outDs[k], latDs[k])
          : sculptHandCrossSection(uHand, sOrig, side, cT, sT, pts[k], tans[k], outDs[k], latDs[k]);

        let p = sculpted.p, c = sculpted.c;
        if (k <= kB) {
          const u = k / kB;
          const pCont = loopPts[m].clone().addScaledVector(loopTans[m], u * 0.40);
          p = pCont.lerp(sculpted.p, smootherstep(0, 1, u));
          const cSock = cols[loopVids[m]], tc = smoothstep(0, 0.85, u);
          c = [lerp(cSock[0], sculpted.c[0], tc), lerp(cSock[1], sculpted.c[1], tc), lerp(cSock[2], sculpted.c[2], tc)];
        }

        const vs = loopVids[m], sb0 = si[vs * 4], sb1 = si[vs * 4 + 1], sw0 = sw[vs * 4], sw1 = sw[vs * 4 + 1];
        let vBones, vWeights;
        if (k <= kJoin && sOrig <= 0.34) {
          const a = smoothstep(0, 0.34, sOrig);
          vBones = [sb0, sb1, shBone, 0]; vWeights = [sw0 * (1 - a), sw1 * (1 - a), a, 0];
        } else if (k <= kJoin && sOrig <= 0.38) {
          vBones = [shBone, elBone, 0, 0]; vWeights = [1, 0, 0, 0];
        } else if (k <= kJoin && sOrig <= 0.54) {
          const a = smoothstep(0.38, 0.54, sOrig);
          vBones = [shBone, elBone, 0, 0]; vWeights = [1 - a, a, 0, 0];
        } else if (k <= kJoin) {
          vBones = [elBone, wrBone, 0, 0]; vWeights = [1, 0, 0, 0];
        } else {
          const a = smoothstep(0.12, 0.48, uHand);
          vBones = [elBone, wrBone, 0, 0]; vWeights = [1 - a, a, 0, 0];
        }
        const rWt = k <= 6 ? 0.45 * smoothstep(7, 0, k) : 0;
        curRing.push(addVert(p, c, uCoord, (m / nR) * (2 / 3), vBones, vWeights, -1, rWt));
      }
      const c0 = curRing[0];
      curRing.push(addVert(verts[c0], cols[c0], uCoord, 2 / 3, [si[c0 * 4], si[c0 * 4 + 1], si[c0 * 4 + 2], si[c0 * 4 + 3]], [sw[c0 * 4], sw[c0 * 4 + 1], sw[c0 * 4 + 2], sw[c0 * 4 + 3]], c0, 0));
      for (let m = 0; m < nR; m++) {
        const a0 = prevRing[m], a1 = prevRing[m + 1], b0 = curRing[m], b1 = curRing[m + 1];
        idx.push(a0, a1, b1, a0, b1, b0);
      }
      prevRing = curRing;
    }
    const wCap = addVert(pts[nTot - 1].clone().addScaledVector(tans[nTot - 1], 0.014), [0.21, 0.23, 0.19], uCoords[nTot - 1] + 0.014 * 0.79, 1 / 3, [elBone, wrBone, 0, 0], [0, 1, 0, 0]);
    for (let m = 0; m < nR; m++) idx.push(wCap, prevRing[m], prevRing[m + 1]);
  }

  relaxVertices(verts, idx, canonOf, relaxWt, 4);
  const normArr = computeWeldedNormals(verts, idx, canonOf);

  const posArr = [], colArr = [];
  for (let v = 0; v < verts.length; v++) {
    posArr.push(verts[v].x, verts[v].y, verts[v].z);
    colArr.push(cols[v][0], cols[v][1], cols[v][2]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colArr, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  g.setAttribute('normal', new THREE.BufferAttribute(normArr, 3));
  g.setIndex(idx);
  return g;
}

// --- Head, Skull (uses boneMat), Jaw, Teeth, Gullet & Bendable Tongue Rig ---
function buildTeethMesh(fn, count, inner, toothMat) {
  const pos = [], col = [], idx = [];
  const cone = (base, dir, len, rad, sgn) => {
    const d = new THREE.Vector3(dir[0] * sgn, dir[1], dir[2]).normalize();
    const t1 = new THREE.Vector3().crossVectors(d, Math.abs(d.x) < 0.8 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1)).normalize();
    const t2 = new THREE.Vector3().crossVectors(d, t1).normalize(), bi = pos.length / 3;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const p = base.clone().addScaledVector(t1, rad * Math.cos(a)).addScaledVector(t2, rad * Math.sin(a));
      pos.push(p.x, p.y, p.z); col.push(0.74, 0.68, 0.58);
    }
    const tp = base.clone().addScaledVector(d, len).add(new THREE.Vector3(0, 0, -0.012));
    pos.push(tp.x, tp.y, tp.z); col.push(0.95, 0.92, 0.84);
    for (let i = 0; i < 6; i++) idx.push(bi + i, bi + ((i + 1) % 6), bi + 6);
  };
  for (let k = 0; k < count; k++) {
    const o = fn(k, false);
    for (const sgn of [-1, 1]) {
      cone(new THREE.Vector3(sgn * o.x, o.y, o.z), o.dir, o.len, o.rad, sgn);
      if (inner && k % 2 === 0) {
        const n = fn(k, true);
        cone(new THREE.Vector3(sgn * n.x, n.y, n.z), n.dir, n.len, n.rad, sgn);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return new THREE.Mesh(g, toothMat);
}

function buildJawMesh(skinMat) {
  const nU = 34, nV = 28, pos = [], col = [], uv = [], idx = [];
  for (let i = 0; i < nU; i++) {
    const u = i / (nU - 1), tip = smoothstep(0.88, 1.0, u);
    const tEnd = clamp((u - 0.93) / 0.07, 0, 1), endRound = Math.sqrt(Math.max(0.02, 1 - 0.86 * tEnd * tEnd));
    const tipFade = (1 - 0.56 * tip) * endRound;
    const hw = (0.242 * (1 - 0.65 * u ** 1.08) + 0.014 * Math.exp(-0.5 * ((u - 0.45) / 0.16) ** 2)) * tipFade;
    const hU = 0.036 * (1 - 0.4 * u) * endRound, hD = -0.115 * (1 - 0.62 * u ** 1.05) * (1 - 0.52 * tip) * endRound;
    for (let j = 0; j < nV; j++) {
      const v = (j / nV) * Math.PI * 2, sV = Math.sin(v), cV = Math.cos(v);
      const yTop = hU * Math.exp(-0.5 * ((Math.abs(sV) - 0.85) / 0.18) ** 2) - 0.035 * (1 - tip) * (1 - Math.abs(sV)) * Math.max(0, cV);
      const yBot = hD * (Math.max(0, -cV) ** 0.85);
      const ly = lerp(yBot, yTop, smoothstep(-0.14, 0.14, cV));
      pos.push(hw * sV, ly, -0.08 + 1.07 * u);
      uv.push(u * 1.2, j / nV);
      if (cV > 0.08 && Math.abs(sV) < 0.72) col.push(0.42, 0.14, 0.15);
      else if (u > 0.30 && Math.abs(sV) > 0.55 && cV > -0.45) {
        const bt = smoothstep(0.30, 0.65, u);
        col.push(lerp(0.19, 0.74, bt), lerp(0.21, 0.71, bt), lerp(0.17, 0.63, bt));
      } else col.push(0.19, 0.21, 0.17);
    }
  }
  for (let i = 0; i < nU - 1; i++) {
    for (let j = 0; j < nV; j++) {
      const jn = (j + 1) % nV, a = i * nV + j, b = (i + 1) * nV + j, c = (i + 1) * nV + jn, d = i * nV + jn;
      idx.push(a, b, c, a, c, d);
    }
  }
  const tipI = pos.length / 3;
  pos.push(0, -0.010, 0.996); uv.push(1.2, 0.5); col.push(0.74, 0.71, 0.63);
  for (let j = 0; j < nV; j++) idx.push(tipI, (nU - 1) * nV + ((j + 1) % nV), (nU - 1) * nV + j);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, skinMat);
  m.castShadow = m.receiveShadow = true;
  return m;
}

function buildTongueRig(jawBone, wetMat) {
  const { basePos, shaftLength, boneZs, prongs, prongJointTs } = ANATOMY.tongue;
  const tongueRoot = new THREE.Group();
  tongueRoot.position.set(basePos[0], basePos[1], basePos[2]);
  jawBone.add(tongueRoot);

  // 7-bone main shaft chain (supports smooth S-bends & stretch with zero shear)
  const tongueBones = [];
  const tongueRestDz = [];
  for (let i = 0; i < boneZs.length; i++) {
    const b = new THREE.Bone();
    b.name = `tongue${i}`;
    const dz = i === 0 ? boneZs[0] : (boneZs[i] - boneZs[i - 1]);
    b.position.set(0, 0, dz);
    tongueRestDz.push(dz);
    if (i === 0) tongueRoot.add(b);
    else tongueBones[i - 1].add(b);
    tongueBones.push(b);
  }

  const shaftGeo = createSkinnedTubeGeometry(30, 12, boneZs, t => ({
    x: 0,
    y: 0.015 * Math.sin(t * Math.PI),
    z: t * shaftLength,
    r: 0.050 * (1 - 0.32 * t),
    col: [lerp(0.66, 0.76, t), lerp(0.22, 0.34, t), lerp(0.24, 0.34, t)],
  }));
  const tongueMesh = new THREE.SkinnedMesh(shaftGeo, wetMat);
  tongueMesh.frustumCulled = false;
  tongueRoot.add(tongueMesh);
  tongueRoot.updateMatrixWorld(true);
  tongueMesh.bind(new THREE.Skeleton(tongueBones));

  // Bendable 3-prong tip attached to shaft tip bone (tongue6 at z = 0.38)
  const prongAnchor = new THREE.Group();
  prongAnchor.position.set(0, 0.006, 0);
  tongueBones[tongueBones.length - 1].add(prongAnchor);

  const tongueProngs = [];
  const prongRigs = prongs.map((pd, pIdx) => {
    const pivot = new THREE.Group();
    prongAnchor.add(pivot);
    tongueProngs.push(pivot);

    const profile = t => ({
      x: pd.x * (t ** 0.85),
      y: -0.04 * Math.sin(t * Math.PI * 0.7) + pd.up * (t ** 1.9),
      z: t * pd.len,
      r: pd.r * (1 - 0.90 * (t ** 1.3)),
      col: [lerp(0.74, 0.86, t), lerp(0.32, 0.50, t), lerp(0.32, 0.46, t)],
    });

    const pBones = [], restOffsets = [];
    let prevPt = new THREE.Vector3(0, 0, 0);
    for (let k = 0; k < prongJointTs.length; k++) {
      const s = profile(prongJointTs[k]);
      const pt = new THREE.Vector3(s.x, s.y, s.z);
      const offset = pt.clone().sub(prevPt);
      prevPt = pt;
      const b = new THREE.Bone();
      b.name = `tongueProng${pIdx}_${k}`;
      b.position.copy(offset);
      restOffsets.push(offset);
      if (k === 0) pivot.add(b);
      else pBones[k - 1].add(b);
      pBones.push(b);
    }

    const pGeo = createSkinnedTubeGeometry(18, 10, prongJointTs, profile, t => t);
    const pMesh = new THREE.SkinnedMesh(pGeo, wetMat);
    pMesh.frustumCulled = false;
    pivot.add(pMesh);
    pivot.updateMatrixWorld(true);
    pMesh.bind(new THREE.Skeleton(pBones));

    return { pivot, bones: pBones, restOffsets, spreadSign: pd.spreadSign };
  });

  return { tongueRoot, tongueBones, tongueRestDz, tongueMesh, tongueProngs, prongRigs };
}

function buildHeadAssembly(headBone, materials) {
  const nU = 56, nV = 48, pos = [], col = [], uv = [], idx = [];
  const prof = (u) => {
    const tip = smoothstep(0.89, 1.0, u), rearT = smoothstep(0.0, 0.16, u);
    const tEnd = clamp((u - 0.93) / 0.07, 0, 1), endRound = Math.sqrt(Math.max(0.02, 1 - 0.88 * tEnd * tEnd));
    const tipFade = (1 - 0.56 * tip) * endRound;
    const hwS = (0.25 * (1 - 0.62 * u ** 1.18) + 0.055 * Math.exp(-0.5 * ((u - 0.22) / 0.10) ** 2) + 0.030 * Math.exp(-0.5 * ((u - 0.50) / 0.11) ** 2)) * tipFade;
    const hTS = (0.26 * (1 - 0.56 * u ** 1.08) + 0.03 * Math.exp(-0.5 * ((u - 0.24) / 0.14) ** 2)) * tipFade;
    return { hw: lerp(0.22, hwS, rearT), hT: lerp(0.21, hTS, rearT), hB: lerp(-0.11, -0.065 * (1 - 0.35 * u) * tipFade, rearT), z: -0.20 + 1.24 * u, tip };
  };
  const rimF = 0.35 + 0.65 * Math.exp(-0.5 * ((1 - 0.88) / 0.16) ** 2);
  for (let i = 0; i < nU; i++) {
    const u = i / (nU - 1), { hw, hT, hB, z, tip } = prof(u), yRim = hB * rimF;
    for (let j = 0; j < nV; j++) {
      const v = (j / nV) * Math.PI * 2, sV = Math.sin(v), cV = Math.cos(v);
      const bridge = 1 - 0.04 * smoothstep(0.45, 0.15, Math.abs(sV)) * smoothstep(0.25, 0.45, u);
      const yTop = yRim + (hT * bridge - yRim) * (Math.max(0, cV) ** 0.78);
      const yBot = hB * (0.35 + 0.65 * Math.exp(-0.5 * ((Math.abs(sV) - 0.88) / 0.16) ** 2)) + 0.055 * (1 - tip) * (1 - Math.abs(sV)) * Math.max(0, -cV);
      let lx = hw * sV, ly = lerp(yBot, yTop, smoothstep(-0.12, 0.08, cV));
      const horn = Math.exp(-0.5 * ((u - 0.22) / 0.085) ** 2) * Math.exp(-0.5 * ((Math.abs(sV) - 0.86) / 0.22) ** 2) * smoothstep(0.0, 0.50, cV);
      lx += Math.sign(sV) * 0.065 * horn; ly += 0.048 * horn; const zH = -0.035 * horn;
      const brow = Math.exp(-0.5 * ((u - 0.48) / 0.16) ** 2) * Math.exp(-0.5 * ((Math.abs(sV) - 0.56) / 0.15) ** 2) * smoothstep(0.35, 0.85, cV);
      ly += 0.054 * brow; lx += Math.sign(sV) * 0.028 * brow;
      const fSide = smoothstep(0.42, 0.84, Math.abs(sV));
      const fen = Math.exp(-1.5 * (((u - 0.58) / 0.11) ** 2 + ((cV - 0.36) / 0.24) ** 2)) * fSide;
      const nos = Math.exp(-2.0 * (((u - 0.87) / 0.052) ** 2 + ((cV - 0.56) / 0.22) ** 2)) * smoothstep(0.28, 0.72, Math.abs(sV));
      const eye = Math.exp(-2.2 * (((u - 0.33) / 0.052) ** 2 + ((cV - 0.24) / 0.16) ** 2)) * fSide;
      lx -= Math.sign(sV) * (0.095 * fen + 0.024 * nos + 0.046 * eye);
      ly -= (0.025 * fen + 0.015 * nos + 0.014 * eye);
      pos.push(lx, ly, z + zH); uv.push(u * 1.4, j / nV);

      const mT = smoothstep(0.14, 0.30, u) * smoothstep(-0.35, 0.15, cV);
      let cr = lerp(0.20, 0.83, mT), cg = lerp(0.22, 0.80, mT), cb = lerp(0.18, 0.72, mT);
      if (cV < -0.18 && Math.abs(sV) < 0.76 && u < 0.90) {
        const pt = Math.min(1, (-cV - 0.18) / 0.40) * smoothstep(0.76, 0.45, Math.abs(sV)) * smoothstep(0.90, 0.78, u);
        cr = lerp(cr, 0.38, pt); cg = lerp(cg, 0.12, pt); cb = lerp(cb, 0.13, pt);
      }
      const dp = clamp(fen * 1.6 + nos * 1.4 + eye * 1.25, 0, 1);
      col.push(lerp(cr, 0.04, dp), lerp(cg, 0.04, dp), lerp(cb, 0.04, dp));
    }
  }
  for (let i = 0; i < nU - 1; i++) {
    for (let j = 0; j < nV; j++) {
      const jn = (j + 1) % nV, a = i * nV + j, b = (i + 1) * nV + j, c = (i + 1) * nV + jn, d = i * nV + jn;
      idx.push(a, b, c, a, c, d);
    }
  }
  const rIdx = pos.length / 3; pos.push(0, 0.04, -0.22); uv.push(0, 0.5); col.push(0.20, 0.22, 0.18);
  for (let j = 0; j < nV; j++) idx.push(rIdx, j, (j + 1) % nV);
  const stIdx = pos.length / 3; pos.push(0, 0.002, 1.046); uv.push(1.4, 0.5); col.push(0.83, 0.80, 0.72);
  for (let j = 0; j < nV; j++) idx.push(stIdx, (nU - 1) * nV + ((j + 1) % nV), (nU - 1) * nV + j);

  const skGeo = new THREE.BufferGeometry();
  skGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  skGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  skGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  skGeo.setIndex(idx);
  skGeo.computeVertexNormals();
  // Skull uses procedural bone material (with vertex colors preserving sockets & rear fade)
  const skMesh = new THREE.Mesh(skGeo, materials.boneMat);
  skMesh.castShadow = skMesh.receiveShadow = true;
  headBone.add(skMesh);

  for (const sgn of [-1, 1]) {
    const eg = new THREE.Group();
    eg.position.set(sgn * 0.182, 0.052, 0.205);
    eg.add(new THREE.Mesh(new THREE.SphereGeometry(0.022, 12, 10), new THREE.MeshStandardMaterial({ color: 0x4f4c24, roughness: 0.06, metalness: 0.08 })));
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.011, 8, 8), new THREE.MeshBasicMaterial({ color: 0x050504 }));
    p.scale.set(0.7, 1.15, 0.45);
    p.position.set(sgn * 0.014, 0, 0.004);
    eg.add(p);
    headBone.add(eg);
  }

  headBone.add(buildTeethMesh((k, inn) => {
    const u = 0.25 + 0.65 * (k / 12), { hw, z, tip } = prof(u), alt = k % 2 === 0 ? 1.12 : 0.78;
    return {
      z,
      x: hw * (inn ? 0.58 : 0.80),
      y: -0.050 * (1 - 0.35 * u) * (1 - 0.62 * tip) + (inn ? 0.012 : 0),
      dir: [-0.12, -1, -0.08],
      len: (inn ? 0.022 : 0.036 + 0.026 * Math.sin(u * Math.PI)) * alt,
      rad: inn ? 0.0075 : 0.0095,
    };
  }, 13, true, materials.toothMat));

  const jawBone = new THREE.Bone();
  jawBone.position.set(0, -0.066, 0.02);
  headBone.add(jawBone);
  jawBone.add(buildJawMesh(materials.skinMat));
  jawBone.add(buildTeethMesh((k, inn) => {
    const u = 0.19 + 0.70 * (k / 11), tip = smoothstep(0.88, 1.0, u);
    const tEnd = clamp((u - 0.93) / 0.07, 0, 1), endRound = Math.sqrt(Math.max(0.02, 1 - 0.86 * tEnd * tEnd));
    const hw = (0.242 * (1 - 0.65 * u ** 1.08) + 0.014 * Math.exp(-0.5 * ((u - 0.45) / 0.16) ** 2)) * (1 - 0.56 * tip) * endRound;
    const alt = k % 2 === 0 ? 1.10 : 0.78;
    return {
      z: -0.08 + 1.07 * u,
      x: hw * (inn ? 0.58 : 0.78),
      y: 0.022 * (1 - 0.35 * u),
      dir: [-0.12, 1, -0.08],
      len: (inn ? 0.020 : 0.032 + 0.024 * Math.sin(u * Math.PI)) * alt,
      rad: inn ? 0.007 : 0.0085,
    };
  }, 12, false, materials.toothMat));

  // Gullet mesh skinned across headBone & jawBone
  const gPos = [], gCol = [], gSi = [], gSw = [], gIdx = [];
  for (let i = 0; i < 14; i++) {
    const u = i / 13, z = -0.28 + 0.84 * u, rx = 0.155 * (1 - 0.28 * smoothstep(0.3, 1.0, u)), deep = 1 - smoothstep(0, 0.55, u);
    for (let j = 0; j < 20; j++) {
      const a = (j / 20) * Math.PI * 2, sa = Math.sin(a), ca = Math.cos(a);
      let px = rx * sa;
      if (u > 0.65 && Math.abs(sa) > 0.5) px *= (1 - 0.15 * (u - 0.65) / 0.35);
      const py = lerp(0.05 * (1 - 0.3 * u) + 0.04 * ca, -0.02 + 0.04 * ca, smoothstep(0.35, -0.45, ca));
      const wJ = smoothstep(0.35, -0.45, ca) * smoothstep(0.08, 0.35, u);
      gPos.push(px, py - 0.035 * wJ, z);
      gCol.push(lerp(0.38, 0.08, deep), lerp(0.11, 0.03, deep), lerp(0.12, 0.04, deep));
      gSi.push(0, 1, 0, 0); gSw.push(1 - wJ, wJ, 0, 0);
    }
  }
  for (let i = 0; i < 13; i++) {
    for (let j = 0; j < 20; j++) {
      const jn = (j + 1) % 20, a = i * 20 + j, b = (i + 1) * 20 + j, c = (i + 1) * 20 + jn, d = i * 20 + jn;
      gIdx.push(a, c, b, a, d, c, a, b, c, a, c, d);
    }
  }
  const backG = gPos.length / 3;
  gPos.push(0, -0.02, -0.30); gCol.push(0.05, 0.02, 0.02); gSi.push(0, 1, 0, 0); gSw.push(1, 0, 0, 0);
  for (let j = 0; j < 20; j++) gIdx.push(backG, (j + 1) % 20, j, backG, j, (j + 1) % 20);
  const gGeo = new THREE.BufferGeometry();
  gGeo.setAttribute('position', new THREE.Float32BufferAttribute(gPos, 3));
  gGeo.setAttribute('color', new THREE.Float32BufferAttribute(gCol, 3));
  gGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(gSi, 4));
  gGeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(gSw, 4));
  gGeo.setIndex(gIdx);
  gGeo.computeVertexNormals();
  const gMesh = new THREE.SkinnedMesh(gGeo, materials.wetMat);
  gMesh.frustumCulled = false;
  headBone.add(gMesh);
  headBone.updateMatrixWorld(true);
  gMesh.bind(new THREE.Skeleton([headBone, jawBone]));

  const tongueRig = buildTongueRig(jawBone, materials.wetMat);
  return { jawBone, ...tongueRig };
}

// ============================================================================
// 6. POSE SCHEMA, BLENDING & INDEPENDENT ANIMATION REGISTRY (ANIMATIONS)
// ============================================================================
function createPose() {
  const w = ANATOMY.limb.wristRest;
  return {
    pOff: new THREE.Vector3(), pRot: new THREE.Euler(0, 0, 0, 'YXZ'),
    chRot: new THREE.Vector3(), n1Rot: new THREE.Vector3(), n2Rot: new THREE.Vector3(), hRot: new THREE.Vector3(),
    jaw: 0.18, tOut: 0.08, tWhip: 0,
    tongueExtend: 1,
    tongueRot: Array.from({ length: ANATOMY.tongue.boneZs.length }, () => [0, 0, 0]),
    prongExtend: 1, prongSpread: 0, prongCurl: 0,
    prongRot: Array.from({ length: 3 }, () => [[0, 0, 0], [0, 0, 0], [0, 0, 0]]),
    tP: [0, 0, 0, 0, 0, 0], tY: [0, 0, 0, 0, 0, 0], tR: [0, 0, 0, 0, 0, 0],
    wL: new THREE.Vector3(w.x, w.y, w.z), wR: new THREE.Vector3(-w.x, w.y, w.z),
    swL: 0, swR: 0,
    wYawL: null, wYawR: null, wPitchL: 0, wPitchR: 0, wRollL: 0, wRollR: 0,
    poleYawL: null, poleYawR: null,
    poleOffsetL: new THREE.Vector3(), poleOffsetR: new THREE.Vector3(),
    digitCurlL: [0, 0, 0, 0], digitCurlR: [0, 0, 0, 0],
    groupYawOffset: 0,
  };
}

function blendPoses(pr, cur, a) {
  if (!pr || a >= 1) return cur;
  if (a <= 0) return pr;
  const lerpArr3 = (a1, a2) => a1.map((v, i) => [lerp(v[0], a2[i][0], a), lerp(v[1], a2[i][1], a), lerp(v[2], a2[i][2], a)]);
  const lerpDigit = (v1, v2, i) => lerp(Array.isArray(v1) ? (v1[i] ?? 0) : (v1 ?? 0), Array.isArray(v2) ? (v2[i] ?? 0) : (v2 ?? 0), a);
  return {
    pOff: pr.pOff.clone().lerp(cur.pOff, a),
    pRot: new THREE.Euler(lerp(pr.pRot.x, cur.pRot.x, a), lerp(pr.pRot.y, cur.pRot.y, a), lerp(pr.pRot.z, cur.pRot.z, a), 'YXZ'),
    chRot: pr.chRot.clone().lerp(cur.chRot, a), n1Rot: pr.n1Rot.clone().lerp(cur.n1Rot, a),
    n2Rot: pr.n2Rot.clone().lerp(cur.n2Rot, a), hRot: pr.hRot.clone().lerp(cur.hRot, a),
    jaw: lerp(pr.jaw, cur.jaw, a), tOut: lerp(pr.tOut, cur.tOut, a), tWhip: lerp(pr.tWhip, cur.tWhip, a),
    tongueExtend: lerp(pr.tongueExtend ?? 1, cur.tongueExtend ?? 1, a),
    tongueRot: lerpArr3(pr.tongueRot, cur.tongueRot),
    prongExtend: lerp(pr.prongExtend ?? 1, cur.prongExtend ?? 1, a),
    prongSpread: lerp(pr.prongSpread ?? 0, cur.prongSpread ?? 0, a),
    prongCurl: lerp(pr.prongCurl ?? 0, cur.prongCurl ?? 0, a),
    prongRot: pr.prongRot.map((pA, i) => lerpArr3(pA, cur.prongRot[i])),
    tP: pr.tP.map((v, i) => lerp(v, cur.tP[i], a)), tY: pr.tY.map((v, i) => lerp(v, cur.tY[i], a)), tR: pr.tR.map((v, i) => lerp(v, cur.tR[i], a)),
    wL: pr.wL.clone().lerp(cur.wL, a), wR: pr.wR.clone().lerp(cur.wR, a),
    swL: lerp(pr.swL, cur.swL, a), swR: lerp(pr.swR, cur.swR, a),
    wYawL: lerp(pr.wYawL ?? pr.pRot.y * 0.6, cur.wYawL ?? cur.pRot.y * 0.6, a),
    wYawR: lerp(pr.wYawR ?? pr.pRot.y * 0.6, cur.wYawR ?? cur.pRot.y * 0.6, a),
    wPitchL: lerp(pr.wPitchL ?? 0, cur.wPitchL ?? 0, a), wPitchR: lerp(pr.wPitchR ?? 0, cur.wPitchR ?? 0, a),
    wRollL: lerp(pr.wRollL ?? 0, cur.wRollL ?? 0, a), wRollR: lerp(pr.wRollR ?? 0, cur.wRollR ?? 0, a),
    poleYawL: lerp(pr.poleYawL ?? pr.pRot.y, cur.poleYawL ?? cur.pRot.y, a),
    poleYawR: lerp(pr.poleYawR ?? pr.pRot.y, cur.poleYawR ?? cur.pRot.y, a),
    poleOffsetL: pr.poleOffsetL.clone().lerp(cur.poleOffsetL, a),
    poleOffsetR: pr.poleOffsetR.clone().lerp(cur.poleOffsetR, a),
    digitCurlL: [0, 1, 2, 3].map(i => lerpDigit(pr.digitCurlL, cur.digitCurlL, i)),
    digitCurlR: [0, 1, 2, 3].map(i => lerpDigit(pr.digitCurlR, cur.digitCurlR, i)),
    groupYawOffset: lerp(pr.groupYawOffset ?? 0, cur.groupYawOffset ?? 0, a),
  };
}

function applyTurnLean(pose, tb) {
  pose.pRot.y += 0.05 * tb; pose.pRot.z -= 0.04 * tb;
  pose.chRot.y += 0.14 * tb; pose.chRot.z -= 0.07 * tb;
  pose.n1Rot.y += 0.17 * tb; pose.n2Rot.y += 0.14 * tb;
  pose.hRot.y += 0.18 * tb; pose.hRot.z -= 0.07 * tb;
  for (let i = 0; i < 6; i++) { pose.tY[i] -= 0.10 * tb * (0.65 + 0.07 * i); pose.tR[i] += 0.04 * tb; }
}

function evalTurnStep(u, phases) {
  let ang = phases[0][2];
  for (let i = 0; i < phases.length; i++) {
    const [u0, u1, a0, a1, lh, ro] = phases[i];
    if (u < u0) break;
    if (u <= u1) {
      const t = (u - u0) / (u1 - u0), sw = Math.sin(Math.PI * t);
      return { ang: lerp(a0, a1, smootherstep(0, 1, t)), lift: lh * (sw ** 0.85), rad: ro * sw, sw };
    }
    ang = a1;
  }
  return { ang, lift: 0, rad: 0, sw: 0 };
}

function turnGroupYawMag(u) {
  const phIn = [[0.14, 0.34, 0, Math.PI * 0.40, 0.32, 0.08], [0.52, 0.72, Math.PI * 0.40, Math.PI, 0.34, 0.08]];
  const phOut = [[0.32, 0.54, 0, Math.PI * (118 / 180), 0.35, 0.10], [0.70, 0.88, Math.PI * (118 / 180), Math.PI, 0.28, 0.06]];
  return lerp(0.5 * (evalTurnStep(u, phIn).ang + evalTurnStep(u, phOut).ang), Math.PI * smootherstep(0.14, 0.88, u), 0.40);
}

function turnPelvisWorldYawMag(u) {
  return turnGroupYawMag(u)
    - 0.055 * Math.sin(Math.PI * smootherstep(0.0, 0.18, u))
    - 0.075 * Math.sin(Math.PI * smootherstep(0.14, 0.86, u))
    + 0.025 * Math.sin(2.0 * Math.PI * smootherstep(0.78, 0.99, u)) * (1.0 - smootherstep(0.86, 0.995, u));
}

function sampleTurnPose(uRaw, dir, pose) {
  const u = clamp(uRaw, 0, 1);
  const phIn = [[0.14, 0.34, 0, Math.PI * 0.40, 0.32, 0.08], [0.52, 0.72, Math.PI * 0.40, Math.PI, 0.34, 0.08]];
  const phOut = [[0.32, 0.54, 0, Math.PI * (118 / 180), 0.35, 0.10], [0.70, 0.88, Math.PI * (118 / 180), Math.PI, 0.28, 0.06]];
  const gYawMag = turnGroupYawMag(u), gYaw = dir * gYawMag, wPelvisMag = turnPelvisWorldYawMag(u);
  const wChestMag = gYawMag + 0.14 * Math.sin(Math.PI * smootherstep(0.08, 0.82, u))
    + 0.028 * Math.sin(Math.PI * smootherstep(0.80, 0.96, u)) * (1.0 - smootherstep(0.88, 0.98, u));
  const wHeadMag = Math.PI * smootherstep(0.03, 0.62, u)
    + 0.085 * Math.sin(Math.PI * smootherstep(0.42, 0.90, u)) * (1.0 - smootherstep(0.82, 0.97, u));
  const wN2Mag = lerp(wChestMag, wHeadMag, 0.64), wN1Mag = lerp(wChestMag, wHeadMag, 0.30);
  const pRotY = dir * (wPelvisMag - gYawMag), chRotY = dir * (wChestMag - wPelvisMag);

  pose.groupYawOffset = gYaw;
  pose.pOff.set(
    dir * stepKeys([[0.00, 0.00], [0.11, -0.13], [0.24, -0.09], [0.35, 0.04], [0.44, 0.11], [0.54, 0.00], [0.63, -0.09], [0.72, 0.02], [0.80, 0.07], [0.91, -0.015], [1.00, 0.00]], u),
    stepKeys([[0.00, 0.00], [0.12, -0.12], [0.24, -0.07], [0.34, -0.13], [0.44, -0.07], [0.54, -0.12], [0.63, -0.06], [0.73, -0.10], [0.82, -0.04], [0.92, 0.015], [1.00, 0.00]], u),
    stepKeys([[0.00, 0.00], [0.12, -0.06], [0.45, 0.03], [0.82, 0.02], [1.00, 0.00]], u)
  );
  pose.pRot.set(
    stepKeys([[0.00, 0.00], [0.13, 0.045], [0.50, 0.055], [0.85, 0.02], [0.94, -0.015], [1.00, 0.00]], u),
    pRotY,
    dir * stepKeys([[0.00, 0.00], [0.12, 0.055], [0.34, -0.070], [0.68, -0.055], [0.88, -0.015], [0.95, 0.010], [1.00, 0.00]], u),
    'YXZ'
  );
  pose.chRot.set(stepKeys([[0.00, 0.00], [0.14, 0.03], [0.55, 0.04], [0.90, -0.01], [1.00, 0.00]], u), chRotY, dir * stepKeys([[0.00, 0.00], [0.14, 0.02], [0.45, -0.05], [0.85, -0.02], [1.00, 0.00]], u));
  pose.n1Rot.set(stepKeys([[0.00, 0.00], [0.16, -0.04], [0.55, -0.03], [0.90, 0.01], [1.00, 0.00]], u), dir * (wN1Mag - wChestMag), 0);
  pose.n2Rot.set(stepKeys([[0.00, 0.00], [0.18, -0.03], [0.55, -0.02], [1.00, 0.00]], u), dir * (wN2Mag - wN1Mag), 0);
  pose.hRot.set(stepKeys([[0.00, 0.00], [0.14, 0.05], [0.45, -0.04], [0.85, -0.02], [1.00, 0.00]], u), dir * (wHeadMag - wN2Mag), dir * (-0.11 * Math.sin(Math.PI * smoothstep(0.04, 0.90, u))));

  const driveEnv = Math.sin(Math.PI * smoothstep(0.05, 0.92, u));
  pose.jaw = 0.20 + 0.09 * driveEnv;
  pose.tOut = 0.08 + 0.07 * driveEnv;
  pose.tWhip = dir * 0.45 * Math.sin(Math.PI * smoothstep(0.04, 0.65, u));

  const sweepPitch = Math.sin(Math.PI * smoothstep(0.16, 0.94, u));
  let prevMag = wPelvisMag;
  for (let seg = 1; seg <= 6; seg++) {
    const lag = 0.028 * seg * (1.0 - smootherstep(0.55, 0.95, u));
    const whipEnv = smootherstep(0.73 + 0.012 * seg, 0.86 + 0.010 * seg, u) * (1.0 - smootherstep(0.87 + 0.010 * seg, 0.985, u));
    const rebound = -0.018 * (seg / 6) * smootherstep(0.92, 0.96, u) * (1.0 - smootherstep(0.96, 0.998, u));
    const wSegMag = turnPelvisWorldYawMag(clamp(u - lag, 0, 1)) + (0.036 * seg) * whipEnv + rebound;
    const localYaw = dir * (wSegMag - prevMag);
    prevMag = wSegMag;
    const idx = 6 - seg;
    pose.tY[idx] = localYaw;
    pose.tP[idx] = (seg <= 3 ? 0.024 : 0.014) * sweepPitch;
    pose.tR[idx] = 0.22 * localYaw;
  }

  const stIn = evalTurnStep(u, phIn), stOut = evalTurnStep(u, phOut);
  const stL = dir === 1 ? stIn : stOut, stR = dir === 1 ? stOut : stIn;
  const aL = dir * stL.ang, aR = dir * stR.ang;
  const piv = new THREE.Vector3(0, 0, ANATOMY.locomotion.pivotLocalZ), rest = ANATOMY.limb.wristRest;
  pose.wL.set(rest.x + stL.rad, rest.y, rest.z).sub(piv).applyAxisAngle(UP_AXIS, aL - gYaw).add(piv); pose.wL.y = rest.y + stL.lift;
  pose.wR.set(-rest.x - stR.rad, rest.y, rest.z).sub(piv).applyAxisAngle(UP_AXIS, aR - gYaw).add(piv); pose.wR.y = rest.y + stR.lift;
  pose.swL = stL.sw; pose.swR = stR.sw;
  pose.wYawL = (aL - gYaw) + pRotY * 0.25; pose.wYawR = (aR - gYaw) + pRotY * 0.25;
  pose.poleYawL = lerp(pRotY + chRotY * 0.4, aL - gYaw, 0.5); pose.poleYawR = lerp(pRotY + chRotY * 0.4, aR - gYaw, 0.5);
  return pose;
}

// Add new animations here:
// - type: 'loop'   -> sample(ctx, pose)                      | model.setAnimation(name)
// - type: 'action' -> sample(ctx, pose) OR partial+apply(...) | model.playAction(name)
// - type: 'layer'  -> apply(pose, ctx, weight)                | model.setLayer(name, weight)
export const ANIMATIONS = {
  idle: {
    type: 'loop',
    sample(ctx, pose) {
      const t = ctx.time, ph = t * 1.65;
      pose.pOff.set(0, 0.032 * Math.sin(ph), 0);
      pose.chRot.set(0.03 * Math.sin(ph - 0.5), 0, 0);
      pose.n1Rot.set(0, 0.11 * Math.sin(t * 0.72), 0);
      pose.hRot.set(-0.04 * Math.cos(t * 1.1), 0.14 * Math.sin(t * 0.72 - 0.45), 0);
      pose.jaw = 0.18 + 0.07 * Math.sin(ph);
      pose.tOut = 0.08 + 0.06 * Math.sin(t * 1.8);
      for (let i = 0; i < 6; i++) pose.tY[i] = 0.07 * Math.sin(t * 1.2 - i * 0.55);
      return pose;
    },
  },

  walk: {
    type: 'loop',
    sample(ctx, pose) {
      const phL = ctx.gaitPhase ?? (ctx.time * 0.90 * Math.PI * 2), phR = phL + Math.PI;
      const foot = (ph, s) => {
        const u = ((ph % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2);
        if (u < 0.58) { const st = u / 0.58; return [new THREE.Vector3(s * (0.82 + 0.04 * Math.sin(st * Math.PI)), 0.09, lerp(0.62, -0.46, st)), 0]; }
        const sw = (u - 0.58) / 0.42;
        return [new THREE.Vector3(s * (0.82 + 0.10 * Math.sin(sw * Math.PI)), 0.09 + 0.46 * (Math.sin(sw * Math.PI) ** 0.85), lerp(-0.46, 0.62, 0.5 - 0.5 * Math.cos(sw * Math.PI))), Math.sin(sw * Math.PI)];
      };
      [pose.wL, pose.swL] = foot(phL, 1); [pose.wR, pose.swR] = foot(phR, -1);
      pose.pOff.set(0.09 * Math.sin(phL), 0.075 * Math.cos(2 * phL) - 0.035, 0.03 * Math.sin(2 * phL));
      pose.pRot.set(0.03 * Math.sin(2 * phL), -0.10 * Math.cos(phL), 0.09 * Math.sin(phL), 'YXZ');
      pose.chRot.set(0.05 * Math.sin(2 * phL), 0.16 * Math.cos(phL), -0.05 * Math.sin(phL));
      pose.n1Rot.set(0.04 * Math.sin(2 * phL + 0.4), -0.08 * Math.cos(phL), 0);
      pose.hRot.set(-0.07 * Math.sin(2 * phL + 0.6), -0.05 * Math.cos(phL), 0);
      pose.jaw = 0.24 + 0.08 * Math.sin(2 * phL);
      pose.tOut = 0.10 + 0.05 * Math.sin(2 * phL);
      for (let i = 0; i < 6; i++) {
        pose.tY[i] = 0.16 * Math.sin(phL - i * 0.72 + 0.4);
        pose.tR[i] = 0.04 * Math.cos(phL - i * 0.6);
        pose.tP[i] = 0.015 * Math.sin(2 * phL - i * 0.5);
      }
      return pose;
    },
  },

  run: {
    type: 'loop',
    sample(ctx, pose) {
      const phL = ctx.gaitPhase ?? (ctx.time * 2.10 * Math.PI * 2), phR = phL + Math.PI * 0.74, bPh = phL - 0.05 * Math.PI;
      const foot = (ph, s) => {
        const u = ((ph % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2);
        if (u < 0.42) return [new THREE.Vector3(s * 0.80, 0.09, lerp(0.84, -0.54, u / 0.42)), 0];
        const sw = (u - 0.42) / 0.58, lift = Math.sin(sw * Math.PI);
        return [new THREE.Vector3(s * (0.80 + 0.12 * lift), 0.09 + 0.48 * (lift ** 0.85), lerp(-0.54, 0.84, 0.5 - 0.5 * Math.cos(sw * Math.PI))), 0.42 * lift * smoothstep(0.15, 0.65, lift)];
      };
      [pose.wL, pose.swL] = foot(phL, 1); [pose.wR, pose.swR] = foot(phR, -1);
      pose.pOff.set(0.07 * Math.sin(phL), -0.03 - 0.08 * Math.cos(bPh), 0.10 * Math.sin(bPh));
      pose.pRot.set(0.06 + 0.08 * Math.sin(bPh), 0.08 * Math.sin(phL), 0.05 * Math.cos(phL), 'YXZ');
      pose.chRot.set(-0.07 * Math.sin(bPh), -0.11 * Math.sin(phL), 0);
      pose.n1Rot.set(-0.07 - 0.06 * Math.sin(bPh), 0, 0);
      pose.hRot.set(0.08 * Math.sin(bPh), 0, 0);
      pose.jaw = 0.40 + 0.14 * Math.sin(bPh);
      pose.tOut = 0.18 + 0.10 * Math.sin(bPh);
      for (let i = 0; i < 6; i++) { pose.tY[i] = 0.22 * Math.sin(phL - i * 0.85); pose.tP[i] = -0.05 * Math.cos(bPh - i * 0.6); }
      return pose;
    },
  },

  scream: {
    type: 'action', duration: 3.4, blendRate: 4.5, lockMovement: true, turnInputScale: 0.25,
    events: [{ at: 0.16, name: 'screamPeak' }],
    canCancel: (u, input) => u > 0.74 && (input?.forward ?? 0) > 0.25,
    sample(ctx, pose) {
      const t = ctx.elapsed, u = (t % 3.4) / 3.4;
      const rear = Math.sin(clamp((u - 0.04) / 0.84, 0, 1) * Math.PI) ** 0.65;
      const trm = Math.sin(t * 50) * rear, swp = Math.sin(u * Math.PI * 3) * rear;
      const tOut = 0.12 + 0.88 * smoothstep(0.14, 0.58, rear);
      pose.pOff.set(0, 0.14 * rear, -0.14 * rear);
      pose.pRot.set(-0.28 * rear, 0.06 * swp, 0.04 * swp, 'YXZ');
      pose.chRot.set(-0.20 * rear + 0.02 * trm, 0.10 * swp, 0);
      pose.n1Rot.set(-0.16 * rear, 0.16 * swp, 0);
      pose.n2Rot.set(-0.10 * rear, 0.12 * swp, 0);
      pose.hRot.set(-0.22 * rear + 0.03 * trm, 0.12 * swp, 0.08 * swp);
      pose.jaw = 0.20 + 0.92 * rear + 0.06 * trm;
      pose.tOut = tOut; pose.tWhip = Math.sin(t * 14) * tOut;
      pose.wL.set(0.92, 0.09, 0.22); pose.wR.set(-0.92, 0.09, 0.22);
      for (let i = 0; i < 6; i++) {
        pose.tP[i] = 0.075 * rear + 0.03 * Math.sin(t * 4.5 - i * 0.7) * rear;
        pose.tY[i] = 0.19 * Math.sin(t * 3.8 - i * 0.65) * (0.3 + 0.7 * rear);
        pose.tR[i] = 0.06 * Math.cos(t * 3.8 - i * 0.6);
      }
      return pose;
    },
  },

  attack: {
    type: 'action', duration: 1.62, blendRate: 5.5, moveSpeedScale: 0.35, turnLeanScale: 0.45,
    sample(ctx, pose) {
      const u = clamp(ctx.u, 0, 1);
      const T = [0.00, 0.12, 0.24, 0.36, 0.48, 0.60, 0.74, 0.88, 1.00];
      const sp = (ys, uu = u) => splineKeys(T, ys, uu);
      const damp = 1 - smoothstep(0.70, 0.96, u);
      const uCh = clamp(u - 0.015 * damp, 0, 1), uNk = clamp(u - 0.025 * damp, 0, 1), uHd = clamp(u - 0.035 * damp, 0, 1);

      pose.pOff.set(sp([0.00, 0.04, 0.08, -0.02, -0.07, 0.04, 0.02, 0.00, 0.00]), sp([0.00, -0.10, -0.22, -0.06, 0.04, -0.05, 0.05, 0.01, 0.00]), sp([0.00, -0.18, -0.44, 0.16, 0.76, 0.58, -0.24, -0.08, 0.00]));
      pose.pRot.set(sp([0.00, -0.03, -0.08, 0.04, 0.11, 0.08, -0.06, -0.02, 0.00]), sp([0.00, -0.04, -0.08, 0.02, 0.07, -0.05, -0.03, 0.00, 0.00]), sp([0.00, -0.02, -0.05, 0.02, 0.05, -0.04, -0.02, 0.00, 0.00]), 'YXZ');
      pose.chRot.set(sp([0.00, -0.05, -0.12, 0.02, 0.16, 0.12, -0.09, -0.03, 0.00], uCh), sp([0.00, 0.05, 0.10, -0.02, -0.09, 0.06, 0.02, 0.00, 0.00], uCh), sp([0.00, 0.03, 0.06, -0.02, -0.06, 0.05, 0.02, 0.00, 0.00], uCh));
      pose.n1Rot.set(sp([0.00, 0.14, 0.28, -0.04, -0.13, -0.02, -0.08, -0.02, 0.00], uNk), sp([0.00, 0.05, 0.10, 0.02, -0.08, 0.09, 0.03, 0.00, 0.00], uNk), 0);
      pose.n2Rot.set(sp([0.00, 0.11, 0.22, -0.03, -0.12, -0.02, -0.06, -0.02, 0.00], uNk), sp([0.00, 0.04, 0.08, 0.02, -0.07, 0.08, 0.02, 0.00, 0.00], uNk), 0);
      pose.hRot.set(sp([0.00, 0.12, 0.26, -0.10, -0.18, 0.06, -0.10, -0.03, 0.00], uHd), sp([0.00, -0.06, -0.12, 0.04, 0.10, -0.16, -0.04, 0.02, 0.00], uHd), sp([0.00, -0.08, -0.16, 0.05, 0.14, -0.18, -0.05, 0.00, 0.00], uHd));
      pose.jaw = stepKeys([[0.00, 0.20], [0.18, 0.12], [0.36, 0.88], [0.45, 1.12], [0.51, 0.02], [0.62, 0.03], [0.78, 0.16], [1.00, 0.20]], u);
      pose.tOut = stepKeys([[0.00, 0.04], [0.22, 0.02], [0.39, 0.26], [0.46, 0.00], [0.66, 0.00], [1.00, 0.05]], u);
      pose.tWhip = Math.sin(u * Math.PI * 6) * smoothstep(0.24, 0.40, u) * (1 - smoothstep(0.43, 0.48, u));

      const liftL = Math.max(0, splineKeys([0.00, 0.22, 0.34, 0.47, 0.60, 0.70, 0.80, 0.90, 1.00], [0.00, 0.00, 0.40, 0.00, 0.00, 0.22, 0.00, 0.06, 0.00], u));
      const liftR = Math.max(0, splineKeys([0.00, 0.25, 0.37, 0.49, 0.62, 0.72, 0.82, 0.92, 1.00], [0.00, 0.00, 0.34, 0.00, 0.00, 0.19, 0.00, 0.05, 0.00], u));
      pose.wL.set(sp([0.82, 0.86, 0.90, 0.82, 0.78, 0.80, 0.88, 0.84, 0.82]), 0.09 + liftL, sp([0.06, -0.06, -0.22, 0.28, 0.74, 0.58, -0.12, 0.00, 0.06]));
      pose.wR.set(-sp([0.82, 0.86, 0.90, 0.84, 0.82, 0.82, 0.88, 0.84, 0.82]), 0.09 + liftR, sp([0.06, -0.04, -0.18, 0.20, 0.62, 0.50, -0.08, 0.02, 0.06]));
      pose.swL = clamp(liftL / 0.40, 0, 1); pose.swR = clamp(liftR / 0.34, 0, 1);

      const delayDamp = 1 - smoothstep(0.76, 0.96, u);
      for (let i = 0; i < 6; i++) {
        const us = clamp(u - (5 - i) * 0.018 * delayDamp, 0, 1);
        const tyVal = sp([0.00, 0.06, 0.13, -0.04, -0.18, 0.12, 0.07, -0.02, 0.00], us) * (1 - 0.06 * i);
        pose.tP[i] = sp([0.00, 0.02, 0.045, 0.08, 0.13, 0.10, 0.03, 0.00, 0.00], us);
        pose.tY[i] = tyVal; pose.tR[i] = 0.28 * tyVal;
      }
      return pose;
    },
  },
  
tongueAttack: {
    type: 'action', duration: 2.35, blendRate: 5.5, moveSpeedScale: 0.08, turnLeanScale: 0.25,
    events: [
      { at: 0.21, name: 'tongueLaunch' },
      { at: 0.34, name: 'tongueGrab' },
      { at: 0.85, name: 'tongueBite' },
      { at: 0.87, name: 'tongueRelease' },
    ],
    sample(ctx, pose) {
      const u = clamp(ctx.u, 0, 1);
      const T = [0.00, 0.10, 0.21, 0.33, 0.46, 0.62, 0.77, 0.89, 1.00];
      const sp = (ys, uu = u) => splineKeys(T, ys, uu);
      const damp = 1 - smoothstep(0.84, 0.98, u);
      const uCh = clamp(u - 0.015 * damp, 0, 1);
      const uNk = clamp(u - 0.025 * damp, 0, 1);
      const uHd = clamp(u - 0.032 * damp, 0, 1);

      // Tug/struggle micro-shake while prey is clamped (u = 0.35..0.66)
      const struggleEnv = bell(u, 0.35, 0.66, 1.2);
      const tugYaw = 0.075 * Math.sin((u - 0.35) * Math.PI * 5.0) * struggleEnv;
      const tugRoll = 0.055 * Math.sin((u - 0.35) * Math.PI * 5.0 + 0.6) * struggleEnv;

      // Body: coil low -> snap forward to shoot -> brace & haul backward -> bite snap -> settle
      pose.pOff.set(
        sp([0.00,  0.03,  0.05, -0.02, -0.04,  0.03,  0.01,  0.00, 0.00]),
        sp([0.00, -0.14, -0.24, -0.14, -0.22, -0.05, -0.12, -0.08, 0.00]),
        sp([0.00, -0.16, -0.32,  0.20,  0.12, -0.58, -0.24,  0.16, 0.00])
      );
      pose.pRot.set(
        sp([0.00,  0.06,  0.08,  0.02, -0.04, -0.22, -0.10,  0.04, 0.00]),
        sp([0.00, -0.03, -0.05,  0.02,  0.03, -0.02,  0.01,  0.00, 0.00]) + 0.3 * tugYaw,
        sp([0.00, -0.02, -0.03,  0.02,  0.02, -0.02,  0.00,  0.00, 0.00]),
        'YXZ'
      );
      pose.chRot.set(
        sp([0.00,  0.10,  0.14, -0.04, -0.06, -0.16, -0.04,  0.06, 0.00], uCh),
        sp([0.00,  0.04,  0.06, -0.02, -0.03,  0.02, -0.01,  0.00, 0.00], uCh) + 0.45 * tugYaw,
        sp([0.00,  0.02,  0.03, -0.02, -0.02,  0.02,  0.00,  0.00, 0.00], uCh) + 0.5 * tugRoll
      );
      pose.n1Rot.set(
        sp([0.00, -0.14, -0.24,  0.06,  0.08,  0.04, -0.04,  0.04, 0.00], uNk),
        sp([0.00,  0.03,  0.04,  0.00, -0.02,  0.02,  0.00,  0.00, 0.00], uNk) + 0.5 * tugYaw,
        0
      );
      pose.n2Rot.set(
        sp([0.00, -0.10, -0.18,  0.04,  0.06,  0.06, -0.02,  0.03, 0.00], uNk),
        sp([0.00,  0.02,  0.03,  0.00, -0.02,  0.02,  0.00,  0.00, 0.00], uNk) + 0.55 * tugYaw,
        0
      );
      pose.hRot.set(
        sp([0.00,  0.10,  0.18, -0.14, -0.08, -0.06, -0.04,  0.10, 0.00], uHd),
        sp([0.00, -0.04, -0.06,  0.02,  0.02, -0.02,  0.01,  0.00, 0.00], uHd) + 0.8 * tugYaw,
        sp([0.00, -0.03, -0.05,  0.02,  0.02,  0.00,  0.00,  0.00, 0.00], uHd) + tugRoll
      );

      // Jaw opens wide for shoot & reel-in, then snaps shut right after tongue clears teeth
      pose.jaw = stepKeys([
        [0.00, 0.18], [0.11, 0.64], [0.21, 1.06], [0.36, 0.98],
        [0.76, 0.94], [0.82, 0.44], [0.86, 0.03], [0.92, 0.06], [1.00, 0.18],
      ], u);
      pose.tOut = stepKeys([
        [0.00, 0.08], [0.18, 0.16], [0.25, 0.88], [0.42, 0.92],
        [0.76, 0.72], [0.83, 0.02], [0.92, 0.04], [1.00, 0.08],
      ], u);
      pose.tWhip = Math.sin(u * Math.PI * 8) * bell(u, 0.18, 0.35, 1.4) + 0.55 * tugYaw;

      // Tongue extension (tweak 11.0 up/down to change reach distance)
      pose.tongueExtend = stepKeys([
        [0.00, 1.00], [0.19, 0.88], [0.24, 3.60], [0.33, 11.0],
        [0.44, 10.4], [0.54, 7.20], [0.68, 3.20], [0.79, 1.25],
        [0.85, 0.95], [1.00, 1.00],
      ], u);

      // Compensate tongue0 pitch for jaw opening + spine pitch so tongue fires straight ahead
      const pitchAboveTongue0 =
        pose.pRot.x + pose.chRot.x + pose.n1Rot.x + pose.n2Rot.x + pose.hRot.x
        + pose.jaw + (-0.10 - 0.28 * pose.tOut + 0.08 * pose.tWhip);
      const targetWorldPitch = 0.05 - 0.07 * bell(u, 0.33, 0.72, 1.0);
      const aimW = smoothstep(0.14, 0.22, u) * (1 - smoothstep(0.76, 0.86, u));
      pose.tongueRot[0] = [
        aimW * (targetWorldPitch - pitchAboveTongue0),
        aimW * (-0.55 * (pose.hRot.y + pose.n2Rot.y)),
        0,
      ];

      // 7-bone shaft bend: S-wave during launch whip, slight tension bow under prey weight
      const whipAmp = bell(u, 0.19, 0.36, 1.3);
      const tensionBow = bell(u, 0.33, 0.76, 0.85);
      const tugShake = bell(u, 0.35, 0.65, 1.1);
      for (let i = 1; i < pose.tongueRot.length; i++) {
        const s = i / (pose.tongueRot.length - 1);
        const launchPitch = 0.085 * Math.sin(u * 30 - i * 0.85) * whipAmp;
        const launchYaw = 0.055 * Math.cos(u * 26 - i * 0.75) * whipAmp;
        const bowPitch = (s < 0.55 ? 0.034 : -0.038) * tensionBow;
        const shakeYaw = 0.022 * Math.sin(u * 40 - i * 0.9) * tugShake;
        pose.tongueRot[i] = [launchPitch + bowPitch, launchYaw + shakeYaw, 0];
      }

      // 3-prong claw: flare wide right before strike -> clamp tightly onto target -> release at bite
      const openFlare = stepKeys([
        [0.00, 0], [0.18, 0.25], [0.27, 0.95], [0.33, 0.70],
        [0.36, -0.22], [0.78, -0.18], [0.85, 0], [1.00, 0],
      ], u);
      const gripClamp = stepKeys([
        [0.00, 0], [0.31, 0.00], [0.36, 1.08], [0.74, 1.02],
        [0.83, 0.15], [0.88, 0], [1.00, 0],
      ], u);
      pose.prongSpread = openFlare;
      pose.prongCurl = gripClamp;
      pose.prongExtend = stepKeys([
        [0.00, 1.00], [0.20, 1.05], [0.31, 1.32], [0.38, 1.15],
        [0.76, 1.08], [0.85, 1.00], [1.00, 1.00],
      ], u);
      pose.prongRot[0] = [
        [-0.24 * Math.max(0, openFlare), 0, 0],
        [0.10 * gripClamp, 0, 0],
        [0.14 * gripClamp, 0, 0],
      ];
      pose.prongRot[1] = [
        [-0.08 * Math.max(0, openFlare), 0, 0],
        [0, -0.08 * gripClamp, 0],
        [0, -0.10 * gripClamp, 0],
      ];
      pose.prongRot[2] = [
        [-0.08 * Math.max(0, openFlare), 0, 0],
        [0, 0.08 * gripClamp, 0],
        [0, 0.10 * gripClamp, 0],
      ];

      // Forelimbs: step wide to plant, dig claws into ground during yank, reset cleanly
      const liftL = Math.max(0, splineKeys([0.00, 0.06, 0.14, 0.22, 0.78, 0.87, 0.94, 1.00], [0.00, 0.18, 0.00, 0.00, 0.00, 0.14, 0.00, 0.00], u));
      const liftR = Math.max(0, splineKeys([0.00, 0.08, 0.16, 0.24, 0.80, 0.89, 0.96, 1.00], [0.00, 0.15, 0.00, 0.00, 0.00, 0.12, 0.00, 0.00], u));
      pose.wL.set(sp([0.82, 0.88, 0.94, 0.92, 0.90, 0.90, 0.88, 0.84, 0.82]), 0.09 + liftL, sp([0.06, 0.14, 0.22, 0.26, 0.24, 0.24, 0.22, 0.14, 0.06]));
      pose.wR.set(-sp([0.82, 0.88, 0.94, 0.92, 0.90, 0.90, 0.88, 0.84, 0.82]), 0.09 + liftR, sp([0.06, 0.12, 0.18, 0.22, 0.20, 0.20, 0.18, 0.12, 0.06]));
      pose.swL = clamp(liftL / 0.18, 0, 1);
      pose.swR = clamp(liftR / 0.15, 0, 1);

      const brace = bell(u, 0.18, 0.84, 0.7);
      const curl = 0.52 * stepKeys([[0.00, 0], [0.18, 0.6], [0.34, 1.0], [0.76, 1.0], [0.88, 0], [1.00, 0]], u);
      pose.digitCurlL = [curl, curl, curl, curl];
      pose.digitCurlR = [curl, curl, curl, curl];
      pose.poleOffsetL.set(-0.14 * brace, 0.08 * brace, 0);
      pose.poleOffsetR.set( 0.14 * brace, 0.08 * brace, 0);

      // Tail counterbalance wave
      const tailDamp = 1 - smoothstep(0.82, 0.98, u);
      for (let i = 0; i < 6; i++) {
        const us = clamp(u - (5 - i) * 0.018 * tailDamp, 0, 1);
        const tyVal = sp([0.00, 0.04, 0.08, -0.05, 0.10, -0.14, 0.06, -0.02, 0.00], us) * (1 - 0.06 * i)
          + 0.05 * Math.sin(us * Math.PI * 4 - i * 0.5) * struggleEnv;
        pose.tP[i] = sp([0.00, 0.02, 0.04, 0.06, 0.04, -0.08, -0.03, 0.02, 0.00], us);
        pose.tY[i] = tyVal;
        pose.tR[i] = 0.25 * tyVal;
      }
      return pose;
    },
  },
  
  turnLeft: { type: 'action', duration: 2.25, blendRate: 6.0, pivotTurn: true, dir: 1, sample: (ctx, pose) => sampleTurnPose(ctx.u, 1, pose) },
  turnRight: { type: 'action', duration: 2.25, blendRate: 6.0, pivotTurn: true, dir: -1, sample: (ctx, pose) => sampleTurnPose(ctx.u, -1, pose) },
};

// ============================================================================
// 7. SKELETON RIG, LIMB BUILDER & IK POSE APPLICATOR
// ============================================================================
function buildLimbRig(side, chestBone, chestW, skinMat) {
  const { L1, L2, shoulderOffset, wristRest, elbowPole, digits: digitSpecs } = ANATOMY.limb;
  const shLocal = new THREE.Vector3(side * shoulderOffset.x, shoulderOffset.y, shoulderOffset.z);
  const S0 = chestW.clone().add(shLocal), W0 = new THREE.Vector3(side * wristRest.x, wristRest.y, wristRest.z);
  const ik = solveTwoBoneIK(S0, W0, new THREE.Vector3(side * elbowPole.x, elbowPole.y, elbowPole.z), L1, L2);
  const qU0 = new THREE.Quaternion().setFromRotationMatrix(computeBoneMatrix(S0, ik.E, ik.perp));
  const qF0 = new THREE.Quaternion().setFromRotationMatrix(computeBoneMatrix(ik.E, W0, ik.perp));

  const shB = new THREE.Bone(); shB.position.copy(shLocal); shB.quaternion.copy(qU0); chestBone.add(shB);
  const elB = new THREE.Bone(); elB.position.set(0, -L1, 0); elB.quaternion.copy(qU0.clone().invert().multiply(qF0)); shB.add(elB);
  const wrB = new THREE.Bone(); wrB.position.set(0, -L2, 0); wrB.quaternion.copy(qF0.clone().invert()); elB.add(wrB);

  const spurPiv = new THREE.Group(); elB.add(spurPiv);
  const spurMesh = new THREE.Mesh(createTubeGeometry(16, 12, t => ({
    x: 0, y: -0.06 + 0.34 * t + 0.08 * t * t, z: -0.04 + 0.42 * t, r: 0.105 * ((1 - t) ** 1.25) + 0.003,
    col: [lerp(0.21, 0.78, smoothstep(0.25, 0.75, t)), lerp(0.23, 0.75, smoothstep(0.25, 0.75, t)), lerp(0.19, 0.66, smoothstep(0.25, 0.75, t))],
  })), skinMat);
  spurMesh.castShadow = true; spurPiv.add(spurMesh);

  const digits = digitSpecs.map(ds => {
    const dp = new THREE.Group(); dp.position.set(side * ds.xo, -0.026, ds.zo); dp.rotation.y = ds.ang * side; wrB.add(dp);
    const nL = 16, nRg = 12, dPos = [], dCol = [], dUv = [], dIdx = [];
    for (let i = 0; i < nL; i++) {
      const t = i / (nL - 1), ct = Math.max(0, (t - 0.70) / 0.30), ft = Math.min(1, t / 0.70);
      const knk = Math.max(0, 0.016 * Math.sin(ft * Math.PI * 2.5)), sb = 0.5 + 0.5 * Math.sin(ft * Math.PI * 10);
      const yC = t < 0.70 ? lerp(0.0, -0.036, ft) + knk : lerp(-0.036, -0.060, ct ** 0.65);
      const rad = (t < 0.70 ? ds.rad * (1 - 0.38 * ft) + 0.010 * Math.max(0, Math.sin(ft * Math.PI * 3)) : ds.rad * 0.62 * (1 - 0.92 * ct)) * (0.72 + 0.28 * smoothstep(0, 0.12, t));
      const col = t < 0.70 ? [lerp(0.22, 0.42, sb * 0.5), lerp(0.23, 0.41, sb * 0.5), lerp(0.20, 0.34, sb * 0.5)] : [lerp(0.14, 0.58, 0.35 * ct), lerp(0.13, 0.54, 0.35 * ct), lerp(0.11, 0.46, 0.35 * ct)];
      for (let j = 0; j <= nRg; j++) {
        const a = ((j % nRg) / nRg) * Math.PI * 2;
        dPos.push(rad * Math.cos(a), yC + rad * 0.75 * Math.sin(a), t * ds.len); dCol.push(...col); dUv.push(t * ds.len * 0.79, (j / nRg) * (2 / 3));
      }
    }
    const stride = nRg + 1;
    for (let i = 0; i < nL - 1; i++) for (let j = 0; j < nRg; j++) {
      const a = i * stride + j, b = (i + 1) * stride + j, c = (i + 1) * stride + j + 1, d = i * stride + j + 1;
      dIdx.push(a, c, b, a, d, c);
    }
    const bc = dPos.length / 3; dPos.push(0, 0, -0.006); dCol.push(0.22, 0.23, 0.19); dUv.push(0, 1 / 3);
    for (let j = 0; j < nRg; j++) dIdx.push(bc, j + 1, j);
    const dGeo = new THREE.BufferGeometry();
    dGeo.setAttribute('position', new THREE.Float32BufferAttribute(dPos, 3));
    dGeo.setAttribute('color', new THREE.Float32BufferAttribute(dCol, 3));
    dGeo.setAttribute('uv', new THREE.Float32BufferAttribute(dUv, 2));
    dGeo.setIndex(dIdx); dGeo.computeVertexNormals();
    const nAttr = dGeo.getAttribute('normal');
    for (let i = 0; i < nL; i++) {
      const i0 = i * stride, i1 = i0 + nRg;
      const nx = nAttr.getX(i0) + nAttr.getX(i1), ny = nAttr.getY(i0) + nAttr.getY(i1), nz = nAttr.getZ(i0) + nAttr.getZ(i1);
      const len = Math.hypot(nx, ny, nz) || 1e-8;
      nAttr.setXYZ(i0, nx / len, ny / len, nz / len); nAttr.setXYZ(i1, nx / len, ny / len, nz / len);
    }
    const dm = new THREE.Mesh(dGeo, skinMat); dm.castShadow = dm.receiveShadow = true; dp.add(dm);
    return dp;
  });

  return { side, shLocal, shB, elB, wrB, spurPiv, digits };
}

class SkeletonRig {
  constructor(group, materials) {
    this.group = group;
    this.L1 = ANATOMY.limb.L1; this.L2 = ANATOMY.limb.L2;
    const { ctrlS, ctrlZ, ctrlY, stationS, boneNames, pelvisIndex, chestIndex } = ANATOMY.spine;
    const wPos = stationS.map(s => new THREE.Vector3(0, evalSpline(ctrlS, ctrlY, s), evalSpline(ctrlS, ctrlZ, s)));

    this.spineBones = boneNames.map(n => { const b = new THREE.Bone(); b.name = n; return b; });
    this.bones = {}; boneNames.forEach((n, i) => { this.bones[n] = this.spineBones[i]; });
    this.bones.pelvis.position.copy(wPos[pelvisIndex]); this.group.add(this.bones.pelvis);
    for (let i = pelvisIndex + 1; i < boneNames.length; i++) { this.spineBones[i].position.copy(wPos[i]).sub(wPos[i - 1]); this.spineBones[i - 1].add(this.spineBones[i]); }
    for (let i = pelvisIndex - 1; i >= 0; i--) { this.spineBones[i].position.copy(wPos[i]).sub(wPos[i + 1]); this.spineBones[i + 1].add(this.spineBones[i]); }
    this.pelvisRest = wPos[pelvisIndex].clone();

    this.limbs = {
      L: buildLimbRig(1, this.bones.chest, wPos[chestIndex], materials.skinMat),
      R: buildLimbRig(-1, this.bones.chest, wPos[chestIndex], materials.skinMat),
    };
    const allBones = [...this.spineBones, this.limbs.L.shB, this.limbs.L.elB, this.limbs.L.wrB, this.limbs.R.shB, this.limbs.R.elB, this.limbs.R.wrB];

    this.bodyMesh = new THREE.SkinnedMesh(buildBodyAndLimbsGeometry(wPos[chestIndex]), materials.skinMat);
    this.bodyMesh.castShadow = this.bodyMesh.receiveShadow = true; this.bodyMesh.frustumCulled = false;
    this.group.add(this.bodyMesh); this.group.updateMatrixWorld(true);
    this.bodyMesh.bind(new THREE.Skeleton(allBones), new THREE.Matrix4());

    const head = buildHeadAssembly(this.bones.headBase, materials);
    this.jawBone = head.jawBone; this.tongueRoot = head.tongueRoot;
    this.tongueBones = head.tongueBones; this.tongueRestDz = head.tongueRestDz;
    this.tongueProngs = head.tongueProngs; this.prongRigs = head.prongRigs;
  }

  applyPose(pose, time) {
    this.bones.pelvis.position.copy(this.pelvisRest).add(pose.pOff);
    this.bones.pelvis.rotation.copy(pose.pRot);
    this.bones.chest.rotation.set(pose.chRot.x, pose.chRot.y, pose.chRot.z);
    this.bones.neck1.rotation.set(pose.n1Rot.x, pose.n1Rot.y, pose.n1Rot.z);
    this.bones.neck2.rotation.set(pose.n2Rot.x, pose.n2Rot.y, pose.n2Rot.z);
    this.bones.headBase.rotation.set(pose.hRot.x, pose.hRot.y, pose.hRot.z);

    this.jawBone.rotation.x = pose.jaw;
    const tE = pose.tOut, xyScale = 0.85 + 0.15 * tE, zBaseScale = 0.62 + 0.58 * tE;
    const segStretch = (zBaseScale / xyScale) * (pose.tongueExtend ?? 1);
    this.tongueRoot.visible = true;
    this.tongueRoot.position.set(0, 0.024, 0.06 + 0.34 * tE);
    this.tongueRoot.scale.setScalar(xyScale);
    this.tongueRoot.rotation.set(-0.10 - 0.28 * tE + 0.08 * pose.tWhip, 0.14 * pose.tWhip, 0);
    for (let i = 0; i < this.tongueBones.length; i++) {
      const rot = pose.tongueRot[i] || [0, 0, 0];
      this.tongueBones[i].rotation.set(rot[0], rot[1], rot[2], 'YXZ');
      if (i > 0) this.tongueBones[i].position.z = this.tongueRestDz[i] * segStretch;
    }
    const prongZScale = (zBaseScale / xyScale) * (pose.prongExtend ?? 1), pSpread = pose.prongSpread ?? 0, pCurl = pose.prongCurl ?? 0;
    for (let idx = 0; idx < this.prongRigs.length; idx++) {
      const pInfo = this.prongRigs[idx], pRotArr = pose.prongRot[idx] || [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      pInfo.pivot.rotation.x = -0.10 * tE + 0.10 * Math.sin(time * 14 + idx * 1.4) * (0.15 + tE) + (idx === 0 ? pSpread * 0.18 : 0);
      pInfo.pivot.rotation.y = (idx === 0 ? 0.08 : (idx === 1 ? 0.12 : -0.12)) * tE + 0.10 * pose.tWhip + pInfo.spreadSign * pSpread * 0.45;
      for (let j = 0; j < 3; j++) {
        const jr = pRotArr[j] || [0, 0, 0];
        pInfo.bones[j].rotation.set(pCurl * 0.42 + jr[0], -pInfo.spreadSign * pCurl * 0.14 + jr[1], jr[2], 'YXZ');
      }
      for (let j = 1; j < pInfo.bones.length; j++) pInfo.bones[j].position.copy(pInfo.restOffsets[j]).multiplyScalar(prongZScale);
    }

    const { tailOrder, tailMinWorldY } = ANATOMY.spine;
    tailOrder.forEach((n, i) => this.bones[n].rotation.set(pose.tP[5 - i], pose.tY[5 - i], pose.tR[5 - i], 'YXZ'));
    this.group.updateMatrixWorld(true);
    const tmp = new THREE.Vector3();
    for (let i = 1; i < tailOrder.length; i++) {
      this.bones[tailOrder[i]].getWorldPosition(tmp);
      if (tmp.y < tailMinWorldY) { this.bones[tailOrder[i - 1]].rotation.x += Math.min(0.55, (tailMinWorldY - tmp.y) * 0.85); this.group.updateMatrixWorld(true); }
    }

    const grpQInv = this.group.quaternion.clone().invert(), chP = new THREE.Vector3(), chQ = new THREE.Quaternion();
    this.bones.chest.getWorldPosition(chP); this.bones.chest.getWorldQuaternion(chQ);
    chP.sub(this.group.position).applyQuaternion(grpQInv); chQ.premultiply(grpQInv);
    const doIK = (limb, wTgt, sw, wYaw, wPitch, wRoll, poleYaw, poleOff, digitCurl) => {
      const S = limb.shLocal.clone().applyQuaternion(chQ).add(chP);
      const bp = ANATOMY.limb.elbowPole;
      const pole = new THREE.Vector3(limb.side * bp.x, bp.y, bp.z).add(poleOff).applyAxisAngle(UP_AXIS, poleYaw);
      const { E, W, perp } = solveTwoBoneIK(S, wTgt, pole, this.L1, this.L2);
      const qU = new THREE.Quaternion().setFromRotationMatrix(computeBoneMatrix(S, E, perp));
      const qF = new THREE.Quaternion().setFromRotationMatrix(computeBoneMatrix(E, W, perp));
      limb.shB.quaternion.copy(chQ.clone().invert().multiply(qU));
      limb.elB.quaternion.copy(qU.clone().invert().multiply(qF));
      limb.wrB.quaternion.copy(qF.clone().invert().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.45 * sw + wPitch, wYaw, wRoll, 'YXZ'))));
      limb.spurPiv.quaternion.copy(qF.clone().invert().multiply(qU.clone().slerp(qF, 0.42)));
      limb.digits.forEach((d, idx) => { d.rotation.x = 0.40 * sw + (Array.isArray(digitCurl) ? (digitCurl[idx] ?? 0) : (digitCurl ?? 0)); });
    };
    doIK(this.limbs.L, pose.wL, pose.swL, pose.wYawL ?? pose.pRot.y * 0.6, pose.wPitchL ?? 0, pose.wRollL ?? 0, pose.poleYawL ?? pose.pRot.y, pose.poleOffsetL, pose.digitCurlL);
    doIK(this.limbs.R, pose.wR, pose.swR, pose.wYawR ?? pose.pRot.y * 0.6, pose.wPitchR ?? 0, pose.wRollR ?? 0, pose.poleYawR ?? pose.pRot.y, pose.poleOffsetR, pose.digitCurlR);
    this.group.updateMatrixWorld(true);
  }
}

// ============================================================================
// 8. ANIMATOR & PUBLIC MODEL FACADE
// ============================================================================
class Animator {
  constructor(model, registry) {
    this.model = model; this.registry = registry;
    this.targetAnim = 'idle'; this.time = 0; this.gaitPhase = 0; this.blend = 1;
    this.prevPose = null; this.usingInput = false;
    this.moveBlend = 0; this.runBlend = 0; this.turnBlend = 0; this.turnStepBlend = 0; this.facingYaw = 0;
    this.activeAction = null;
    this.layers = new Map();
  }

  _fireActionEvent(actionName, eventName) {
    if (eventName === 'screamPeak' && this.model.onScreamPeak) this.model.onScreamPeak();
    if (this.model.onActionEvent) this.model.onActionEvent(actionName, eventName);
  }

  _fireActionEnd(state) {
    if (!state) return;
    if (state.name === 'attack' && this.model.onAttackEnd) this.model.onAttackEnd();
    else if (state.name === 'scream' && this.model.onScreamEnd) this.model.onScreamEnd();
    else if (state.def.pivotTurn && this.model.onTurnEnd) this.model.onTurnEnd(this.targetAnim);
    if (this.model.onActionEnd) this.model.onActionEnd(state.name);
  }

  _cancelActiveAction(fireCallback = true) {
    if (!this.activeAction) return;
    const prev = this.activeAction; this.activeAction = null;
    if (fireCallback) this._fireActionEnd(prev);
  }

  setBaseState(name) {
    const def = this.registry[name];
    if (!def || def.type !== 'loop') return false;
    if (this.activeAction?.def.pivotTurn) { this.targetAnim = name; this.activeAction.returnAnim = name; return true; }
    if (name === this.targetAnim && (!this.activeAction || this.activeAction.def.partial)) return true;
    this.prevPose = this.getCurrentPose();
    if (this.activeAction && !this.activeAction.def.partial) this._cancelActiveAction(true);
    this.targetAnim = name; this.blend = 0;
    return true;
  }

  playAction(name, opts = {}) {
    const def = this.registry[name];
    if (!def || def.type !== 'action') return false;
    if (this.activeAction?.def.pivotTurn) return false;
    if (this.activeAction && this.activeAction.name === name && !opts.restart) return false;
    if (!def.partial) { this.prevPose = this.getCurrentPose(); this.blend = 0; }
    this._cancelActiveAction(true);
    const state = {
      name, def, elapsed: 0, duration: opts.duration ?? def.duration ?? 1.0, firedEvents: new Set(),
      returnAnim: (this.targetAnim === 'walk' || this.targetAnim === 'run') ? this.targetAnim : 'idle',
    };
    if (def.pivotTurn) {
      const startYaw = normalizeAngle(this.model.group.rotation.y);
      this.facingYaw = startYaw; state.startYaw = startYaw; state.targetYaw = startYaw + def.dir * Math.PI;
      state.pivotWorld = new THREE.Vector3(0, 0, ANATOMY.locomotion.pivotLocalZ).applyAxisAngle(UP_AXIS, startYaw).add(this.model.group.position);
    }
    this.activeAction = state;
    return true;
  }

  setLayer(name, targetWeight = 1, blendSpeed = null) {
    const def = this.registry[name];
    if (!def || def.type !== 'layer') return false;
    const ex = this.layers.get(name), sp = blendSpeed ?? def.blendSpeed ?? 6;
    if (ex) { ex.target = clamp(targetWeight, 0, 1); ex.speed = sp; }
    else this.layers.set(name, { weight: 0, target: clamp(targetWeight, 0, 1), speed: sp });
    return true;
  }

  getLayerWeight(name) { return this.layers.get(name)?.weight ?? 0; }

  _sampleBaseLocomotion() {
    const baseKey = (this.targetAnim !== 'walk' && this.targetAnim !== 'run' && this.registry[this.targetAnim]) ? this.targetAnim : 'idle';
    const basePose = this.registry[baseKey].sample({ time: this.time, gaitPhase: this.gaitPhase }, createPose());
    if (this.moveBlend <= 1e-3 && this.turnStepBlend <= 1e-3) {
      if (Math.abs(this.turnBlend) > 1e-3) applyTurnLean(basePose, this.turnBlend);
      return basePose;
    }
    const walkPose = this.registry.walk.sample({ time: this.time, gaitPhase: this.gaitPhase }, createPose());
    const movePose = this.runBlend > 1e-3 ? blendPoses(walkPose, this.registry.run.sample({ time: this.time, gaitPhase: this.gaitPhase }, createPose()), this.runBlend) : walkPose;
    let locoPose = movePose, locoWeight = this.moveBlend;
    if (this.turnStepBlend > 1e-3) {
      const ts = this.registry.walk.sample({ time: this.time, gaitPhase: this.gaitPhase }, createPose());
      ts.wL.z = lerp(0.06, ts.wL.z, 0.35); ts.wR.z = lerp(0.06, ts.wR.z, 0.35);
      ts.wL.x += 0.06 * ts.swL; ts.wR.x -= 0.06 * ts.swR;
      locoPose = blendPoses(movePose, ts, this.turnStepBlend / Math.max(this.moveBlend + this.turnStepBlend, 1e-5));
      locoWeight = clamp(this.moveBlend + 0.78 * this.turnStepBlend, 0, 1);
    }
    const pose = blendPoses(basePose, locoPose, smoothstep(0, 1, locoWeight));
    if (Math.abs(this.turnBlend) > 1e-3) applyTurnLean(pose, this.turnBlend);
    return pose;
  }

  _sampleBasePose() {
    if (this.usingInput) return this._sampleBaseLocomotion();
    return (this.registry[this.targetAnim] ?? this.registry.idle).sample({ time: this.time }, createPose());
  }

  _sampleActionPose(act, uOvr = null) {
    const u = uOvr ?? clamp(act.elapsed / act.duration, 0, 1);
    return act.def.sample({ u, elapsed: uOvr != null ? u * act.duration : act.elapsed, time: this.time, gaitPhase: this.gaitPhase }, createPose());
  }

  _applyOverlays(pose, actionScale = 1) {
    for (const [name, st] of this.layers.entries()) {
      if (st.weight > 1e-4) this.registry[name]?.apply?.(pose, { time: this.time, gaitPhase: this.gaitPhase }, st.weight * actionScale);
    }
    if (this.activeAction?.def.partial && this.activeAction.def.apply) {
      const act = this.activeAction, u = clamp(act.elapsed / act.duration, 0, 1);
      act.def.apply(pose, { u, elapsed: act.elapsed, time: this.time, gaitPhase: this.gaitPhase }, smoothstep(0, 0.12, u) * (1 - smoothstep(0.85, 1.0, u)));
    }
    return pose;
  }

  getCurrentPose() {
    const cur = (this.activeAction && !this.activeAction.def.partial) ? this._sampleActionPose(this.activeAction) : this._sampleBasePose();
    const blended = (this.blend < 1 && this.prevPose) ? blendPoses(this.prevPose, cur, smoothstep(0, 1, this.blend)) : cur;
    return this._applyOverlays(blended, this.activeAction?.def.layerScale ?? 1);
  }

  update(dt, speed, input = null) {
    this.time += dt * speed; this.usingInput = Boolean(input);
    const blendRate = (this.activeAction?.def.blendRate ?? 4.5) * Math.max(1, speed);
    if (this.blend < 1) this.blend = Math.min(1, this.blend + dt * blendRate);

    for (const [name, st] of this.layers.entries()) {
      st.weight = lerp(st.weight, st.target, 1 - Math.exp(-st.speed * dt));
      if (st.target === 0 && st.weight < 1e-4) this.layers.delete(name);
    }

    if (input && !this.activeAction?.def.pivotTurn) {
      const forwardIn = clamp(input.forward ?? 0, 0, 1), turnIn = clamp(input.turn ?? 0, -1, 1), runIn = Boolean(input.run);
      if (this.activeAction?.def.canCancel?.(this.activeAction.elapsed / this.activeAction.duration, input)) {
        this.prevPose = this.getCurrentPose(); this._cancelActiveAction(true); this.blend = 0;
      }
      const actDef = this.activeAction?.def;
      const moveTarget = actDef?.lockMovement ? 0 : forwardIn;
      const turnTarget = actDef?.turnInputScale != null ? turnIn * actDef.turnInputScale : turnIn;
      const kMove = 1 - Math.exp(-9.5 * dt), kRun = 1 - Math.exp(-6.5 * dt), kTurn = 1 - Math.exp(-10.0 * dt);
      this.moveBlend = lerp(this.moveBlend, moveTarget, kMove); if (this.moveBlend < 1e-4 && moveTarget === 0) this.moveBlend = 0;
      this.runBlend = lerp(this.runBlend, runIn ? 1 : 0, kRun);
      this.turnBlend = lerp(this.turnBlend, turnTarget, kTurn); if (Math.abs(this.turnBlend) < 1e-4 && turnTarget === 0) this.turnBlend = 0;
      this.turnStepBlend = lerp(this.turnStepBlend, Math.abs(turnTarget) * (1 - clamp(moveTarget * 2, 0, 1)), kMove);

      const forwardSpeed = lerp(ANATOMY.locomotion.walkSpeed, ANATOMY.locomotion.runSpeed, this.runBlend) * this.moveBlend * speed * (actDef?.moveSpeedScale ?? 1.0);
      const turnAngSpeed = lerp(1.95, 1.55, this.moveBlend * this.runBlend) * speed;
      this.facingYaw = normalizeAngle(this.facingYaw + this.turnBlend * turnAngSpeed * dt);
      this.model.group.rotation.y = this.facingYaw;
      this.model.group.position.x += Math.sin(this.facingYaw) * forwardSpeed * dt;
      this.model.group.position.z += Math.cos(this.facingYaw) * forwardSpeed * dt;
      if (input.bounds != null) {
        this.model.group.position.x = clamp(this.model.group.position.x, -input.bounds, input.bounds);
        this.model.group.position.z = clamp(this.model.group.position.z, -input.bounds, input.bounds);
      }
      const moveFreq = forwardSpeed / lerp(1.08 / 0.58, 1.38 / 0.42, this.runBlend);
      const turnStepFreq = 0.92 * Math.abs(this.turnBlend) * this.turnStepBlend * speed;
      this.gaitPhase = (this.gaitPhase + dt * Math.max(moveFreq, turnStepFreq) * Math.PI * 2) % (Math.PI * 2);
    }

    let cur;
    if (this.activeAction) {
      const act = this.activeAction;
      act.elapsed += dt * speed;
      const u = act.elapsed / act.duration;
      if (act.def.events) for (const ev of act.def.events) if (u >= ev.at && !act.firedEvents.has(ev.name)) { act.firedEvents.add(ev.name); this._fireActionEvent(act.name, ev.name); }
      if (u >= 1) {
        if (!act.def.partial) { this.prevPose = blendPoses(this.prevPose, this._sampleActionPose(act, 1), smoothstep(0, 1, this.blend)); this.blend = 0; }
        if (act.def.pivotTurn) {
          this.facingYaw = normalizeAngle(act.targetYaw);
          this.model.group.position.copy(act.pivotWorld).sub(new THREE.Vector3(0, 0, ANATOMY.locomotion.pivotLocalZ).applyAxisAngle(UP_AXIS, this.facingYaw));
          if (Math.abs(this.model.group.position.x) < 1e-9) this.model.group.position.x = 0;
          if (Math.abs(this.model.group.position.z) < 1e-9) this.model.group.position.z = 0;
          this.model.group.rotation.y = this.facingYaw; this.targetAnim = act.returnAnim;
        }
        this.activeAction = null; this._fireActionEnd(act); cur = this._sampleBasePose();
      } else if (act.def.partial) {
        cur = this._sampleBasePose();
      } else {
        cur = this._sampleActionPose(act, u);
        if (act.def.pivotTurn) {
          const curYaw = act.startYaw + cur.groupYawOffset;
          this.model.group.position.copy(act.pivotWorld).sub(new THREE.Vector3(0, 0, ANATOMY.locomotion.pivotLocalZ).applyAxisAngle(UP_AXIS, curYaw));
          this.model.group.rotation.y = curYaw;
        } else if (this.usingInput && Math.abs(this.turnBlend) > 1e-3 && act.def.turnLeanScale) applyTurnLean(cur, act.def.turnLeanScale * this.turnBlend);
      }
    } else {
      cur = this._sampleBasePose();
    }
    const pose = (this.blend < 1 && this.prevPose) ? blendPoses(this.prevPose, cur, smoothstep(0, 1, this.blend)) : cur;
    return this._applyOverlays(pose, this.activeAction?.def.layerScale ?? 1);
  }
}

export class SkullcrawlerModel {
  constructor({ maxAnisotropy = 4 } = {}) {
    this.group = new THREE.Group();
    const materials = createCreatureMaterials(maxAnisotropy);
    this.skinMat = materials.skinMat; this.boneMat = materials.boneMat;
    this.toothMat = materials.toothMat; this.wetMat = materials.wetMat;
    this.L1 = ANATOMY.limb.L1; this.L2 = ANATOMY.limb.L2;

    this.rig = new SkeletonRig(this.group, materials);
    this.spineBones = this.rig.spineBones; this.bones = this.rig.bones;
    this.pelvisRest = this.rig.pelvisRest; this.limbs = this.rig.limbs;
    this.bodyMesh = this.rig.bodyMesh; this.jawBone = this.rig.jawBone;
    this.tongueRoot = this.rig.tongueRoot; this.tongueProngs = this.rig.tongueProngs;

    this.animations = { ...ANIMATIONS };
    this.animator = new Animator(this, this.animations);
    this.speed = 1;
    this.onScreamPeak = null; this.onScreamEnd = null;
    this.onAttackEnd = null; this.onTurnEnd = null;
    this.onActionEvent = null; this.onActionEnd = null;
  }

  get targetAnim() { return this.animator.targetAnim; }
  get attackActive() { return this.animator.activeAction?.name === 'attack'; }
  get screamActive() { return this.animator.activeAction?.name === 'scream'; }
  get turnActive() { return Boolean(this.animator.activeAction?.def.pivotTurn); }
  get facingYaw() { return this.animator.facingYaw; }
  set facingYaw(v) { this.animator.facingYaw = v; }
  get moveBlend() { return this.animator.moveBlend; }
  get runBlend() { return this.animator.runBlend; }
  get turnBlend() { return this.animator.turnBlend; }

  registerAnimation(name, def) { this.animations[name] = def; }
  setAnimation(name) {
    if (name === 'turnLeft' || name === 'turn_left') return this.triggerTurn('left');
    if (name === 'turnRight' || name === 'turn_right') return this.triggerTurn('right');
    if (name === 'scream') return this.triggerScream();
    if (name === 'attack') return this.triggerAttack();
    const def = this.animations[name];
    if (!def) return false;
    return def.type === 'action' ? this.animator.playAction(name) : this.animator.setBaseState(name);
  }
  playAction(name, opts) { return this.animator.playAction(name, opts); }
  setLayer(name, weight = 1, blendSpeed = null) { return this.animator.setLayer(name, weight, blendSpeed); }
  getLayerWeight(name) { return this.animator.getLayerWeight(name); }
  triggerAttack() { return this.animator.playAction('attack'); }
  triggerScream() { return this.animator.playAction('scream'); }
  triggerTurn(dirOrName) { return this.animator.playAction((dirOrName === 'right' || dirOrName === -1) ? 'turnRight' : 'turnLeft'); }
  update(dt, input = null) { this.rig.applyPose(this.animator.update(dt, this.speed, input), this.animator.time); }
}
