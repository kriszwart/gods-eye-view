// Re-validate every GLB in out/glb with the Khronos glTF validator.
import { readFile, readdir } from 'node:fs/promises';
import validator from 'gltf-validator';

const dir = new URL('./out/glb/', import.meta.url);
let bad = 0;
for (const f of (await readdir(dir)).filter((n) => n.endsWith('.glb')).sort()) {
  const bytes = new Uint8Array(await readFile(new URL(f, dir)));
  const r = await validator.validateBytes(bytes);
  const { numErrors, numWarnings } = r.issues;
  if (numErrors) bad++;
  console.log(`${numErrors ? '✗' : '✓'} ${f.padEnd(20)} ${numErrors} errors, ${numWarnings} warnings`);
}
if (bad) process.exit(1);
