// qa-r3 probe: does a wrapped PKB web line really make p28..p30 overset, or is __sc_lineInfo wrong? Also tint swap on frame 5887.
// Works on a COPY of the v06 master only (test_fixtures/runs/qa-r3-probe.indd), closes it without saving.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolClient } from './client.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MASTER = path.join(ROOT, 'test_fixtures', 'BRAC_TEST_MASTER.indd');
const COPY = path.join(ROOT, 'test_fixtures', 'runs', 'qa-r3-probe.indd');
const c = new ToolClient({ log: () => {} });
const out = {};
try {
  const l = await c.call('list_open_documents', {});
  if ((l.norm.data || []).length) throw new Error('other documents open');
  fs.copyFileSync(MASTER, COPY);
  await c.call('open_document', { filePath: COPY });
  const S = (code, undoName) => c.script(code, { docName: COPY, undoName });
  const comp = () => S(`var s=__resolveDocument().stories.itemByID(5846); var o=[]; for (var i=26;i<=31;i++){ var p=s.paragraphs[i]; var a=null,z=null; try{ a=p.characters[0].parentTextFrames.length ? p.characters[0].parentTextFrames[0].id : null; z=p.characters[-1].parentTextFrames.length ? p.characters[-1].parentTextFrames[0].id : null; }catch(e){ a='err '+e; } o.push({i:i, first:a, last:z, lines:p.lines.length, t:String(p.contents).substr(0,25)}); } __ok({ overflows: s.overflows, paras: o });`);
  out.before = await comp();
  const long = 'www.agrani-bank-overseas-workers-loan-information-desk-qa.example.org/branches';
  const r = await c.call('replace_contact_block', { document_id: COPY, frameId: 46588, lines: [{ type: 'address', text: 'QA address line' }, { type: 'web', text: long }, { type: 'email', text: 'qa@example.org' }, { type: 'phone', text: '+880 1 000 000' }], wrapPolicy: 'warn' });
  out.call = { success: r.norm.success, data: r.norm.data && { applied: r.norm.data.applied, warnings: r.norm.data.warnings, lineCount: r.norm.data.lineCount, lines: r.norm.data.lines } };
  out.after = await comp();
  await c.call('undo', { document_id: COPY, expectUndoName: 'replace_contact_block' });
  // tint probe
  out.tintSetup = await S(`var d=__resolveDocument(); var col=d.colors.itemByName('Pantone 7498 C'); var t=null; try{ t=d.tints.add(col,{tintValue:50}); }catch(e){ t=d.tints.add({baseColor:col, tintValue:50}); } var f=d.textFrames.itemByID(5887); f.fillColor=t; __ok({ tint:String(t.name), page: f.parentPage ? f.parentPage.documentOffset : null, fill:String(f.fillColor.name), locked: f.locked, itemLayerLocked: f.itemLayer.locked });`, 'probe tint');
  const sw = await c.call('swap_swatch_in_scope', { document_id: COPY, fromSwatch: 'Pantone 7498 C', toSwatch: 'Pantone 298 C', scope: { pageIndexes: [13] }, overrideMode: 'all', dryRun: true });
  out.swapDry = sw.norm.data || sw.norm.error;
  const sw2 = await c.call('swap_swatch_in_scope', { document_id: COPY, fromSwatch: 'Pantone 7498 C', toSwatch: 'Pantone 298 C', scope: { pageIndexes: [13] }, overrideMode: 'all' });
  out.swap = sw2.norm.data || sw2.norm.error;
  out.fillAfter = await S(`var f=__resolveDocument().textFrames.itemByID(5887).fillColor; var o={name:String(f.name)}; try{o.base=f.baseColor.name;o.tint=f.tintValue;}catch(e){} __ok(o);`);
} catch (e) { out.error = String(e && e.stack || e); }
finally {
  const cl = await c.call('close_document', { document_id: COPY, save: 'no' });
  out.closed = cl.norm.success;
  out.openAfter = (await c.call('list_open_documents', {})).norm.data;
  fs.writeFileSync(path.join(ROOT, 'test_output', 'runs', 'qa-r3b', 'probe_wrap_tint.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 1).slice(0, 9000));
  await c.close();
}
