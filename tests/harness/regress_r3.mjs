// Round-3 regression scenarios (qa-r3). One scenario per round-2 fix (qa-r2-01..05, design-r2-01..11).
// Each scenario starts from a FRESH copy of the v06 master (freshCopy). v06 facts (pristine copy):
//   story 5846 (PKB + Agrani): p12 "Application form..." Body Description Numbers, restart "1."; p13..p16 "2.".."5."
//   p27..p30 PKB contact block (frame 46588: address/web/email/phone), p65..p67 Agrani block (frame 49888: address/web/phone)
//   p32/p33/p69 hold inline tables (U+0016); Contact info style has GREP ".+(?<=:)" -> Bold
//   master "1-Access to Finance" running head 48265 uses char style "Running head" in Pantone 7498 C
export async function regressionR3(h) {
  const { scenario, rec, T, S, client, FX, DOC, freshCopy } = h;
  const SID = FX.pkb.storyId;
  const raw = (r) => (r && r.result && typeof r.result === 'object' && r.result.data !== undefined ? r.result.data : r && r.norm && r.norm.data) || {};
  const mcpJson = (r) => { try { return JSON.parse(r.mcpText); } catch { return null; } };
  const pinfo = (from, to) => S(`var s=__resolveDocument().stories.itemByID(${SID}); var n=s.paragraphs.length; var a=[]; var to=Math.min(${to}, n-1);
for (var i=${from}; i<=to; i++){ var p=s.paragraphs[i]; var rt=''; try{rt=String(p.bulletsAndNumberingResultText);}catch(e){}
 var st=p.appliedParagraphStyle; a.push({i:i, t:String(p.contents).substr(0,60), sid:st.id, nc:p.numberingContinue, sa:p.numberingStartAt, rt:rt, sb:p.spaceBefore, styleSb:st.spaceBefore, tb:p.tables.length, anch:p.allPageItems.length, f0:String(p.characters[0].fontStyle), li:p.leftIndent, fi:p.firstLineIndent}); }
var fffc=String(s.contents).split('\\uFFFC').length-1;
__ok({n:n, anchored:s.allPageItems.length, topAnchored:s.pageItems.length, fffc:fffc, overflows:s.overflows, len:s.characters.length, paras:a});`);
  const P = (info, i) => info.paras.find((x) => x.i === i) || {};
  const undoName = () => S(`var u=''; try{u=String(__resolveDocument().undoName);}catch(e){} __ok(u);`);

  // ── 20: qa-r2-01 — a failed tool call carries data (continue_story blocker) to the MCP caller ──
  await scenario(20, 'qa-r2-01/design-r2-08 failed continue_story returns isError + data.blocker (oversetCells, trailingParagraphs) through invokeTool', 900000, async (scn) => {
    await freshCopy();
    const c = await T('continue_story', { storyId: SID, maxPages: 3 }, { timeoutMs: 300000 });
    const j = mcpJson(c) || {};
    const b = (j.data || {}).blocker;
    scn.mcp = { isError: !c.norm.success, keys: Object.keys(j), error: j.error, code: j.code, blockerKeys: b && Object.keys(b) };
    rec(scn, 'MCP text of the failed call is {ok:false, error, data:{blocker}}', !c.norm.success && j.ok === false && typeof j.error === 'string' && !!b && Array.isArray(b.reasons) && b.reasons.length > 0, scn.mcp);
    rec(scn, 'harness/worker exposes the failure data (result.data.blocker)', !!(raw(c).blocker), { resultKeys: c.result && Object.keys(c.result) });
    rec(scn, 'blocker.oversetCells is a list (<=20) with tableId/row/column/textExcerpt', !!b && Array.isArray(b.oversetCells) && b.oversetCells.length <= 20 && b.oversetCells.every((x) => 'tableId' in x && 'row' in x && 'column' in x && 'textExcerpt' in x), { oversetCells: b && (b.oversetCells || []).slice(0, 3), n: b && b.oversetCells && b.oversetCells.length });
    rec(scn, 'blocker.trailingParagraphs is a list (<=20) of {index, style, text}', !!b && Array.isArray(b.trailingParagraphs) && b.trailingParagraphs.length <= 20 && b.trailingParagraphs.every((x) => 'index' in x && 'style' in x), { trailing: b && (b.trailingParagraphs || []).slice(0, 3) });
    const ok = await T('list_open_documents', {});
    const okJ = mcpJson(ok);
    rec(scn, 'success path unchanged (plain data array, no ok/error wrapper)', ok.norm.success && Array.isArray(okJ), { type: typeof okJ });
  });

  // ── 21: qa-r2-02 — conflicting edits for one paragraphIndex are all skipped ──
  await scenario(21, 'qa-r2-02 replace_paragraphs: replace+delete / duplicate edits for one paragraph -> all skipped as mismatches, nothing written', 900000, async (scn) => {
    await freshCopy();
    const b = await pinfo(0, 71);
    const r1 = await T('replace_paragraphs', { storyId: SID, edits: [{ paragraphIndex: 20, text: 'QA x' }, { paragraphIndex: 20, delete: true, expectText: 'Loan Term' }, { paragraphIndex: 20, insertAfter: true, text: 'QA ins' }] });
    const d1 = raw(r1);
    const a1 = await pinfo(0, 71);
    scn.r1 = { success: r1.norm.success, error: r1.norm.error, mismatches: d1.mismatches, applied: d1.applied };
    rec(scn, 'replace + delete + insert on p20: 3 mismatches "conflicting", 0 applied, story unchanged', (d1.mismatches || []).length === 3 && (d1.mismatches || []).every((m) => /conflicting|both replaced and deleted/i.test(m.reason || m.err || JSON.stringify(m))) && (d1.applied || []).length === 0 && a1.n === b.n && P(a1, 20).t === P(b, 20).t, scn.r1);
    const r2 = await T('replace_paragraphs', { storyId: SID, edits: [{ paragraphIndex: 19, text: 'QA dup A' }, { paragraphIndex: 19, text: 'QA dup B' }, { paragraphIndex: 3, text: 'Services QA' }] });
    const d2 = raw(r2);
    const a2 = await pinfo(0, 71);
    scn.r2 = { success: r2.norm.success, error: r2.norm.error, mismatches: d2.mismatches, applied: (d2.applied || []).map((x) => x.paragraphIndex) };
    rec(scn, 'duplicate replace on p19 skipped (2 mismatches) while the unrelated p3 edit applies', (d2.mismatches || []).length === 2 && JSON.stringify(scn.r2.applied) === '[3]' && P(a2, 19).t === P(b, 19).t && /^Services QA/.test(P(a2, 3).t), scn.r2);
  });

  // ── 22: design-r2-03 — deleting the item that restarts a list moves the restart ──
  await scenario(22, 'design-r2-03 delete the first numbered item (p12 restart "1.") -> restart moves to p13, list reads 1-4, no numbering warning', 900000, async (scn) => {
    await freshCopy();
    const b = await pinfo(10, 20);
    rec(scn, 'baseline p12 restarts "1.", p13..p16 "2.".."5."', P(b, 12).nc === false && P(b, 12).rt === '1.\t' && P(b, 16).rt === '5.\t', { p12: P(b, 12), p16: P(b, 16) });
    const d = await T('replace_paragraphs', { storyId: SID, edits: [{ paragraphIndex: 12, delete: true, expectText: 'Application form' }] });
    const x = raw(d);
    const a = await pinfo(10, 20);
    const ap = (x.applied || [])[0] || {};
    scn.del = { success: d.norm.success, error: d.norm.error, applied: x.applied, warnings: x.warnings, overrideErrors: x.overrideErrors, numberingChanges: x.numberingChanges };
    rec(scn, 'delete succeeds, applied[0].numberingRestartMovedTo set, no overrideErrors', d.norm.success && ap.numberingRestartMovedTo !== undefined && (x.overrideErrors || []).length === 0, scn.del);
    rec(scn, 'new p12 ("04 passport...") restarts at "1." and the list reads 1..4', P(a, 12).nc === false && P(a, 12).rt === '1.\t' && P(a, 13).rt === '2.\t' && P(a, 15).rt === '4.\t' && /^04 passport/.test(P(a, 12).t), { p12: P(a, 12), p13: P(a, 13), p15: P(a, 15) });
    rec(scn, 'no "list numbering changed" warning for the expected shift', !(x.warnings || []).some((w) => /numbering changed/i.test(w)), { warnings: x.warnings });
    const u = await T('undo', { expectUndoName: 'replace_paragraphs' });
    const au = await pinfo(10, 20);
    rec(scn, 'one undo restores p12 and its restart', u.norm.success && P(au, 12).t === P(b, 12).t && P(au, 12).nc === false && P(au, 13).nc === P(b, 13).nc, { p12: P(au, 12), p13: P(au, 13) });
  });

  // ── 23: design-r2-07 — table paragraph delete (allowTable) ──
  await scenario(23, 'design-r2-07 delete a table paragraph: refused without allowTable/expectations, dryRun reports table, real delete + undo; text replace on a table paragraph refused', 900000, async (scn) => {
    await freshCopy();
    const b = await pinfo(30, 71);
    const tabs = await S(`var s=__resolveDocument().stories.itemByID(${SID}); var o=[]; var ix=[32,33,69]; for (var k=0;k<ix.length;k++){ var p=s.paragraphs[ix[k]]; var t=p.tables; var r={i:ix[k], n:t.length}; if (t.length){ r.rows=t[0].rows.length; r.cols=t[0].columns.length; var an=0; try{ for (var c=0;c<t[0].cells.length;c++) an+=t[0].cells[c].allPageItems.length; }catch(e){ an=-1; } r.cellAnchors=an; r.first=String(t[0].cells[0].contents).substr(0,30); } o.push(r); } __ok(o);`);
    scn.tables = tabs;
    const tgt = tabs.find((t) => t.n === 1 && t.cellAnchors === 0) || tabs[0];
    const r0 = await T('replace_paragraphs', { storyId: SID, dryRun: true, edits: [{ paragraphIndex: tgt.i, delete: true, allowTable: true }] });
    rec(scn, 'allowTable without expectText/expectTableRows -> mismatch', (raw(r0).mismatches || []).length === 1 && (raw(r0).applied || []).length === 0, { data: raw(r0), error: r0.norm.error });
    const r1 = await T('replace_paragraphs', { storyId: SID, edits: [{ paragraphIndex: tgt.i, delete: true }] });
    rec(scn, 'delete of a table paragraph without allowTable -> mismatch, unchanged', (raw(r1).mismatches || []).length === 1 && (await pinfo(30, 71)).n === b.n, { data: raw(r1) });
    const r2 = await T('replace_paragraphs', { storyId: SID, edits: [{ paragraphIndex: tgt.i, text: 'QA would kill the table' }] });
    rec(scn, 'text replace on a table paragraph (U+0016) is refused', (raw(r2).mismatches || []).length === 1 && (await pinfo(30, 71)).n === b.n, { data: raw(r2) });
    const ed = { paragraphIndex: tgt.i, delete: true, allowTable: true, expectTableRows: tgt.rows, expectTableColumns: tgt.cols };
    const dry = await T('replace_paragraphs', { storyId: SID, dryRun: true, edits: [ed] });
    const dd = raw(dry), de = (dd.applied || [])[0] || {};
    scn.dry = { data: dd, target: tgt };
    if (tgt.cellAnchors !== 0) {
      rec(scn, 'table with anchored objects in cells is refused (no table without cell anchors exists)', (dd.mismatches || []).length === 1, scn.dry);
      return;
    }
    rec(scn, 'dryRun with expectTableRows/Columns reports entry.tables (rows, columns, cellCount)', dry.norm.success && Array.isArray(de.tables) && de.tables[0] && de.tables[0].rows === tgt.rows && de.tables[0].columns === tgt.cols && 'cellCount' in de.tables[0], scn.dry);
    const bad = await T('replace_paragraphs', { storyId: SID, dryRun: true, edits: [{ ...ed, expectTableRows: tgt.rows + 1 }] });
    rec(scn, 'wrong expectTableRows -> mismatch', (raw(bad).mismatches || []).length === 1, { data: raw(bad) });
    const real = await T('replace_paragraphs', { storyId: SID, edits: [ed] });
    const rd = raw(real), re = (rd.applied || [])[0] || {};
    const a = await pinfo(30, 71);
    rec(scn, 'real delete removes the paragraph + table (tablesDeleted reported), anchors unchanged', real.norm.success && Array.isArray(re.tablesDeleted) && a.n === b.n - 1 && a.anchored === b.anchored, { applied: rd.applied, mismatches: rd.mismatches, overrideErrors: rd.overrideErrors, n0: b.n, n1: a.n });
    const u = await T('undo', { expectUndoName: 'replace_paragraphs' });
    const au = await pinfo(30, 71);
    rec(scn, 'undo restores the table paragraph', u.norm.success && au.n === b.n && P(au, tgt.i).tb === 1, { n: au.n, p: P(au, tgt.i) });
  });

  // ── 24: design-r2-05 — spaceBefore override of the following paragraph after an insert ──
  await scenario(24, 'design-r2-05 insertAfter warns about the next paragraph\'s local spaceBefore; resetNextSpacing:true resets it (spacingReset)', 900000, async (scn) => {
    await freshCopy();
    const b0 = await pinfo(2, 4);
    const sbStyle = P(b0, 3).styleSb;
    await S(`var p=__resolveDocument().stories.itemByID(${SID}).paragraphs[3]; p.spaceBefore = p.appliedParagraphStyle.spaceBefore + 9; __ok(p.spaceBefore);`, { undoName: 'harness local spaceBefore' });
    const b = await pinfo(2, 4);
    rec(scn, 'setup: p3 "Service/s" has a local spaceBefore override (+9pt)', Math.abs(P(b, 3).sb - (sbStyle + 9)) < 0.01, { p3: P(b, 3) });
    const i1 = await T('replace_paragraphs', { storyId: SID, edits: [{ paragraphIndex: 2, insertAfter: true, text: 'QA inserted regular paragraph' }] });
    const x1 = raw(i1);
    scn.warn = { success: i1.norm.success, warnings: x1.warnings, applied: x1.applied };
    rec(scn, 'insert succeeds and warns "keeps local spaceBefore" naming paragraph 4', i1.norm.success && (x1.warnings || []).some((w) => /spaceBefore/.test(w) && /paragraph 4\b/.test(w)), scn.warn);
    await T('undo', { expectUndoName: 'replace_paragraphs' });
    const i2 = await T('replace_paragraphs', { storyId: SID, edits: [{ paragraphIndex: 2, insertAfter: true, text: 'QA inserted regular paragraph', resetNextSpacing: true }] });
    const x2 = raw(i2);
    const a = await pinfo(2, 5);
    const sr = ((x2.applied || [])[0] || {}).spacingReset;
    scn.reset = { success: i2.norm.success, spacingReset: sr, p4: P(a, 4), warnings: x2.warnings };
    rec(scn, 'resetNextSpacing: spacingReset {paragraphIndex 4, from, to=style} and p4 spaceBefore = style value', i2.norm.success && !!sr && sr.paragraphIndex === 4 && Math.abs(P(a, 4).sb - sbStyle) < 0.01 && /^Service/.test(P(a, 4).t), scn.reset);
    const i3 = await T('replace_paragraphs', { storyId: SID, dryRun: true, edits: [{ paragraphIndex: 7, label: 'Nationality', value: 'x', resetNextSpacing: true }] });
    rec(scn, 'resetNextSpacing on a non-insert / non-restyle edit is rejected', !i3.norm.success || (raw(i3).mismatches || []).length === 1, { success: i3.norm.success, error: i3.norm.error, data: raw(i3) });
  });

  // ── 25: design-r2-04 — ':'-keyed GREP guard ──
  await scenario(25, 'design-r2-04 GREP guard: ":" in a Contact info line is a mismatch; acceptGrepEffects writes it (bold up to colon) with a warning; snapshot reports colonStyleRules', 900000, async (scn) => {
    await freshCopy();
    const b = await pinfo(27, 31);
    const r1 = await T('replace_paragraphs', { storyId: SID, edits: [{ paragraphIndex: 30, text: 'Help Desk: +880 1 222 333' }] });
    const x1 = raw(r1);
    rec(scn, 'replace_paragraphs: text with ":" into p30 (template has none) -> mismatch with rules, nothing written', (x1.mismatches || []).length === 1 && /GREP|nested/.test(x1.mismatches[0].reason) && (await pinfo(27, 31)).paras.every((p, k) => p.t === b.paras[k].t), { mismatches: x1.mismatches });
    const r2 = await T('replace_paragraphs', { storyId: SID, edits: [{ paragraphIndex: 30, text: 'Help Desk: +880 1 222 333', acceptGrepEffects: true }] });
    const x2 = raw(r2);
    const fs2 = await S(`var p=__resolveDocument().stories.itemByID(${SID}).paragraphs[30]; var c=String(p.contents); var k=c.indexOf('Help'); var ci=c.indexOf(':'); __ok({ t:c.substr(0,40), label:String(p.characters[k].fontStyle), colon:String(p.characters[ci].fontStyle), value:String(p.characters[ci+3].fontStyle) });`);
    scn.accepted = { success: r2.norm.success, warnings: x2.warnings, fonts: fs2 };
    rec(scn, 'acceptGrepEffects:true writes it, with a warning; label bold (GREP), value not bold', r2.norm.success && (x2.applied || []).length === 1 && (x2.warnings || []).some((w) => /GREP|nested|:/.test(w)) && /Bold/.test(fs2.label) && !/Bold/.test(fs2.value), scn.accepted);
    await T('undo', { expectUndoName: 'replace_paragraphs' });
    const L = [{ type: 'address', text: 'Head Office: QA address' }, { type: 'web', text: 'www.qa.example' }, { type: 'email', text: 'qa@example.org' }, { type: 'phone', text: '+880 1 000 000' }];
    const c1 = await T('replace_contact_block', { frameId: FX.pkb.secondFrame, lines: L, dryRun: true });
    rec(scn, 'replace_contact_block: "Head Office:" address line -> mismatch on line 0', (raw(c1).mismatches || []).some((m) => m.line === 0 && /GREP|nested/.test(m.reason)), { mismatches: raw(c1).mismatches });
    const c2 = await T('replace_contact_block', { frameId: FX.pkb.secondFrame, lines: L, dryRun: true, acceptGrepEffects: true });
    rec(scn, 'replace_contact_block acceptGrepEffects:true -> no mismatch (warning)', (raw(c2).mismatches || []).length === 0, { mismatches: raw(c2).mismatches, warnings: raw(c2).warnings });
    const sn = await T('snapshot_document', { pageRange: '15', includeCharFormatting: true });
    const ci = ((sn.norm.data || {}).pages || []).flatMap((p) => p.frames || []).flatMap((f) => f.paragraphs || []).filter((p) => /Contact info/.test(p.style));
    rec(scn, 'snapshot: Contact info paragraphs carry colonStyleRules (grep .+(?<=:))', ci.length > 0 && ci.every((p) => Array.isArray(p.colonStyleRules) && p.colonStyleRules.length > 0), { first: ci[0] && { style: ci[0].style, colonStyleRules: ci[0].colonStyleRules } });
  });

  // ── 26: design-r2-06 — typeAliases / extraIcons ──
  await scenario(26, 'design-r2-06 replace_contact_block typeAliases {fax:"phone"} and extraIcons (email icon duplicated from the PKB block into the Agrani block)', 1200000, async (scn) => {
    await freshCopy();
    const AG = 49888;
    const L3 = [{ type: 'address', text: 'QA Agrani address' }, { type: 'web', text: 'www.agrani-qa.example' }, { type: 'fax', text: '+880 2 999 999' }];
    const f0 = await T('replace_contact_block', { frameId: AG, lines: L3, dryRun: true });
    rec(scn, 'fax without alias -> mismatch (no icon), nothing changed', (raw(f0).mismatches || []).length > 0, { mismatches: raw(f0).mismatches });
    const f1 = await T('replace_contact_block', { frameId: AG, lines: L3, typeAliases: { fax: 'phone' }, dryRun: true });
    rec(scn, 'typeAliases {fax:"phone"} -> no mismatch, aliasesUsed reported', (raw(f1).mismatches || []).length === 0 && JSON.stringify(raw(f1).aliasesUsed || '').includes('fax'), { data: { mismatches: raw(f1).mismatches, aliasesUsed: raw(f1).aliasesUsed, effectiveTypes: raw(f1).effectiveTypes }, error: f1.norm.error });
    const f2 = await T('replace_contact_block', { frameId: AG, lines: L3, typeAliases: { fax: 'bogus' }, dryRun: true });
    rec(scn, 'typeAliases with an invalid target type is rejected', !f2.norm.success, { error: f2.norm.error });
    const b = await pinfo(25, 72);
    const iconIdx = await S(`var p=__resolveDocument().stories.itemByID(${SID}).paragraphs[29]; __ok(p.characters[0].index);`);
    const L4 = [{ type: 'address', text: 'QA Agrani address' }, { type: 'web', text: 'www.agrani-qa.example' }, { type: 'email', text: 'agrani@qa.example' }, { type: 'phone', text: '+880 2 111 111' }];
    const xArgs = { frameId: AG, lines: L4, extraIcons: [{ type: 'email', iconFrom: { storyId: SID, characterIndex: iconIdx } }], wrapPolicy: 'warn' };
    let xi = await T('replace_contact_block', xArgs);
    let xd = raw(xi);
    // qa-r3-01: frame 49888 is full — if the added line pushes contact lines into overset the write is rolled back
    // (applied:false, "pushed into overset"); then repeat with allowOverset:true to check the extraIcons mechanics.
    const xOverset = xi.norm.success && xd.applied === false && xd.rolledBack === true && (xd.mismatches || []).some((m) => m.reason === 'pushed into overset');
    if (xOverset) {
      const ar = await pinfo(25, 72);
      rec(scn, 'extraIcons write that would push lines into overset is rolled back, story unchanged', ar.n === b.n && ar.fffc === b.fffc && ar.paras.every((p, k) => p.t === b.paras[k].t), { mismatches: xd.mismatches });
      xi = await T('replace_contact_block', { ...xArgs, allowOverset: true });
      xd = raw(xi);
    }
    const a = await pinfo(25, 72);
    scn.extra = { success: xi.norm.success, error: xi.norm.error, applied: xd.applied, mismatches: xd.mismatches, addErrors: xd.addErrors, warnings: xd.warnings, rolledBack: xd.rollbackRequired || xd.rolledBack, n0: b.n, n1: a.n, anch0: b.anchored, anch1: a.anchored, fffc0: b.fffc, fffc1: a.fffc, top0: b.topAnchored, top1: a.topAnchored, p65_68: [65, 66, 67, 68].map((i) => P(a, i).t) };
    // icons may be groups: count anchor characters (U+FFFC) / top-level anchored items, not allPageItems
    rec(scn, 'extraIcons: +1 paragraph, +1 anchored icon (U+FFFC and top-level item), email line between web and phone, icon+tab prefix', xi.norm.success && a.n === b.n + 1 && a.fffc === b.fffc + 1 && a.topAnchored === b.topAnchored + 1 && P(a, 67).t.startsWith('\uFFFC\tagrani@qa.example') && P(a, 68).t.startsWith('\uFFFC\t+880 2 111') && P(a, 66).t.startsWith('\uFFFC\twww.agrani-qa'), scn.extra);
    const sz = await S(`var s=__resolveDocument().stories.itemByID(${SID}); function g(pi){ var it=s.paragraphs[pi].allPageItems[0]; var gb=it.geometricBounds; return [Math.round((gb[2]-gb[0])*100)/100, Math.round((gb[3]-gb[1])*100)/100]; } __ok({ src: g(29), added: g(67) });`);
    rec(scn, 'duplicated icon has the same size as the source icon', JSON.stringify(sz.src) === JSON.stringify(sz.added), sz);
    const xb = await T('replace_contact_block', { frameId: FX.pkb.secondFrame, lines: [{ type: 'address', text: 'a' }, { type: 'web', text: 'b' }, { type: 'email', text: 'c' }, { type: 'email', text: 'd' }, { type: 'phone', text: 'e' }], extraIcons: [{ type: 'email', iconFrom: { storyId: SID, characterIndex: iconIdx } }], dryRun: true });
    rec(scn, 'extraIcons for a type already in the template block -> mismatch', (raw(xb).mismatches || []).length > 0, { mismatches: raw(xb).mismatches, error: xb.norm.error });
  });

  // ── 27: qa-r2-03 + design-r2-10 — wrapping icon line policy ──
  await scenario(27, 'qa-r2-03/design-r2-10 replace_contact_block wrapPolicy: default mismatch rolls back; hangingIndent indents the wrapped line', 1200000, async (scn) => {
    await freshCopy();
    const AG = 49888;
    const long = 'www.agrani-bank-overseas-workers-loan-information-desk-qa.example.org/branches';
    // (a) Agrani block (frame 49888 is full): the wrapped web line pushes the web + phone lines, composed before, into overset.
    //     User rule "no hidden/overset text": such a write must be rolled back / reported as mismatch, never kept.
    const La = [{ type: 'address', text: 'QA Agrani address' }, { type: 'web', text: long }, { type: 'phone', text: '+880 2 111 111' }];
    const comp = () => S(`var s=__resolveDocument().stories.itemByID(${SID}); var o=[]; for (var i=65;i<=67;i++){ var p=s.paragraphs[i]; var f=null; try{ f=p.characters[-1].parentTextFrames.length ? p.characters[-1].parentTextFrames[0].id : null; }catch(e){} o.push(f); } __ok(o);`);
    const c0 = await comp();
    const ba = await pinfo(60, 70);
    const ma = await T('replace_contact_block', { frameId: AG, lines: La });
    const mad = raw(ma);
    const c1 = await comp();
    const aa = await pinfo(60, 70);
    scn.agraniOverset = { composedBefore: c0, composedAfter: c1, success: ma.norm.success, applied: mad.applied, rolledBack: mad.rolledBack, mismatches: mad.mismatches, warnings: mad.warnings };
    const keptHidden = c0.every((f) => f !== null) && c1.some((f) => f === null);
    rec(scn, 'default wrapPolicy: a write that pushes previously composed contact lines into overset is rolled back (no hidden text kept)', !keptHidden && (mad.applied === false || c1.every((f) => f !== null)), scn.agraniOverset);
    if (keptHidden) await T('undo', { expectUndoName: 'replace_contact_block' });
    const aa2 = await pinfo(60, 70);
    rec(scn, 'Agrani block text restored (by rollback or harness undo)', aa2.paras.every((p, k) => p.t === ba.paras[k].t), { p66: P(aa2, 66), afterCall: P(aa, 66) });
    const oa = (mad.mismatches || []).filter((x) => x.reason === 'pushed into overset');
    rec(scn, 'qa-r3-01: overset mismatches are line-specific {line, reason "pushed into overset", frameId 49888}', ma.norm.success && mad.rolledBack === true && oa.length > 0 && oa.every((x) => typeof x.line === 'number' && x.frameId === AG), { mismatches: mad.mismatches });
    const same = (x, y) => x.paras.every((p, k) => p.t === y.paras[k].t) && x.anchored === y.anchored;
    const undoIfChanged = async (x, y) => { if (!same(x, y)) await T('undo', { expectUndoName: 'replace_contact_block' }); };
    // (b) PKB block (frame 46588; v06: its thread cannot take more lines, the story overflows already).
    //     The long web line is pushed (with email/phone) into overset -> every wrapPolicy rolls it back unless allowOverset:true.
    const Lw = [{ type: 'address', text: 'QA address line' }, { type: 'web', text: long }, { type: 'email', text: 'qa@example.org' }, { type: 'phone', text: '+880 1 000 000' }];
    const b = await pinfo(25, 32);
    const m = await T('replace_contact_block', { frameId: FX.pkb.secondFrame, lines: Lw });
    const md = raw(m);
    const a = await pinfo(25, 32);
    scn.mismatch = { success: m.norm.success, applied: md.applied, rolledBack: md.rolledBack, mismatches: md.mismatches, warnings: md.warnings };
    const om = (md.mismatches || []).filter((x) => x.reason === 'pushed into overset');
    rec(scn, 'default wrapPolicy: web line pushed into overset -> success, applied:false, rolledBack:true, mismatch {line 1, "pushed into overset", frameId 46588}', m.norm.success && md.applied === false && md.rolledBack === true && om.some((x) => x.line === 1 && x.frameId === FX.pkb.secondFrame) && om.every((x) => !!x.suggestion), scn.mismatch);
    rec(scn, 'rolled-back call leaves the story text unchanged', same(a, b), { p28: P(a, 28) });
    await undoIfChanged(a, b);
    const ho = await T('replace_contact_block', { frameId: FX.pkb.secondFrame, lines: Lw, wrapPolicy: 'hangingIndent' });
    const hod = raw(ho);
    const aho = await pinfo(25, 32);
    rec(scn, 'hangingIndent: still overset after re-measuring -> rolled back with "pushed into overset" mismatches, text unchanged', ho.norm.success && hod.applied === false && hod.rolledBack === true && (hod.mismatches || []).some((x) => x.reason === 'pushed into overset') && same(aho, b), { applied: hod.applied, rolledBack: hod.rolledBack, mismatches: hod.mismatches, hangingIndentApplied: hod.hangingIndentApplied });
    await undoIfChanged(aho, b);
    const wo = await T('replace_contact_block', { frameId: FX.pkb.secondFrame, lines: Lw, wrapPolicy: 'warn' });
    const awo = await pinfo(25, 32);
    rec(scn, "wrapPolicy 'warn' does not keep overset text either (rolled back, overset mismatch)", wo.norm.success && raw(wo).applied === false && raw(wo).rolledBack === true && same(awo, b), { applied: raw(wo).applied, mismatches: raw(wo).mismatches, warnings: raw(wo).warnings });
    await undoIfChanged(awo, b);
    // (c) wrap that stays composed (long ADDRESS line 0: its first characters stay in frame 46588).
    const La0 = [{ type: 'address', text: 'QA Head Office address, House 71-72, Old Elephant Road, Eskaton Garden, Ramna, Dhaka 1000, Bangladesh' }, { type: 'web', text: 'www.qa.example' }, { type: 'email', text: 'qa@example.org' }, { type: 'phone', text: '+880 1 000 000' }];
    const w0 = await T('replace_contact_block', { frameId: FX.pkb.secondFrame, lines: La0 });
    const w0d = raw(w0);
    const aw0 = await pinfo(25, 32);
    const wm0 = (w0d.mismatches || []).find((x) => x.line === 0 && /wraps/.test(x.reason)) || {};
    scn.wrapMismatch = { success: w0.norm.success, applied: w0d.applied, rolledBack: w0d.rolledBack, mismatches: w0d.mismatches, warnings: w0d.warnings };
    rec(scn, 'default wrapPolicy: wrapped address -> success, applied:false, rolledBack:true, mismatch {line 0, frameWidth, lineCount, suggestion}', w0.norm.success && w0d.applied === false && w0d.rolledBack === true && wm0.frameWidth > 0 && wm0.lineCount > 1 && !!wm0.suggestion && same(aw0, b), scn.wrapMismatch);
    await undoIfChanged(aw0, b);
    const hi = await T('replace_contact_block', { frameId: FX.pkb.secondFrame, lines: La0, wrapPolicy: 'hangingIndent' });
    const hd = raw(hi);
    const ah = await pinfo(25, 32);
    const hiOk = hi.norm.success && hd.applied === true && (hd.hangingIndentApplied || []).length > 0 && P(ah, 27).fi < 0 && Math.abs((P(ah, 27).li - P(b, 27).li) + (P(ah, 27).fi - P(b, 27).fi)) < 0.5;
    const hiRolled = hi.norm.success && hd.applied === false && hd.rolledBack === true && (hd.mismatches || []).some((x) => x.reason === 'pushed into overset' && /hanging indent/.test(String(x.detail))) && same(ah, b);
    scn.hanging = { success: hi.norm.success, applied: hd.applied, rolledBack: hd.rolledBack, hangingIndentApplied: hd.hangingIndentApplied, mismatches: hd.mismatches, warnings: hd.warnings, p27: P(ah, 27), p27before: P(b, 27) };
    rec(scn, 'hangingIndent (default allowOverset): indent applied and kept when nothing is overset, otherwise re-measured and rolled back ("still, after the hanging indent")', hiOk || hiRolled, scn.hanging);
    await undoIfChanged(ah, b);
    const hk = await T('replace_contact_block', { frameId: FX.pkb.secondFrame, lines: La0, wrapPolicy: 'hangingIndent', allowOverset: true });
    const hkd = raw(hk);
    const ahk = await pinfo(25, 32);
    scn.hangingKept = { success: hk.norm.success, applied: hkd.applied, hangingIndentApplied: hkd.hangingIndentApplied, warnings: hkd.warnings, p27: P(ahk, 27), p27before: P(b, 27) };
    rec(scn, 'hangingIndent + allowOverset: applied, hangingIndentApplied reported, p27 firstLineIndent negative and leftIndent grown by the same hang', hk.norm.success && hkd.applied === true && (hkd.hangingIndentApplied || []).length > 0 && P(ahk, 27).fi < 0 && Math.abs((P(ahk, 27).li - P(b, 27).li) + (P(ahk, 27).fi - P(b, 27).fi)) < 0.5 && P(ahk, 27).t.startsWith('\uFFFC\tQA Head Office'), scn.hangingKept);
    await undoIfChanged(ahk, b);
    const w = await T('replace_contact_block', { frameId: FX.pkb.secondFrame, lines: La0, wrapPolicy: 'warn', allowOverset: true });
    rec(scn, "wrapPolicy 'warn' + allowOverset keeps the write and warns about wrapping", w.norm.success && raw(w).applied === true && (raw(w).warnings || []).some((x) => /wrap/i.test(x)), { warnings: raw(w).warnings, applied: raw(w).applied });
  });

  // \u2500\u2500 31: design-r3-03 \u2014 replace_paragraphs rolls back a write that leaves text hidden in a single unthreaded frame \u2500\u2500
  await scenario(33, 'design-r3-03 replace_paragraphs: new overset in the unthreaded opener title frame -> rolled back (applied:false, mismatch); allowOverset:true keeps it', 900000, async (scn) => {
    await freshCopy();
    const TS = FX.opener.titleStory;
    const tinfo = () => S(`var s=__resolveDocument().stories.itemByID(${TS}); var a=[]; for (var i=0;i<s.paragraphs.length;i++) a.push(String(s.paragraphs[i].contents)); __ok({ overflows: s.overflows, frames: s.textContainers.length, paras: a });`);
    const t0 = await tinfo();
    const longTitle = 'Access to Women, Childcare, Family Support, Legal Aid, Housing, Health and Reintegration Services for Returnee Migrant Workers';
    const r = await T('replace_paragraphs', { storyId: TS, edits: [{ paragraphIndex: 1, text: longTitle, expectStyleId: FX.styleIds.chapterName }] });
    const d = raw(r);
    const t1 = await tinfo();
    const om = (d.mismatches || []).find((m) => /overset/.test(m.reason)) || {};
    scn.rollback = { before: t0, after: t1, success: r.norm.success, error: r.norm.error, applied: d.applied, rolledBack: d.rolledBack, mismatches: d.mismatches, warnings: d.warnings, oversetCaused: d.oversetCaused };
    rec(scn, 'title story fits before (1 frame, no overflow)', t0.overflows === false && t0.frames === 1, t0);
    rec(scn, 'overset write -> success, applied:false, rolledBack:true, mismatch {kind overset, frameId = title frame, singleUnthreadedFrame, paragraphs[0].paragraphIndex 1}', r.norm.success && d.applied === false && d.rolledBack === true && om.kind === 'overset' && om.frameId === FX.opener.titleFrame && om.singleUnthreadedFrame === true && (om.paragraphs || []).some((p) => p.paragraphIndex === 1), scn.rollback);
    rec(scn, 'story text and overflow state unchanged after the rollback', t1.overflows === false && JSON.stringify(t1.paras) === JSON.stringify(t0.paras), { t0, t1 });
    if (JSON.stringify(t1.paras) !== JSON.stringify(t0.paras)) await T('undo', { expectUndoName: 'replace_paragraphs' });
    const k = await T('replace_paragraphs', { storyId: TS, allowOverset: true, edits: [{ paragraphIndex: 1, text: longTitle, expectStyleId: FX.styleIds.chapterName }] });
    const kd = raw(k);
    const t2 = await tinfo();
    rec(scn, 'allowOverset:true keeps the write (applied list), with overset warnings', k.norm.success && Array.isArray(kd.applied) && kd.applied.length === 1 && t2.overflows === true && (kd.warnings || []).some((w) => /allowOverset/.test(w)), { applied: kd.applied, warnings: kd.warnings, t2 });
    if (k.norm.success) await T('undo', { expectUndoName: 'replace_paragraphs' });
    const s0 = await T('replace_paragraphs', { storyId: TS, edits: [{ paragraphIndex: 1, text: 'Access to QA', expectStyleId: FX.styleIds.chapterName }] });
    rec(scn, 'a title that fits is applied normally (no overset mismatch)', s0.norm.success && Array.isArray(raw(s0).applied) && raw(s0).applied.length === 1 && !(raw(s0).mismatches || []).length, { data: raw(s0), error: s0.norm.error });
  });

  // \u2500\u2500 32: design-r3-04 \u2014 ':'-keyed GREP with 2+ colons in one line \u2500\u2500
  await scenario(34, 'design-r3-04 GREP .+(?<=:) bolds to the LAST colon: a line with 2+ ":" is a line-specific mismatch naming the bold value part; acceptGrepEffects writes it with a warning', 900000, async (scn) => {
    await freshCopy();
    const b = await pinfo(27, 31);
    const two = 'Hotline: 10:00-17:00 Sun-Thu';
    const r1 = await T('replace_paragraphs', { storyId: SID, dryRun: true, edits: [{ paragraphIndex: 30, text: two }] });
    const m1 = (raw(r1).mismatches || [])[0] || {};
    rec(scn, 'replace_paragraphs: 2-colon text -> mismatch on paragraph 30 naming the value part that would be bold', (raw(r1).mismatches || []).length === 1 && m1.paragraphIndex === 30 && /LAST ":"/.test(m1.reason) && /10:00/.test(m1.reason) && !!(m1.multiColon && m1.multiColon.colonCount === 3), { mismatches: raw(r1).mismatches });
    const L = [{ type: 'address', text: 'QA address' }, { type: 'web', text: 'www.qa.example' }, { type: 'email', text: 'qa@example.org' }, { type: 'phone', text: 'Phone: +880 1 000 000, ext: 12' }];
    const c1 = await T('replace_contact_block', { frameId: FX.pkb.secondFrame, lines: L, dryRun: true });
    const cm = (raw(c1).mismatches || []).find((m) => m.line === 3) || {};
    rec(scn, 'replace_contact_block: line 3 with 2 ":" -> mismatch {line 3, multiColon, reason names the bold value part}', !!cm.multiColon && cm.multiColon.colonCount === 2 && /LAST ":"/.test(cm.reason) && /\+880 1 000 000, ext:/.test(cm.reason), { mismatches: raw(c1).mismatches });
    const c2 = await T('replace_contact_block', { frameId: FX.pkb.secondFrame, lines: L, dryRun: true, acceptGrepEffects: true });
    rec(scn, 'acceptGrepEffects:true -> no mismatch, line-specific warning about the bold value part', (raw(c2).mismatches || []).length === 0 && (raw(c2).warnings || []).some((w) => /^line 3: /.test(w) && /LAST ":"/.test(w)), { mismatches: raw(c2).mismatches, warnings: raw(c2).warnings });
    const one = await T('replace_paragraphs', { storyId: SID, dryRun: true, edits: [{ paragraphIndex: 30, text: '+880 1 000 000' }] });
    rec(scn, 'no ":" -> no GREP mismatch (control)', (raw(one).mismatches || []).length === 0, { mismatches: raw(one).mismatches });
    rec(scn, 'nothing written by the dry runs', (await pinfo(27, 31)).paras.every((p, k) => p.t === b.paras[k].t), {});
  });

  // ── 35: r4-B3 / r4-B4 / F3 — per-paragraph colon count, dryRun says wraps are not measured ──
  //     (offline helper checks for '(?=:).+' vs '.+(?<=:)' live in tests/harness/unit_r4.mjs)
  await scenario(35, 'r4-B3 multi-colon guard counts ":" per resulting paragraph; r4-B4 contact dryRun reports notChecked (wraps/overset)', 900000, async (scn) => {
    await freshCopy();
    const b = await pinfo(27, 31);
    const split = await T('replace_paragraphs', { storyId: SID, dryRun: true, edits: [{ paragraphIndex: 30, text: 'Help: +880 1 111\rDesk: +880 1 222' }] });
    const ms = raw(split).mismatches || [];
    rec(scn, 'two \\r paragraphs with one ":" each -> only the no-colon-template GREP mismatch, no multiColon', ms.length === 1 && !ms[0].multiColon && /GREP|nested/.test(ms[0].reason), { mismatches: ms });
    const split2 = await T('replace_paragraphs', { storyId: SID, dryRun: true, edits: [{ paragraphIndex: 30, text: 'Help: +880 1 111\rHotline: 10:00-17:00' }] });
    const m2 = (raw(split2).mismatches || [])[0] || {};
    rec(scn, '\\r edit whose 2nd paragraph has 3 ":" -> multiColon {colonCount 3, paragraphOfEdit 1}', !!m2.multiColon && m2.multiColon.colonCount === 3 && m2.multiColon.paragraphOfEdit === 1, { mismatches: raw(split2).mismatches });
    const L = [{ type: 'address', text: 'QA address' }, { type: 'web', text: 'www.qa.example' }, { type: 'email', text: 'qa@example.org' }, { type: 'phone', text: '+880 1 000 000' }];
    const d = await T('replace_contact_block', { frameId: FX.pkb.secondFrame, lines: L, dryRun: true });
    rec(scn, 'replace_contact_block dryRun: no mismatch, notChecked names wraps/overset', d.norm.success && (raw(d).mismatches || []).length === 0 && (raw(d).notChecked || []).some((x) => /wrap/.test(x) && /overset/.test(x)), { data: raw(d) });
    rec(scn, 'nothing written by the dry runs', (await pinfo(27, 31)).paras.every((p, k) => p.t === b.paras[k].t), {});
  });

  // ── 28: design-r2-09 — effective formatting runs in snapshot / label detection ──
  await scenario(28, 'design-r2-09 snapshot segments are effective runs (source:"effective"); includeRawSegments adds rawSegments; label detection on GREP-bold labels', 900000, async (scn) => {
    await freshCopy();
    const sn = await T('snapshot_document', { pageRange: '14', includeCharFormatting: true, includeRawSegments: true });
    const paras = ((sn.norm.data || {}).pages || []).flatMap((p) => p.frames || []).flatMap((f) => f.paragraphs || []);
    const p7 = paras.find((p) => p.storyParagraphIndex === 7) || {};
    const segs = p7.segments || [];
    scn.p7 = { text: p7.text, label: p7.label, segments: segs, rawSegments: p7.rawSegments };
    rec(scn, 'p7 "Nationality:" segments carry source:"effective"; first segment bold, ends at/after the colon; later segment not bold', sn.norm.success && segs.length >= 2 && segs.every((s) => s.source === 'effective') && /Bold/.test(segs[0].fontStyle) && !/Bold/.test(segs[segs.length - 1].fontStyle), scn.p7);
    rec(scn, 'rawSegments present with includeRawSegments:true', Array.isArray(p7.rawSegments) && p7.rawSegments.length > 0, { raw: p7.rawSegments });
    const sn2 = await T('snapshot_document', { pageRange: '14', includeCharFormatting: true });
    const p7b = ((sn2.norm.data || {}).pages || []).flatMap((p) => p.frames || []).flatMap((f) => f.paragraphs || []).find((p) => p.storyParagraphIndex === 7) || {};
    rec(scn, 'rawSegments absent by default', !('rawSegments' in p7b), { keys: Object.keys(p7b) });
    const lv = await T('replace_paragraphs', { storyId: SID, dryRun: true, edits: [{ paragraphIndex: 8, label: 'Age', value: 'QA value' }] });
    const e = (raw(lv).applied || [])[0] || {};
    rec(scn, 'label/value dryRun on p8 reports labelFontStyle bold + fontStyleSource', lv.norm.success && /Bold/.test(String(e.labelFontStyle)) && !!e.fontStyleSource, { applied: raw(lv).applied, mismatches: raw(lv).mismatches });
  });

  // ── 29: chapter theme (design-r2-01/02/11, qa-r2-04) ──
  await scenario(29, 'design-r2-01/02/11 + qa-r2-04 swap_swatch_in_scope tints / fromSwatches / grep-aware counts; theme_chapter remap + masterAfterSwap', 1500000, async (scn) => {
    await freshCopy();
    await S(`var d=__resolveDocument(); var c=d.colors.itemByName(${JSON.stringify(FX.chapterColor)}); var t=null; try{ t=d.tints.add(c,{tintValue:50}); }catch(e){ t=d.tints.add({baseColor:c, tintValue:50}); } d.textFrames.itemByID(${FX.pkb.bgFrame}).fillColor=t; __ok(String(t.name));`, { undoName: 'harness tint setup' });
    const sw = await T('swap_swatch_in_scope', { fromSwatch: FX.chapterColor, toSwatch: 'Pantone 298 C', scope: { pageIndexes: [13] }, overrideMode: 'all' });
    const x = raw(sw);
    const fill = await S(`var it=__resolveDocument().textFrames.itemByID(${FX.pkb.bgFrame}); var f=it.fillColor; var o={ name:String(f.name), type:f.constructor.name }; try{ o.base=f.baseColor.name; o.tint=f.tintValue; }catch(e){} __ok(o);`);
    scn.tint = { success: sw.norm.success, error: sw.norm.error, tintsCreated: x.tintsCreated, tintHits: x.tintHits, perSource: x.perSource, grepProtected: x.grepProtected, grepDerived: x.grepDerived, fill };
    rec(scn, 'a 50% tint of the chapter colour becomes a 50% tint of Pantone 298 C (tintsCreated)', sw.norm.success && (x.tintsCreated || []).some((t) => t.baseColor === 'Pantone 298 C' && t.tintValue === 50) && fill.base === 'Pantone 298 C' && fill.tint === 50, scn.tint);
    rec(scn, 'result reports grepProtected / grepDerived / perSource counts', typeof x.grepProtected === 'number' && typeof x.grepDerived === 'number' && !!x.perSource, scn.tint);
    const effCnt = await S(`var d=__resolveDocument(); function c(id){ var ch=d.textFrames.itemByID(id).texts[0].characters.everyItem().fillColor, n=0; for (var k=0;k<ch.length;k++){ try{ if (ch[k].name==${JSON.stringify(FX.chapterColor)}) n++; }catch(e){} } return n; } __ok({ f02: c(${FX.pkb.firstFrame}), f03: c(${FX.pkb.secondFrame}) });`);
    rec(scn, 'after overrideMode all on page 02: no character in frame 5864 RENDERS in the old colour except GREP-protected ones', effCnt.f02 <= (x.grepProtected || 0), { effCnt, grepProtected: x.grepProtected });
    const ms = await T('swap_swatch_in_scope', { fromSwatch: [FX.chapterColor, 'Pantone 298 C'], toSwatch: 'Black', scope: { pageIndexes: [14] }, dryRun: true });
    rec(scn, 'fromSwatch array: dry run succeeds and reports perSource for both swatches', ms.norm.success && Object.keys(raw(ms).perSource || {}).length === 2, { perSource: raw(ms).perSource, error: ms.norm.error });
    const thArgs = { sourceMaster: '1-Access to Finance', newNamePrefix: '4', newBaseName: 'Theme QA', textReplace: [{ find: 'Chapter 1: Access to Finance', replace: 'Chapter 4: Theme QA' }], fromSwatch: FX.chapterColor, toSwatch: 'Pantone 298 C',
      styles: [{ styleType: 'paragraph', source: 'Regular set/Color Reset/Service Name Numbered', newName: 'Service Name Numbered', groupPath: 'Chapter 4/Color Reset' }, { styleType: 'paragraph', source: 'Regular set/Color Reset/Part Heading', newName: 'Part Heading', groupPath: 'Chapter 4/Color Reset' },
        { styleType: 'paragraph', source: FX.styleIds.providerName, newName: 'Provider Name', groupPath: 'Chapter 4/Color Reset' }, { styleType: 'character', source: 'Running head', newName: 'Running head 4' }] };
    // r4-B1 setup: the SOURCE Provider Name gets paragraph shading in the chapter colour (the real BRAC run lost it on 'Provider Name W')
    const pnSetup = await S(`var d=__resolveDocument(); var all=d.allParagraphStyles, st=null; for (var i=0;i<all.length;i++) if (all[i].id===${FX.styleIds.providerName}) st=all[i];
var o={ ok: !!st }; if (st){ var c=d.colors.itemByName(${JSON.stringify(FX.chapterColor)}); try{ st.paragraphShadingOn=true; st.paragraphShadingColor=c; o.shading=true; }catch(e){ o.shadingErr=String(e); } o.path=String(st.name); }
__ok(o);`, { undoName: 'harness provider name shading setup' });
    rec(scn, 'setup (r4-B1): source Provider Name has paragraph shading in the chapter colour', pnSetup && pnSetup.ok && pnSetup.shading, pnSetup);
    // design-r3-01 setup: give the SOURCE Part Heading paragraph shading (30% tint of the chapter colour), a paragraph border and a rule below
    // in the chapter colour, so the duplicate must have all three recoloured (and the audit must look at them)
    const phSetup = await S(`var d=__resolveDocument(); var st=d.paragraphStyleGroups.itemByName('Regular set').paragraphStyleGroups.itemByName('Color Reset').paragraphStyles.itemByName('Part Heading');
var c=d.colors.itemByName(${JSON.stringify(FX.chapterColor)}); var t=null; var ts=d.tints; for (var i=0;i<ts.length;i++){ try{ if (ts[i].baseColor.id===c.id && Math.abs(ts[i].tintValue-30)<0.01) t=ts[i]; }catch(e){} }
if(!t){ try{ t=d.tints.add(c,{tintValue:30}); }catch(e){ t=d.tints.add({baseColor:c, tintValue:30}); } }
var o={ ok: st.isValid };
try{ st.paragraphShadingOn=true; st.paragraphShadingColor=t; o.shading=true; }catch(e){ o.shadingErr=String(e); }
try{ st.paragraphBorderOn=true; st.paragraphBorderColor=c; o.border=true; }catch(e){ o.borderErr=String(e); }
try{ st.ruleBelow=true; st.ruleBelowColor=c; o.rule=true; }catch(e){ o.ruleErr=String(e); }
__ok(o);`, { undoName: 'harness style colour setup' });
    rec(scn, 'setup: source Part Heading has shading (30% tint) + border + rule below in the chapter colour', phSetup && phSetup.ok && phSetup.shading && phSetup.border && phSetup.rule, phSetup);
    const dup = await T('theme_chapter', { ...thArgs, styles: [...thArgs.styles, { ...thArgs.styles[0], newName: 'Service Name Numbered B' }], dryRun: true });
    rec(scn, 'theme_chapter refuses the same source style listed twice', !dup.norm.success && /duplicates the same source/i.test(String(dup.norm.error)), { error: dup.norm.error });
    const th = await T('theme_chapter', thArgs, { timeoutMs: 600000 });
    const t = raw(th);
    scn.theme = { success: th.norm.success, error: th.norm.error, remapped: t.remapped, masterAfterSwap: t.masterAfterSwap, styleColourAudit: t.styleColourAudit, offColourItems: t.offColourItems, warnings: t.warnings };
    rec(scn, 'theme_chapter: running head remapped to "Running head 4" (remapped.characterRanges > 0)', th.norm.success && !!t.remapped && t.remapped.characterRanges > 0, scn.theme);
    rec(scn, 'theme_chapter: masterAfterSwap.styleDerivedRemaining == 0 and localRemaining == 0', th.norm.success && !!t.masterAfterSwap && Number(JSON.stringify(t.masterAfterSwap.styleDerivedRemaining).replace(/[^0-9]/g, '') || 0) === 0 && Number(JSON.stringify(t.masterAfterSwap.localRemaining).replace(/[^0-9]/g, '') || 0) === 0, scn.theme.masterAfterSwap);
    const rh = await S(`var m=__resolveDocument().masterSpreads.itemByName('4-Theme QA'); var o=[]; var it=m.textFrames; for (var i=0;i<it.length;i++){ var r=it[i].texts[0].textStyleRanges; for (var k=0;k<r.length;k++) o.push(String(r[k].appliedCharacterStyle.name)+'|'+String(r[k].contents).substr(0,25)); } __ok(o);`);
    rec(scn, 'new master text uses "Running head 4" for the chapter running head', rh.some((x) => /^Running head 4\|Chapter 4/.test(x)), { runs: rh });
    // design-r3-01: the duplicated Part Heading gets shading / border / rule colours of the new chapter; the source keeps the old ones
    const phc = await S(`var d=__resolveDocument();
function g(st){ var o={ valid: st.isValid }; if(!st.isValid) return o; var ps=['paragraphShadingColor','paragraphBorderColor','ruleBelowColor'];
 for (var i=0;i<ps.length;i++){ var v=null; try{ v=st[ps[i]]; }catch(e){ o[ps[i]]='ERR '+e; continue; } if(!v||typeof v!=='object'){ o[ps[i]]=String(v); continue; }
  var x=v; try{ var el=v.getElements(); if(el&&el.length) x=el[0]; }catch(e){} var r={ name:String(x.name), type:x.constructor.name }; try{ var b=x.baseColor; if(b){ r.base=String(b.name); r.tint=Number(x.tintValue); } }catch(e){} o[ps[i]]=r; }
 return o; }
var dupSt=d.paragraphStyleGroups.itemByName('Chapter 4').paragraphStyleGroups.itemByName('Color Reset').paragraphStyles.itemByName('Part Heading');
var srcSt=d.paragraphStyleGroups.itemByName('Regular set').paragraphStyleGroups.itemByName('Color Reset').paragraphStyles.itemByName('Part Heading');
__ok({ dup: g(dupSt), src: g(srcSt) });`);
    const dS = (phc && phc.dup) || {}, sS = (phc && phc.src) || {};
    rec(scn, 'design-r3-01: duplicated Part Heading shading is a 30% tint of Pantone 298 C', !!dS.paragraphShadingColor && dS.paragraphShadingColor.base === 'Pantone 298 C' && Math.abs(Number(dS.paragraphShadingColor.tint) - 30) < 0.01, phc);
    rec(scn, 'design-r3-01: duplicated Part Heading border + rule below are Pantone 298 C', !!dS.paragraphBorderColor && dS.paragraphBorderColor.name === 'Pantone 298 C' && !!dS.ruleBelowColor && dS.ruleBelowColor.name === 'Pantone 298 C', phc);
    rec(scn, 'design-r3-01: source Part Heading keeps the chapter colour (shading base, border, rule)', !!sS.paragraphShadingColor && sS.paragraphShadingColor.base === FX.chapterColor && !!sS.paragraphBorderColor && sS.paragraphBorderColor.name === FX.chapterColor && !!sS.ruleBelowColor && sS.ruleBelowColor.name === FX.chapterColor, phc);
    const scProps = ((t.styleColours || {}).props || []).filter((r) => /Part Heading/.test(r.style));
    rec(scn, 'design-r3-01: styleColours lists the Part Heading shading/border/rule as target colour; styleColourAudit has no Part Heading entry',
      ['paragraphShadingColor', 'paragraphBorderColor', 'ruleBelowColor'].every((p) => scProps.some((r) => r.prop === p && r.state === 'target')) && !(t.styleColourAudit || []).some((a) => /Part Heading/.test(a.style) && !/not duplicated/.test(a.prop)),
      { styleColours: scProps, styleColourAudit: t.styleColourAudit });
    rec(scn, 'qa-r3-02: theme_chapter created the 30% tint of Pantone 298 C for the shading (tintsCreated), no style write failures',
      ((t.swap || {}).tintsCreated || []).some((x) => x.baseColor === 'Pantone 298 C' && Math.abs(x.tintValue - 30) < 0.01) && !(t.mismatches || []).some((m) => m.type === 'styleColourWriteFailed'), { tintsCreated: (t.swap || {}).tintsCreated, mismatches: t.mismatches });
    // r4-B1 / F2: real-run regression — the duplicates' paragraph-only colours are read, swapped and reported
    const pnc = await S(`var d=__resolveDocument(); var g=d.paragraphStyleGroups.itemByName('Chapter 4').paragraphStyleGroups.itemByName('Color Reset');
function nm(v){ if(!v||typeof v!=='object') return String(v); var x=v; try{ var el=v.getElements(); if(el&&el.length) x=el[0]; }catch(e){} var r={ name:String(x.name) }; try{ var b=x.baseColor; if(b&&typeof b==='object'){ r.base=String(b.name); r.tint=Number(x.tintValue); } }catch(e){} return r; }
var o={}; try{ o.pnShading=nm(g.paragraphStyles.itemByName('Provider Name').paragraphShadingColor); }catch(e){ o.pnErr=String(e); }
try{ o.phBorder=nm(g.paragraphStyles.itemByName('Part Heading').paragraphBorderColor); }catch(e){ o.phErr=String(e); }
__ok(o);`);
    rec(scn, 'r4-B1: after the real run, duplicated Provider Name shading == toSwatch and Part Heading border == toSwatch', !!pnc && !!pnc.pnShading && pnc.pnShading.name === 'Pantone 298 C' && !!pnc.phBorder && pnc.phBorder.name === 'Pantone 298 C', pnc);
    const sChanges = ((t.swap || {}).styleChanges || []);
    rec(scn, 'r4-B1: swap.styleChanges lists Provider Name paragraphShadingColor and Part Heading paragraphBorderColor',
      sChanges.some((c) => /Provider Name/.test(c.style) && c.prop === 'paragraphShadingColor') && sChanges.some((c) => /Part Heading/.test(c.style) && c.prop === 'paragraphBorderColor'), { styleChanges: sChanges });
    // 4 paragraph styles x 13 colour attrs + 1 character style x 6 (F2: paragraph styles got the 6 character attrs only -> 24/30)
    const nP = thArgs.styles.filter((s) => s.styleType === 'paragraph').length, nC = thArgs.styles.filter((s) => s.styleType === 'character').length;
    const sc = t.styleColours || {};
    rec(scn, 'F2: styleColours.checked covers all paragraph-style colour attributes (13 per paragraph style, 6 per character style), nothing unreadable',
      Number(sc.checked) + ((sc.unreadable || []).length) === nP * 13 + nC * 6 && (sc.unreadable || []).length === 0, { checked: sc.checked, expected: nP * 13 + nC * 6, unreadable: sc.unreadable });
    rec(scn, 'F2: styleColours lists target rows for the swapped props (source/target rows are not dropped as neutral)',
      (sc.props || []).some((r) => r.state === 'target' && /Provider Name/.test(r.style) && r.prop === 'paragraphShadingColor') && !(sc.props || []).some((r) => r.state === 'source'), { props: sc.props });
    rec(scn, 'r4-B1: no styleColourUnreadable / styleColourNotSwapped mismatches', !(t.mismatches || []).some((m) => m.type === 'styleColourUnreadable' || m.type === 'styleColourNotSwapped'), { mismatches: t.mismatches });
    rec(scn, 'design-r3-02: short running-head replacement reports no textReplace overset mismatch', th.norm.success && !(t.mismatches || []).some((m) => m.type === 'textReplaceOverset') && Array.isArray((t.masterAfterSwap || {}).oversetFrames), { mismatches: t.mismatches, oversetFrames: (t.masterAfterSwap || {}).oversetFrames });
    const u = await T('undo', { expectUndoName: 'theme_chapter' });
    rec(scn, 'one undo removes the themed chapter', u.norm.success && raw(u).undone === true, { undo: raw(u), error: u.norm.error });
  });

  // ── 31: design-r3-02 textReplace that oversets the running head on the duplicated master ──
  await scenario(31, 'design-r3-02 duplicate_master_spread textReplace overset: default rolls back (text + formatting) and reports the frame; keep reports it', 900000, async (scn) => {
    await freshCopy();
    const FIND = 'Chapter 1: Access to Finance';
    const LONG = 'Chapter 5: ' + 'A very long running head that cannot fit on one line '.repeat(12).trim();
    const rhInfo = (masterName) => S(`var m=__resolveDocument().masterSpreads.itemByName(${JSON.stringify(masterName)}); var o={ valid: m.isValid, frames: [] }; if (m.isValid){ var tf=m.textFrames;
for (var i=0;i<tf.length;i++){ var s=tf[i].parentStory, txt=String(s.contents); if (txt.indexOf(${JSON.stringify(FIND)})<0 && txt.indexOf('Chapter 5:')<0) continue; var p=txt.indexOf(${JSON.stringify(FIND)}); var f=null;
 if (p>=0){ var r=s.characters.itemByRange(p, p+${FIND.length - 1}); var cs=r.characters.everyItem().appliedCharacterStyle, fs=r.characters.everyItem().fontStyle, sz=r.characters.everyItem().pointSize; f={ cs: [], fs: [], sz: [] }; for (var k=0;k<cs.length;k++){ f.cs.push(String(cs[k].name)); f.fs.push(String(fs[k])); f.sz.push(Number(sz[k])); } }
 o.frames.push({ id: tf[i].id, overflows: s.overflows, text: txt.substr(0,80), fmt: f }); } }
__ok(o);`);
    const src = await rhInfo('1-Access to Finance');
    rec(scn, 'source master has a running head frame with the chapter text, not overset', src.valid && src.frames.length > 0 && src.frames.every((f) => f.overflows === false), src);
    const a = await T('duplicate_master_spread', { sourceName: '1-Access to Finance', newNamePrefix: 'QO', newBaseName: 'Overset QA', textReplace: [{ find: FIND, replace: LONG }] });
    const ad = raw(a);
    const mmA = (ad.mismatches || []).filter((m) => m.type === 'textReplaceOverset');
    scn.rollback = { success: a.norm.success, error: a.norm.error, mismatches: ad.mismatches, replacements: ad.replacements, warnings: ad.warnings };
    rec(scn, 'default: mismatch textReplaceOverset with action rolledBack naming the frame and text', a.norm.success && mmA.length > 0 && mmA.every((m) => m.action === 'rolledBack' && m.frameId && typeof m.text === 'string' && m.text.length > 0), scn.rollback);
    rec(scn, 'default: a warning names the frame and says the replacement was rolled back', (ad.warnings || []).some((w) => /textReplace mismatch/.test(w) && /rolled back/.test(w) && /frame \d+/.test(w)), ad.warnings);
    rec(scn, 'r4-B2: no default-run warning claims the replacement was kept ("keep")', !(ad.warnings || []).some((w) => /textReplace mismatch/.test(w) && /kept because/.test(w)), ad.warnings);
    rec(scn, 'default: replacements[0].rolledBack > 0 and count excludes rolled-back matches', !!ad.replacements && ad.replacements[0].rolledBack > 0 && ad.replacements[0].count === 0, ad.replacements);
    const aft = await rhInfo('QO-Overset QA');
    const sf = src.frames.find((f) => f.fmt) || {}, af = aft.frames.find((f) => f.fmt) || {};
    rec(scn, 'default: new master running head is back to the original text and NOT overset', aft.valid && aft.frames.length > 0 && aft.frames.every((f) => f.overflows === false && f.text.indexOf('Chapter 5:') < 0) && !!af.fmt, aft);
    rec(scn, 'default: rolled-back text keeps the per-character formatting of the source (char style, font style, size)', !!sf.fmt && !!af.fmt && JSON.stringify(sf.fmt) === JSON.stringify(af.fmt), { src: sf.fmt, after: af.fmt });
    const u1 = await T('undo', { expectUndoName: 'duplicate_master_spread' });
    rec(scn, 'undo removes the rolled-back duplicate', u1.norm.success && raw(u1).undone === true, { undo: raw(u1), error: u1.norm.error });
    const b = await T('duplicate_master_spread', { sourceName: '1-Access to Finance', newNamePrefix: 'QK', newBaseName: 'Overset Keep', textReplace: [{ find: FIND, replace: LONG }], textReplaceOverset: 'keep' });
    const bd = raw(b);
    const mmB = (bd.mismatches || []).filter((m) => m.type === 'textReplaceOverset');
    rec(scn, 'keep: mismatch reported with action kept (frame named), replacement stays', b.norm.success && mmB.length > 0 && mmB.every((m) => m.action === 'kept' && m.frameId) && bd.replacements[0].count > 0, { mismatches: bd.mismatches, replacements: bd.replacements, error: b.norm.error });
    rec(scn, 'r4-B2: keep run warning says "kept because" and not "rolled back"', (bd.warnings || []).some((w) => /textReplace mismatch/.test(w) && /kept because/.test(w)) && !(bd.warnings || []).some((w) => /textReplace mismatch/.test(w) && /rolled back/.test(w)), bd.warnings);
    const u2 = await T('undo', { expectUndoName: 'duplicate_master_spread' });
    rec(scn, 'undo removes the kept duplicate', u2.norm.success && raw(u2).undone === true, { undo: raw(u2), error: u2.norm.error });
    const bad = await T('duplicate_master_spread', { sourceName: '1-Access to Finance', newNamePrefix: 'QX', newBaseName: 'X', textReplaceOverset: 'maybe', dryRun: true });
    rec(scn, 'invalid textReplaceOverset is refused', !bad.norm.success && /textReplaceOverset/.test(String(bad.norm.error)), { error: bad.norm.error });
  });

  // ── 30: qa-r2-05 in-script Downloads guard (read-only probe) ──
  await scenario(30, 'qa-r2-05 in-script write guard: __mcpIsWritablePath refuses Downloads, accepts the run copy (default roots)', 300000, async (scn) => {
    const r = await S(`__ok({ dl: __mcpIsWritablePath('C:\\\\Users\\\\Litoondev\\\\Downloads\\\\Brac\\\\x.indd'), dlBlocked: !!__mcpDownloadsBlocked('C:\\\\Users\\\\Litoondev\\\\Downloads\\\\Brac\\\\x.indd'), copy: __mcpIsWritablePath(${JSON.stringify(DOC)}), allowed: __MCP_DOWNLOADS_ALLOWED.length });`);
    scn.guard = r;
    rec(scn, 'Downloads path not writable and blocked in-script; run copy writable; no Downloads roots configured', r.dl === false && r.dlBlocked === true && r.copy === true && r.allowed === 0, r);
  });
}
