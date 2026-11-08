// One-off exploration of a v06 run copy (read-only). Usage: node tests/harness/_explore_v06.mjs <label>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolClient } from './client.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const label = process.argv[2] || 'explore-v06';
const COPY = path.join(ROOT, 'test_fixtures', 'runs', label + '.indd');
const MASTER = path.join(ROOT, 'test_fixtures', 'BRAC_TEST_MASTER.indd');
const OUT = path.join(ROOT, 'test_output', 'runs', label);
fs.mkdirSync(OUT, { recursive: true });
const client = new ToolClient({ log: (s) => console.log(s) });
const res = {};
try {
  const l = await client.call('list_open_documents', {});
  res.openBefore = l.norm.data;
  if (Array.isArray(l.norm.data) && l.norm.data.length) throw new Error('documents open: ' + JSON.stringify(l.norm.data));
  fs.copyFileSync(MASTER, COPY);
  const o = await client.call('open_document', { filePath: COPY }, { timeoutMs: 600000 });
  res.open = o.norm;
  const code = fs.readFileSync(path.join(HERE, '_explore_v06.jsx'), 'utf-8');
  res.dump = await client.script(code, { docName: COPY, timeoutMs: 600000 });
} catch (e) { res.error = String(e.stack || e); }
finally {
  const c = await client.call('close_document', { document_id: COPY, save: 'no' }, { timeoutMs: 300000 });
  res.close = c.norm;
  const l2 = await client.call('list_open_documents', {});
  res.openAfter = l2.norm.data;
  fs.writeFileSync(path.join(OUT, 'explore.json'), JSON.stringify(res, null, 2));
  console.log('wrote', path.join(OUT, 'explore.json'));
  await client.close();
}
