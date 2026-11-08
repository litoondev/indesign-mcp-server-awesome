#!/usr/bin/env node
// BRAC InDesign MCP live test harness — targets the v06 TEMPLATE book.
// Usage:  node tests/harness/run.mjs <label> [--only=1,2,5] [--keep-open] [--master=test_fixtures/<file>.indd]
// Copies test_fixtures/BRAC_TEST_MASTER.indd (a copy of "BRAC Referral Directory Book 06.indd") ->
// test_fixtures/runs/<label>.indd, opens ONLY the copy, runs the scenarios through the same MCP dispatch
// path as src/index.ts (worker.mjs -> invokeTool), writes test_output/runs/<label>/results.json + JPEGs,
// then closes the copy without saving. The master itself is never opened or saved.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ToolClient } from './client.mjs';
import * as C from './checks.mjs';
import { regressionR2 } from './regress_r2.mjs';
import { regressionR3 } from './regress_r3.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const masterArg = process.argv.find((a) => a.startsWith('--master='));
const MASTER = masterArg ? path.resolve(ROOT, masterArg.slice(9)) : path.join(ROOT, 'test_fixtures', 'BRAC_TEST_MASTER.indd');
if (path.dirname(MASTER).toLowerCase() !== path.join(ROOT, 'test_fixtures').toLowerCase() || !/\.indd$/i.test(MASTER)) {
  console.error('--master must be an .indd directly inside test_fixtures/'); process.exit(2);
}
// v05 (930 MB, wrong book) must never be used again.
if (/v05/i.test(path.basename(MASTER)) || fs.statSync(MASTER).size > 100 * 1024 * 1024) {
  console.error(`REFUSING: ${MASTER} is the v05 book (or > 100 MB). The harness only runs on the v06 template book.`); process.exit(2);
}
const label = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
if (!/^[A-Za-z0-9_.-]+$/.test(label)) { console.error('label must be [A-Za-z0-9_.-]'); process.exit(2); }
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.slice(7).split(',')) : null;
const KEEP_OPEN = process.argv.includes('--keep-open');

const RUN_DIR = path.join(ROOT, 'test_fixtures', 'runs');
const COPY = path.join(RUN_DIR, `${label}.indd`);
const DOC = COPY; // document_id = full path (unambiguous)
const OUT = path.join(ROOT, 'test_output', 'runs', label);
const DOCX_DIR = path.join(ROOT, 'content', 'v06_docx');
const DOCX_FIN = path.join(DOCX_DIR, 'Chapter 06 - Access to Financial Services (2)_Phone Numbers Checked.docx');
const DOCX_WOMEN = path.join(DOCX_DIR, 'Chapter 01 - Access to Women & Child Care & Family Support Services (5)_Phone Numbers Checked.docx');

// ── v06 fixture facts (verified on a copy of BRAC Referral Directory Book 06.indd) ──
const FX = {
  pageCount: 25,
  pageSizeIn: [6, 9],
  opener: { pageIndex: 12, pageName: 'XIII', master: 'A-Parent', rectId: 49496, rectFill: 'Pantone 7498 C', titleFrame: 49996, titleStory: 49978, descFrame: 51009, descStory: 50991 },
  chapterMaster: '1-Access to Finance',
  chapterColor: 'Pantone 7498 C',
  contentPages: [13, 23], // names 02..12
  pkb: { storyId: 5846, firstFrame: 5864, secondFrame: 46588, pages: [13, 14], bgFrame: 5887, lastTemplatePara: 33 },
  reint: { storyId: 51733, frames: [51730, 51765], pages: [22, 23], stressPara: 31 },
  ch2Opener: { pageIndex: 24, master: 'B-Blank', rectId: 51998 },
  styleIds: { partHeading: 46572, providerName: 42373, regular: 28407, paraHeading: 42296, serviceName: 51377, colonBullets: 42932, numbers: 52088, contactInfo: 49556, chapterNumber: 42124, chapterName: 52089 },
  skillStyleNames: ['Body Description Colon Bullets ', 'Service Name Numbered', 'Contact info', 'Provider Name', 'Part Heading', 'Paragraph Heading', 'Body Description Numbers'],
  missingLinks: 3,
};
// Template paragraphs of the PKB entry (story 5846, paragraphs 0..33) — first characters, for the structure guard.
const PKB_EXPECT = ['A ∙ Safe Migration', 'Probashi Kallyan Bank (PKB)', 'Probashi Kallyan Bank (PKB) is', 'Service/s', 'Migration Loan without Collateral:', 'Other Services:', 'Eligibility Criteria', 'Nationality:', 'Age:', 'Income Source:', 'Status:', 'Documents Requirement', 'Application form', '04 passport', 'A photocopy of the passport', 'Photographs and identity', 'Three signed bank', 'A bank account', 'Various Relevant Information', 'Loan Limit:', 'Loan Term:', 'Repayment Schedule:', 'Interest Rate:', 'Service Delivery Time:', 'Process to Get Service', 'Submit the application', 'Contact Information', '\uFFFC\tProbashi Kallyan Bhaban', '\uFFFC\twww.pkb.gov.bd', '\uFFFC\tinfo@pkb.gov.bd', '\uFFFC\t+88 02 48322873', 'Probashi Kallyan Bank Branches', '\u0016', '\u0016'];

fs.mkdirSync(OUT, { recursive: true });
const logLines = [];
const LIVE_LOG = path.join(OUT, 'harness.log');
fs.writeFileSync(LIVE_LOG, '');
const log = (s) => { logLines.push(s); try { fs.appendFileSync(LIVE_LOG, s + '\n'); } catch {} try { console.log(s); } catch {} };
const client = new ToolClient({ bridgeTimeout: 900000, defaultCallTimeout: 600000, log });

const results = { label, startedAt: new Date().toISOString(), copy: COPY, outDir: OUT, scenarios: [], mismatchNotes: [], toolCalls: null };
const state = {};

function rec(scn, name, pass, detail, extra = {}) {
  scn.checks.push({ name, pass: !!pass, detail, ...extra });
  log(`    ${pass ? 'PASS' : 'FAIL'} ${name}${pass ? '' : ' :: ' + JSON.stringify(detail).slice(0, 600)}`);
}
const same = (a, b) => path.normalize(String(a || '')).toLowerCase() === path.normalize(String(b || '')).toLowerCase();

async function assertOnlyCopyOpen() {
  const l = await client.call('list_open_documents', {});
  const docs = Array.isArray(l.norm.data) ? l.norm.data : [];
  const others = docs.filter((d) => !same(d.fullName, COPY));
  if (others.length) throw new Error(`SAFETY: other documents are open (${others.map((d) => d.fullName || d.name).join('; ')}); refusing to continue`);
  if (!docs.some((d) => same(d.fullName, COPY))) throw new Error('SAFETY: the run copy is not open');
}
/** Every tool call carries document_id = the copy's full path; we still re-check nothing else is open. */
async function T(name, args = {}, opts = {}) {
  await assertOnlyCopyOpen();
  return client.call(name, { document_id: DOC, ...args }, opts);
}
const S = (code, opts = {}) => client.script(code, { docName: DOC, ...opts });

/** Close the run copy (no save), re-copy the pristine v06 master over it and open it again. */
async function freshCopy() {
  if (state.opened) {
    const cl = await client.call('close_document', { document_id: DOC, save: 'no' }, { timeoutMs: 600000 });
    if (!cl.norm.success) throw new Error('freshCopy: could not close the run copy: ' + cl.norm.error);
    state.opened = false;
  }
  const l = await client.call('list_open_documents', {});
  const open = Array.isArray(l.norm.data) ? l.norm.data : [];
  if (open.length) throw new Error(`SAFETY: other documents are open (${open.map((d) => d.fullName || d.name).join('; ')})`);
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.copyFileSync(MASTER, COPY);
  const o = await client.call('open_document', { filePath: COPY }, { timeoutMs: 600000 });
  if (!o.norm.success) throw new Error('freshCopy: open failed: ' + o.norm.error);
  state.opened = true;
  await assertOnlyCopyOpen();
}

