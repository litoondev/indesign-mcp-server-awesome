// Focused probe (run copy only): which paragraph/character overrides does replace_paragraphs text mode lose?
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolClient } from './client.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const COPY = path.join(ROOT, 'test_fixtures', 'runs', 'qa-r1-probe.indd');
const OUT = path.join(ROOT, 'test_output', 'runs', 'qa-r1');
const client = new ToolClient({ log: (s) => console.log(s) });
const props = `var d=__resolveDocument(); var s=d.stories.itemByID(5846); var out={};
var idx=[4,12,13,27,28];
for (var k=0;k<idx.length;k++){ var p=s.paragraphs[idx[k]]; var t=String(p.contents); var pre=0; while(pre<t.length&&(t.charAt(pre)=='\\uFFFC'||t.charAt(pre)=='\\t')) pre++;
 var c=p.characters[pre];
 out[idx[k]]={ text:t.substr(0,30), numberingContinue:p.numberingContinue, numberingStartAt:p.numberingStartAt, listType:String(p.bulletsAndNumberingListType),
   charFont:c.appliedFont.fontStyleName, charStyle:c.appliedCharacterStyle.name, styleFont:p.appliedParagraphStyle.fontStyle, leftIndent:p.leftIndent, spaceBefore:p.spaceBefore }; }
__ok(out);`;
const res = {};
try {
  const l = await client.call('list_open_documents', {});
  if ((l.norm.data || []).length) throw new Error('docs open');
  fs.copyFileSync(path.join(ROOT, 'test_fixtures', 'BRAC_TEST_MASTER.indd'), COPY);
  await client.call('open_document', { filePath: COPY });
  res.before = await client.script(props, { docName: COPY });
  const r = await client.call('replace_paragraphs', { document_id: COPY, storyId: 5846, edits: [{ paragraphIndex: 12, text: 'NEW first document' }, { paragraphIndex: 27, text: 'NEW address line' }, { paragraphIndex: 4, text: 'NEW service' }] });
  res.replace = r.norm;
  res.after = await client.script(props, { docName: COPY });
} catch (e) { res.error = String(e.stack || e); }
finally {
  const c = await client.call('close_document', { document_id: COPY, save: 'no' });
  res.closed = c.norm.success;
  res.openAfter = (await client.call('list_open_documents', {})).norm.data;
  fs.writeFileSync(path.join(OUT, 'probe_overrides.json'), JSON.stringify(res, null, 2));
  console.log(JSON.stringify({ before: res.before, after: res.after, error: res.error, closed: res.closed, openAfter: res.openAfter }, null, 1));
  await client.close();
}

