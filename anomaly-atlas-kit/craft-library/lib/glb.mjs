// Converts a three.js node tree plus sampled channels into a GLB using
// glTF-Transform (pure Node, no browser APIs). Geometry shared between nodes is
// written once; materials are created from the tags set in build.mjs.

import { Document, NodeIO } from '@gltf-transform/core';

const round = (v) => Math.round(v * 1e6) / 1e6;

export async function toGlb({ root, channels, meta }) {
  const doc = new Document();
  doc.getRoot().getAsset().generator = 'anomaly-craft-library 1.0 (glTF-Transform)';
  const buffer = doc.createBuffer('main');
  const materials = new Map();
  const meshes = new Map();
  const nodeFor = new Map();

  const gltfMaterial = (m) => {
    const spec = m.userData.gltf;
    if (materials.has(spec.name)) return materials.get(spec.name);
    const out = doc
      .createMaterial(spec.name)
      .setBaseColorFactor(spec.baseColor || [1, 1, 1, 1])
      .setMetallicFactor(spec.metallic ?? 0)
      .setRoughnessFactor(spec.roughness ?? 1)
      .setEmissiveFactor(spec.emissive || [0, 0, 0])
      .setAlphaMode(spec.alpha === 'BLEND' ? 'BLEND' : 'OPAQUE')
      .setDoubleSided(!!spec.doubleSided);
    const extras = {};
    if (spec.irOnly) extras.irOnly = true;
    if (spec.emissive) extras.role = 'light';
    if (Object.keys(extras).length) out.setExtras(extras);
    materials.set(spec.name, out);
    return out;
  };

  const gltfMesh = (geometry, m) => {
    const key = `${geometry.uuid}|${m.userData.gltf.name}`;
    if (meshes.has(key)) return meshes.get(key);
    const pos = geometry.getAttribute('position');
    const nor = geometry.getAttribute('normal');
    const prim = doc.createPrimitive().setMaterial(gltfMaterial(m));
    prim.setAttribute(
      'POSITION',
      doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos.array)).setBuffer(buffer),
    );
    if (nor) {
      const n = new Float32Array(nor.array);
      for (let i = 0; i < n.length; i += 3) {
        const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
        n[i] /= l;
        n[i + 1] /= l;
        n[i + 2] /= l;
      }
      prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(n).setBuffer(buffer));
    }
    if (geometry.index) {
      const idx = geometry.index.array;
      const arr = pos.count <= 65535 ? new Uint16Array(idx) : new Uint32Array(idx);
      prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(arr).setBuffer(buffer));
    }
    const mesh = doc.createMesh(m.userData.gltf.name).addPrimitive(prim);
    meshes.set(key, mesh);
    return mesh;
  };

  const convert = (obj) => {
    const node = doc.createNode(obj.name || '');
    const p = obj.position.toArray().map(round);
    const q = obj.quaternion.toArray().map(round);
    const s = obj.scale.toArray().map(round);
    if (p.some((v) => v !== 0)) node.setTranslation(p);
    if (q[0] || q[1] || q[2] || q[3] !== 1) node.setRotation(q);
    if (s.some((v) => v !== 1)) node.setScale(s);
    if (obj.isMesh) node.setMesh(gltfMesh(obj.geometry, obj.material));
    nodeFor.set(obj, node);
    for (const child of obj.children) node.addChild(convert(child));
    return node;
  };

  const rootNode = convert(root);
  rootNode.setExtras({
    craftId: meta.id,
    name: meta.name,
    family: meta.family,
    nominalSizeM: meta.nominalSizeM,
    loopSeconds: meta.loopSeconds,
    reportedShapes: meta.reportedShapes,
    irOnly: meta.irOnly,
    generator: 'anomaly-craft-library',
  });
  const scene = doc.createScene(meta.id).addChild(rootNode);
  doc.getRoot().setDefaultScene(scene);

  if (channels.length) {
    const anim = doc.createAnimation('idle');
    const inputs = new Map();
    const input = (times) => {
      const key =
        times.length <= 64
          ? Array.from(times).join(',')
          : `${times.length}|${times[0]}|${times[1]}|${times[times.length - 1]}`;
      if (!inputs.has(key))
        inputs.set(key, doc.createAccessor().setType('SCALAR').setArray(new Float32Array(times)).setBuffer(buffer));
      return inputs.get(key);
    };
    for (const ch of channels) {
      const node = nodeFor.get(ch.node);
      if (!node) throw new Error(`${meta.id}: channel target missing (${ch.node.name})`);
      const output = doc
        .createAccessor()
        .setType(ch.path === 'rotation' ? 'VEC4' : 'VEC3')
        .setArray(new Float32Array(ch.values))
        .setBuffer(buffer);
      const sampler = doc
        .createAnimationSampler()
        .setInput(input(ch.times))
        .setOutput(output)
        .setInterpolation(ch.interpolation || 'LINEAR');
      const channel = doc
        .createAnimationChannel()
        .setTargetNode(node)
        .setTargetPath(ch.path)
        .setSampler(sampler);
      anim.addSampler(sampler).addChannel(channel);
    }
  }

  const io = new NodeIO();
  return io.writeBinary(doc);
}
