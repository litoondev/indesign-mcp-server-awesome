// Round-2 regression scenarios (qa-r2). One scenario per fixed bug / new tool from round 1.
// Every scenario starts from a FRESH copy of the v06 master (freshCopy), so they are independent
// of scenarios 1-9 and of each other. Facts below were verified on a pristine v06 copy:
//   story 5846 (PKB + Agrani, pages 02-10, overset at baseline because of the Agrani branch table at p69)
//   p12 "Application form..." Body Description Numbers, numberingContinue=false (list restart), result "1.\t"
//   p36 "Agrani Bank loan..." Service Name Numbered, numberingContinue=false, NO_LIST
//   p40 "ALOW loan application..." Body Description Numbers, numberingContinue=false, result "1.\t"
//   contact block 0 = p27..p30 (frame 46588, address/web/email/phone), block 1 = p65..p67 (frame 49888, address/web/phone)
//   p32/p33/p69 hold tables (U+0016), p27..p30 and p65..p67 start with U+FFFC + tab
//   page 13 ("02") has the empty background frame 5887 overlapping 5864
//   master "1-Access to Finance": running head frame 48265 ("Chapter 1: Access to Finance"), 48288 ("Referral Directory for Safe Mi...")
//   page 12 (XIII, chapter opener) is RIGHT_HAND; 25 pages; masters: 1-Access to Finance, 2-Access to Social Welfare, B-Blank, A-Parent
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function regressionR2(h) {
  const { scenario, rec, T, S, client, C, FX, DOC, ROOT, freshCopy } = h;
  const SID = FX.pkb.storyId;
  const raw = (r) => (r && r.result && typeof r.result === 'object' && r.result.data !== undefined ? r.result.data : r && r.norm && r.norm.data) || {};
  const pinfo = (sid, from, to) => S(`var d=__resolveDocument(); var s=d.stories.itemByID(${Number(sid)}); var n=s.paragraphs.length; var a=[]; var to=Math.min(${Number(to)}, n-1);
for (var i=${Number(from)}; i<=to; i++){ var p=s.paragraphs[i]; var rt=''; try{rt=String(p.bulletsAndNumberingResultText);}catch(e){}
  var c=String(p.contents); var ci=c.indexOf(':'); var lf=null, vf=null;
  try{ if(ci>0 && ci<60){ var k0=0; while(k0<c.length && (c.charAt(k0)=='\\uFFFC'||c.charAt(k0)=='\\t')) k0++; lf=String(p.characters[k0].fontStyle)+'|'+String(p.characters[ci].fontStyle); vf=String(p.characters[Math.min(ci+2,c.length-2)].fontStyle);} }catch(e){}
  var fc=''; try{ fc=p.characters[0].fillColor.name; }catch(e){}
  a.push({i:i, t:c.substr(0,60), sid:p.appliedParagraphStyle.id, nc:p.numberingContinue, sa:p.numberingStartAt, rt:rt, lt:String(p.bulletsAndNumberingListType), lf:lf, vf:vf, fc:fc, anch:p.allPageItems.length, tb:p.tables.length, li:p.leftIndent, fi:p.firstLineIndent, sb:p.spaceBefore, sa2:p.spaceAfter}); }
__ok({n:n, len:s.characters.length, overflows:s.overflows, anchored:s.allPageItems.length, text:String(s.contents).length, paras:a});`);
  const storyText = (sid) => S(`var s=__resolveDocument().stories.itemByID(${Number(sid)}); __ok(String(s.contents).replace(/[\\u0000-\\u001f]/g, function(c){ return '<'+c.charCodeAt(0)+'>'; }));`);
  const pages = () => S(`var d=__resolveDocument(); var a=[]; for (var i=0;i<d.pages.length;i++) a.push(d.pages[i].name+':'+String(d.pages[i].side)); var m=[]; for (var j=0;j<d.masterSpreads.length;j++) m.push(d.masterSpreads[j].name); var u=''; var rd=''; try{u=String(d.undoName);}catch(e){} try{rd=String(d.redoName);}catch(e){} __ok({count:d.pages.length, sides:a, masters:m, undoName:u, redoName:rd});`);
  const idxOf = (info, prefix) => { const p = info.paras.find((x) => x.t.startsWith(prefix)); return p ? p.i : -1; };

  // ── 10: qa-r1-01 / design-r1-01 — paragraph overrides (list restart) survive replace_paragraphs ──
  await scenario(10, 'qa-r1-01 replace_paragraphs keeps paragraph-level overrides (list restart) and \\r paragraphs continue the list', 1200000, async (scn) => {
    await freshCopy();
    const b = await pinfo(SID, 10, 45);
    const P = (info, i) => info.paras.find((x) => x.i === i);
    rec(scn, 'baseline: p12 and p40 restart their numbered lists (numberingContinue=false, "1.")', P(b, 12).nc === false && P(b, 12).rt === '1.\t' && P(b, 40).nc === false && P(b, 40).rt === '1.\t' && P(b, 36).nc === false, { p12: P(b, 12), p36: P(b, 36), p40: P(b, 40) });
    const r1 = await T('replace_paragraphs', { storyId: SID, edits: [
      { paragraphIndex: 12, text: 'QA replaced application form text', expectStyleId: FX.styleIds.numbers },
      { paragraphIndex: 13, text: 'QA replaced second document item', expectStyleId: FX.styleIds.numbers },
      { paragraphIndex: 36, text: 'QA replaced Agrani service name', expectStyleId: FX.styleIds.serviceName },
    ] });
    const d1 = raw(r1);
    scn.replace1 = { success: r1.norm.success, error: r1.norm.error, overrideErrors: d1.overrideErrors, warnings: d1.warnings, rollbackRequired: d1.rollbackRequired, applied: d1.applied };
    rec(scn, 'replace_paragraphs p12/p13/p36 succeeds with no overrideErrors / rollback', r1.norm.success && (d1.overrideErrors || []).length === 0 && !d1.rollbackRequired && (d1.mismatches || []).length === 0, scn.replace1);
    const a = await pinfo(SID, 10, 45);
    rec(scn, 'p12 keeps the list restart (numberingContinue=false, still "1.") and p13 is "2."', P(a, 12).nc === false && P(a, 12).rt === '1.\t' && P(a, 13).rt === '2.\t' && /^QA replaced application/.test(P(a, 12).t), { p12: P(a, 12), p13: P(a, 13) });
    rec(scn, 'Agrani lists unaffected: p36 numberingContinue=false, p40 restarts at "1."', P(a, 36).nc === false && P(a, 40).nc === false && P(a, 40).rt === '1.\t', { p36: P(a, 36), p40: P(a, 40) });
    rec(scn, 'paragraph styles and indents of p10..p45 unchanged', b.paras.every((p) => { const q = P(a, p.i); return q && q.sid === p.sid && q.li === p.li && q.fi === p.fi && q.sb === p.sb && q.sa2 === p.sa2; }), { diff: b.paras.filter((p) => { const q = P(a, p.i); return !q || q.sid !== p.sid || q.li !== p.li || q.fi !== p.fi; }).map((p) => ({ i: p.i, before: p, after: P(a, p.i) })) });
    const u = await T('undo', { expectUndoName: 'replace_paragraphs' });
    const au = await pinfo(SID, 10, 45);
    rec(scn, 'undo (expectUndoName replace_paragraphs) restores the original paragraphs', u.norm.success && raw(u).undone === true && P(au, 12).t === P(b, 12).t && P(au, 36).t === P(b, 36).t, { undo: raw(u), error: u.norm.error });
    // \r split: new paragraphs must continue the list (style value), only the first keeps the restart
    const styleNc = await S(`var d=__resolveDocument(); var st=null; var a=d.allParagraphStyles; for (var i=0;i<a.length;i++) if (a[i].id==${FX.styleIds.numbers}) st=a[i]; __ok(st.numberingContinue);`);
    const r2 = await T('replace_paragraphs', { storyId: SID, edits: [{ paragraphIndex: 12, text: 'QA doc one\rQA doc two\rQA doc three', expectStyleId: FX.styleIds.numbers }] });
    const d2 = raw(r2);
    scn.replace2 = { success: r2.norm.success, error: r2.norm.error, overrideErrors: d2.overrideErrors, applied: d2.applied, styleNumberingContinue: styleNc };
    const c = await pinfo(SID, 10, 20);
    rec(scn, '\\r split adds 2 paragraphs, no overrideErrors', r2.norm.success && (d2.overrideErrors || []).length === 0 && ((d2.applied || [])[0] || {}).paragraphsAdded === 2, scn.replace2);
    rec(scn, 'split paragraphs: first restarts ("1.", nc=false), added ones continue (nc = style value) -> "2.","3.", old p13 becomes "4."',
      P(c, 12).nc === false && P(c, 12).rt === '1.\t' && P(c, 13).nc === styleNc && P(c, 13).rt === '2.\t' && P(c, 14).rt === '3.\t' && P(c, 15).rt === '4.\t' && /^04 passport/.test(P(c, 15).t),
      { p12: P(c, 12), p13: P(c, 13), p14: P(c, 14), p15: P(c, 15), styleNc });
  });

  // ── 11: qa-r1-05 / design-r1-02 — delete + insertAfter edit kinds ──
  await scenario(11, 'qa-r1-05 replace_paragraphs delete / insertAfter (label:value and other style) / atomic per paragraph', 1200000, async (scn) => {
    await freshCopy();
    const b = await pinfo(SID, 0, 71);
    const t0 = await storyText(SID);
    // refusals
    const ref = await T('replace_paragraphs', { storyId: SID, edits: [
      { paragraphIndex: 27, delete: true },
      { paragraphIndex: 32, delete: true },
      { paragraphIndex: 19, delete: true, expectText: 'WRONG PREFIX' },
    ] });
    const rd = raw(ref);
    scn.refusals = { success: ref.norm.success, error: ref.norm.error, mismatches: rd.mismatches, applied: rd.applied };
    rec(scn, 'delete refuses icon paragraph (U+FFFC), table paragraph and wrong expectText (3 mismatches, 0 applied)', (rd.mismatches || []).length === 3 && (rd.applied || []).length === 0, scn.refusals);
    rec(scn, 'refused deletes changed nothing', (await storyText(SID)) === t0, {});
    const both = await T('replace_paragraphs', { storyId: SID, edits: [{ paragraphIndex: 20, text: 'x' }, { paragraphIndex: 20, delete: true }] });
    const tBoth = await storyText(SID);
    const pBoth = await pinfo(SID, 18, 22);
    rec(scn, 'replace + delete on the same paragraph is rejected and changes nothing', (!both.norm.success || (raw(both).mismatches || []).length > 0) && tBoth === t0, { success: both.norm.success, error: both.norm.error, mismatches: raw(both).mismatches, applied: raw(both).applied, p20before: b.paras[20].t, p20after: (pBoth.paras.find((p) => p.i === 20) || {}).t });
    if (tBoth !== t0) await T('undo', { expectUndoName: 'replace_paragraphs' }); // isolate the next checks from that defect
    const atom = await T('replace_paragraphs', { storyId: SID, edits: [{ paragraphIndex: 27, delete: true }, { paragraphIndex: 27, insertAfter: true, text: 'QA should not appear' }] });
    rec(scn, 'atomic: insertAfter is not applied when the delete of the same paragraph is refused', (await storyText(SID)) === t0 && ((raw(atom).applied) || []).length === 0, { success: atom.norm.success, data: raw(atom) });
    // delete a surplus numbered item (p17 "A bank account...")
    const del = await T('replace_paragraphs', { storyId: SID, edits: [{ paragraphIndex: 17, delete: true, expectText: 'A bank account' }] });
    const a1 = await pinfo(SID, 0, 71);
    scn.del = { success: del.norm.success, error: del.norm.error, data: raw(del) };
    rec(scn, 'delete p17 with expectText removes exactly that paragraph', del.norm.success && a1.n === b.n - 1 && a1.paras[17].t.startsWith('Various Relevant Information') && !a1.paras.some((p) => p.t.startsWith('A bank account')), { n0: b.n, n1: a1.n, p17: a1.paras[17], data: scn.del });
    rec(scn, 'neighbours keep style/numbering after delete (p16 "5.", heading style)', a1.paras[16].rt === '5.\t' && a1.paras[16].sid === FX.styleIds.numbers && a1.paras[17].sid === FX.styleIds.paraHeading && a1.anchored === b.anchored, { p16: a1.paras[16], p17: a1.paras[17] });
    // insertAfter with label/value under "Nationality: ..." (p7)
    const ins = await T('replace_paragraphs', { storyId: SID, edits: [{ paragraphIndex: 7, insertAfter: true, label: 'QA Label', value: 'qa inserted value text' }] });
    const a2 = await pinfo(SID, 0, 12);
    scn.insLV = { success: ins.norm.success, error: ins.norm.error, data: raw(ins), p7: a2.paras[7], p8: a2.paras[8] };
    rec(scn, 'insertAfter label/value creates p8 in the anchor style, anchor untouched', ins.norm.success && a2.paras[8].t.startsWith('QA Label: qa inserted value') && a2.paras[8].sid === FX.styleIds.colonBullets && a2.paras[7].t === b.paras[7].t, scn.insLV);
    rec(scn, 'inserted label bold up to the colon, value roman (same as anchor)', a2.paras[8].lf === b.paras[7].lf && a2.paras[8].vf === b.paras[7].vf && /Bold/.test(String(a2.paras[8].lf)) && !/Bold/.test(String(a2.paras[8].vf)), { anchor: { lf: b.paras[7].lf, vf: b.paras[7].vf }, inserted: { lf: a2.paras[8].lf, vf: a2.paras[8].vf } });
    // insertAfter with another style (Paragraph Heading) after p2 (Regular)
    const ins2 = await T('replace_paragraphs', { storyId: SID, edits: [{ paragraphIndex: 2, insertAfter: true, text: 'QA inserted heading', styleId: FX.styleIds.paraHeading }] });
    const a3 = await pinfo(SID, 0, 6);
    rec(scn, 'insertAfter text+styleId: new paragraph has the other style, anchor keeps Regular + text', ins2.norm.success && a3.paras[3].t.startsWith('QA inserted heading') && a3.paras[3].sid === FX.styleIds.paraHeading && a3.paras[2].sid === FX.styleIds.regular && a3.paras[2].t === b.paras[2].t && a3.paras[3].fc === b.paras[3].fc, { success: ins2.norm.success, error: ins2.norm.error, p2: a3.paras[2], p3: a3.paras[3], templateHeading: b.paras[3] });
    // delete + insertAfter on the same index = replace in another style (find "Loan Limit:" now)
    const cur = await pinfo(SID, 0, 40);
    const iLL = idxOf(cur, 'Loan Limit:');
    const rs = await T('replace_paragraphs', { storyId: SID, edits: [{ paragraphIndex: iLL, delete: true, expectText: 'Loan Limit:' }, { paragraphIndex: iLL, insertAfter: true, text: 'QA replaced in Regular style', styleId: FX.styleIds.regular }] });
    const a4 = await pinfo(SID, 0, 40);
    rec(scn, 'delete + insertAfter on one index replaces the paragraph in another style', rs.norm.success && a4.n === cur.n && a4.paras[iLL].t.startsWith('QA replaced in Regular') && a4.paras[iLL].sid === FX.styleIds.regular && !a4.paras.some((p) => p.t.startsWith('Loan Limit:')), { success: rs.norm.success, error: rs.norm.error, data: raw(rs), at: a4.paras[iLL], iLL });
    rec(scn, 'anchored object count unchanged through all edits', a4.anchored === b.anchored, { before: b.anchored, after: a4.anchored });
  });

  // ── 12: qa-r1-02 / design-r1-03 — replace_contact_block picks ONE block ──
  await scenario(12, 'qa-r1-02 replace_contact_block splits the story into icon blocks (frame range / blockIndex / firstParagraphIndex / availableBlocks)', 1200000, async (scn) => {
    await freshCopy();
    const L4 = [{ type: 'address', text: 'QA address line' }, { type: 'web', text: 'www.qa.example' }, { type: 'email', text: 'qa@example.org' }, { type: 'phone', text: '+880 1 000 000' }];
    const L3 = [{ type: 'address', text: 'QA Agrani address' }, { type: 'web', text: 'www.agrani-qa.example' }, { type: 'phone', text: '+880 2 111 111' }];
    const d0 = await T('replace_contact_block', { frameId: FX.pkb.secondFrame, lines: L4, dryRun: true });
    const x0 = raw(d0);
    rec(scn, 'frame 46588, no scope: picks the PKB block (4 lines) by frame range, no mismatch', d0.norm.success && (x0.templateLines || []).length === 4 && (x0.mismatches || []).length === 0, { error: d0.norm.error, templateTypes: x0.templateTypes, templateLines: (x0.templateLines || []).map((l) => String(l.text).slice(0, 30)), mismatches: x0.mismatches, block: x0.block || x0.blockIndex });
    const d1 = await T('replace_contact_block', { frameId: 49888, lines: L3, dryRun: true });
    const x1 = raw(d1);
    rec(scn, 'frame 49888, no scope: picks the Agrani block (3 lines address/web/phone)', d1.norm.success && (x1.templateLines || []).length === 3 && (x1.mismatches || []).length === 0 && JSON.stringify(x1.templateTypes) === JSON.stringify(['address', 'web', 'phone']), { error: d1.norm.error, templateTypes: x1.templateTypes, mismatches: x1.mismatches });
    const d2 = await T('replace_contact_block', { frameId: FX.pkb.secondFrame, blockIndex: 1, lines: L3, dryRun: true });
    const x2 = raw(d2);
    rec(scn, 'blockIndex:1 selects the Agrani block even from frame 46588', d2.norm.success && (x2.templateLines || []).length === 3 && (x2.mismatches || []).length === 0, { error: d2.norm.error, templateTypes: x2.templateTypes, mismatches: x2.mismatches });
    const d3 = await T('replace_contact_block', { frameId: FX.pkb.secondFrame, firstParagraphIndex: 66, lines: L3, dryRun: true });
    const x3 = raw(d3);
    rec(scn, 'firstParagraphIndex:66 selects the block containing p66 (Agrani)', d3.norm.success && (x3.templateLines || []).length === 3 && (x3.mismatches || []).length === 0, { error: d3.norm.error, templateTypes: x3.templateTypes, mismatches: x3.mismatches });
    const d4 = await T('replace_contact_block', { frameId: FX.pkb.firstFrame, lines: L4, dryRun: true });
    const x4 = raw(d4);
    const ab = (x4.mismatches || []).flatMap((m) => m.availableBlocks || []);
    rec(scn, 'frame 5864 (no block starts there): mismatch with availableBlocks (2 blocks: p27 x4, p65 x3), nothing changed', (x4.mismatches || []).length > 0 && ab.length === 2 && ab[0].firstParagraphIndex === 27 && ab[0].lineCount === 4 && ab[1].firstParagraphIndex === 65 && ab[1].lineCount === 3, { success: d4.norm.success, error: d4.norm.error, mismatches: x4.mismatches });
    const d5 = await T('replace_contact_block', { frameId: FX.pkb.secondFrame, blockIndex: 7, lines: L4, dryRun: true });
    rec(scn, 'blockIndex out of range -> mismatch/error, no change', !d5.norm.success || (raw(d5).mismatches || []).length > 0, { success: d5.norm.success, error: d5.norm.error, mismatches: raw(d5).mismatches });
    // real apply on block 1 with short lines that fit (frame 49888 is full: nothing may be pushed into overset)
    const P = (info, i) => info.paras.find((x) => x.i === i);
    const compS = `var s=__resolveDocument().stories.itemByID(${SID}); var o=[]; for (var i=65;i<=67;i++){ var p=s.paragraphs[i]; var f=null; try{ f=p.characters[-1].parentTextFrames.length ? p.characters[-1].parentTextFrames[0].id : null; }catch(e){} o.push({ i:i, lines:p.lines.length, lastCharFrame:f, t:String(p.contents).substr(0,30) }); } __ok(o);`;
    const b = await pinfo(SID, 25, 70);
    const ap = await T('replace_contact_block', { frameId: 49888, lines: L3 });
    const xa = raw(ap);
    const a = await pinfo(SID, 25, 70);
    const compA = await S(compS);
    scn.apply = { success: ap.norm.success, error: ap.norm.error, applied: xa.applied, warnings: xa.warnings, mismatches: xa.mismatches, composedState: compA };
    rec(scn, 'apply on block 1 replaces p65..p67 only, icon+tab kept, block 0 untouched', ap.norm.success && xa.applied === true && P(a, 65).t.startsWith('\uFFFC\tQA Agrani address') && P(a, 66).t.startsWith('\uFFFC\twww.agrani-qa') && P(a, 67).t.startsWith('\uFFFC\t+880 2 111') && [27, 28, 29, 30].every((i) => P(a, i).t === P(b, i).t) && a.anchored === b.anchored, { ...scn.apply, p65: P(a, 65), p66: P(a, 66), p67: P(a, 67) });
    rec(scn, 'no false "not composed"/overset warning for composed lines', !(xa.warnings || []).some((w) => /not composed|overset/.test(w)) || !compA.every((c) => c.lastCharFrame), { warnings: xa.warnings, composedState: compA });
    await T('undo', { expectUndoName: 'replace_contact_block' });
    // qa-r3-01: a long web line that pushes itself / the phone line (composed before) into overset -> rolled back with line-specific mismatches
    const comp0 = await S(compS);
    const b2 = await pinfo(SID, 25, 70);
    const Lw = [L3[0], { type: 'web', text: 'www.agrani-bank-overseas-workers-loan-information-desk-qa.example.org/branches' }, L3[2]];
    const ow = await T('replace_contact_block', { frameId: 49888, lines: Lw });
    const xo = raw(ow);
    const a2 = await pinfo(SID, 25, 70);
    const comp1 = await S(compS);
    const om = (xo.mismatches || []).filter((m) => m.reason === 'pushed into overset');
    scn.overset = { success: ow.norm.success, error: ow.norm.error, applied: xo.applied, rolledBack: xo.rolledBack, mismatches: xo.mismatches, warnings: xo.warnings, composedBefore: comp0, composedAfter: comp1 };
    rec(scn, 'long web line pushing lines into overset: success, applied:false, rolledBack:true, mismatches {line, reason "pushed into overset", frameId 49888}', ow.norm.success && xo.applied === false && xo.rolledBack === true && om.length > 0 && om.every((m) => typeof m.line === 'number' && m.frameId === 49888) && om.some((m) => m.line === 1 || m.line === 2), scn.overset);
    rec(scn, 'rolled-back overset write leaves the story text and composition unchanged (no hidden text kept)', b2.paras.every((p, k) => p.t === a2.paras[k].t) && a2.anchored === b2.anchored && comp1.every((c, k) => c.lastCharFrame === comp0[k].lastCharFrame), { p66: P(a2, 66), composedAfter: comp1 });
    if (!b2.paras.every((p, k) => p.t === a2.paras[k].t)) await T('undo', { expectUndoName: 'replace_contact_block' });
    // allowOverset:true keeps it (explicit decision), with the overset warnings
    const ka = await T('replace_contact_block', { frameId: 49888, lines: Lw, allowOverset: true });
    const xk = raw(ka);
    rec(scn, 'allowOverset:true keeps the write and warns about the overset lines', ka.norm.success && xk.applied === true && (xk.warnings || []).some((w) => /overset/.test(w)) && (xk.oversetLines || []).length > 0, { applied: xk.applied, warnings: xk.warnings, oversetLines: xk.oversetLines, error: ka.norm.error });
    if (ka.norm.success && xk.applied === true) await T('undo', { expectUndoName: 'replace_contact_block' });
  });

  // ── 13: design-r1-04 — continue_story diagnoses a blocking table ──
  await scenario(13, 'design-r1-04 continue_story on the overset PKB/Agrani story reports data.blocker (table rows) and allowRowBreak', 1200000, async (scn) => {
    await freshCopy();
    const p0 = await pages();
    const c0 = await T('continue_story', { storyId: SID, maxPages: 3 }, { timeoutMs: 300000 });
    const x0 = raw(c0);
    const p1 = await pages();
    scn.plain = { ms: c0.ms, success: c0.norm.success, error: c0.norm.error, blocker: x0.blocker, pagesAdded: x0.pagesAdded };
    rec(scn, 'continue_story returns success:false within 120s with data.blocker', c0.ms < 120000 && !c0.norm.success && !!x0.blocker && Array.isArray(x0.blocker.reasons) && x0.blocker.reasons.length > 0, scn.plain);
    rec(scn, 'blocker names the table (tableId, rows / tallest row / keep options)', !!(x0.blocker && x0.blocker.table && (x0.blocker.table.tableId || x0.blocker.table.id) !== undefined), { table: x0.blocker && x0.blocker.table });
    rec(scn, 'no pages left behind after the failed continue_story', p1.count === p0.count, { before: p0.count, after: p1.count });
    const c1 = await T('continue_story', { storyId: SID, maxPages: 3, allowRowBreak: true }, { timeoutMs: 300000 });
    const x1 = raw(c1);
    const p2 = await pages();
    const ov = await S(`var s=__resolveDocument().stories.itemByID(${SID}); __ok(s.overflows);`);
    scn.rowBreak = { ms: c1.ms, success: c1.norm.success, error: c1.norm.error, rowBreakChanges: x1.rowBreakChanges, blocker: x1.blocker, pagesAdded: x1.pagesAdded, warnings: x1.warnings, overflowsAfter: ov, pages: p2.count };
    const okFlow = c1.norm.success && Array.isArray(x1.rowBreakChanges) && x1.rowBreakChanges.length > 0 && ov === false;
    const okRefuse = !c1.norm.success && x1.blocker && x1.blocker.allowRowBreakTried === true && p2.count === p0.count;
    rec(scn, 'allowRowBreak:true either flows (rowBreakChanges reported, no overset) or reports allowRowBreakTried and leaves no pages', c1.ms < 120000 && (okFlow || okRefuse), scn.rowBreak);
  });

  // ── 14: qa-r1-09 / design-r1-09 — verify_page_invariants empty frames + master issues ──
  await scenario(14, 'qa-r1-09/design-r1-09 verify_page_invariants: empty background frame 5887 -> emptyFrameOverlaps; master running-head issues -> masterIssues', 900000, async (scn) => {
    await freshCopy();
    const v0 = await T('verify_page_invariants', { pageIndexes: [13, 14] });
    const x0 = raw(v0);
    const pg13 = (x0.pages || []).find((p) => p.pageIndex === 13) || (x0.pages || [])[0] || {};
    scn.pristine = { summary: x0.summary, overlaps: pg13.overlaps, emptyFrameOverlaps: pg13.emptyFrameOverlaps, masterIssues: pg13.masterIssues };
    rec(scn, 'empty frame 5887 overlap is listed under emptyFrameOverlaps, not overlaps', v0.norm.success && (pg13.emptyFrameOverlaps || []).some((o) => o.emptyFrameId === FX.pkb.bgFrame) && !(pg13.overlaps || []).some((o) => JSON.stringify(o).includes(String(FX.pkb.bgFrame))), scn.pristine);
    rec(scn, 'pristine pages: no masterIssues', (x0.summary || []).every((s) => s.masterIssues === 0), { summary: x0.summary });
    // break the master: overset running head + placeholder text (copy only)
    await S(`var d=__resolveDocument(); var f=d.textFrames.itemByID(48265); var s=''; for (var i=0;i<40;i++) s+='Chapter 1: Access to Finance overset QA '; f.parentStory.contents=s;
var g=d.textFrames.itemByID(48288); g.parentStory.contents='Lorem ipsum dolor sit amet QA'; __ok({ov:f.overflows});`, { undoName: 'harness break master text' });
    const v1 = await T('verify_page_invariants', { pageIndexes: [13, 14, 15] });
    const x1 = raw(v1);
    const mi = (x1.pages || []).flatMap((p) => p.masterIssues || []);
    scn.broken = { ok: x1.ok, summary: x1.summary, masterIssues: mi };
    rec(scn, 'overset master frame 48265 reported once under masterIssues (ref master:1-Access to Finance ...)', mi.filter((m) => m.frameId === 48265 && m.issue === 'overset').length === 1 && mi.some((m) => /^master:1-Access to Finance frame 48265/.test(m.ref)), scn.broken);
    rec(scn, 'placeholder in master frame 48288 reported under masterIssues and ok=false', mi.some((m) => m.frameId === 48288 && m.issue === 'placeholder') && x1.ok === false, scn.broken);
  });

  // ── 15: qa-r1-04 / design-r1-05 / design-r1-06 — duplicate_page sides, spreads, afterPage, keepSide ──
  await scenario(15, 'qa-r1-04 duplicate_page: side flip reported, keepSide refuses (doc unchanged), spread returns both pages, afterPage/referencePageIndex', 1200000, async (scn) => {
    await freshCopy();
    const p0 = await pages();
    const d1 = await T('duplicate_page', { pageIndex: FX.opener.pageIndex, toLocation: 'after' }, { timeoutMs: 600000 });
    const x1 = raw(d1), pg = (x1.pages || [])[0] || {};
    scn.flip = { success: d1.norm.success, error: d1.norm.error, page: pg, warnings: x1.warnings, sideChanged: x1.sideChanged };
    rec(scn, 'right-hand opener duplicated "after": pages[0].sideChanged, sourceSide right, side left, warning', d1.norm.success && pg.sideChanged === true && /right/i.test(pg.sourceSide) && /left/i.test(pg.side) && x1.sideChanged === true && (x1.warnings || []).some((w) => /landed on a/i.test(w)), scn.flip);
    const u1 = await T('undo', { expectUndoName: 'MCP: Duplicate Page' });
    const p1 = await pages();
    rec(scn, 'undo (expectUndoName "MCP: Duplicate Page") removes the copy', u1.norm.success && raw(u1).undone === true && p1.count === p0.count && p1.sides.join() === p0.sides.join(), { undo: raw(u1), error: u1.norm.error, count: p1.count });
    const d2 = await T('duplicate_page', { pageIndex: FX.opener.pageIndex, toLocation: 'after', keepSide: true }, { timeoutMs: 600000 });
    const p2 = await pages();
    scn.keepSide = { success: d2.norm.success, error: d2.norm.error, pages: p2.count, undoName: p2.undoName };
    rec(scn, 'keepSide:true refuses, says the document is unchanged, page count and sides identical', !d2.norm.success && /unchanged/i.test(String(d2.norm.error)) && p2.count === p0.count && p2.sides.join() === p0.sides.join(), scn.keepSide);
    const d3 = await T('duplicate_page', { pageIndex: FX.pkb.pages[0], toLocation: 'end', spread: true }, { timeoutMs: 600000 });
    const x3 = raw(d3);
    const p3 = await pages();
    scn.spread = { success: d3.norm.success, error: d3.norm.error, pages: (x3.pages || []).map((p) => ({ id: p.id, newIndex: p.newIndex, side: p.side, sourceSide: p.sourceSide, sideChanged: p.sideChanged })), newPageIds: x3.newPageIds, warnings: x3.warnings, count: p3.count };
    rec(scn, 'spread:true on spread 02-03 lists BOTH new pages (pages[] and newPageIds length 2)', d3.norm.success && (x3.pages || []).length === 2 && (x3.newPageIds || []).length === 2 && p3.count === p0.count + 2, scn.spread);
    await T('undo', { expectUndoName: 'MCP: Duplicate Page' });
    const d4 = await T('duplicate_page', { pageIndex: FX.pkb.pages[0], toLocation: 'afterPage' });
    rec(scn, 'toLocation afterPage without referencePageIndex -> validation error, no change', !d4.norm.success && /referencePageIndex/.test(String(d4.norm.error)) && (await pages()).count === p0.count, { error: d4.norm.error });
    const d5 = await T('duplicate_page', { pageIndex: FX.pkb.pages[0], toLocation: 'after', referencePageIndex: 20 });
    rec(scn, 'referencePageIndex with toLocation "after" is refused', !d5.norm.success && /referencePageIndex/.test(String(d5.norm.error)), { error: d5.norm.error });
    const d6 = await T('duplicate_page', { pageIndex: FX.pkb.pages[0], toLocation: 'afterPage', referencePageIndex: 22 }, { timeoutMs: 600000 });
    const x6 = raw(d6), q6 = (x6.pages || [])[0] || {};
    rec(scn, 'afterPage referencePageIndex 22 (right page "11") puts the copy of left page "02" at index 23, still left, no side flip', d6.norm.success && q6.newIndex === 23 && /left/i.test(q6.side) && q6.sideChanged === false, { success: d6.norm.success, error: d6.norm.error, page: q6, warnings: x6.warnings });
  });

  // ── 16: qa-r1-03 — undo/redo by name, no blind undo after a no-op ──
  await scenario(16, 'qa-r1-03 undo/redo report names; expectUndoName guards against undoing an earlier step after a no-op find_replace_text', 900000, async (scn) => {
    await freshCopy();
    const u0 = await T('undo', {});
    rec(scn, 'undo on a freshly opened document: undone:false with a reason', u0.norm.success && raw(u0).undone === false && !!raw(u0).reason, { data: raw(u0), error: u0.norm.error });
    const p0 = await pages();
    const fr = await T('find_replace_text', { findWhat: 'Agrani', changeTo: 'AGRANI-QA', caseSensitive: true, scope: { pageIndex: 17 } });
    const p1 = await pages();
    rec(scn, 'doc.undoName is populated after a change (this InDesign exposes undoName)', fr.norm.success && p1.undoName.length > 0, { undoName: p1.undoName, fr: raw(fr) });
    const dp = await T('duplicate_page', { pageIndex: 23, toLocation: 'end' }, { timeoutMs: 600000 });
    const p2 = await pages();
    const nm = await T('find_replace_text', { findWhat: 'NO-SUCH-TEXT-QA', changeTo: 'x', scope: { pageIndex: 17 } });
    const p3 = await pages();
    rec(scn, 'no-op find_replace_text returns noChange:true and changes nothing', nm.norm.success && raw(nm).noChange === true && raw(nm).replacements === 0 && p3.count === p2.count, { data: raw(nm), undoNameBefore: p2.undoName, undoNameAfter: p3.undoName });
    const ue = await T('undo', { expectUndoName: 'Find/Replace Text' });
    const p4 = await pages();
    scn.guarded = { success: ue.norm.success, error: ue.norm.error, code: ue.norm.code, data: raw(ue), pagesBefore: p3.count, pagesAfter: p4.count, undoNameBefore: p3.undoName };
    rec(scn, 'undo with expectUndoName "Find/Replace Text" after the no-op never reverts the duplicate_page step', dp.norm.success && p4.count === p2.count && (ue.norm.success ? raw(ue).undone !== true || /find/i.test(String(raw(ue).undoneName)) : /UNDO_NAME_MISMATCH|not "Find/.test(String(ue.norm.code) + String(ue.norm.error))), scn.guarded);
    const pu = await pages();
    const u2 = await T('undo', {});
    const x2 = raw(u2);
    const p5 = await pages();
    scn.plain = { data: x2, pagesBefore: pu.count, pagesAfter: p5.count, undoNameBefore: pu.undoName };
    rec(scn, 'plain undo returns undoneName (= the step name before the call), nextUndoName, pagesBefore/pagesAfter', u2.norm.success && x2.undone === true && x2.undoneName === pu.undoName && typeof x2.nextUndoName === 'string' && x2.pagesBefore === pu.count && x2.pagesAfter === p5.count, scn.plain);
    const r2 = await T('redo', { expectRedoName: x2.undoneName });
    const x3 = raw(r2);
    const p6 = await pages();
    rec(scn, 'redo (expectRedoName) re-applies the same step and reports redoneName', r2.norm.success && x3.redone === true && x3.redoneName === x2.undoneName && p6.count === pu.count, { data: x3, error: r2.norm.error, pages: p6.count });
    const r3 = await T('redo', { expectRedoName: 'Something Else' });
    rec(scn, 'redo with a wrong expectRedoName is refused (nothing to redo or name mismatch)', !r3.norm.success || raw(r3).redone === false, { success: r3.norm.success, error: r3.norm.error, data: raw(r3) });
  });

  // ── 17: design-r1-08 / design-r1-02b / design-r1-07(1) — styles ──
  await scenario(17, 'design-r1-08/02b/07 styles: fill-only object style adds no stroke; story-relative apply_style keeps bold/roman; create_paragraph_style groupPath/duplicateFrom', 1200000, async (scn) => {
    await freshCopy();
    const fr = (id) => S(`var it=__resolveDocument().pageItems.itemByID(${id}); __ok({ fill: it.fillColor.name, fillTint: it.fillTint, stroke: it.strokeColor.name, sw: it.strokeWeight, os: it.appliedObjectStyle.name });`);
    const f0 = await fr(FX.pkb.bgFrame);
    const co = await T('create_object_style', { name: 'QA Fill Only', fillColor: FX.chapterColor });
    scn.createObj = { success: co.norm.success, error: co.norm.error, data: raw(co) };
    rec(scn, 'create_object_style fill-only succeeds and enables only the fill category', co.norm.success && JSON.stringify(raw(co).enabledCategories || []).includes('ill') && !JSON.stringify(raw(co).enabledCategories || []).toLowerCase().includes('stroke'), scn.createObj);
    const ao = await T('apply_style', { styleType: 'object', styleName: 'QA Fill Only', frameId: FX.pkb.bgFrame });
    const f1 = await fr(FX.pkb.bgFrame);
    scn.applyObj = { success: ao.norm.success, error: ao.norm.error, data: raw(ao), before: f0, after: f1 };
    rec(scn, 'apply_style object: fill becomes the chapter colour, stroke stays None / weight unchanged (no 1pt Black)', ao.norm.success && f1.fill === FX.chapterColor && f1.stroke === f0.stroke && f1.sw === f0.sw, scn.applyObj);
    // story-relative paragraph apply keeps bold label / roman value
    const b = await pinfo(SID, 6, 12);
    const ap = await T('apply_style', { styleType: 'paragraph', styleId: FX.styleIds.colonBullets, storyId: SID, storyParagraphIndex: 7, storyParagraphEnd: 10, expectText: 'Nationality' });
    const a = await pinfo(SID, 6, 12);
    scn.applyPara = { success: ap.norm.success, error: ap.norm.error, details: (raw(ap).details || []).length, before: b.paras.slice(1, 5).map((p) => [p.lf, p.vf]), after: a.paras.slice(1, 5).map((p) => [p.lf, p.vf]) };
    rec(scn, 'apply_style storyId+storyParagraphIndex..End applies to 4 paragraphs and keeps bold label/roman value', ap.norm.success && (raw(ap).details || []).length === 4 && JSON.stringify(scn.applyPara.before) === JSON.stringify(scn.applyPara.after), scn.applyPara);
    const bad = await T('apply_style', { styleType: 'paragraph', styleId: FX.styleIds.regular, storyId: SID, storyParagraphIndex: 7, expectText: 'Nope' });
    const a2 = await pinfo(SID, 6, 12);
    rec(scn, 'expectText mismatch fails and changes nothing', !bad.norm.success && a2.paras[1].sid === FX.styleIds.colonBullets, { error: bad.norm.error });
    const viaFrame = await T('apply_style', { styleType: 'paragraph', styleId: FX.styleIds.regular, frameId: FX.pkb.secondFrame, storyParagraphIndex: 25, expectText: 'Submit the application' });
    rec(scn, 'frameId + storyParagraphIndex resolves to the parent story (p25 of story 5846)', viaFrame.norm.success && ((raw(viaFrame).details || [])[0] || {}).storyParagraphIndex === 25, { error: viaFrame.norm.error, details: raw(viaFrame).details });
    // create_paragraph_style duplicateFrom into a new group, same name allowed in another group
    const cp = await T('create_paragraph_style', { name: 'Service Name Numbered', duplicateFrom: 'Regular set/Color Reset/Service Name Numbered', groupPath: 'QA Chapter/Color Reset', fillColor: 'Pantone 298 C' });
    const chk = await S(`var d=__resolveDocument(); var a=d.allParagraphStyles, out=[]; for (var i=0;i<a.length;i++) if (a[i].name=='Service Name Numbered') { var g=[]; var p=a[i].parent; while (p && p.constructor.name=='ParagraphStyleGroup') { g.unshift(p.name); p=p.parent; } out.push({ id:a[i].id, group:g.join('/'), fill:a[i].fillColor.name, list:String(a[i].bulletsAndNumberingListType), font:a[i].appliedFont.name+' '+a[i].fontStyle }); } __ok(out);`);
    scn.createPara = { success: cp.norm.success, error: cp.norm.error, data: raw(cp), styles: chk };
    const orig = chk.find((s) => s.id === FX.styleIds.serviceName), copy = chk.find((s) => s.group === 'QA Chapter/Color Reset');
    rec(scn, 'create_paragraph_style duplicateFrom + groupPath: copy in "QA Chapter/Color Reset" with new colour, numbering/font copied, original unchanged', cp.norm.success && !!copy && copy.fill === 'Pantone 298 C' && orig && orig.fill === FX.chapterColor && copy.list === orig.list && copy.font === orig.font, scn.createPara);
    const cp2 = await T('create_paragraph_style', { name: 'Service Name Numbered', groupPath: 'QA Chapter/Color Reset' });
    rec(scn, 'same name in the same group is refused', !cp2.norm.success, { error: cp2.norm.error });
    const cp3 = await T('create_paragraph_style', { name: 'QA Shaded', groupPath: 'QA Chapter', paragraphShadingOn: true, paragraphShadingColor: 'Pantone 298 C', paragraphShadingTint: 20, ruleBelow: true, ruleBelowColor: 'Pantone 298 C' });
    const sh = await S(`var d=__resolveDocument(); var a=d.allParagraphStyles, r=null; for (var i=0;i<a.length;i++) if (a[i].name=='QA Shaded') { var o={}; try{o.shadingOn=a[i].paragraphShadingOn; o.shadingColor=a[i].paragraphShadingColor.name; o.shadingTint=a[i].paragraphShadingTint;}catch(e){o.err=String(e);} try{o.ruleBelow=a[i].ruleBelow; o.ruleBelowColor=a[i].ruleBelowColor.name;}catch(e){} r=o; } __ok(r);`);
    rec(scn, 'create_paragraph_style paragraph shading + rule below colours', cp3.norm.success && sh && sh.shadingOn === true && sh.shadingColor === 'Pantone 298 C' && sh.ruleBelowColor === 'Pantone 298 C', { error: cp3.norm.error, style: sh });
  });

  // ── 18: design-r1-07(2) — chapter theme tools ──
  await scenario(18, 'design-r1-07 duplicate_master_spread / swap_swatch_in_scope / theme_chapter (one undo step)', 1500000, async (scn) => {
    await freshCopy();
    const masterColors = (name) => S(`var d=__resolveDocument(); var m=d.masterSpreads.itemByName(${JSON.stringify(name)}); if (!m.isValid) { __ok(null); } else { var it=m.allPageItems, o={ items: [], text: [] };
for (var i=0;i<it.length;i++){ var x=it[i]; var f='', s=''; try{f=x.fillColor.name;}catch(e){} try{s=x.strokeColor.name;}catch(e){} o.items.push(x.id+':'+f+'/'+s);
 if (x.constructor.name=='TextFrame') { var r=x.texts[0].textStyleRanges; for (var k=0;k<r.length;k++){ var c=''; try{c=r[k].fillColor.name;}catch(e){} o.text.push(x.id+':'+c+':'+String(r[k].contents).substr(0,20)); } } } __ok(o); }`);
    const p0 = await pages();
    const src0 = await masterColors('1-Access to Finance');
    const TR = [{ find: 'Chapter 1: Access to Finance', replace: 'Chapter 3: Women and Child Care' }];
    const dm0 = await T('duplicate_master_spread', { sourceName: '1-Access to Finance', newNamePrefix: '3', newBaseName: 'Women QA', textReplace: TR, dryRun: true });
    rec(scn, 'duplicate_master_spread dryRun reports and changes nothing', dm0.norm.success && raw(dm0).dryRun === true && (await pages()).masters.length === p0.masters.length, { data: raw(dm0), error: dm0.norm.error });
    const dm = await T('duplicate_master_spread', { sourceName: '1-Access to Finance', newNamePrefix: '3', newBaseName: 'Women QA', textReplace: TR });
    const p1 = await pages();
    const nm = await masterColors('3-Women QA');
    const src1 = await masterColors('1-Access to Finance');
    scn.dup = { success: dm.norm.success, error: dm.norm.error, data: raw(dm), masters: p1.masters, newText: nm && nm.text,
      sourceDiff: { itemsBefore: src0.items.filter((x) => !src1.items.includes(x)), itemsAfter: src1.items.filter((x) => !src0.items.includes(x)), textBefore: src0.text.filter((x) => !src1.text.includes(x)), textAfter: src1.text.filter((x) => !src0.text.includes(x)) } };
    rec(scn, 'duplicate_master_spread creates "3-Women QA" with the running head replaced, source master unchanged', dm.norm.success && p1.masters.includes('3-Women QA') && !!nm && nm.text.some((t) => /Chapter 3: Women and/.test(t)) && JSON.stringify([...src1.items].sort().concat([...src1.text].sort())) === JSON.stringify([...src0.items].sort().concat([...src0.text].sort())), scn.dup);
    const dmx = await T('duplicate_master_spread', { sourceName: '1-Access to Finance', newNamePrefix: '1', newBaseName: 'Clash' });
    rec(scn, 'used prefix "1" is refused', !dmx.norm.success, { error: dmx.norm.error });
    const sw0 = await T('swap_swatch_in_scope', { fromSwatch: FX.chapterColor, toSwatch: 'Pantone 298 C', scope: { masterNames: ['3-Women QA'] }, dryRun: true });
    const sw = await T('swap_swatch_in_scope', { fromSwatch: FX.chapterColor, toSwatch: 'Pantone 298 C', scope: { masterNames: ['3-Women QA'] }, overrideMode: 'all' });
    const nm2 = await masterColors('3-Women QA');
    scn.swap = { dry: raw(sw0), real: raw(sw), error: sw.norm.error, newMaster: nm2 };
    rec(scn, 'swap_swatch_in_scope (masterNames, overrideMode all) removes Pantone 7498 C from the new master only', sw.norm.success && !JSON.stringify(nm2).includes(FX.chapterColor) && JSON.stringify(await masterColors('1-Access to Finance')) === JSON.stringify(src0), scn.swap);
    // page scope: only the text range of frames on page 02; page 03 frame text untouched
    const cnt = () => S(`var d=__resolveDocument(); function c(id){ var r=d.textFrames.itemByID(id).texts[0].textStyleRanges, n=0; for (var k=0;k<r.length;k++){ try{ if (r[k].fillColor.name==${JSON.stringify(FX.chapterColor)}) n+=r[k].characters.length; }catch(e){} } return n; } __ok({ f02: c(${FX.pkb.firstFrame}), f03: c(${FX.pkb.secondFrame}) });`);
    const spl = await T('swap_swatch_in_scope', { fromSwatch: FX.chapterColor, toSwatch: 'Pantone 298 C', scope: { pageIndexes: [13] }, dryRun: true });
    rec(scn, 'localOnly (default) dry run on page 02 counts style-derived colour (Part Heading / Service Name styles) instead of overriding it', spl.norm.success && /[1-9]/.test(JSON.stringify(raw(spl).styleDerived || {})), { data: raw(spl), error: spl.norm.error });
    const c0 = await cnt();
    const sp =await T('swap_swatch_in_scope', { fromSwatch: FX.chapterColor, toSwatch: 'Pantone 298 C', scope: { pageIndexes: [13] }, overrideMode: 'all' });
    const c1 = await cnt();
    scn.pageScope = { before: c0, after: c1, data: raw(sp), error: sp.norm.error };
    rec(scn, 'page scope recolours text in the page-02 frame only (page-03 frame of the same story untouched)', sp.norm.success && c0.f02 > 0 && c1.f02 === 0 && c1.f03 === c0.f03, scn.pageScope);
    // theme_chapter: one undo step
    const pB = await pages();
    const stylesB = await S(`__ok(__resolveDocument().allParagraphStyles.length + __resolveDocument().allCharacterStyles.length);`);
    const thArgs = { sourceMaster: '1-Access to Finance', newNamePrefix: '4', newBaseName: 'Theme QA', textReplace: [{ find: 'Chapter 1: Access to Finance', replace: 'Chapter 4: Theme QA' }], fromSwatch: FX.chapterColor, toSwatch: 'Pantone 298 C',
      styles: [{ styleType: 'paragraph', source: 'Regular set/Color Reset/Service Name Numbered', newName: 'Service Name Numbered', groupPath: 'Chapter 4/Color Reset' }, { styleType: 'paragraph', source: 'Regular set/Color Reset/Part Heading', newName: 'Part Heading', groupPath: 'Chapter 4/Color Reset' }, { styleType: 'character', source: 'Running head', newName: 'Running head 4' }] };
    const th0 = await T('theme_chapter', { ...thArgs, dryRun: true });
    rec(scn, 'theme_chapter dryRun succeeds and changes nothing', th0.norm.success && (await pages()).masters.length === pB.masters.length, { data: raw(th0), error: th0.norm.error });
    const th = await T('theme_chapter', thArgs, { timeoutMs: 600000 });
    const pT = await pages();
    const thS = await S(`var d=__resolveDocument(); var o={}; var a=d.allParagraphStyles; for (var i=0;i<a.length;i++){ var g=''; try{ var pp=a[i].parent; var gs=[]; while (pp && pp.constructor.name=='ParagraphStyleGroup') { gs.unshift(pp.name); pp=pp.parent; } g=gs.join('/'); }catch(e){} if (a[i].name=='Service Name Numbered'||a[i].name=='Part Heading') o[a[i].id+':'+g+'/'+a[i].name]=a[i].fillColor.name; } var c=d.allCharacterStyles; for (var j=0;j<c.length;j++) if (/^Running head/.test(c[j].name)) o[c[j].id+':'+c[j].name]=c[j].fillColor.name; __ok(o);`);
    const nm4 = await masterColors('4-Theme QA');
    scn.theme = { success: th.norm.success, error: th.norm.error, data: raw(th), masters: pT.masters, styles: thS, undoName: pT.undoName };
    const vals = Object.entries(thS);
    rec(scn, 'theme_chapter creates master 4-Theme QA + 3 styles in Pantone 298 C, originals keep Pantone 7498 C', th.norm.success && pT.masters.includes('4-Theme QA') && !!nm4 && nm4.text.some((t) => /Chapter 4: Theme QA/.test(t)) &&
      vals.filter(([k, v]) => /Chapter 4\/|Running head 4/.test(k) && v === 'Pantone 298 C').length === 3 && vals.filter(([k]) => !/Chapter 4\/|Running head 4/.test(k)).every(([, v]) => v === FX.chapterColor), scn.theme);
    const nm4c = await masterColors('4-Theme QA');
    rec(scn, 'themed master 4-Theme QA shows no old chapter colour (running head text remapped to the duplicated styles or recoloured)', !!nm4c && !JSON.stringify(nm4c).includes(FX.chapterColor), { newMaster: nm4c, styleDerived: (raw(th).swap || {}).styleDerived });
    const u = await T('undo', { expectUndoName: 'theme_chapter' });
    const pU = await pages();
    const stylesU = await S(`__ok(__resolveDocument().allParagraphStyles.length + __resolveDocument().allCharacterStyles.length);`);
    rec(scn, 'ONE undo (expectUndoName theme_chapter) removes the master and the styles', u.norm.success && raw(u).undone === true && pU.masters.join() === pB.masters.join() && stylesU === stylesB, { undo: raw(u), error: u.norm.error, masters: pU.masters, stylesBefore: stylesB, stylesAfter: stylesU });
  });

  // ── 19: qa-r1-08 — single write-path policy (Node-side, no InDesign writes outside roots) ──
  await scenario(19, 'qa-r1-08 write-path policy: Downloads refused by every write path; test_fixtures/runs + test_output accepted', 600000, async (scn) => {
    const imp = (p) => import(pathToFileURL(path.join(ROOT, 'dist', ...p.split('/'))).href);
    const safety = await imp('bridge/safety.js'), tp = await imp('tools/textPipelineShared.js'), kit = await imp('tools/batchC_layoutKit.js'), pol = await imp('tools/batchB_writePolicy.js');
    const DL = 'C:\\Users\\Litoondev\\Downloads\\Brac\\qa_should_be_refused.indd';
    const DLpdf = 'C:\\Users\\Litoondev\\Downloads\\Brac\\__qa_no_such_dir\\x.pdf';
    const okIndd = path.join(ROOT, 'test_fixtures', 'runs', 'qa-r2-policy-probe.indd');
    const okPdf = path.join(ROOT, 'test_output', 'runs', 'qa-r2-policy', 'probe.pdf');
    const tryIt = (fn) => { try { fn(); return 'allowed'; } catch (e) { return 'refused: ' + String(e.message).slice(0, 160); } };
    // NOTE: batchC assertSafeWritePath mkdirs the parent folder once the checks pass; under the broad root it is
    // therefore only probed through its Downloads rule (downloadsBlockReason) so nothing can ever be created in Downloads.
    const runAll = (broadRoot) => ({
      bridgeSafety_saveDocument: tryIt(() => safety.assertSafeWritePath(DL, ['.indd'], { overwrite: true })),
      textPipelineShared: tryIt(() => tp.assertSafeWritePath(DL, ['.indd'], { overwrite: true })),
      batchC_export: broadRoot ? (pol.downloadsBlockReason(DLpdf) ? 'refused: ' + pol.downloadsBlockReason(DLpdf).slice(0, 120) : 'allowed') : tryIt(() => kit.assertSafeWritePath(DLpdf, ['.pdf'], { overwrite: true })),
      okRunsIndd: tryIt(() => tp.assertSafeWritePath(okIndd, ['.indd'], { overwrite: true })),
      okOutputPdf: tryIt(() => kit.assertSafeWritePath(okPdf, ['.pdf'], { overwrite: true })),
      okRunsBridge: tryIt(() => safety.assertSafeWritePath(okIndd, ['.indd'], { overwrite: true })),
    });
    const def = runAll();
    scn.defaultRoots = def;
    rec(scn, 'default roots: all write checks refuse Downloads, accept test_fixtures/runs and test_output', /^refused/.test(def.bridgeSafety_saveDocument) && /^refused/.test(def.textPipelineShared) && /^refused/.test(def.batchC_export) && def.okRunsIndd === 'allowed' && def.okOutputPdf === 'allowed' && def.okRunsBridge === 'allowed', def);
    rec(scn, 'textPipelineShared refusal is a SAFETY: error with the Downloads message', /SAFETY: .*Downloads/i.test(def.textPipelineShared), { msg: def.textPipelineShared });
    // a broad root that CONTAINS Downloads (e.g. the user profile): the Downloads rule must still apply on every path
    const prev = process.env.INDESIGN_MCP_WRITE_ROOTS;
    process.env.INDESIGN_MCP_WRITE_ROOTS = 'C:\\Users\\Litoondev;' + path.join(ROOT, 'test_fixtures', 'runs') + ';' + path.join(ROOT, 'test_output');
    let broad;
    try { broad = runAll(true); } finally { if (prev === undefined) delete process.env.INDESIGN_MCP_WRITE_ROOTS; else process.env.INDESIGN_MCP_WRITE_ROOTS = prev; }
    scn.broadRoots = broad;
    rec(scn, 'roots = C:\\Users\\Litoondev: Downloads still refused by textPipelineShared and export (batchC)', /^refused/.test(broad.textPipelineShared) && /^refused/.test(broad.batchC_export), broad);
    rec(scn, 'roots = C:\\Users\\Litoondev: save_document path check (bridge/safety, used by document.ts) also refuses Downloads (single policy)', /^refused/.test(broad.bridgeSafety_saveDocument), { bridgeSafety_saveDocument: broad.bridgeSafety_saveDocument, note: 'document.ts save_document imports assertSafeWritePath from ../bridge/safety.js, which has no Downloads rule' });
    rec(scn, 'downloadsBlockReason detects Downloads paths', !!pol.downloadsBlockReason(DL) && pol.downloadsBlockReason(okIndd) === null, {});
    // tool level (default roots): the refusals happen in Node before InDesign is touched
    const rb = await client.call('restore_backup', { backupPath: path.join(ROOT, 'test_output', '_backups', 'none.indd'), targetPath: DL });
    rec(scn, 'restore_backup with a Downloads target is refused', !rb.norm.success && !fs.existsSync(DL), { error: rb.norm.error });
    const ex = await client.call('export_pdf', { document_id: DOC, outputPath: DLpdf });
    rec(scn, 'export_pdf to Downloads is refused (no folder created)', !ex.norm.success && !fs.existsSync(path.dirname(DLpdf)), { error: ex.norm.error });
    const sv = await client.call('save_document', { document_id: DOC, filePath: DL });
    rec(scn, 'save_document Save As into Downloads is refused', !sv.norm.success && !fs.existsSync(DL), { error: sv.norm.error });
  });
}