async function scenario(id, name, timeoutMs, fn) {
  if (ONLY && !ONLY.has(String(id))) return;
  const scn = { id, name, passed: false, durationMs: 0, checks: [], detail: '' };
  results.scenarios.push(scn);
  log(`\n=== Scenario ${id}: ${name}`);
  const t0 = Date.now();
  let timer;
  try {
    await Promise.race([
      fn(scn),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`SCENARIO TIMEOUT after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
    scn.passed = scn.checks.length > 0 && scn.checks.every((c) => c.pass);
  } catch (e) {
    scn.passed = false;
    scn.error = String(e && e.message || e);
    if (e && e.call) scn.errorCall = { name: e.call.name, ms: e.call.ms, error: e.call.norm.error };
    log(`    ERROR ${scn.error}`);
  } finally {
    clearTimeout(timer);
    scn.durationMs = Date.now() - t0;
    scn.detail = scn.error ? scn.error : scn.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${JSON.stringify(c.detail).slice(0, 400)}`).join(' | ') || 'all checks passed';
    log(`    -> ${scn.passed ? 'PASSED' : 'FAILED'} in ${scn.durationMs}ms`);
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  }
}

// ── content source (DOCX via the parse_content_file tool) ──
async function parseDocx(file) {
  const r = await client.call('parse_content_file', { filePath: file });
  if (!r.norm.success) throw new Error('parse_content_file failed: ' + r.norm.error);
  return r.norm.data;
}
const clean = (s) => String(s).replace(/\s+$/, '').replace(/^\s+/, '');
function pkbSource(paras) {
  const T_ = paras.map((p) => clean(p.text));
  const at = (re, from = 0) => { const i = T_.findIndex((t, k) => k >= from && re.test(t)); if (i < 0) throw new Error('source marker not found: ' + re); return i; };
  const iSP = at(/^Service Provider$/), iName = at(/^Probashi Kallyan Bank \(PKB\)$/, iSP), iObj = at(/^Objectives?$/, iName);
  const iTypes = at(/^Types? of Services?$/, iObj), iElig = at(/^Eligibility Criteria$/, iTypes), iProc = at(/^Procedure (of|to) Access Service$/, iElig);
  const iContact = at(/^Contact Address/, iProc), iBranch = at(/^All Branch Address$/, iContact);
  const sl = (a, b) => T_.slice(a, b).filter(Boolean);
  const contact = sl(iContact + 1, iBranch);
  return {
    partHeading: T_[at(/^Financial Solutions for Potential Migrants$/)], group: T_[at(/^Government Services$/)],
    serviceProviderLabel: T_[iSP], name: T_[iName], objectiveLabel: T_[iObj],
    objective: sl(iObj + 1, iTypes), typesHeading: T_[iTypes], services: sl(iTypes + 1, iElig),
    eligHeading: T_[iElig], elig: sl(iElig + 1, iProc), procHeading: T_[iProc], proc: sl(iProc + 1, iContact),
    contactHeading: T_[iContact], contact, branchHeading: T_[iBranch], all: sl(iSP, iBranch + 1),
  };
}
const splitLV = (t) => { const i = t.indexOf(':'); return i > 0 && i < 60 && !/^https?$/i.test(t.slice(0, i)) ? { label: t.slice(0, i), value: t.slice(i + 1).trim() } : null; };

/** Build the PKB replacement plan: template paragraph index -> edit (or 'keep' / 'delete'). */
function pkbPlan(src) {
  if (src.services.length !== 3 || src.elig.length !== 10 || src.proc.length !== 4 || src.contact.length !== 5) throw new Error('PKB source shape changed: ' + JSON.stringify({ s: src.services.length, e: src.elig.length, p: src.proc.length, c: src.contact.length }));
  const lv = (t) => { const s = splitLV(t); return s ? { label: s.label, value: s.value } : { text: t }; };
  const stripLabel = (t) => t.replace(/^[A-Za-z ]+:\s*/, '');
  const plan = {
    0: { text: 'A ∙ ' + src.partHeading }, 1: { text: src.name }, 2: { text: src.objective.join('\r') }, 3: { text: src.typesHeading },
    4: { text: src.services[0] }, 5: { text: src.services.slice(1).join('\r') }, 6: { text: src.eligHeading },
    7: lv(src.elig[0]), 8: lv(src.elig[1]), 9: lv(src.elig[2]), 10: lv(src.elig[3]),
    11: 'keep', 12: { text: src.elig[4] }, 13: { text: src.elig[5] }, 14: { text: src.elig[6] }, 15: { text: src.elig[7] }, 16: { text: src.elig[8] }, 17: 'delete',
    18: 'keep', 19: { text: src.elig[9] }, 20: 'delete', 21: 'delete', 22: 'delete', 23: 'delete',
    24: { text: src.procHeading }, 25: { text: src.proc.join('\r') }, 26: { text: src.contactHeading },
    // qa-r3: Contact info has GREP ".+(?<=:)" -> Bold, so any ':' would be bolded (design-r2-04 guard). Labels are dropped
    // (icons carry them) and the URL scheme is dropped (template convention www.../domain) — recorded as mismatch notes.
    27: { text: stripLabel((src.contact[0] + ' ' + src.contact[1]).trim()) }, // address (2 source lines -> 1 icon line)
    28: { text: stripLabel(src.contact[4]).replace(/^https?:\/\//i, '').replace(/\/$/, '') }, // web
    29: { text: stripLabel(src.contact[3]) }, // email
    30: { text: stripLabel(src.contact[2]) }, // phone
    31: { text: src.branchHeading }, 32: 'keep', 33: 'keep',
  };
  const notes = [
    `Page 02: mismatch — template has 2 "Service Name Numbered" slots, source has ${src.services.length} services; the 3rd is added as a new paragraph with the same style (no label:value in source, so whole service is the chapter-colour name)`,
    'Page 02: mismatch — source lists the 5 document items and the loan limit under "Eligibility Criteria"; template has separate "Documents Requirement" (6 slots) and "Various Relevant Information" (5 slots) sections. Headings kept, documents mapped 1:1, surplus template slots (1 document, 4 info bullets) removed',
    `Page 02: mismatch — source eligibility item 3 ("${src.elig[2].slice(0, 40)}…") has no "Label:"; it lands in a "Label: value" Colon-Bullets slot`,
    'Page 02: mismatch — source "Service Provider"/"Objectives" labels and the "Government Services" group heading have no slot in the template (not inserted)',
    'Page 03: mismatch — source contact block has 5 lines (address split over 2, labelled "Help Desk Number:/Email:/Website:") in order address,phone,email,web; template has 4 icon lines in order address,web,email,phone. Address joined to 1 line, labels dropped (icons carry them), lines placed in template order',
    'Page 03: branch table content is not in the DOCX; template tables left unchanged',
    'Page 03: source website is "https://pkb.gov.bd/" and the address starts with "Head Office:"; the Contact info GREP style (.+(?<=:) -> Bold) would bold everything up to a ":" (replace_paragraphs/replace_contact_block report this as a mismatch). Placed as "pkb.gov.bd" (scheme dropped) and the address without "Head Office:" — needs user confirmation',
  ];
  return { plan, notes };
}

const raw5 = (r) => (r && r.result && typeof r.result === 'object' && r.result.data !== undefined ? r.result.data : r && r.norm && r.norm.data) || {};
// paragraph font/colour at a paragraph-relative offset (inspectStory runs)
function runAt(p, off) { return p.runs.find((r) => off >= r.s && off < r.e) || null; }
function prefixLen(t) { let i = 0; while (i < t.length && (t[i] === '\uFFFC' || t[i] === '\t')) i++; return i; }
/** formatting of a replaced paragraph must equal its template paragraph (label/value pattern or uniform). */
function checkFormatPreserved(before, after, mode) {
  const problems = [];
  const bt = before.text.replace(/\r$/, ''), at_ = after.text.replace(/\r$/, '');
  const bp = prefixLen(bt), ap = prefixLen(at_);
  const b0 = runAt(before, bp), a0 = runAt(after, ap);
  if (!b0 || !a0) return { pass: false, detail: { i: after.i, problem: 'no runs', before: before.runs, after: after.runs } };
  // BRAC rule (effective, per-character formatting incl. GREP styles): "Label:" bold up to and including the colon,
  // value roman; a paragraph without a label is uniformly the template's value formatting (or its only formatting).
  const tLabel = splitLV(bt.slice(bp)) ? bt.indexOf(':') : -1;
  const tv = tLabel >= 0 ? (runAt(before, tLabel + 2) || b0) : b0;
  const nLabel = splitLV(at_.slice(ap)) ? at_.indexOf(':') : -1;
  const expectAt = (off) => (nLabel >= 0 && off <= nLabel && tLabel >= 0) ? b0 : tv;
  for (let off = ap; off < at_.length; off++) {
    if (/\s/.test(at_[off])) continue;
    const r = runAt(after, off), e = expectAt(off);
    if (!r) continue;
    if (nLabel >= 0 && tLabel < 0 && off <= nLabel) { if (!/Bold/.test(r.font)) { problems.push(`label char ${off} ${r.font} not bold`); break; } continue; }
    if (r.font !== e.font || r.color !== e.color) { problems.push(`char ${off} "${at_.slice(off, off + 12)}" ${r.font}/${r.color} != expected ${e.font}/${e.color}`); break; }
  }
  return { pass: problems.length === 0, detail: { i: after.i, text: at_.slice(0, 50), problems } };
}

async function oversetInfo(storyId) {
  return S(`var doc=__resolveDocument(); var s=doc.stories.itemByID(${Number(storyId)}); var tc=s.textContainers; var last=tc[tc.length-1];
var vis=0; for (var i=0;i<tc.length;i++) vis+=tc[i].characters.length;
__ok({ overflows: s.overflows, length: s.characters.length, visibleChars: vis, oversetChars: s.characters.length - vis, frames: tc.length });`);
}

// ════════════════════════════════ scenarios ════════════════════════════════
async function main() {
  // ── 1 connect / open copy / v06 fixture guard ──
  await scenario(1, 'connect + list_open_documents + open copy + v06 fixture guard', 900000, async (scn) => {
    const tools = await client.listTools();
    const need = ['replace_paragraphs', 'replace_contact_block', 'verify_page_invariants', 'continue_story', 'restore_backup', 'list_backups', 'probe_indesign', 'cascade_reflow', 'snapshot_document', 'backup_document', 'parse_content_file'];
    rec(scn, 'tool registry builds from dist and contains the new tools', tools.length > 100 && need.every((n) => tools.includes(n)), { toolCount: tools.length, missing: need.filter((n) => !tools.includes(n)) });
    const pr = await client.call('probe_indesign', {});
    rec(scn, 'probe_indesign', pr.norm.success, { ms: pr.ms, data: pr.norm.data, error: pr.norm.error });
    const lst = await client.call('list_open_documents', {});
    rec(scn, 'list_open_documents', lst.norm.success, { ms: lst.ms, docs: lst.norm.data });
    const open = Array.isArray(lst.norm.data) ? lst.norm.data : [];
    if (open.length) throw new Error(`SAFETY: other documents are open (${open.map((d) => d.fullName || d.name).join('; ')}). Close them before running the harness.`);

    fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.copyFileSync(MASTER, COPY);
    rec(scn, 'copy master -> run file', fs.existsSync(COPY) && fs.statSync(COPY).size === fs.statSync(MASTER).size, { copy: COPY, bytes: fs.statSync(COPY).size });
    results.master = { path: MASTER, bytes: fs.statSync(MASTER).size, mtime: fs.statSync(MASTER).mtime };

    const o = await client.call('open_document', { filePath: COPY }, { timeoutMs: 600000 });
    state.opened = true;
    rec(scn, 'open_document (copy) succeeds with no warning', o.norm.success && !(o.norm.data || {}).warning, { ms: o.ms, result: o.norm.data, error: o.norm.error });
    rec(scn, 'open_document finishes < 120s', o.ms < 120000, { ms: o.ms });
    const l2 = await client.call('list_open_documents', {});
    const me = (Array.isArray(l2.norm.data) ? l2.norm.data : []).find((d) => same(d.fullName, COPY));
    rec(scn, 'list_open_documents shows fullName + writable:true for the copy', !!(me && me.writable === true), { docs: l2.norm.data });
    const ga = await client.call('get_active_document', { document_id: DOC });
    rec(scn, 'get_active_document(document_id=path)', ga.norm.success && same(ga.norm.data && ga.norm.data.fullName, COPY), { error: ga.norm.error, data: ga.norm.data && ga.norm.data.fullName });

    const fp = await S(`var d=__resolveDocument();
function t(id){ var it=d.textFrames.itemByID(id); return it.isValid ? String(it.contents) : null; }
var pg=d.pages; var op=pg[${FX.opener.pageIndex}], c1=pg[${FX.pkb.pages[0]}];
var rect=d.rectangles.itemByID(${FX.opener.rectId});
var st=d.stories.itemByID(${FX.pkb.storyId});
var miss=0; for (var i=0;i<d.links.length;i++) if (d.links[i].status==LinkStatus.LINK_MISSING) miss++;
var cb=d.paragraphStyles.length, all=d.allParagraphStyles.length, names=[]; for (var k=0;k<d.allParagraphStyles.length;k++) names.push(d.allParagraphStyles[k].name);
var cbs=null; try { var x=d.allParagraphStyles; for (var q=0;q<x.length;q++) if (x[q].id==${FX.styleIds.colonBullets}) cbs={ font: x[q].appliedFont.name, fontStyle: String(x[q].fontStyle), nested: x[q].nestedStyles.length, grep: x[q].nestedGrepStyles.length }; } catch(e){}
__ok({ pages: pg.length, w: d.documentPreferences.pageWidth, h: d.documentPreferences.pageHeight, facing: d.documentPreferences.facingPages,
  openerName: op.name, openerMaster: op.appliedMaster ? op.appliedMaster.name : null, title: t(${FX.opener.titleFrame}), desc: (t(${FX.opener.descFrame})||'').substr(0,40),
  rectFill: rect.isValid ? rect.fillColor.name : null, c1Name: c1.name, c1Master: c1.appliedMaster ? c1.appliedMaster.name : null,
  pkbStart: st.isValid ? String(st.paragraphs[0].contents).substr(0,20) : null, bgFrame: d.textFrames.itemByID(${FX.pkb.bgFrame}).isValid,
  ch2Master: pg.length>${FX.ch2Opener.pageIndex} ? pg[${FX.ch2Opener.pageIndex}].appliedMaster.name : null, missingLinks: miss, topLevelParaStyles: cb, allParaStyles: all, styleNames: names, colonBulletsStyle: cbs,
  pkbOverflowsAtBaseline: st.overflows });`);
    state.fixture = fp;
    const fixtureOk = fp.pages === FX.pageCount && Math.abs(fp.w - 6) < 0.01 && Math.abs(fp.h - 9) < 0.01 && fp.facing === true && fp.openerName === FX.opener.pageName && fp.openerMaster === FX.opener.master &&
      fp.title === 'Chapter 1\rAccess to Finance' && fp.rectFill === FX.opener.rectFill && fp.c1Name === '02' && fp.c1Master === FX.chapterMaster &&
      fp.pkbStart === 'A ∙ Safe Migration\r' && fp.bgFrame && fp.ch2Master === FX.ch2Opener.master;
    rec(scn, 'fixture is the BRAC v06 template book (25 pages, 6x9, Chapter 1 opener XIII, PKB story, frame 5887)', fixtureOk, { ...fp, styleNames: undefined, master: results.master });
    if (!fixtureOk) throw new Error('FIXTURE MISMATCH: master is not the v06 template book. Refusing to run v06 scenarios.');
    rec(scn, `3 missing links (cover EPS + 2 PNG) are expected and left alone`, fp.missingLinks === FX.missingLinks, { missingLinks: fp.missingLinks });
    rec(scn, 'skill style names exist in doc.allParagraphStyles (incl. trailing-space name)', FX.skillStyleNames.every((n) => fp.styleNames.includes(n)), { missing: FX.skillStyleNames.filter((n) => !fp.styleNames.includes(n)), topLevel: fp.topLevelParaStyles, all: fp.allParaStyles });
    scn.baselineNotes = { pkbStoryOversetAtBaseline: fp.pkbOverflowsAtBaseline, colonBulletsStyle: fp.colonBulletsStyle };
    state.pkbOverset0 = await oversetInfo(FX.pkb.storyId);
    scn.pkbOverset0 = state.pkbOverset0;
  });

  // ── 2 backup / list / restore ──
  await scenario(2, 'backup_document + list_backups + restore_backup (refusals + real restore to a 2nd run file)', 1200000, async (scn) => {
    await assertOnlyCopyOpen();
    const b = await T('backup_document', { label: 'harness' }, { timeoutMs: 900000 });
    const bp = b.norm.data && b.norm.data.backupPath;
    rec(scn, 'backup_document returns success with backupPath', b.norm.success && !!bp, { ms: b.ms, data: b.norm.data, error: b.norm.error });
    rec(scn, 'backup file exists under test_output/_backups and is ~ the doc size', !!(bp && fs.existsSync(bp) && fs.statSync(bp).size > 1e6 && bp.toLowerCase().startsWith(path.join(ROOT, 'test_output', '_backups').toLowerCase())), { bp, size: bp && fs.existsSync(bp) ? fs.statSync(bp).size : null });
    const bt = await client.call('backup_document', { label: 'harness-target', document_id: 'NO_SUCH_DOC.indd' }, { timeoutMs: 300000 });
    rec(scn, 'backup_document with unknown document_id fails (targeting honoured)', !bt.norm.success && /not open|no document|not found/i.test(String(bt.norm.error)), { mcpText: String(bt.mcpText).slice(0, 400) });
    const lb = await client.call('list_backups', {});
    rec(scn, 'list_backups lists the new backup', lb.norm.success && (lb.norm.data.files || []).some((f) => same(f.path, bp)), { count: lb.norm.data && lb.norm.data.count, error: lb.norm.error });
    // refusals — all must happen in Node before any InDesign close/copy
    const rm = await client.call('restore_backup', { backupPath: bp, targetPath: MASTER });
    rec(scn, 'restore_backup refuses the pristine master as target', !rm.norm.success, { error: rm.norm.error });
    const outside = path.join(ROOT, '_qa_outside_roots', 'x.indd');
    const ro = await client.call('restore_backup', { backupPath: bp, targetPath: outside });
    rec(scn, 'restore_backup refuses a target outside the write roots', !ro.norm.success && !fs.existsSync(outside), { error: ro.norm.error });
    const l0 = await client.call('list_open_documents', {});
    rec(scn, 'refused restores did not close the run copy', (l0.norm.data || []).some((d) => same(d.fullName, COPY)), { docs: l0.norm.data });
    // real restore into a different run file, then close it again
    const RESTORED = path.join(RUN_DIR, `${label}_restored.indd`);
    if (fs.existsSync(RESTORED)) fs.unlinkSync(RESTORED);
    const rr = await client.call('restore_backup', { backupPath: bp, targetPath: RESTORED }, { timeoutMs: 600000 });
    rec(scn, 'restore_backup to a new run file opens it', rr.norm.success && same(rr.norm.data && rr.norm.data.fsName, RESTORED) && rr.norm.data.pageCount === FX.pageCount, { data: rr.norm.data, error: rr.norm.error });
    const cr = await client.call('close_document', { document_id: RESTORED, save: 'no' }, { timeoutMs: 300000 });
    rec(scn, 'restored file closed again', cr.norm.success, { error: cr.norm.error });
    await assertOnlyCopyOpen();
  });

  // ── 3 parse_content_file on the v06 DOCX sources ──
  await scenario(3, 'parse_content_file on the Chapter 06 (Financial) and Chapter 01 (Women & Child) DOCX copies', 300000, async (scn) => {
    const fin = await parseDocx(DOCX_FIN);
    rec(scn, 'Chapter 06 DOCX parses into paragraphs', fin.format === 'docx' && fin.paragraphCount > 300, { paragraphCount: fin.paragraphCount, warnings: fin.warnings });
    const src = pkbSource(fin.content);
    state.pkbSrc = src;
    scn.pkbSource = src;
    rec(scn, 'PKB block located (3 services, 10 eligibility items, 4 steps, 5 contact lines)', src.services.length === 3 && src.elig.length === 10 && src.proc.length === 4 && src.contact.length === 5, { services: src.services.length, elig: src.elig.length, proc: src.proc.length, contact: src.contact });
    const bad = fin.content.filter((p) => /\n/.test(p.text) && !p.isListItem).length;
    rec(scn, 'list items are separate paragraphs (no <li> merged into one)', fin.content.filter((p) => p.isListItem).length > 50, { listItems: fin.content.filter((p) => p.isListItem).length, multilineNonList: bad });
    const w = await parseDocx(DOCX_WOMEN);
    rec(scn, 'Chapter 01 DOCX parses', w.format === 'docx' && w.paragraphCount > 50, { paragraphCount: w.paragraphCount, first: w.content.slice(0, 3).map((p) => p.text.slice(0, 80)) });
    state.womenSrc = w.content;
    const dl = await client.call('parse_content_file', { filePath: path.join(DOCX_DIR, 'nonexistent_qa.docx') });
    rec(scn, 'parse_content_file reports a missing file cleanly', !dl.norm.success && /not found/i.test(String(dl.norm.error)), { error: dl.norm.error });
  });

  // ── 4 snapshot_document ──
  await scenario(4, 'snapshot_document pages 02-03 (1-based 14-15) + document_id targeting + limits', 900000, async (scn) => {
    await assertOnlyCopyOpen();
    const s = await T('snapshot_document', { pageRange: '14-15', includeCharFormatting: true }, { timeoutMs: 600000 });
    const d = s.norm.data || {};
    rec(scn, 'snapshot_document (2 pages, char formatting) succeeds', s.norm.success, { ms: s.ms, error: s.norm.error });
    rec(scn, 'snapshot returns parsed JSON object', s.norm.success && typeof s.result?.data === 'object', { typeofData: typeof s.result?.data, note: s.norm.note });
    rec(scn, 'snapshot of 2 pages completes < 30s', s.ms < 30000, { ms: s.ms });
    if (d.pages) {
      rec(scn, 'snapshot covers pages 02,03 with chapter master', d.pages.map((p) => p.name).join(',') === '02,03' && d.pages.every((p) => (p.master || p.appliedMaster || '').includes(FX.chapterMaster)), { pages: d.pages.map((p) => ({ name: p.name, master: p.master || p.appliedMaster, idx: p.pageIndex })) });
      const f = d.pages[0].frames.find((fr) => fr.id === FX.pkb.firstFrame);
      rec(scn, 'frame 5864 reported with storyId 5846, next 46588, and empty bg frame 5887 present', !!(f && f.storyId === FX.pkb.storyId && f.nextFrameId === FX.pkb.secondFrame && d.pages[0].frames.some((x) => x.id === FX.pkb.bgFrame)), { frame: f && { id: f.id, storyId: f.storyId, next: f.nextFrameId }, frames: d.pages[0].frames.map((x) => x.id) });
      const p7 = f && f.paragraphs.find((p) => p.storyParagraphIndex === 7);
      rec(scn, 'paragraph 7 "Nationality: ..." has storyParagraphIndex 7, style path and bold label detected', !!(p7 && /Nationality/.test(p7.text) && /Body Description Colon Bullets/.test(p7.style) && p7.label && p7.label.text === 'Nationality'), { p7 });
      const f2 = d.pages[1].frames.find((fr) => fr.id === FX.pkb.secondFrame);
      const ci = f2 && f2.paragraphs.filter((p) => /Contact info/.test(p.style));
      rec(scn, 'contact paragraphs on page 03 report anchoredCount 1 + tabCount 1', !!(ci && ci.length === 4 && ci.every((p) => p.anchoredCount === 1 && p.tabCount >= 1)), { ci: ci && ci.map((p) => ({ i: p.storyParagraphIndex, a: p.anchoredCount, t: p.tabCount, text: p.text.slice(0, 30) })) });
      const names = (d.paragraphStyles || []).map((x) => x.name);
      rec(scn, 'snapshot paragraphStyles uses allParagraphStyles (style groups)', FX.skillStyleNames.every((n) => names.includes(n)), { count: names.length, missing: FX.skillStyleNames.filter((n) => !names.includes(n)) });
      rec(scn, 'snapshot units are points', d.units === 'points' && Math.abs((d.pageSize || {}).width - 432) < 0.5, { units: d.units, pageSize: d.pageSize });
      state.snapshot = d;
    }
    const s2 = await client.call('snapshot_document', { pageRange: '14', includeCharFormatting: false, document_id: path.basename(COPY) }, { timeoutMs: 300000 });
    rec(scn, 'snapshot_document with document_id = copy name succeeds', s2.norm.success && same(s2.norm.data && s2.norm.data.filePath, COPY), { error: s2.norm.error, file: s2.norm.data && s2.norm.data.filePath });
    const s3 = await client.call('snapshot_document', { pageRange: '14', document_id: 'NO_SUCH_DOC.indd' }, { timeoutMs: 300000 });
    rec(scn, 'snapshot_document with unknown document_id fails', !s3.norm.success, { result: s3.norm.success ? `silently snapshotted "${s3.norm.data && s3.norm.data.documentName}"` : s3.norm.error });
    const s4 = await T('snapshot_document', { pageRange: '14-18' });
    rec(scn, 'snapshot_document refuses > 4 pages', !s4.norm.success, { error: s4.norm.error });
    const s5 = await T('snapshot_document', {});
    rec(scn, 'snapshot_document requires pageRange', !s5.norm.success, { error: s5.norm.error });
  });

  // ── 5 content replacement: PKB entry (Chapter 1 pages 02-03) from the Chapter 06 DOCX ──
  await scenario(5, 'content replacement: PKB entry (pages 02-03) with replace_paragraphs / replace_contact_block / verify_page_invariants', 2400000, async (scn) => {
    await assertOnlyCopyOpen();
    const pk = FX.pkb;
    const src = state.pkbSrc || pkbSource((await parseDocx(DOCX_FIN)).content);
    const { plan, notes } = pkbPlan(src);
    results.mismatchNotes.push(...notes);
    const pagesToInspect = [12, 13, 14, 15];

    // ── before ──
    const storyB = await C.inspectStory(client, DOC, pk.storyId);
    const geomB = await C.inspectPages(client, DOC, pagesToInspect);
    const ovB = await T('check_overset_text', {});
    const vB = await T('verify_page_invariants', { pageIndexes: pk.pages });
    rec(scn, 'verify_page_invariants baseline succeeds', vB.norm.success, { error: vB.norm.error, data: vB.norm.success ? undefined : vB.norm.data });
    scn.verifyBaseline = vB.norm.data;
    state.before5 = { storyB, geomB };
    scn.jpegsBefore = await C.exportPagesJpeg(client, DOC, pk.pages, OUT, 'before5');
    const layoutOk = storyB.paragraphs.length === 72 && PKB_EXPECT.every((t, i) => storyB.paragraphs[i].text.startsWith(t));
    rec(scn, 'template PKB entry has the expected 34-paragraph structure (story 72 paragraphs)', layoutOk, { count: storyB.paragraphs.length, mismatch: PKB_EXPECT.map((t, i) => storyB.paragraphs[i] && !storyB.paragraphs[i].text.startsWith(t) ? { i, want: t, got: storyB.paragraphs[i].text.slice(0, 30) } : null).filter(Boolean) });
    if (!layoutOk) throw new Error('fixture structure changed; update PKB_EXPECT');

    // 5a: negative / dry-run behaviour of replace_paragraphs (must not change anything)
    const textB = C.storyText(storyB);
    const neg = await T('replace_paragraphs', { storyId: pk.storyId, dryRun: true, edits: [
      { paragraphIndex: 3, text: 'X', expectStyleId: FX.styleIds.regular },
      { paragraphIndex: 6, label: 'Bad', value: 'no colon here' },
      { paragraphIndex: 999, text: 'missing' },
    ] });
    const mm = (neg.norm.data || {}).mismatches || [];
    rec(scn, 'replace_paragraphs dryRun reports expectStyleId / no-label / missing-paragraph mismatches', neg.norm.success && mm.length === 3 && ((neg.norm.data || {}).applied || []).length === 0, { mismatches: mm, applied: (neg.norm.data || {}).applied, error: neg.norm.error });
    const negA = await T('replace_paragraphs', { storyId: pk.storyId, keepLeadingAnchors: false, edits: [{ paragraphIndex: 27, text: 'icon would be deleted' }] });
    const mmA = (negA.norm.data || {}).mismatches || [];
    rec(scn, 'replace_paragraphs refuses to overwrite an anchored icon (keepLeadingAnchors:false)', negA.norm.success && mmA.length === 1 && /anchored/i.test(mmA[0].reason), { data: negA.norm.data, error: negA.norm.error });
    const storyN = await C.inspectStory(client, DOC, pk.storyId);
    rec(scn, 'negative/dry-run calls changed nothing', C.storyText(storyN) === textB && storyN.anchored === storyB.anchored, { lenBefore: textB.length, lenAfter: C.storyText(storyN).length });

    // 5b: contact block via replace_contact_block (one line per icon, template order)
    const contactLines = [
      { type: 'address', text: plan[27].text }, { type: 'web', text: plan[28].text },
      { type: 'email', text: plan[29].text }, { type: 'phone', text: plan[30].text },
    ];
    // design-r2-04 guard: the raw source lines (with "Head Office:" / "https:") must be reported, not written
    const rawLines = [{ type: 'address', text: src.contact[0] }, { type: 'web', text: src.contact[4].replace(/^[A-Za-z ]+:\s*/, '') }, contactLines[2], contactLines[3]];
    const rcbRaw = await T('replace_contact_block', { frameId: pk.secondFrame, lines: rawLines, dryRun: true });
    rec(scn, 'raw source contact lines with ":" are reported as GREP mismatches (address + web), nothing written', (raw5(rcbRaw).mismatches || []).some((m) => m.line === 0 && /GREP|nested/.test(m.reason)), { mismatches: (raw5(rcbRaw).mismatches || []).map((m) => ({ line: m.line, reason: String(m.reason).slice(0, 80) })) });
    const rcbDry = await T('replace_contact_block', { frameId: pk.secondFrame, lines: contactLines, dryRun: true });
    const rcbD = rcbDry.norm.data || {};
    scn.replaceContactBlockDryRun = rcbD;
    rec(scn, 'replace_contact_block can address the PKB contact block (4 icon lines) inside the threaded story', rcbDry.norm.success && (rcbD.templateTypes || []).length === 4 && (rcbD.mismatches || []).length === 0,
      { error: rcbDry.norm.error, structure: rcbD.structure, templateTypes: rcbD.templateTypes, templateLines: (rcbD.templateLines || []).map((l) => l.text.slice(0, 30)), mismatches: rcbD.mismatches });
    let contactViaBlock = false;
    if (rcbDry.norm.success && (rcbD.mismatches || []).length === 0) {
      const rcb = await T('replace_contact_block', { frameId: pk.secondFrame, lines: contactLines });
      contactViaBlock = rcb.norm.success && rcb.norm.data && rcb.norm.data.applied;
      rec(scn, 'replace_contact_block applies', contactViaBlock, { data: rcb.norm.data, error: rcb.norm.error });
    }

    // 5c: replace_paragraphs with the full plan (dry run first)
    const edits = [];
    for (const [k, v] of Object.entries(plan)) {
      if (v === 'keep' || v === 'delete') continue;
      const i = Number(k);
      if (contactViaBlock && i >= 27 && i <= 30) continue;
      edits.push({ paragraphIndex: i, expectStyleId: storyB.paragraphs[i].styleId, ...v });
    }
    const dry = await T('replace_paragraphs', { storyId: pk.storyId, edits, dryRun: true });
    rec(scn, 'replace_paragraphs dryRun accepts the whole plan (no mismatches)', dry.norm.success && (dry.norm.data.mismatches || []).length === 0 && dry.norm.data.applied.length === edits.length, { mismatches: dry.norm.data && dry.norm.data.mismatches, applied: dry.norm.data && dry.norm.data.applied && dry.norm.data.applied.length, error: dry.norm.error });
    const textBeforeRep = C.storyText(await C.inspectStory(client, DOC, pk.storyId)); // after replace_contact_block, before replace_paragraphs
    const t5 = Date.now();
    const rep = await T('replace_paragraphs', { storyId: pk.storyId, edits }, { timeoutMs: 600000 });
    const rd = rep.norm.data || {};
    scn.replaceResult = { ms: Date.now() - t5, mismatches: rd.mismatches, styleErrors: rd.styleErrors, anchorsBefore: rd.anchorsBefore, anchorsAfter: rd.anchorsAfter, storyOverflows: rd.storyOverflows, added: (rd.applied || []).filter((a) => a.paragraphsAdded).map((a) => [a.paragraphIndex, a.paragraphsAdded]) };
    rec(scn, 'replace_paragraphs applies the plan in one call, anchors unchanged, no style errors', rep.norm.success && (rd.mismatches || []).length === 0 && (rd.styleErrors || []).length === 0 && rd.anchorsBefore === rd.anchorsAfter, { ...scn.replaceResult, error: rep.norm.error });
    rec(scn, 'replace_paragraphs reports paragraphsAdded for \\r-split edits (5:+1, 25:+3)', JSON.stringify(scn.replaceResult.added) === JSON.stringify([[5, 1], [25, 3]]), scn.replaceResult.added);

    // 5d: single-step undo / redo of replace_paragraphs
    const afterEditText = C.storyText(await C.inspectStory(client, DOC, pk.storyId));
    const u = await T('undo', {});
    const textU = C.storyText(await C.inspectStory(client, DOC, pk.storyId));
    rec(scn, 'one undo reverts the whole replace_paragraphs call', u.norm.success && textU === textBeforeRep, { error: u.norm.error, undoData: u.norm.data, lenBeforeReplace: textBeforeRep.length, lenAfterUndo: textU.length });
    const rdo = await T('redo', {});
    const textR = C.storyText(await C.inspectStory(client, DOC, pk.storyId));
    rec(scn, 'redo re-applies it', rdo.norm.success && textR === afterEditText, { error: rdo.norm.error, lenEdited: afterEditText.length, lenAfterRedo: textR.length });
    if (textR !== afterEditText) throw new Error('redo did not restore the edit; aborting scenario');

    // 5e: remove surplus template paragraphs with replace_paragraphs {delete:true, expectText} (new in round 1)
    const added = { 5: 1, 25: 3 };
    const post = (i) => i + Object.entries(added).filter(([k]) => Number(k) < i).reduce((a, [, v]) => a + v, 0);
    const dels = Object.entries(plan).filter(([, v]) => v === 'delete').map(([k]) => Number(k))
      .map((i) => ({ paragraphIndex: post(i), delete: true, expectText: storyB.paragraphs[i].text.replace(/\r$/, '').slice(0, 40) }));
    const delR = await T('replace_paragraphs', { storyId: pk.storyId, edits: dels });
    const delD = delR.norm.data || {};
    rec(scn, 'surplus template paragraphs removed with replace_paragraphs delete (17, 20-23)', delR.norm.success && (delD.mismatches || []).length === 0 && (delD.applied || []).filter((a) => a.kind === 'delete').length === dels.length && (delD.overrideErrors || []).length === 0, { edits: dels, mismatches: delD.mismatches, applied: delD.applied, overrideErrors: delD.overrideErrors, error: delR.norm.error });

    // ── after ──
    const storyA = await C.inspectStory(client, DOC, pk.storyId);
    const geomA = await C.inspectPages(client, DOC, pagesToInspect);
    state.after5 = { storyA, geomA };
    scn.jpegsAfter = await C.exportPagesJpeg(client, DOC, pk.pages, OUT, 'after5');
    const vA = await T('verify_page_invariants', { pageIndexes: pk.pages, baseline: vB.norm.data });
    scn.verifyAfter = vA.norm.data;
    rec(scn, 'verify_page_invariants (vs baseline) succeeds', vA.norm.success, { error: vA.norm.error, data: vA.norm.success ? undefined : vA.norm.data });
    const vd = vA.norm.data || {}, vb = vB.norm.data || {};
    const sumA = vd.summary || [], sumB = vb.summary || [];
    const diffProblems = ((vd.baselineDiff || {}).problems || []).filter((p) => !/style sequence changed/.test(p)); // sequence change is expected (planned)
    const vBad = sumA.filter((s, k) => s.placeholderHits > 0 || s.textOutsideMargins > 0 || s.overlaps > ((sumB[k] || {}).overlaps || 0) || s.oversetStories > ((sumB[k] || {}).oversetStories || 0));
    rec(scn, 'verify_page_invariants vs baseline: no placeholder, margin, NEW overlap/overset problems; only the planned style-sequence change', vA.norm.success && vBad.length === 0 && diffProblems.length === 0, { summaryAfter: sumA, summaryBefore: sumB, diffProblems });

    // expected paragraph sequence (template index per resulting paragraph)
    const seq = [];
    for (let i = 0; i <= pk.lastTemplatePara; i++) {
      const v = plan[i]; if (v === 'delete') continue;
      const n = v === 'keep' ? 1 : (v.text !== undefined ? v.text.split('\r').length : 1);
      for (let k = 0; k < n; k++) seq.push({ t: i, mode: v === 'keep' ? 'keep' : v.label !== undefined ? 'labelValue' : 'text', k });
    }
    for (let i = pk.lastTemplatePara + 1; i < storyB.paragraphs.length; i++) seq.push({ t: i, mode: 'keep', k: 0 });
    const P = storyA.paragraphs;
    rec(scn, 'resulting paragraph count matches the plan', P.length === seq.length, { got: P.length, expected: seq.length });
    const styleBad = [], fmtBad = [];
    for (let j = 0; j < Math.min(P.length, seq.length); j++) {
      const tp = storyB.paragraphs[seq[j].t];
      if (P[j].styleId !== tp.styleId) styleBad.push({ j, text: P[j].text.slice(0, 40), style: P[j].style, expected: tp.style });
      if (seq[j].mode !== 'keep' && seq[j].t !== 28 && tp.styleId !== FX.styleIds.serviceName) { const f = checkFormatPreserved(tp, P[j], seq[j].mode); if (!f.pass) fmtBad.push(f.detail); } // 28 = web line, recorded mismatch (https:)
    }
    rec(scn, 'each resulting paragraph keeps the paragraph style of its template paragraph', styleBad.length === 0, { mismatches: styleBad });
    // paragraph-level local overrides (list numbering restart) must survive: first "Documents Requirement" item restarts at 1
    const ncBad = [];
    for (let j = 0; j < Math.min(P.length, seq.length); j++) {
      const tp = storyB.paragraphs[seq[j].t];
      if (seq[j].k === 0 && (P[j].numberingContinue !== tp.numberingContinue || P[j].numberingStartAt !== tp.numberingStartAt)) ncBad.push({ j, text: P[j].text.slice(0, 40), numberingContinue: P[j].numberingContinue, template: tp.numberingContinue, startAt: P[j].numberingStartAt, templateStartAt: tp.numberingStartAt });
    }
    rec(scn, 'paragraph-level overrides kept (numbered list restart: Documents list starts at 1, not 4)', ncBad.length === 0, { mismatches: ncBad });
    rec(scn, 'character formatting of every replaced paragraph equals its template (bold label/roman value, colours)', fmtBad.length === 0, { failures: fmtBad });
    const svc = P.filter((p) => p.styleId === FX.styleIds.serviceName && p.i < 10);
    rec(scn, 'Service Name paragraphs in chapter colour (Pantone 7498 C) and bold', svc.length === 3 && svc.every((p) => p.runs.every((r) => r.color === FX.chapterColor && /Bold/.test(r.font))), { svc: svc.map((p) => ({ t: p.text.slice(0, 30), runs: p.runs })) });
    const ciA = P.filter((p) => p.styleId === FX.styleIds.contactInfo).slice(0, 4);
    const ciB = storyB.paragraphs.filter((p) => p.styleId === FX.styleIds.contactInfo).slice(0, 4);
    rec(scn, 'contact lines keep anchored icon + tab and per-line anchored counts', ciA.length === 4 && ciA.every((p, k) => p.text.startsWith('\uFFFC\t') && p.anchored === ciB[k].anchored), { after: ciA.map((p) => [p.anchored, p.text.slice(0, 30)]), before: ciB.map((p) => p.anchored) });
    rec(scn, 'anchored objects in story unchanged', storyA.anchored === storyB.anchored, { before: storyB.anchored, after: storyA.anchored });
    const full = C.storyText(storyA);
    const resid = C.checkNoResidue(full, ['Migration Loan without Collateral', 'Other Services: Some other Service', 'Status: must be a returnee', 'Application form provided by the bank', 'Loan Term: 3 years', 'Service Delivery Time: 7 working days', 'Eskaton Garden Road, Dhaka 1000\r', '+88 02 48322873', 'www.pkb.gov.bd', 'Probashi Kallyan Bank Branches']);
    rec(scn, 'no residue of old PKB content (no old/new mixing)', resid.pass, resid.detail);
    rec(scn, 'no Lorem/placeholder text in story', C.checkNoPlaceholder([full]).pass, C.checkNoPlaceholder([full]).detail);
    const want = [src.name, ...src.objective, src.typesHeading, ...src.services, src.eligHeading, ...src.elig, src.procHeading, ...src.proc, src.contactHeading, plan[27].text, plan[28].text, plan[29].text, plan[30].text, src.branchHeading];
    const pres = C.checkContentPresent(want, full);
    rec(scn, 'all mapped source content is placed (nothing omitted)', pres.pass, pres.detail);
    const ov1 = await oversetInfo(pk.storyId);
    scn.overset = { before: state.pkbOverset0, after: ov1 };
    rec(scn, 'no NEW overset text (overset char count not increased vs baseline)', ov1.oversetChars <= (state.pkbOverset0 ? state.pkbOverset0.oversetChars : 0), scn.overset);
    const ovA = await T('check_overset_text', {});
    rec(scn, 'check_overset_text: overset story count not increased', ovA.norm.success && (ovA.norm.data.oversetStories || 0) <= ((ovB.norm.data || {}).oversetStories || 0), { before: ovB.norm.data, after: ovA.norm.data });
    const mg = C.checkMargins(geomA, geomB);
    rec(scn, 'no NEW frames past page margins on pages XIII-04', mg.pass, mg.detail);
    const ovl = C.checkOverlaps(geomA, geomB);
    rec(scn, 'no NEW overlapping frames on pages XIII-04', ovl.pass, ovl.detail);
    const um = C.checkItemsUnmoved(geomB, geomA);
    rec(scn, 'no top-level item moved / vanished (incl. empty frame 5887)', um.pass, um.detail);
    rec(scn, 'JPEG before/after exported', [...scn.jpegsBefore, ...scn.jpegsAfter].every((j) => j.exists), { files: [...scn.jpegsBefore, ...scn.jpegsAfter].map((j) => j.file + (j.exists ? '' : ' MISSING ' + (j.error || ''))) });
  });

  // ── 6 continue_story / cascade_reflow / reflow_page_layout ──
  await scenario(6, 'continue_story (cascade_reflow alias) + reflow_page_layout: pre-existing overset, overflow stress on PKB Reintegration story', 2400000, async (scn) => {
    await assertOnlyCopyOpen();
    const pagesAll = Array.from({ length: 14 }, (_, i) => 12 + i);
    // 6a: reflow_page_layout on a page that does not overflow moves nothing
    const g0 = await C.inspectPages(client, DOC, pagesAll);
    const s0 = await C.inspectStory(client, DOC, FX.pkb.storyId);
    const rp = await T('reflow_page_layout', { pageIndex: 14 }, { timeoutMs: 600000 });
    rec(scn, 'reflow_page_layout (page 03) succeeds', rp.norm.success, { ms: rp.ms, data: rp.norm.data, error: rp.norm.error });
    const g1 = await C.inspectPages(client, DOC, pagesAll);
    rec(scn, 'reflow_page_layout moves nothing on a non-overflowing page', C.checkItemsUnmoved(g0, g1).pass, C.checkItemsUnmoved(g0, g1).detail);
    const rpn = await T('reflow_page_layout', { pageName: 'XIII' });
    rec(scn, 'reflow_page_layout without pageIndex but with pageName works or fails cleanly (no hang)', rpn.ms < 60000, { ms: rpn.ms, ok: rpn.norm.success, error: rpn.norm.error });

    // 6b: PKB story is overset at baseline (Agrani branch table cannot fit any frame) -> continue_story must not loop or leave empty pages
    const ov0 = await oversetInfo(FX.pkb.storyId);
    const c0 = await T('continue_story', { storyId: FX.pkb.storyId, maxPages: 3 }, { timeoutMs: 300000 });
    scn.continuePkb = { ms: c0.ms, data: c0.norm.data, error: c0.norm.error };
    const ov1 = await oversetInfo(FX.pkb.storyId);
    const g2 = await C.inspectPages(client, DOC, Array.from({ length: 17 }, (_, i) => 12 + i));
    const emptyNew = g2.pages.filter((p) => p.index > 21 && p.index < 22 + (g2.pageCount - g1.pageCount) && p.items.every((it) => it.type !== 'TextFrame' || it.chars === 0));
    rec(scn, 'continue_story on the unfittable table returns within 120s and reports the stop', c0.ms < 120000 && (c0.norm.success || /progress|fit|overset|stop/i.test(String(c0.norm.error))), scn.continuePkb);
    rec(scn, 'continue_story leaves no empty inserted pages behind', emptyNew.length === 0, { pageCountBefore: g1.pageCount, pageCountAfter: g2.pageCount, emptyNew: emptyNew.map((p) => p.name) });
    rec(scn, 'continue_story did not change PKB text / fonts', C.checkPointSizesUnchanged(s0, await C.inspectStory(client, DOC, FX.pkb.storyId)).pass && ov1.length === ov0.length, { ov0, ov1 });
    if (g2.pageCount !== g1.pageCount) {
      // undo whatever was inserted so 6c starts from a known layout
      const u = await T('undo', {});
      scn.undoAfter6b = u.norm;
    }

    // 6c: overflow stress — Reintegration story (pages 11-12) gets 8 extra paragraphs through replace_paragraphs
    const rs = FX.reint;
    const sr0 = await C.inspectStory(client, DOC, rs.storyId);
    const geomS0 = await C.inspectPages(client, DOC, pagesAll);
    const stressP = sr0.paragraphs[rs.stressPara];
    rec(scn, 'stress anchor paragraph is the Regular "Submit the application..." paragraph', stressP.styleId === FX.styleIds.regular && /^Submit the application/.test(stressP.text), { text: stressP.text.slice(0, 40), style: stressP.style });
    const extra = Array.from({ length: 8 }, (_, k) => `STRESS ${k + 1}: ` + (state.pkbSrc ? state.pkbSrc.proc[k % 4] : 'Overflow stress paragraph with enough words to take two lines in the template frame.'));
    const add = await T('replace_paragraphs', { storyId: rs.storyId, edits: [{ paragraphIndex: rs.stressPara, expectStyleId: FX.styleIds.regular, text: stressP.text.replace(/\r$/, '') + '\r' + extra.join('\r') }], allowOverset: true /* intentional overflow, cascaded below by continue_story */ });
    rec(scn, 'stress setup via replace_paragraphs (+8 paragraphs)', add.norm.success && (add.norm.data.applied || [])[0] && add.norm.data.applied[0].paragraphsAdded === 8, { data: add.norm.data, error: add.norm.error });
    const ovS0 = await oversetInfo(rs.storyId);
    rec(scn, 'stress precondition: Reintegration story overflows', ovS0.overflows, ovS0);
    const srS0 = await C.inspectStory(client, DOC, rs.storyId);
    const cr = await T('cascade_reflow', { storyId: rs.storyId }, { timeoutMs: 600000 });
    const cd = cr.norm.data || {};
    scn.cascade = { ms: cr.ms, data: cd, error: cr.norm.error };
    rec(scn, 'cascade_reflow (alias of continue_story) succeeds', cr.norm.success, scn.cascade);
    const ovS1 = await oversetInfo(rs.storyId);
    rec(scn, 'stress: overflow resolved (no overset)', !ovS1.overflows, ovS1);
    const nAdded = (cd.pagesAdded || cd.addedPages || []).length;
    const geomS1 = await C.inspectPages(client, DOC, Array.from({ length: 14 + nAdded }, (_, i) => 12 + i));
    const srS1 = await C.inspectStory(client, DOC, rs.storyId);
    rec(scn, 'stress: fonts not shrunk', C.checkPointSizesUnchanged(srS0, srS1).pass, C.checkPointSizesUnchanged(srS0, srS1).detail);
    rec(scn, 'stress: story gained threaded frames (cascade, not overlap)', srS1.frames.length > srS0.frames.length, { before: srS0.frames, after: srS1.frames });
    const newPages = geomS1.pages.filter((p) => p.index >= 24 && p.index < 24 + nAdded);
    rec(scn, 'stress: inserted pages sit right after page 12, carry the chapter master and threaded frames inside margins',
      nAdded > 0 && newPages.length === nAdded && newPages.every((p) => p.master === FX.chapterMaster && p.items.some((it) => it.type === 'TextFrame' && (it.prev || it.next))) && C.checkMargins({ pages: newPages }).pass,
      { nAdded, newPages: newPages.map((p) => ({ i: p.index, name: p.name, master: p.master, side: p.side, items: p.items.map((it) => `${it.type}#${it.id}`) })), margins: C.checkMargins({ pages: newPages }).detail });
    const moved = C.checkItemsUnmoved(geomS0, geomS1);
    // page renumbering and left/right flips (x shifts by a page width) are not moves; vertical position or size changes are
    const tol = 0.005;
    const realMoves = moved.detail.moved.filter((m) => Math.abs(m.from[0] - m.to[0]) > tol || Math.abs(m.from[2] - m.to[2]) > tol || Math.abs((m.from[3] - m.from[1]) - (m.to[3] - m.to[1])) > tol);
    rec(scn, 'stress: no existing item moved vertically or resized (page renumbering / side flips ignored)', realMoves.length === 0 && moved.detail.vanishedFromInspectedPages.length === 0, { realMoves: realMoves.slice(0, 10), vanished: moved.detail.vanishedFromInspectedPages, renumberedOrFlipped: moved.detail.moved.length });
    const ch2 = geomS1.pages.find((p) => p.items.some((it) => it.id === FX.ch2Opener.rectId));
    rec(scn, 'stress: Chapter 2 opener still exists on master B-Blank', !!(ch2 && ch2.master === FX.ch2Opener.master), { ch2: ch2 && { i: ch2.index, name: ch2.name, side: ch2.side } });
    rec(scn, 'stress: odd page insertion is reported as a facing-parity warning (Chapter 2 opener flips side)', nAdded % 2 === 0 || /parity|side|odd/i.test(JSON.stringify(cd)), { nAdded, ch2Side: ch2 && ch2.side, warnings: cd.warnings || cd.parityWarning || cd.parity });
    const ovl = C.checkOverlaps(geomS1, geomS0);
    rec(scn, 'stress: no overlaps created', ovl.pass, ovl.detail);
    const vS = await T('verify_page_invariants', { pageIndexes: Array.from({ length: Math.min(16, 2 + nAdded) }, (_, i) => 22 + i) });
    scn.verifyStress = vS.norm.data;
    rec(scn, 'stress: verify_page_invariants on pages 11.. succeeds', vS.norm.success, { error: vS.norm.error });
    scn.jpegsStress = await C.exportPagesJpeg(client, DOC, [22, 23, ...newPages.map((p) => p.index)].slice(0, 5), OUT, 'after6stress');
    state.after6 = { nAdded };
  });

  // ── 7 other tools used by the skills ──
  await scenario(7, 'find_text / find_replace_text scope + undo / get_text_frame_content / analyze_layout / export_jpeg / set_text_frame_content guard', 1800000, async (scn) => {
    await assertOnlyCopyOpen();
    const ft = await T('find_text', { findWhat: 'PKB' });
    rec(scn, 'find_text "PKB"', ft.norm.success && ft.norm.data.total > 0, { ms: ft.ms, total: ft.norm.data && ft.norm.data.total, error: ft.norm.error });
    const ft2 = await T('find_text', { findWhat: "clients' close", scope: { storyId: FX.pkb.storyId } });
    rec(scn, "find_text with apostrophe + story scope", ft2.norm.success, { error: ft2.norm.error, total: ft2.norm.data && ft2.norm.data.total });
    const page3Before = await C.inspectStory(client, DOC, FX.pkb.storyId);
    const docState = () => S(`var d=__resolveDocument(); var u=''; try { u=String(d.undoName); } catch(e){} __ok({ undoName: u, pages: d.pages.length, reintLen: d.stories.itemByID(${FX.reint.storyId}).characters.length });`);
    const st0 = await docState();
    const fr = await T('find_replace_text', { findWhat: 'Agrani', changeTo: 'AGRANI-QA', caseSensitive: true, scope: { pageIndex: 17 } });
    const afterFR = await C.inspectStory(client, DOC, FX.pkb.storyId);
    const inside = afterFR.paragraphs.filter((p) => /AGRANI-QA/.test(p.text));
    const outside = inside.filter((p) => p.page !== '06');
    rec(scn, 'find_replace_text with scope.pageIndex only changes text on that page', fr.norm.success && fr.norm.data.replacements > 0 && inside.length > 0 && outside.length === 0, { data: fr.norm.data, error: fr.norm.error, outside: outside.map((p) => `${p.page}:${p.text.slice(0, 30)}`) });
    const u = await T('undo', {});
    const afterU = await C.inspectStory(client, DOC, FX.pkb.storyId);
    const st1 = await docState();
    rec(scn, 'one undo reverts find_replace_text (and nothing else)', u.norm.success && C.storyText(afterU) === C.storyText(page3Before) && st1.pages === st0.pages && st1.reintLen === st0.reintLen, { error: u.norm.error, st0, st1 });
    // regression: a tool call that changes nothing must not leave the undo stack such that `undo` silently reverts an EARLIER step
    const nm = await T('find_replace_text', { findWhat: 'NO-SUCH-TEXT-QA', changeTo: 'x', scope: { pageIndex: 17 } });
    const st2 = await docState();
    rec(scn, 'no-op find_replace_text (0 hits) does not change the document or the undo name', nm.norm.success && nm.norm.data.replacements === 0 && st2.undoName === st1.undoName && st2.pages === st1.pages, { nm: nm.norm.data, before: st1, after: st2 });
    // ...so an `undo` right after it reverts the PREVIOUS step (run 1: it silently removed the page cascade_reflow had inserted).
    // The undo tool must at least say which step it undid (or accept an expected undo name).
    const u2 = await T('undo', {});
    const st3 = await docState();
    scn.blindUndo = { response: u2.norm.data, undoNameBefore: st2.undoName, pagesBefore: st2.pages, pagesAfter: st3.pages };
    rec(scn, 'undo reports which step it reverted (no blind undo of an earlier step)', u2.norm.success && !!(u2.norm.data && typeof u2.norm.data.undoneName === 'string' && u2.norm.data.undoneName === st2.undoName && typeof u2.norm.data.nextUndoName === 'string'), scn.blindUndo);
    rec(scn, 'no-op find_replace_text reports noChange:true', nm.norm.success && nm.norm.data.noChange === true, { nm: nm.norm.data });
    const r2 = await T('redo', {});
    const st4 = await docState();
    rec(scn, 'redo restores the step the blind undo reverted', r2.norm.success && st4.pages === st2.pages && st4.reintLen === st2.reintLen, { st2, st4 });
    const gc = await T('get_text_frame_content', { frameId: FX.pkb.secondFrame });
    rec(scn, 'get_text_frame_content (mid-thread frame) returns frame text + storyId', gc.norm.success && gc.norm.data.storyId === FX.pkb.storyId, { ms: gc.ms, error: gc.norm.error, keys: gc.norm.data && Object.keys(gc.norm.data) });
    const gp = await T('get_text_frame_content', { pageIndex: 14 });
    rec(scn, 'get_text_frame_content by pageIndex returns JSON', gp.norm.success && typeof gp.result?.data === 'object', { error: gp.norm.error, note: gp.norm.note });
    const al = await T('analyze_layout', { pageIndex: 14 });
    rec(scn, 'analyze_layout (page 03, table + anchored icons) returns JSON', al.norm.success && typeof al.result?.data === 'object', { ms: al.ms, error: al.norm.error, note: al.norm.note });
    const stc = await T('set_text_frame_content', { frameId: FX.pkb.firstFrame, content: 'plain overwrite' });
    rec(scn, 'set_text_frame_content refuses a formatted/threaded story without mode:replace_all_plain', !stc.norm.success, { error: stc.norm.error });
    const pa = await C.inspectStory(client, DOC, FX.pkb.storyId);
    rec(scn, 'refused set_text_frame_content changed nothing', C.storyText(pa) === C.storyText(page3Before), {});

    const exDir = path.join(OUT, 'export_jpeg_tool');
    fs.rmSync(exDir, { recursive: true, force: true }); fs.mkdirSync(exDir, { recursive: true });
    await S(`app.jpegExportPreferences.jpegExportRange = ExportRangeOrAllPages.EXPORT_ALL; __ok(1);`);
    const ex = await T('export_jpeg', { outputPath: path.join(exDir, 'tool.jpg'), pageIndices: [13], resolution: 36, quality: 'low' }, { timeoutMs: 600000 });
    const files = fs.readdirSync(exDir);
    rec(scn, 'export_jpeg pageIndices [13] writes exactly one file', ex.norm.success && files.length === 1, { error: ex.norm.error, files, data: ex.norm.data });
    const ex2 = await T('export_jpeg', { outputPath: path.join(exDir, 'byname.jpg'), pageRange: '03', resolution: 36, quality: 'low' }, { timeoutMs: 600000 });
    rec(scn, 'export_jpeg pageRange "03" (page name) writes exactly one more file', ex2.norm.success && fs.readdirSync(exDir).length === 2, { error: ex2.norm.error, files: fs.readdirSync(exDir) });
    const ex3 = await T('export_jpeg', { outputPath: path.join(ROOT, '_qa_outside_roots', 'x.jpg'), pageIndices: [13] });
    rec(scn, 'export_jpeg outside the write roots is refused', !ex3.norm.success && !fs.existsSync(path.join(ROOT, '_qa_outside_roots')), { error: ex3.norm.error });
  });

  // ── 8 new chapter from the template (job B smoke test) ──
  await scenario(8, 'new chapter from template: duplicate opener + content spread, own colour, text via replace_paragraphs', 1800000, async (scn) => {
    await assertOnlyCopyOpen();
    const w = state.womenSrc || (await parseDocx(DOCX_WOMEN)).content;
    const title = clean(w.find((p) => clean(p.text).length > 3).text);
    const desc = clean(w.find((p) => clean(p.text).length > 200).text);
    scn.source = { title, desc: desc.slice(0, 80) };
    results.mismatchNotes.push('New chapter: chapter number is not in the DOCX ("Chapter 01" file name vs. book position); "Chapter 3" used as placeholder number — confirm with the user');
    const pkb0 = await C.inspectStory(client, DOC, FX.pkb.storyId);
    const info0 = await S(`var d=__resolveDocument(); __ok({ pages: d.pages.length });`);
    const sw = await T('create_color_swatch', { name: 'QA Chapter Women', colorSpace: 'CMYK', colorValues: [0, 85, 10, 0], colorModel: 'process' });
    rec(scn, 'create_color_swatch for the new chapter colour', sw.norm.success, { error: sw.norm.error, data: sw.norm.data });
    const dp = await T('duplicate_page', { pageIndex: FX.opener.pageIndex, toLocation: 'end' }, { timeoutMs: 600000 });
    const ddTop = dp.norm.data || {};
    const dd = (ddTop.pages || [])[0] || ddTop;
    scn.duplicateOpener = ddTop;
    rec(scn, 'duplicate_page (chapter opener XIII) to end succeeds and reports side/parity/lorem', dp.norm.success && dd.newIndex === info0.pages && 'loremFrameIds' in dd && 'parity' in ddTop, { error: dp.norm.error, data: ddTop });
    rec(scn, 'duplicated opener keeps master A-Parent and has no Lorem frames', dd.appliedMaster === FX.opener.master && (dd.loremFrameIds || []).length === 0, { appliedMaster: dd.appliedMaster, lorem: dd.loremFrameIds });
    rec(scn, 'duplicate_page warns when the copy lands on the other side than its source (right-hand opener -> left page)', String(dd.side).toLowerCase() === String(ddTop.sourceSide).toLowerCase() || !!ddTop.warning || !!(ddTop.parity && ddTop.parity.warning), { sourceSide: ddTop.sourceSide, newSide: dd.side, warning: ddTop.warning, parity: ddTop.parity });
    const np = await S(`var d=__resolveDocument(); var p=d.pages[${dd.newIndex ?? -1}]; var out={ name: p.name, frames: [], rects: [] };
var it=p.allPageItems; for (var i=0;i<it.length;i++){ var o=it[i]; if (o.constructor.name==='TextFrame') out.frames.push({ id:o.id, story:o.parentStory.id, text:String(o.contents).substr(0,30) }); if (o.constructor.name==='Rectangle') out.rects.push({ id:o.id, fill:o.fillColor.name }); }
__ok(out);`);
    const tf = np.frames.find((f) => /^Chapter 1/.test(f.text)), df = np.frames.find((f) => /^Access to financial/.test(f.text));
    rec(scn, 'duplicated opener has its own (unthreaded) title and description stories', !!(tf && df && tf.story !== FX.opener.titleStory && df.story !== FX.opener.descStory), np);
    if (tf && df) {
      const r1 = await T('replace_paragraphs', { storyId: tf.story, edits: [{ paragraphIndex: 0, text: 'Chapter 3', expectStyleId: FX.styleIds.chapterNumber }, { paragraphIndex: 1, text: title.replace(/^Chapter \d+\s*[-:–]\s*/i, ''), expectStyleId: FX.styleIds.chapterName }] });
      // design-r3-03: a title that wraps into overset in its single unthreaded frame is rolled back with an overset mismatch (never kept hidden).
      const r1d = r1.norm.data || {};
      const r1Overset = r1.norm.success && r1d.applied === false && r1d.rolledBack === true && (r1d.mismatches || []).some((m) => /overset/.test(m.reason) && m.singleUnthreadedFrame === true);
      rec(scn, 'opener title replaced (styles kept), or rolled back with a single-frame overset mismatch', r1.norm.success && ((r1d.mismatches || []).length === 0 || r1Overset), { data: r1d, error: r1.norm.error });
      const ovt = await oversetInfo(tf.story);
      rec(scn, 'opener title not overset after the call (no hidden text kept)', !ovt.overflows, ovt);
      if (r1Overset) results.mismatchNotes.push(`New chapter opener: title "${title}" does not fit the template title frame (would be overset) — write rolled back; needs a decision (shorter title or bigger frame)`);
      const r2 = await T('replace_paragraphs', { storyId: df.story, edits: [{ paragraphIndex: 0, text: desc }] });
      // design-r3-03: a description that does not fit the unthreaded frame is rolled back (applied:false, rolledBack:true, overset mismatch).
      const r2d = r2.norm.data || {};
      const r2Overset = r2.norm.success && r2d.applied === false && r2d.rolledBack === true && (r2d.mismatches || []).some((m) => /overset/.test(m.reason));
      rec(scn, 'opener description replaced (or rolled back with an overset mismatch)', r2.norm.success && ((r2d.mismatches || []).length === 0 || r2Overset), { data: r2d, error: r2.norm.error });
      const ovd = await oversetInfo(df.story);
      rec(scn, 'opener description not overset (or mismatch must be recorded)', !ovd.overflows, ovd);
      if (ovd.overflows || r2Overset) results.mismatchNotes.push(`New chapter opener: description from the DOCX (${desc.length} chars) does not fit the template description frame — needs a decision (shorter text or bigger frame)`);
    }
    const rect = np.rects[0];
    if (rect) await S(`var d=__resolveDocument(); d.rectangles.itemByID(${rect.id}).fillColor = d.swatches.itemByName('QA Chapter Women'); __ok(1);`, { undoName: 'harness chapter colour' });
    const ds = await T('duplicate_page', { pageIndex: FX.pkb.pages[0], toLocation: 'end', spread: true }, { timeoutMs: 600000 });
    const dsd = ds.norm.data || {};
    scn.duplicateSpread = dsd;
    rec(scn, 'duplicate_page spread:true (content spread 02-03) succeeds with chapter master', ds.norm.success && /Access to Finance/.test(JSON.stringify(dsd.appliedMaster || dsd)), { error: ds.norm.error, data: dsd });
    const pkb1 = await C.inspectStory(client, DOC, FX.pkb.storyId);
    rec(scn, 'duplicating template pages did NOT alter the source chapter story (text, frames)', C.storyText(pkb1) === C.storyText(pkb0) && pkb1.frames.join() === pkb0.frames.join(), { framesBefore: pkb0.frames, framesAfter: pkb1.frames, lenBefore: C.storyText(pkb0).length, lenAfter: C.storyText(pkb1).length });
    rec(scn, 'duplicate_page reports threadedFrameIds / warning for threaded source frames', 'threadedFrameIds' in dsd || /thread/i.test(JSON.stringify(dsd)), { threadedFrameIds: dsd.threadedFrameIds, warning: dsd.warning });
    const info1 = await S(`var d=__resolveDocument(); __ok({ pages: d.pages.length });`);
    const vN = await T('verify_page_invariants', { pageIndexes: Array.from({ length: info1.pages - info0.pages }, (_, i) => info0.pages + i) });
    scn.verifyNewChapter = vN.norm.data;
    rec(scn, 'verify_page_invariants on the new chapter pages succeeds', vN.norm.success, { error: vN.norm.error });
    scn.jpegs = await C.exportPagesJpeg(client, DOC, Array.from({ length: info1.pages - info0.pages }, (_, i) => info0.pages + i), OUT, 'newchapter');
    rec(scn, 'JPEGs of new chapter pages exported', scn.jpegs.every((j) => j.exists), scn.jpegs.map((j) => j.file));
    // side-change regression: duplicating the right-hand opener to the end of a document whose next page is LEFT
    const info2 = await S(`var d=__resolveDocument(); __ok({ pages: d.pages.length, lastSide: String(d.pages[-1].side) });`);
    const dp2 = await T('duplicate_page', { pageIndex: FX.opener.pageIndex, toLocation: 'end' }, { timeoutMs: 600000 });
    const d2 = dp2.norm.data || {}, d2p = (d2.pages || [])[0] || {};
    scn.duplicateOpener2 = { before: info2, data: d2 };
    rec(scn, 'duplicate_page warns when a right-hand opener copy lands on a LEFT page', dp2.norm.success && (String(d2p.side).toLowerCase() === String(d2p.sourceSide).toLowerCase() || (d2p.sideChanged === true && (d2.warnings || []).some((w) => /landed on a/i.test(w)))), { page: d2p, sourceSide: d2.sourceSide, warnings: d2.warnings, parity: d2.parity, error: dp2.norm.error });
  });

  // ── 9 bridge / safety live checks ──
  await scenario(9, 'bridge safety: save in place, refused Save As outside roots, Downloads refusal (Node), timeout + auto-probe', 900000, async (scn) => {
    await assertOnlyCopyOpen();
    const safety = await import(pathToFileURL(path.join(ROOT, 'dist', 'bridge', 'safety.js')).href);
    const dl = 'C:\\Users\\Litoondev\\Downloads\\Brac\\qa_should_be_refused.indd';
    let refusedDl = false, refusedMaster = false;
    try { safety.assertSafeWritePath(dl, ['.indd'], { overwrite: true }); } catch { refusedDl = true; }
    try { safety.assertSafeWritePath(MASTER, ['.indd'], { overwrite: true }); } catch { refusedMaster = true; }
    rec(scn, 'safety.assertSafeWritePath refuses Downloads and the master (Node, no InDesign)', refusedDl && refusedMaster, { refusedDl, refusedMaster, roots: safety.getWriteRoots && safety.getWriteRoots() });
    const tp = await import(pathToFileURL(path.join(ROOT, 'dist', 'tools', 'textPipelineShared.js')).href);
    const kit = await import(pathToFileURL(path.join(ROOT, 'dist', 'tools', 'batchC_layoutKit.js')).href);
    const agree = [tp, kit].map((m) => { try { m.assertSafeWritePath(dl, ['.indd'], { overwrite: true }); return 'allowed'; } catch { return 'refused'; } });
    rec(scn, 'all three assertSafeWritePath copies refuse Downloads', agree.every((a) => a === 'refused'), { textPipelineShared: agree[0], batchC_layoutKit: agree[1] });
    const outside = path.join(ROOT, '_qa_outside_roots', 'saveas.indd');
    const sa = await T('save_document', { filePath: outside });
    rec(scn, 'save_document Save As outside the write roots is refused', !sa.norm.success && !fs.existsSync(outside), { error: sa.norm.error });
    const mtime0 = fs.statSync(COPY).mtimeMs;
    const sv = await T('save_document', {}, { timeoutMs: 600000 });
    rec(scn, 'save_document in place on the run copy succeeds', sv.norm.success && fs.statSync(COPY).mtimeMs > mtime0, { error: sv.norm.error, data: sv.norm.data });
    const slow = await T('run_script', { script: 'var t=new Date().getTime(); while (new Date().getTime()-t < 8000) {} __ok(1);', timeoutMs: 2000 });
    rec(scn, 'slow run_script with timeoutMs 2000 returns EXECUTION_TIMEOUT_STILL_RUNNING quickly', !slow.norm.success && slow.ms < 15000 && /EXECUTION_TIMEOUT_STILL_RUNNING/.test(String(slow.norm.code || '') + String(slow.mcpText)), { ms: slow.ms, code: slow.norm.code, mcpText: String(slow.mcpText).slice(0, 300) });
    const nx = await client.call('list_open_documents', {}, { timeoutMs: 120000 });
    rec(scn, 'next call after the timeout auto-probes and succeeds', nx.norm.success && Array.isArray(nx.norm.data), { ms: nx.ms, error: nx.norm.error, mcpText: String(nx.mcpText).slice(0, 300) });
    await assertOnlyCopyOpen();
  });

  // ── 10-19: round-2 regression scenarios (each on a fresh copy of the v06 master) ──
  await regressionR2({ scenario, rec, T, S, client, C, FX, DOC, COPY, MASTER, ROOT, OUT, freshCopy, state });
  // ── 20-30: round-3 regression scenarios (round-2 fixes) ──
  await regressionR3({ scenario, rec, T, S, client, C, FX, DOC, COPY, MASTER, ROOT, OUT, freshCopy, state });
}

// ════════════════════════════════ run ════════════════════════════════
let exitCode = 0;
try {
  await main();
} catch (e) {
  log('HARNESS ERROR ' + (e && e.stack || e));
  exitCode = 1;
} finally {
  if (state.opened && !KEEP_OPEN) {
    const cl = await client.call('close_document', { document_id: DOC, save: 'no' }, { timeoutMs: 600000 });
    results.closed = cl.norm.success ? true : cl.norm.error;
    if (!cl.norm.success) {
      try { await client.script(`var d=__findDocument(${JSON.stringify(DOC)}); if(d) d.close(SaveOptions.NO); __ok(true);`, { timeoutMs: 600000 }); results.closed = 'closed via fallback'; } catch (e) { results.closed = 'FAILED: ' + e.message; }
    }
    const lst = await client.call('list_open_documents', {});
    results.openAfterClose = lst.norm.data;
  }
  results.finishedAt = new Date().toISOString();
  results.toolCalls = client.calls;
  results.summary = { total: results.scenarios.length, passed: results.scenarios.filter((s) => s.passed).length, failed: results.scenarios.filter((s) => !s.passed).map((s) => s.id) };
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  log(`\nResults: ${path.join(OUT, 'results.json')}  passed ${results.summary.passed}/${results.summary.total}`);
  await client.close();
  process.exit(exitCode);
}
