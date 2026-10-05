import * as THREE from 'three';

/**
 * Everything that makes the prototype read as Counter-Strike 1.6 rather than
 * a grey-box test level: Dust-style sandstone, wooden crates, a CT bot, and
 * an AK-47 viewmodel. Pure presentation. Nothing here feeds the duel.
 */

/** Dust haze, used for both the sky and the fog so distance fades into the sky. */
export const SKY = 0xd8c9a0;

function canvas(size: number, paint: (g: CanvasRenderingContext2D, n: number) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  paint(g, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Deterministic, so a reload does not reshuffle the walls. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function speckle(g: CanvasRenderingContext2D, n: number, r: () => number, count: number, alpha: number) {
  for (let i = 0; i < count; i++) {
    const v = r() > 0.5 ? 255 : 0;
    g.fillStyle = `rgba(${v},${v},${v},${alpha * r()})`;
    g.fillRect(r() * n, r() * n, 1 + r() * 2, 1 + r() * 2);
  }
}

/** Dust2 sandstone: warm blocks with dark mortar lines and grain. */
export function sandstone(): THREE.CanvasTexture {
  return canvas(256, (g, n) => {
    const r = rng(7);
    g.fillStyle = '#c4a56a';
    g.fillRect(0, 0, n, n);
    const rows = 4, h = n / rows;
    for (let y = 0; y < rows; y++) {
      const cols = y % 2 ? 2 : 3, w = n / cols, off = y % 2 ? w / 2 : 0;
      for (let x = -1; x <= cols; x++) {
        const l = 0.9 + r() * 0.2;
        g.fillStyle = `rgb(${196 * l | 0},${165 * l | 0},${106 * l | 0})`;
        g.fillRect(x * w + off + 2, y * h + 2, w - 4, h - 4);
      }
    }
    speckle(g, n, r, 1800, 0.12);
    g.strokeStyle = 'rgba(70,50,25,0.55)';
    g.lineWidth = 3;
    for (let y = 0; y < rows; y++) {
      g.beginPath(); g.moveTo(0, y * h); g.lineTo(n, y * h); g.stroke();
      const cols = y % 2 ? 2 : 3, w = n / cols, off = y % 2 ? w / 2 : 0;
      for (let x = -1; x <= cols; x++) { g.beginPath(); g.moveTo(x * w + off, y * h); g.lineTo(x * w + off, (y + 1) * h); g.stroke(); }
    }
  });
}

/** Packed dirt, mottled. */
export function dirt(): THREE.CanvasTexture {
  return canvas(256, (g, n) => {
    const r = rng(21);
    g.fillStyle = '#a89064';
    g.fillRect(0, 0, n, n);
    for (let i = 0; i < 140; i++) {
      const l = 0.82 + r() * 0.3;
      g.fillStyle = `rgba(${150 * l | 0},${120 * l | 0},${80 * l | 0},0.35)`;
      g.beginPath(); g.arc(r() * n, r() * n, 6 + r() * 22, 0, 7); g.fill();
    }
    speckle(g, n, r, 2600, 0.18);
  });
}

/** Crate: dark frame, planked face, nails. */
export function crate(): THREE.CanvasTexture {
  return canvas(128, (g, n) => {
    const r = rng(3);
    g.fillStyle = '#8a6a3c';
    g.fillRect(0, 0, n, n);
    for (let y = 0; y < 8; y++) {
      const l = 0.85 + r() * 0.3;
      g.fillStyle = `rgb(${150 * l | 0},${112 * l | 0},${62 * l | 0})`;
      g.fillRect(8, 8 + y * 14, n - 16, 13);
    }
    g.strokeStyle = '#4a3418';
    g.lineWidth = 8;
    g.strokeRect(4, 4, n - 8, n - 8);
    g.lineWidth = 6;
    g.beginPath(); g.moveTo(8, 8); g.lineTo(n - 8, n - 8); g.moveTo(n - 8, 8); g.lineTo(8, n - 8); g.stroke();
    g.fillStyle = '#222';
    for (const [x, y] of [[8, 8], [n - 8, 8], [8, n - 8], [n - 8, n - 8], [n / 2, n / 2]]) g.fillRect(x - 2, y - 2, 4, 4);
  });
}

/** One material per box, with the texture tiled to roughly 2m a repeat. */
export function tiled(tex: THREE.Texture, w: number, h: number, d: number, tint = 0xffffff): THREE.MeshLambertMaterial {
  const t = tex.clone();
  t.needsUpdate = true;
  t.repeat.set(Math.max(1, Math.max(w, d) / 2), Math.max(1, h / 2));
  return new THREE.MeshLambertMaterial({ map: t, color: tint });
}

const mat = (color: number, rough = 0.7, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });

/** A CT in urban gear: helmet, vest, dark fatigues, AWP across the chest. */
export function ctBot(): { group: THREE.Group; parts: THREE.Mesh[] } {
  const group = new THREE.Group();
  const part = (m: THREE.Mesh, kind: 'body' | 'head') => { m.userData.part = kind; return m; };
  const legs = part(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.3), mat(0x1e2433)), 'body');
  legs.position.y = 0.4;
  const torso = part(new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.7, 0.35), mat(0x2d3b57)), 'body');
  torso.position.y = 1.15;
  const vest = part(new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.5, 0.39), mat(0x1a1d26, 0.9)), 'body');
  vest.position.y = 1.18;
  const head = part(new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 14), mat(0xd9a77a, 0.8)), 'head');
  head.position.y = 1.7;
  const helmet = part(new THREE.Mesh(new THREE.SphereGeometry(0.19, 14, 14, 0, Math.PI * 2, 0, Math.PI * 0.55), mat(0x141820, 0.5, 0.2)), 'head');
  helmet.position.y = 1.72;
  const awp = part(new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.1, 1.25), mat(0x2f3a2a, 0.6, 0.3)), 'body');
  awp.position.set(0.22, 1.25, 0.45);
  const scope = part(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.3, 10), mat(0x0c0c0c, 0.3, 0.6)), 'body');
  scope.rotation.x = Math.PI / 2;
  scope.position.set(0.22, 1.33, 0.4);
  const parts = [legs, torso, vest, head, helmet, awp, scope];
  group.add(...parts);
  return { group, parts };
}

/** AK-47 viewmodel in camera space. Lower right, barrel toward -z. */
export function ak47(): THREE.Group {
  const g = new THREE.Group();
  const box = (w: number, h: number, d: number, color: number, x: number, y: number, z: number, rough = 0.6, metal = 0.2) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, rough, metal));
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  const wood = 0x7a4a22, steel = 0x24262a;
  box(0.05, 0.07, 0.34, steel, 0, 0, -0.1); // receiver
  box(0.045, 0.06, 0.3, wood, 0, -0.005, -0.42, 0.8, 0); // handguard
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.3, 10), mat(0x15161a, 0.3, 0.7));
  barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.015, -0.7); g.add(barrel);
  box(0.016, 0.04, 0.02, steel, 0, 0.055, -0.82); // front sight
  box(0.04, 0.09, 0.24, wood, 0, -0.025, 0.22, 0.8, 0); // stock
  box(0.038, 0.11, 0.05, wood, 0, -0.1, 0.05, 0.8, 0).rotation.x = -0.35; // grip
  const mag = box(0.032, 0.16, 0.06, steel, 0, -0.14, -0.2); mag.rotation.x = 0.4; // curved magazine, approximated
  box(0.03, 0.02, 0.1, steel, 0, 0.05, -0.02); // rear sight
  g.position.set(0.2, -0.2, -0.38);
  g.rotation.set(0.02, 0.05, 0);
  return g;
}
