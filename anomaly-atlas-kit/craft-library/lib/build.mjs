// Builds one craft definition into a three.js node tree plus sampled animation
// channels. Everything is authored in normalised units and scaled to metres on
// the root node. All motion uses whole-number cycles per loop, so every channel
// returns to its starting value and the idle animation loops without a seam.

import * as THREE from 'three';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const MESH_TYPES = new Set([
  'lathe',
  'torus',
  'tetra',
  'octa',
  'box',
  'cylinder',
  'extrude',
  'side-extrude',
]);
const LIGHT_TYPES = new Set([
  'point-lights',
  'ring-lights',
  'arc-lights',
  'scatter-lights',
  'spiral-lights',
]);

/** Deterministic pseudo-random generator so rebuilds are byte-stable. */
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const frac = (v) => v - Math.floor(v);
const axisVector = (a) =>
  a === 'x'
    ? new THREE.Vector3(1, 0, 0)
    : a === 'z'
      ? new THREE.Vector3(0, 0, 1)
      : new THREE.Vector3(0, 1, 0);

/** Create a tagged material; glb.mjs turns the tag into a glTF material. */
function material(name, spec) {
  if (!spec) throw new Error(`Unknown material: ${name}`);
  const m = new THREE.MeshStandardMaterial({ name });
  m.userData.gltf = { name, ...spec };
  return m;
}

/** Bake a part's static rotation and scale into its geometry. */
function bakeStatic(geometry, part) {
  if (part.scale) geometry.scale(...part.scale);
  if (part.rotation) {
    const e = new THREE.Euler(
      part.rotation[0] * DEG,
      part.rotation[1] * DEG,
      part.rotation[2] * DEG,
      'XYZ',
    );
    geometry.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(e));
  }
  return geometry;
}

/** Faceted normals, dropping degenerate triangles (for example lathe poles). */
function flatten(geometry) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const src = g.getAttribute('position').array;
  const keep = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let i = 0; i < src.length; i += 9) {
    a.fromArray(src, i);
    b.fromArray(src, i + 3);
    c.fromArray(src, i + 6);
    const area = b.clone().sub(a).cross(c.clone().sub(a)).length();
    if (area > 1e-10) for (let k = 0; k < 9; k++) keep.push(src[i + k]);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3));
  out.computeVertexNormals();
  return out;
}

/** Plan-view outline points [x, z] for extrusions (supports a crescent helper). */
function outlinePoints(outline) {
  if (Array.isArray(outline)) return outline;
  if (outline && typeof outline.crescent === 'number') {
    // Two unit circles, the second offset by d towards +z; keep the part of
    // the first that lies outside the second. Tips are the intersections.
    const d = outline.crescent;
    const steps = outline.steps || 32;
    const xi = Math.sqrt(1 - (d * d) / 4);
    const tipAngle = Math.atan2(d / 2, xi);
    const pts = [];
    const a0 = Math.PI - tipAngle;
    const a1 = TAU + tipAngle;
    for (let i = 0; i <= steps; i++) {
      const a = a0 + ((a1 - a0) * i) / steps;
      pts.push([Math.cos(a), Math.sin(a)]);
    }
    const u0 = Math.atan2(d / 2 - d, xi);
    const u1 = Math.atan2(d / 2 - d, -xi);
    const start = u0 < 0 ? u0 + TAU : u0;
    const end = u1 < 0 ? u1 + TAU : u1;
    for (let i = 1; i < steps; i++) {
      const u = start + ((end - start) * i) / steps;
      pts.push([Math.cos(u), d + Math.sin(u)]);
    }
    return pts;
  }
  throw new Error('Unsupported outline');
}

