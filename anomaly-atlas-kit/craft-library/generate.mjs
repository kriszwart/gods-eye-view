// Compile crafts.json into out/glb/*.glb, out/glyphs/*.svg and out/manifest.json.
// Usage: node generate.mjs [--only id,id] [--no-validate]

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildCraft } from './lib/build.mjs';
import { toGlb } from './lib/glb.mjs';
import { glyphSvg } from './lib/glyph.mjs';

const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const validate = !args.includes('--no-validate');

const lib = JSON.parse(await readFile(new URL('./crafts.json', import.meta.url), 'utf8'));
await mkdir(new URL('./out/glb/', import.meta.url), { recursive: true });
await mkdir(new URL('./out/glyphs/', import.meta.url), { recursive: true });

let validator = null;
if (validate) {
  try {
    validator = (await import('gltf-validator')).default;
  } catch {
    console.warn('gltf-validator not installed; skipping validation');
  }
}

const manifest = {
  schema: 'anomaly-craft-manifest/1',
  loopSeconds: lib.loopSeconds,
  generatedAt: new Date().toISOString(),
  crafts: [],
};
let failures = 0;

for (const def of lib.crafts) {
  if (only && !only.has(def.id)) continue;
  const built = buildCraft(def, lib.materials, lib.loopSeconds);
  const glb = await toGlb(built);
  const svg = glyphSvg(built);
  await writeFile(new URL(`./out/glb/${def.id}.glb`, import.meta.url), glb);
  await writeFile(new URL(`./out/glyphs/${def.id}.svg`, import.meta.url), svg);

  let report = null;
  if (validator) {
    const r = await validator.validateBytes(new Uint8Array(glb), { maxIssues: 50 });
    report = { errors: r.issues.numErrors, warnings: r.issues.numWarnings, infos: r.issues.numInfos, hints: r.issues.numHints };
    if (r.issues.numErrors) {
      failures++;
      console.error(`✗ ${def.id}`, r.issues.messages.filter((m) => m.severity === 0).slice(0, 5));
    }
  }
  let triangles = 0;
  let nodes = 0;
  built.root.traverse((o) => {
    nodes++;
    if (o.isMesh) {
      const g = o.geometry;
      triangles += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    }
  });
  manifest.crafts.push({
    ...built.meta,
    glb: `glb/${def.id}.glb`,
    glyph: `glyphs/${def.id}.svg`,
    bytes: glb.byteLength,
    sha256: createHash('sha256').update(glb).digest('hex'),
    triangles: Math.round(triangles),
    nodes,
    channels: built.channels.length,
    validation: report,
  });
  console.log(
    `${report && report.errors ? '✗' : '✓'} ${def.id.padEnd(14)} ${String(glb.byteLength).padStart(7)} B  ${String(Math.round(triangles)).padStart(6)} tris  ${String(built.channels.length).padStart(3)} ch  N=${built.meta.samples}` +
      (report ? `  (${report.errors} err, ${report.warnings} warn)` : ''),
  );
}

await writeFile(new URL('./out/manifest.json', import.meta.url), JSON.stringify(manifest, null, 2));
console.log(`\n${manifest.crafts.length} crafts written to out/`);
if (failures) {
  console.error(`${failures} craft(s) failed validation`);
  process.exit(1);
}
