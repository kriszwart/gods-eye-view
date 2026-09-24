// Message Batches API runner (half the price of standard calls; most batches
// finish within an hour). Needs ANTHROPIC_API_KEY in the environment.
//   node src/extract/batch.mjs submit local_data/extraction/bluebook.requests.jsonl
//   node src/extract/batch.mjs status <batch_id>
//   node src/extract/batch.mjs fetch <batch_id> local_data/extraction/bluebook.results.jsonl
// Requests are JSONL lines of { custom_id, params } as the API expects.

import { readFile, writeFile, appendFile } from 'node:fs/promises';

const API = 'https://api.anthropic.com/v1/messages/batches';
const MAX_REQUESTS = 100000;
const MAX_BYTES = 250 * 1024 * 1024;
const headers = () => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Set ANTHROPIC_API_KEY first');
  return { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
};

async function submit(file) {
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  const chunks = [];
  let cur = [];
  let bytes = 0;
  for (const line of lines) {
    if (cur.length >= MAX_REQUESTS || bytes + line.length > MAX_BYTES) {
      chunks.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(JSON.parse(line));
    bytes += line.length;
  }
  if (cur.length) chunks.push(cur);
  for (const requests of chunks) {
    const res = await fetch(API, { method: 'POST', headers: headers(), body: JSON.stringify({ requests }) });
    const body = await res.json();
    if (!res.ok) throw new Error(`Batch submit failed: ${res.status} ${JSON.stringify(body).slice(0, 400)}`);
    console.log(`${body.id}  ${requests.length} requests  ${body.processing_status}`);
    await appendFile(`${file}.batches`, `${body.id}\n`);
  }
}

async function status(id) {
  const res = await fetch(`${API}/${id}`, { headers: headers() });
  const body = await res.json();
  console.log(JSON.stringify({ id: body.id, status: body.processing_status, counts: body.request_counts, ends_at: body.ends_at }, null, 2));
  return body;
}

async function fetchResults(id, out) {
  const batch = await status(id);
  if (batch.processing_status !== 'ended') return console.log('Not finished yet; try again later.');
  const res = await fetch(batch.results_url, { headers: headers() });
  const text = await res.text();
  const rows = [];
  for (const line of text.split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    const row = { custom_id: r.custom_id, ok: r.result?.type === 'succeeded', data: null, error: null, model: r.result?.message?.model ?? null };
    if (row.ok) {
      const raw = (r.result.message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      try {
        row.data = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      } catch {
        row.ok = false;
        row.error = `Unparseable JSON: ${raw.slice(0, 200)}`;
      }
    } else row.error = r.result?.type || 'unknown';
    rows.push(JSON.stringify(row));
  }
  await writeFile(out, rows.join('\n') + '\n');
  console.log(`${rows.length} results written to ${out}`);
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'submit') await submit(a);
else if (cmd === 'status') await status(a);
else if (cmd === 'fetch') await fetchResults(a, b);
else console.log('Usage: batch.mjs submit <requests.jsonl> | status <id> | fetch <id> <out.jsonl>');