/** Geometry for mesh-type parts (everything that is not a light/particle set). */
function meshGeometry(part) {
  switch (part.type) {
    case 'lathe': {
      const pts = part.profile.map(([r, y]) => new THREE.Vector2(r, y));
      let g = new THREE.LatheGeometry(pts, part.segments || 96);
      if (part.flat) g = flatten(g);
      return bakeStatic(g, part);
    }
    case 'torus':
      return bakeStatic(
        new THREE.TorusGeometry(part.radius, part.tube, 24, 96),
        part,
      );
    case 'tetra':
      return bakeStatic(new THREE.TetrahedronGeometry(part.radius || 1), part);
    case 'octa':
      return bakeStatic(
        flatten(new THREE.OctahedronGeometry(part.radius || 1)),
        part,
      );
    case 'box':
      return bakeStatic(new THREE.BoxGeometry(...part.size), part);
    case 'cylinder':
      return bakeStatic(
        new THREE.CylinderGeometry(
          part.radiusTop,
          part.radiusBottom,
          part.height,
          16,
        ),
        part,
      );
    case 'extrude': {
      const pts = outlinePoints(part.outline);
      const shape = new THREE.Shape(
        pts.map(([x, z]) => new THREE.Vector2(x, -z)),
      );
      const bevel = part.bevel || 0;
      const g = new THREE.ExtrudeGeometry(shape, {
        depth: part.depth,
        bevelEnabled: bevel > 0,
        bevelThickness: bevel,
        bevelSize: bevel,
        bevelSegments: 2,
        curveSegments: 12,
      });
      g.rotateX(-Math.PI / 2);
      g.translate(0, -part.depth / 2, 0);
      return bakeStatic(g, part);
    }
    case 'side-extrude': {
      const shape = new THREE.Shape(
        part.profile.map(([x, y]) => new THREE.Vector2(x, y)),
      );
      const bevel = part.bevel || 0;
      const g = new THREE.ExtrudeGeometry(shape, {
        depth: part.width,
        bevelEnabled: bevel > 0,
        bevelThickness: bevel,
        bevelSize: bevel,
        bevelSegments: 2,
      });
      g.translate(0, 0, -part.width / 2);
      return bakeStatic(g, part);
    }
    default:
      return null;
  }
}

/** Light/particle positions and chase order for multi-node light parts. */
function lightLayout(part) {
  switch (part.type) {
    case 'point-lights':
      return part.positions.map((p, i) => ({
        p,
        order: part.order ? part.order[i] : i,
      }));
    case 'ring-lights':
      return Array.from({ length: part.count }, (_, i) => {
        const a = (i / part.count) * TAU;
        return {
          p: [
            Math.cos(a) * part.radius,
            part.y || 0,
            Math.sin(a) * part.radius,
          ],
          order: i,
        };
      });
    case 'arc-lights':
      return Array.from({ length: part.count }, (_, i) => {
        const f = part.count === 1 ? 0 : i / (part.count - 1);
        const a = (part.startDeg + (part.endDeg - part.startDeg) * f) * DEG;
        return {
          p: [Math.cos(a) * part.radius, 0, Math.sin(a) * part.radius],
          order: i,
        };
      });
    case 'scatter-lights': {
      const r = rng(part.seed || 1);
      return Array.from({ length: part.count }, (_, i) => {
        const u = r() * TAU;
        const v = Math.acos(2 * r() - 1);
        const rad = part.radius * Math.cbrt(0.25 + 0.75 * r());
        return {
          p: [
            rad * Math.sin(v) * Math.cos(u),
            rad * Math.cos(v) * 0.6,
            rad * Math.sin(v) * Math.sin(u),
          ],
          order: i,
        };
      });
    }
    case 'spiral-lights': {
      const out = [];
      for (let a = 0; a < part.arms; a++) {
        for (let k = 1; k <= part.perArm; k++) {
          const f = k / part.perArm;
          const th = TAU * (a / part.arms + part.turns * f);
          out.push({
            p: [
              Math.cos(th) * part.radius * f,
              0,
              Math.sin(th) * part.radius * f,
            ],
            order: k - 1,
          });
        }
      }
      return out;
    }
    default:
      return [];
  }
}

/**
 * Build a craft into { root, body, channels, meta }.
 * channels: [{ node, path, times, values, interpolation }]
 */
