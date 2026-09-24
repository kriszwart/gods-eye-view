// Embed the generated GLBs, glyphs, manifest and definitions into a single
// self-contained preview page: preview/atlas.html (open it in any browser).

import { readFile, writeFile } from 'node:fs/promises';

const here = (p) => new URL(p, import.meta.url);
const manifest = JSON.parse(await readFile(here('./out/manifest.json'), 'utf8'));
const library = JSON.parse(await readFile(here('./crafts.json'), 'utf8'));
const glyphs = {};
const glbs = {};
for (const c of manifest.crafts) {
  glyphs[c.id] = await readFile(here(`./out/${c.glyph}`), 'utf8');
  glbs[c.id] = (await readFile(here(`./out/${c.glb}`))).toString('base64');
}
let cases = [];
try {
  cases = JSON.parse(await readFile(here('../pipeline/sample/hero-cases.sample.json'), 'utf8')).cases;
} catch {
  console.warn('No sample cases found; the plate will omit "Seen in".');
}
const data = JSON.stringify({ manifest, library, glyphs, glbs, cases }).replace(/<\//g, '<\\/');
const template = await readFile(here('./preview/atlas.template.html'), 'utf8');
if (!template.includes('__ATLAS_DATA__')) throw new Error('Template placeholder missing');
const html = template.replace('__ATLAS_DATA__', () => data);
await writeFile(here('./preview/atlas.html'), html);
console.log(`preview/atlas.html written (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
