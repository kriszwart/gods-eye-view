// Produces a compact SVG glyph per craft: the hull silhouette (traced from a
// raster of the projected rest-pose triangles) plus light positions as dots.
// Side view projects (x, y); plan view projects (x, z) looking down.

import * as THREE from 'three';
import { contours } from 'd3-contour';

const GRID = 220;
const VIEW = 100;
const PAD = 7;

function simplify(points, tolerance) {
  if (points.length < 4) return points;
  const sq = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  const segDist = (p, a, b) => {
    const l = sq(a, b);
    if (!l) return sq(p, a);
    let t = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / l;
    t = Math.max(0, Math.min(1, t));
    return sq(p, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
  };
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const tol = tolerance * tolerance;
  while (stack.length) {
    const [s, e] = stack.pop();
    let max = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segDist(points[i], points[s], points[e]);
      if (d > max) {
        max = d;
        idx = i;
      }
    }
    if (max > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export function glyphSvg({ root, meta }) {
  root.updateMatrixWorld(true);
  const view = meta.glyphView === 'plan' ? 'plan' : 'side';
  const project = (v) => (view === 'plan' ? [v.x, v.z] : [v.x, -v.y]);
  const tris = [];
  const glowTris = [];
  const lights = [];
  const ghosts = [];
  const v = new THREE.Vector3();
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = ([x, y]) => {
    box.minX = Math.min(box.minX, x);
    box.maxX = Math.max(box.maxX, x);
    box.minY = Math.min(box.minY, y);
    box.maxY = Math.max(box.maxY, y);
  };

  root.traverse((obj) => {
    if (!obj.isMesh) return;
    const spec = obj.material.userData.gltf || {};
    const worldScale = new THREE.Vector3();
    obj.getWorldScale(worldScale);
    if (obj.userData.light) {
      // Ignore the light's own (animated) scale; use its parent's.
      const ps = new THREE.Vector3();
      obj.parent.getWorldScale(ps);
      obj.getWorldPosition(v);
      const c = project(v);
      const r = (obj.geometry.parameters?.radius ?? 0.05) * ps.x;
      lights.push({ c, r });
      grow([c[0] - r, c[1] - r]);
      grow([c[0] + r, c[1] + r]);
      return;
    }
    if (spec.irOnly) {
      obj.getWorldPosition(v);
      const r = (obj.geometry.parameters?.radius ?? 0.3) * worldScale.x;
      const c = project(v);
      ghosts.push({ c, r });
      grow([c[0] - r, c[1] - r]);
      grow([c[0] + r, c[1] + r]);
      return;
    }
    const pos = obj.geometry.getAttribute('position');
    const index = obj.geometry.index;
    const pts = [];
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
      const p = project(v);
      pts.push(p);
      grow(p);
    }
    const n = index ? index.count : pos.count;
    const bucket = spec.emissive ? glowTris : tris;
    for (let i = 0; i < n; i += 3) {
      const a = index ? index.getX(i) : i;
      const b = index ? index.getX(i + 1) : i + 1;
      const c = index ? index.getX(i + 2) : i + 2;
      bucket.push([pts[a], pts[b], pts[c]]);
    }
  });

  const w = box.maxX - box.minX || 1;
  const h = box.maxY - box.minY || 1;
  const scale = (VIEW - PAD * 2) / Math.max(w, h);
  const ox = PAD + (VIEW - PAD * 2 - w * scale) / 2;
  const oy = PAD + (VIEW - PAD * 2 - h * scale) / 2;
  const toView = ([x, y]) => [ox + (x - box.minX) * scale, oy + (y - box.minY) * scale];

  const trace = (triangles, cls, fill) => {
    if (!triangles.length) return '';
    const grid = new Float64Array(GRID * GRID);
    const g = (p) => {
      const [x, y] = toView(p);
      return [(x / VIEW) * GRID, (y / VIEW) * GRID];
    };
    for (const t of triangles) {
      const [a, b, c] = t.map(g);
      const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
      const maxX = Math.min(GRID - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
      const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
      const maxY = Math.min(GRID - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
      const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(area) < 1e-9) continue;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const w0 = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
          const w1 = (c[0] - b[0]) * (py - b[1]) - (c[1] - b[1]) * (px - b[0]);
          const w2 = (a[0] - c[0]) * (py - c[1]) - (a[1] - c[1]) * (px - c[0]);
          if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0))
            grid[y * GRID + x] = 1;
        }
      }
    }
    const [shape] = contours().size([GRID, GRID]).thresholds([0.5])(grid);
    const k = VIEW / GRID;
    const parts = [];
    for (const polygon of shape.coordinates) {
      for (const ring of polygon) {
        const pts = simplify(ring.map(([x, y]) => [x * k, y * k]), 0.35);
        if (pts.length < 3) continue;
        parts.push('M' + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L') + 'Z');
      }
    }
    return parts.length
      ? `<path class="${cls}" fill="${fill}" fill-rule="evenodd" d="${parts.join('')}"/>`
      : '';
  };
  const body = trace(tris, 'hull', 'currentColor');
  const glow = trace(glowTris, 'glow', 'var(--glyph-light, currentColor)');

  const dots = lights
    .map(({ c, r }) => {
      const [x, y] = toView(c);
      const rr = Math.max(0.9, r * scale);
      return `<circle class="light" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rr.toFixed(1)}"/>`;
    })
    .join('');
  const ghostRings = ghosts
    .map(({ c, r }) => {
      const [x, y] = toView(c);
      return `<circle class="ghost" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(r * scale).toFixed(1)}" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2.5 2.5"/>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW} ${VIEW}" data-craft="${meta.id}" data-view="${view}" role="img" aria-label="${meta.name}">${body}${glow}${ghostRings}<g class="lights" fill="var(--glyph-light, currentColor)">${dots}</g></svg>`;
}