export function buildCraft(def, materialSpecs, loopSeconds) {
  const T = loopSeconds;
  const mats = new Map();
  const mat = (name) => {
    if (!mats.has(name)) mats.set(name, material(name, materialSpecs[name]));
    return mats.get(name);
  };

  const root = new THREE.Group();
  root.name = def.id;
  const motion = def.motion || {};
  let jumpNode = null;
  if (motion.jump) {
    jumpNode = new THREE.Group();
    jumpNode.name = 'jump';
    root.add(jumpNode);
  }
  const body = new THREE.Group();
  body.name = 'body';
  (jumpNode || root).add(body);

  const pivots = new Map();
  const partNodes = new Map(); // part name -> [{ node, order, base, extra }]

  for (const part of def.parts) {
    const pivot = new THREE.Group();
    pivot.name = part.name;
    if (part.position && !MESH_TYPES.has(part.type))
      pivot.position.fromArray(part.position);
    const parent = part.parent ? pivots.get(part.parent) : body;
    if (!parent) throw new Error(`${def.id}: unknown parent ${part.parent}`);
    parent.add(pivot);
    pivots.set(part.name, pivot);
    const nodes = [];

    if (part.type === 'group') {
      // Empty pivot used as an animation handle (an orbit) or a static frame.
      if (part.rotation)
        pivot.rotation.set(
          part.rotation[0] * DEG,
          part.rotation[1] * DEG,
          part.rotation[2] * DEG,
        );
    } else if (LIGHT_TYPES.has(part.type) || part.type === 'spheres') {
      const isLight = LIGHT_TYPES.has(part.type);
      const geo = new THREE.SphereGeometry(
        part.size,
        isLight ? 14 : 28,
        isLight ? 10 : 18,
      );
      const layout =
        part.type === 'spheres'
          ? part.positions.map((p, i) => ({ p, order: i }))
          : lightLayout(part);
      layout.forEach(({ p, order }, i) => {
        const m = new THREE.Mesh(geo, mat(part.material));
        m.name = `${part.name}_${i}`;
        m.position.fromArray(p);
        m.userData.light = isLight;
        pivot.add(m);
        nodes.push({ node: m, order, base: m.position.clone() });
      });
    } else if (part.type === 'plume') {
      const geo = new THREE.SphereGeometry(part.size, 12, 8);
      for (let i = 0; i < part.count; i++) {
        const m = new THREE.Mesh(geo, mat(part.material));
        m.name = `${part.name}_${i}`;
        m.position.fromArray(part.origin);
        m.userData.light = true;
        pivot.add(m);
        nodes.push({ node: m, order: i, base: m.position.clone() });
      }
    } else if (part.type === 'tentacles') {
      const geo = new THREE.SphereGeometry(part.size, 10, 8);
      for (let i = 0; i < part.count; i++) {
        const a = (i / part.count) * TAU;
        const chain = new THREE.Group();
        chain.name = `${part.name}_${i}`;
        chain.position.set(
          Math.cos(a) * part.radius,
          part.y,
          Math.sin(a) * part.radius,
        );
        pivot.add(chain);
        for (let j = 0; j < part.segments; j++) {
          const m = new THREE.Mesh(geo, mat(part.material));
          m.name = `${part.name}_${i}_${j}`;
          m.position.set(0, -(j + 1) * part.segLength, 0);
          const s = 1 - (0.55 * j) / part.segments;
          m.scale.setScalar(s);
          chain.add(m);
          nodes.push({
            node: m,
            order: j,
            base: m.position.clone(),
            extra: { chain: i, seg: j, count: part.count, segs: part.segments },
          });
        }
      }
    } else if (part.type === 'legs') {
      for (let i = 0; i < part.count; i++) {
        const a = (i / part.count) * TAU + Math.PI / 2;
        const top = new THREE.Vector3(
          Math.cos(a) * part.radius,
          part.top,
          Math.sin(a) * part.radius,
        );
        const bottom = new THREE.Vector3(
          Math.cos(a) * (part.radius + part.splay),
          part.bottom,
          Math.sin(a) * (part.radius + part.splay),
        );
        const dir = bottom.clone().sub(top);
        const len = dir.length();
        const legGeo = new THREE.CylinderGeometry(
          part.thickness,
          part.thickness,
          len,
          10,
        );
        const leg = new THREE.Mesh(legGeo, mat(part.material));
        leg.name = `${part.name}_${i}`;
        leg.position.copy(top.clone().add(bottom).multiplyScalar(0.5));
        leg.quaternion.setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          dir.clone().normalize(),
        );
        pivot.add(leg);
        const footGeo = new THREE.SphereGeometry(part.foot, 16, 10);
        footGeo.scale(1, 0.45, 1);
        const foot = new THREE.Mesh(footGeo, mat(part.material));
        foot.name = `${part.name}_foot_${i}`;
        foot.position.copy(bottom);
        pivot.add(foot);
      }
    } else {
      const geo = meshGeometry(part);
      if (!geo) throw new Error(`${def.id}: unsupported part type ${part.type}`);
      const m = new THREE.Mesh(geo, mat(part.material));
      m.name = `${part.name}_mesh`;
      if (part.position) m.position.fromArray(part.position);
      pivot.add(m);
      nodes.push({ node: m, order: 0, base: m.position.clone() });
    }
    partNodes.set(part.name, { part, nodes, pivot });
  }

  // Scale to metres from the rest-pose bounds.
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const metresPerUnit = def.nominalSizeM / maxDim;
  root.scale.setScalar(metresPerUnit);

  // ---- motion sampling -------------------------------------------------
  const cyc = [];
  const push = (v) => Number.isFinite(v) && cyc.push(Math.abs(v));
  if (motion.spin) push(motion.spin.rev * 3);
  if (motion.bob) push(motion.bob.cycles);
  if (motion.drift) push(motion.drift.cycles);
  if (motion.skip) push(motion.skip.cycles * 2);
  if (motion.vibrate) push(motion.vibrate.cycles);
  if (motion.stretch) push(motion.stretch.cycles);
  if (motion.precess) push(motion.precess.cycles * 2);
  if (motion.tumble)
    push(Math.max(motion.tumble.x || 0, motion.tumble.y || 0, motion.tumble.z || 0) * 3);
  for (const r of motion.rock || []) push(r.cycles);
  for (const p of motion.pulse || []) if (p.mode !== 'strobe') push(p.cycles);
  for (const p of motion.plume || []) push(p.speed * 2);
  for (const s of motion.sway || []) push(s.cycles);
  for (const c of motion.counter || []) push(c.rev * 3);
  const N = Math.min(481, Math.max(121, 8 * Math.max(0, ...cyc) + 1));
  const times = Float32Array.from({ length: N }, (_, k) => (k * T) / (N - 1));
  const w = (c, t) => (TAU * c * t) / T;
  const channels = [];
  const addChannel = (node, path, tArr, values, interpolation = 'LINEAR') =>
    channels.push({ node, path, times: tArr, values, interpolation });

  // Body translation, rotation and scale.
  const hasT = motion.bob || motion.drift || motion.skip || motion.vibrate;
  const hasR =
    motion.spin || motion.precess || motion.tumble || (motion.rock || []).length;
  if (hasT) {
    const v = new Float32Array(N * 3);
    for (let k = 0; k < N; k++) {
      const t = times[k];
      const p = [0, 0, 0];
      if (motion.bob) p[1] += motion.bob.amp * Math.sin(w(motion.bob.cycles, t));
      if (motion.drift) {
        const i = 'xyz'.indexOf(motion.drift.axis || 'x');
        p[i] += motion.drift.amp * Math.sin(w(motion.drift.cycles, t));
      }
      if (motion.skip)
        p[1] +=
          motion.skip.amp *
          (Math.abs(Math.sin((Math.PI * motion.skip.cycles * t) / T)) - 0.5);
      if (motion.vibrate) {
        const i = 'xyz'.indexOf(motion.vibrate.axis || 'x');
        p[i] += motion.vibrate.amp * Math.sin(w(motion.vibrate.cycles, t));
      }
      v.set(p, k * 3);
    }
    addChannel(body, 'translation', times, v);
  }
  if (hasR) {
    const v = new Float32Array(N * 4);
    const q = new THREE.Quaternion();
    const prev = new THREE.Quaternion();
    for (let k = 0; k < N; k++) {
      const t = times[k];
      q.identity();
      if (motion.precess) {
        const phi = w(motion.precess.cycles, t);
        const axis = new THREE.Vector3(Math.cos(phi), 0, Math.sin(phi));
        q.multiply(
          new THREE.Quaternion().setFromAxisAngle(axis, motion.precess.deg * DEG),
        );
      }
      for (const r of motion.rock || []) {
        q.multiply(
          new THREE.Quaternion().setFromAxisAngle(
            axisVector(r.axis),
            r.deg * DEG * Math.sin(w(r.cycles, t)),
          ),
        );
      }
      if (motion.tumble) {
        const e = new THREE.Euler(
          w(motion.tumble.x || 0, t),
          w(motion.tumble.y || 0, t),
          w(motion.tumble.z || 0, t),
          'XYZ',
        );
        q.multiply(new THREE.Quaternion().setFromEuler(e));
      }
      if (motion.spin)
        q.multiply(
          new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0),
            w(motion.spin.rev, t),
          ),
        );
      q.normalize();
      if (k > 0 && prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      prev.copy(q);
      v.set([q.x, q.y, q.z, q.w], k * 4);
    }
    addChannel(body, 'rotation', times, v);
  }
  if (motion.stretch) {
    const v = new Float32Array(N * 3);
    const i = 'xyz'.indexOf(motion.stretch.axis || 'x');
    for (let k = 0; k < N; k++) {
      const e = 0.5 - 0.5 * Math.cos(w(motion.stretch.cycles, times[k]));
      const s = [1 - 0.22 * motion.stretch.amount * e, 1 - 0.22 * motion.stretch.amount * e, 1 - 0.22 * motion.stretch.amount * e];
      s[i] = 1 + motion.stretch.amount * e;
      v.set(s, k * 3);
    }
    addChannel(body, 'scale', times, v);
  }

  // Discrete jumps (near-instant repositioning) on the jump node.
  if (motion.jump && jumpNode) {
    const r = rng(motion.jump.seed || 1);
    const n = motion.jump.count;
    const tj = new Float32Array(n);
    const vj = new Float32Array(n * 3);
    for (let j = 0; j < n; j++) {
      tj[j] = (j * T) / n;
      const a = r() * TAU;
      const rad = j === 0 ? 0 : motion.jump.radius * (0.35 + 0.65 * r());
      vj.set([Math.cos(a) * rad, (r() - 0.5) * motion.jump.radius * 0.4, Math.sin(a) * rad], j * 3);
    }
    addChannel(jumpNode, 'translation', tj, vj, 'STEP');
  }

  // Counter-rotating sub-parts (orbits, rings).
  for (const c of motion.counter || []) {
    const target = pivots.get(c.target);
    if (!target) throw new Error(`${def.id}: unknown counter target ${c.target}`);
    const v = new Float32Array(N * 4);
    const q = new THREE.Quaternion();
    const prev = new THREE.Quaternion();
    for (let k = 0; k < N; k++) {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), w(c.rev, times[k]));
      if (k > 0 && prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      prev.copy(q);
      v.set([q.x, q.y, q.z, q.w], k * 4);
    }
    addChannel(target, 'rotation', times, v);
  }

  // Light pulses: sync, chase or strobe (STEP).
  for (const p of motion.pulse || []) {
    const entry = partNodes.get(p.target);
    if (!entry) throw new Error(`${def.id}: unknown pulse target ${p.target}`);
    const count = Math.max(1, ...entry.nodes.map((n) => n.order + 1));
    for (const { node, order } of entry.nodes) {
      const base = node.scale.x;
      const phase = p.mode === 'chase' ? order / count : 0;
      if (p.mode === 'strobe') {
        const duty = p.duty ?? 0.2;
        const events = [];
        for (let k = 0; k < p.cycles; k++) {
          const on = frac((k + phase) / p.cycles) * T;
          const off = frac((k + phase + duty) / p.cycles) * T;
          events.push([on, 1.45], [off, 0.3]);
        }
        events.sort((a, b) => a[0] - b[0]);
        const lead = events[events.length - 1][1];
        const list = events[0][0] > 0 ? [[0, lead], ...events] : events;
        const tArr = Float32Array.from(list.map((e) => e[0]));
        const vArr = new Float32Array(list.length * 3);
        list.forEach((e, i) => vArr.set([e[1] * base, e[1] * base, e[1] * base], i * 3));
        addChannel(node, 'scale', tArr, vArr, 'STEP');
      } else {
        const v = new Float32Array(N * 3);
        for (let k = 0; k < N; k++) {
          const s = Math.max(
            0.05,
            1 + (p.amount ?? 0.3) * Math.sin(TAU * ((p.cycles * times[k]) / T - phase)),
          ) * base;
          v.set([s, s, s], k * 3);
        }
        addChannel(node, 'scale', times, v);
      }
    }
  }

  // Plume particles flowing from the origin and fading out.
  for (const p of motion.plume || []) {
    const entry = partNodes.get(p.target);
    const part = entry.part;
    const dir = new THREE.Vector3(...part.direction).normalize();
    const side = new THREE.Vector3(0, 1, 0).cross(dir);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    const up = dir.clone().cross(side).normalize();
    const n = entry.nodes.length;
    entry.nodes.forEach(({ node }, i) => {
      const tv = new Float32Array(N * 3);
      const sv = new Float32Array(N * 3);
      for (let k = 0; k < N; k++) {
        const f = frac(i / n + (p.speed * times[k]) / T);
        const j1 = Math.sin(w(3, times[k]) + i * 1.7) * part.spread * f * 3;
        const j2 = Math.cos(w(2, times[k]) + i * 2.3) * part.spread * f * 3;
        const pos = new THREE.Vector3(...part.origin)
          .addScaledVector(dir, part.length * f)
          .addScaledVector(side, j1)
          .addScaledVector(up, j2);
        tv.set(pos.toArray(), k * 3);
        const s = Math.max(0.02, Math.pow(Math.sin(Math.PI * f), 0.7) * (1 - 0.45 * f));
        sv.set([s, s, s], k * 3);
      }
      addChannel(node, 'translation', times, tv);
      addChannel(node, 'scale', times, sv);
    });
  }

  // Wandering lights (swarms): smooth Lissajous drift around a base point.
  for (const wd of motion.wander || []) {
    const entry = partNodes.get(wd.target);
    const r = rng(17);
    entry.nodes.forEach(({ node, base }) => {
      const a = 1 + Math.floor(r() * 3);
      const b = 1 + Math.floor(r() * 3);
      const c = 1 + Math.floor(r() * 3);
      const p1 = r() * TAU;
      const p2 = r() * TAU;
      const p3 = r() * TAU;
      const v = new Float32Array(N * 3);
      for (let k = 0; k < N; k++) {
        const t = times[k];
        v.set(
          [
            base.x + wd.amp * Math.sin(w(a, t) + p1),
            base.y + wd.amp * 0.6 * Math.sin(w(b, t) + p2),
            base.z + wd.amp * Math.sin(w(c, t) + p3),
          ],
          k * 3,
        );
      }
      addChannel(node, 'translation', times, v);
    });
  }

  // Tentacle sway: serpentine offsets growing towards the tips.
  for (const sw of motion.sway || []) {
    const entry = partNodes.get(sw.target);
    for (const { node, base, extra } of entry.nodes) {
      const phase = (extra.chain / extra.count) * TAU;
      const factor = Math.pow((extra.seg + 1) / extra.segs, 1.3);
      const v = new Float32Array(N * 3);
      for (let k = 0; k < N; k++) {
        const a = w(sw.cycles, times[k]) - sw.wave * extra.seg + phase;
        v.set(
          [
            base.x + sw.amp * factor * Math.sin(a),
            base.y,
            base.z + sw.amp * factor * Math.cos(a),
          ],
          k * 3,
        );
      }
      addChannel(node, 'translation', times, v);
    }
  }

  // Rest pose = the first sample of every channel, so viewers that do not play
  // animations (and the glyph tracer) see a representative frame.
  for (const ch of channels) {
    const v = ch.values;
    if (ch.path === 'translation') ch.node.position.set(v[0], v[1], v[2]);
    else if (ch.path === 'scale') ch.node.scale.set(v[0], v[1], v[2]);
    else ch.node.quaternion.set(v[0], v[1], v[2], v[3]);
  }

  const meta = {
    id: def.id,
    name: def.name,
    family: def.family,
    nominalSizeM: def.nominalSizeM,
    metresPerUnit,
    loopSeconds: T,
    samples: N,
    reportedShapes: def.reportedShapes || [],
    glyphView: def.glyphView || 'side',
    irOnly: !!def.irOnly,
    parts: def.parts.map((p) => ({ name: p.name, type: p.type, material: p.material || null })),
    motions: Object.keys(motion),
  };
  return { root, body, channels, meta };
}
