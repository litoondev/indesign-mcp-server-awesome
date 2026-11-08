// Reusable invariant checks for the BRAC content-replacement workflow.
// Every check returns {pass, detail, ...}. Inspection is done with read-only
// ExtendScript through the run_script tool (ToolClient.script), targeting the
// run copy by document name so it never touches another open document.
import fs from 'node:fs';
import path from 'node:path';

const MARGIN_TOL = 0.01; // inches
const OVERLAP_MIN_AREA = 0.01; // sq inches

// ───────────────────────── inspection ─────────────────────────

/** Paragraph-level dump of a story with per-character formatting runs. */
export async function inspectStory(client, docName, storyId) {
  const code = `
var doc = __resolveDocument();
var s = doc.stories.itemByID(${Number(storyId)});
if (!s.isValid) { __fail('story ${Number(storyId)} not found'); } else {
var paras = s.paragraphs.everyItem().getElements();
var out = [];
for (var i = 0; i < paras.length; i++) {
  var p = paras[i];
  // Per-character sampling (textStyleRanges of a paragraph can start in the previous paragraph, which
  // mis-attributes formatting); consecutive equal characters are merged into runs.
  var runs = [];
  var nC = p.characters.length;
  if (nC > 0) {
    var ce = p.characters.everyItem();
    var fsA = ce.fontStyle, szA = ce.pointSize, fcA = ce.fillColor;
    if (!(fsA instanceof Array)) { fsA = [fsA]; szA = [szA]; fcA = [fcA]; }
    var cur = null;
    for (var k = 0; k < fsA.length; k++) {
      var fc = ''; try { fc = fcA[k].name; } catch (e) {}
      var fs = String(fsA[k]), sz = szA[k];
      if (cur && cur.font === fs && cur.color === fc && cur.size === sz) { cur.e = k + 1; continue; }
      cur = { s: k, e: k + 1, font: fs, color: fc, size: sz }; runs.push(cur);
    }
  }
  var fr = null, pg = null;
  try { fr = p.parentTextFrames[0].id; pg = p.parentTextFrames[0].parentPage ? p.parentTextFrames[0].parentPage.name : null; } catch (e) {}
  out.push({ i: i, style: p.appliedParagraphStyle.name, styleId: p.appliedParagraphStyle.id,
             text: String(p.contents), frameId: fr, page: pg, anchored: p.allPageItems.length,
             pointSize: p.pointSize, numberingContinue: p.numberingContinue, numberingStartAt: p.numberingStartAt, runs: runs });
}
var tc = s.textContainers; var frames = [];
for (var j = 0; j < tc.length; j++) frames.push(tc[j].id);
var lastBaseline = null, lastPage = null;
try { var vis = s.textContainers[s.textContainers.length - 1]; var ll = vis.lines[-1]; lastBaseline = ll.baseline; lastPage = vis.parentPage ? vis.parentPage.name : null; } catch (e) {}
__ok({ storyId: s.id, overflows: s.overflows, length: s.characters.length, anchored: s.allPageItems.length, frames: frames, paragraphs: out, lastBaseline: lastBaseline, lastPage: lastPage });
}`;
  return client.script(code, { docName, timeoutMs: 300000 });
}

/** Geometry + structure of pages (top-level items, text-frame threading, masters). */
export async function inspectPages(client, docName, pageIdxs) {
  const code = `
var doc = __resolveDocument();
var idxs = [${pageIdxs.map(Number).join(',')}];
var res = { pageCount: doc.pages.length, pages: [] };
for (var n = 0; n < idxs.length; n++) {
  var pi = idxs[n]; if (pi >= doc.pages.length) continue;
  var pg = doc.pages[pi];
  var m = 'None'; try { m = pg.appliedMaster ? pg.appliedMaster.name : 'None'; } catch (e) {}
  var mp = pg.marginPreferences;
  var items = [];
  var els = pg.pageItems.everyItem().getElements();
  for (var i = 0; i < els.length; i++) {
    var it = els[i];
    var o = { id: it.id, type: it.constructor.name, b: it.geometricBounds, visible: it.visible };
    if (o.type === 'TextFrame') {
      o.overflows = it.overflows; o.storyId = it.parentStory.id;
      o.prev = it.previousTextFrame ? it.previousTextFrame.id : null;
      o.next = it.nextTextFrame ? it.nextTextFrame.id : null;
      o.chars = it.characters.length;
      o.text = String(it.contents).substr(0, 80);
    }
    if (o.type === 'Group') {
      var poly = 0, tfs = [];
      var all = it.allPageItems;
      for (var k = 0; k < all.length; k++) {
        if (all[k].constructor.name === 'Polygon') poly++;
        if (all[k].constructor.name === 'TextFrame') tfs.push(all[k].id);
      }
      o.polygons = poly; o.textFrames = tfs;
    }
    items.push(o);
  }
  res.pages.push({ index: pi, name: pg.name, side: String(pg.side), master: m, bounds: pg.bounds,
    margins: { top: mp.top, bottom: mp.bottom, left: mp.left, right: mp.right }, items: items });
}
__ok(res);`;
  return client.script(code, { docName, timeoutMs: 300000 });
}

/** Contact block: frame text + number of icon polygons in its group (and anchored items). */
export async function inspectContactBlock(client, docName, frameId) {
  const code = `
var doc = __resolveDocument();
var tf = doc.textFrames.itemByID(${Number(frameId)});
if (!tf.isValid) { __fail('contact frame missing'); } else {
var grp = tf.parent; var poly = 0; var gid = null;
while (grp && grp.constructor.name === 'Group' && grp.parent && grp.parent.constructor.name === 'Group') grp = grp.parent;
if (grp && grp.constructor.name === 'Group') { gid = grp.id; var all = grp.allPageItems; for (var k = 0; k < all.length; k++) if (all[k].constructor.name === 'Polygon') poly++; }
var storyText = String(tf.parentStory.contents);
var lines = storyText.split(/[\\n\\r]/);
var runs = []; var tsr = tf.textStyleRanges.everyItem().getElements();
for (var i = 0; i < tsr.length; i++) { var r = tsr[i]; var f=''; try { f = r.appliedFont.fontStyleName; } catch(e){} var c=''; try { c = r.fillColor.name; } catch(e){} runs.push(f + '/' + c + '/' + r.characters.length); }
__ok({ id: tf.id, groupId: gid, iconPolygons: poly, anchored: tf.allPageItems.length, overflows: tf.overflows, bounds: tf.geometricBounds,
       text: storyText, visibleText: String(tf.contents), lineCount: lines.length, visibleLineCount: String(tf.contents).split(/[\\n\\r]/).length, lines: lines, runs: runs, style: tf.paragraphs[0].appliedParagraphStyle.name });
}`;
  return client.script(code, { docName, timeoutMs: 120000 });
}

/** Export specific pages (0-based absolute indexes) as JPEG, explicitly setting the export range. */
export async function exportPagesJpeg(client, docName, pageIdxs, outDir, prefix, resolution = 110) {
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  for (const pi of pageIdxs) {
    const file = path.join(outDir, `${prefix}_p${pi}.jpg`).replace(/\\/g, '/');
    const code = `
var doc = __resolveDocument();
var pg = doc.pages[${Number(pi)}];
var pr = app.jpegExportPreferences;
pr.jpegExportRange = ExportRangeOrAllPages.EXPORT_RANGE;
pr.pageString = '+' + (pg.documentOffset + 1);
pr.exportingSpread = false;
pr.exportResolution = ${Number(resolution)};
pr.jpegQuality = JPEGOptionsQuality.HIGH;
doc.exportFile(ExportFormat.JPG, new File('${file}'));
__ok({ page: pg.name, file: '${file}' });`;
    try {
      const d = await client.script(code, { docName, timeoutMs: 300000 });
      files.push({ page: pi, name: d.page, file: path.normalize(file), exists: fs.existsSync(file) });
    } catch (e) {
      files.push({ page: pi, file: path.normalize(file), exists: false, error: e.message });
    }
  }
  return files;
}

// ───────────────────────── pure checks ─────────────────────────

const isBold = (font) => /bold|black|heavy/i.test(font || '');

/** Runs that cover [from, to) of a paragraph. */
function runsIn(para, from, to) {
  return para.runs.filter((r) => r.e > from && r.s < to);
}

/**
 * BRAC "label: value" rule: chars 0..colon (inclusive) bold (+labelColor if given),
 * chars after colon roman (+valueColor if given). Ignores the trailing \r.
 */
export function checkBoldColon(para, { labelColor = null, valueColor = null } = {}) {
  const text = para.text.replace(/\r$/, '');
  const colon = text.indexOf(':');
  if (colon < 0) return { pass: false, detail: `no colon in paragraph ${para.i}: "${text.slice(0, 60)}"` };
  const problems = [];
  for (const r of runsIn(para, 0, colon + 1)) {
    if (!isBold(r.font)) problems.push(`label chars ${r.s}-${r.e} are "${r.font}" (expected Bold)`);
    if (labelColor && r.color !== labelColor) problems.push(`label chars ${r.s}-${r.e} color "${r.color}" (expected "${labelColor}")`);
  }
  // value after colon: skip leading whitespace
  let vs = colon + 1;
  while (vs < text.length && /\s/.test(text[vs])) vs++;
  for (const r of runsIn(para, vs, text.length)) {
    if (isBold(r.font)) problems.push(`value chars ${r.s}-${r.e} are "${r.font}" (expected Roman)`);
    if (valueColor && r.color !== valueColor) problems.push(`value chars ${r.s}-${r.e} color "${r.color}" (expected "${valueColor}")`);
  }
  return { pass: problems.length === 0, detail: problems.length ? `para ${para.i}: ` + problems.join('; ') : `para ${para.i} ok (colon@${colon})` };
}

/** Whole paragraph must be bold/roman (+color). */
export function checkUniform(para, { bold, color = null }) {
  const text = para.text.replace(/\r$/, '');
  const problems = [];
  for (const r of runsIn(para, 0, text.length)) {
    if (/^\s*$/.test(text.slice(r.s, r.e))) continue;
    if (bold !== isBold(r.font)) problems.push(`chars ${r.s}-${r.e} "${r.font}" (expected ${bold ? 'Bold' : 'Roman'})`);
    if (color && r.color !== color) problems.push(`chars ${r.s}-${r.e} color "${r.color}" (expected "${color}")`);
  }
  return { pass: problems.length === 0, detail: problems.length ? `para ${para.i}: ` + problems.join('; ') : `para ${para.i} ok` };
}

/** Placeholder / dummy text left in touched stories. */
export function checkNoPlaceholder(texts, re = /lorem|ipsum|dummy text|xxxx|\[placeholder\]/i) {
  const hits = [];
  texts.forEach((t, i) => { const m = String(t).match(re); if (m) hits.push({ i, match: m[0], ctx: String(t).slice(Math.max(0, m.index - 30), m.index + 40) }); });
  return { pass: hits.length === 0, detail: hits.length ? hits : 'no placeholder text', hits };
}

/** Old text that must be gone after replacement (detects old/new content mixing). */
export function checkNoResidue(fullText, fragments) {
  const left = fragments.filter((f) => normText(fullText).includes(normText(f)));
  return { pass: left.length === 0, detail: left.length ? { residue: left } : 'no residue of replaced content' };
}

export function normText(s) {
  return String(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[\r\n\t\x0a]/g, ' ').replace(new RegExp(String.fromCharCode(0x2028), 'g'), ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Every source string must appear somewhere in the placed text (no omitted content). */
export function checkContentPresent(sourceStrings, placedText) {
  const hay = normText(placedText);
  const missing = sourceStrings.filter((s) => s.trim() && !hay.includes(normText(s)));
  return { pass: missing.length === 0, detail: missing.length ? { missing } : `all ${sourceStrings.length} source strings present` };
}

function within(b, box) {
  return b[0] >= box[0] - MARGIN_TOL && b[1] >= box[1] - MARGIN_TOL && b[2] <= box[2] + MARGIN_TOL && b[3] <= box[3] + MARGIN_TOL;
}

/** Margin box of a page in spread coordinates [top,left,bottom,right]. */
export function marginBox(page) {
  const [t, l, b, r] = page.bounds;
  const m = page.margins;
  // facing pages: for left-hand pages InDesign's "left" margin is the outside one; all 0.6 in BRAC, so symmetric.
  return [t + m.top, l + m.left, b - m.bottom, r - m.right];
}

/** Items extending past page margins. Pass `baseline` (same shape) to report only NEW violations. */
export function checkMargins(pagesInfo, baseline = null, { ignoreTypes = [] } = {}) {
  const viol = [];
  const baseSet = new Set();
  if (baseline) for (const p of baseline.pages) for (const it of p.items) if (!within(it.b, marginBox(p))) baseSet.add(it.id);
  for (const p of pagesInfo.pages) {
    const box = marginBox(p);
    for (const it of p.items) {
      if (ignoreTypes.includes(it.type)) continue;
      if (!within(it.b, box)) {
        const v = { page: p.name, id: it.id, type: it.type, bounds: it.b.map((x) => +x.toFixed(3)), marginBox: box.map((x) => +x.toFixed(3)), preexisting: baseSet.has(it.id) };
        viol.push(v);
      }
    }
  }
  const fresh = viol.filter((v) => !v.preexisting);
  return { pass: fresh.length === 0, detail: { newViolations: fresh, preexisting: viol.filter((v) => v.preexisting).length }, violations: viol };
}

function overlapArea(a, b) {
  const h = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const w = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return h > 0 && w > 0 ? h * w : 0;
}

/** Overlapping top-level items per page (text frames vs anything). Baseline-aware. */
export function checkOverlaps(pagesInfo, baseline = null) {
  const key = (a, b) => [a, b].sort((x, y) => x - y).join('-');
  const baseSet = new Set();
  const collect = (info) => {
    const out = [];
    for (const p of info.pages) {
      const its = p.items.filter((i) => i.visible !== false);
      for (let i = 0; i < its.length; i++) for (let j = i + 1; j < its.length; j++) {
        const A = its[i], B = its[j];
        if (A.type !== 'TextFrame' && B.type !== 'TextFrame' && A.type !== 'Group' && B.type !== 'Group') continue;
        if (A.type === 'TextFrame' && A.chars === 0 && B.type !== 'TextFrame') continue;
        const area = overlapArea(A.b, B.b);
        if (area > OVERLAP_MIN_AREA) out.push({ page: p.name, a: `${A.type}#${A.id}`, b: `${B.type}#${B.id}`, area: +area.toFixed(3), k: key(A.id, B.id) });
      }
    }
    return out;
  };
  if (baseline) for (const o of collect(baseline)) baseSet.add(o.k);
  const all = collect(pagesInfo);
  const fresh = all.filter((o) => !baseSet.has(o.k));
  return { pass: fresh.length === 0, detail: { newOverlaps: fresh, preexisting: all.length - fresh.length }, overlaps: all };
}

/** Pages added after an operation must carry the chapter master and contain threaded frames. */
export function checkAddedPages(before, after, chapterMaster) {
  const added = after.pageCount - before.pageCount;
  const problems = [];
  if (added > 0) {
    const newPages = after.pages.filter((p) => p.index >= before.pageCount);
    for (const p of newPages) {
      if (p.master !== chapterMaster) problems.push(`page ${p.name} master "${p.master}" (expected "${chapterMaster}")`);
      const tfs = p.items.filter((i) => i.type === 'TextFrame');
      if (tfs.length && !tfs.some((t) => t.prev || t.next)) problems.push(`page ${p.name} has text frames but none threaded`);
    }
  }
  return { pass: problems.length === 0, detail: { pagesAdded: added, problems } };
}

/** Font sizes must not change (reflow tools shrink fonts, which breaks the template). */
export function checkPointSizesUnchanged(beforeStory, afterStory) {
  const changed = [];
  const n = Math.min(beforeStory.paragraphs.length, afterStory.paragraphs.length);
  for (let i = 0; i < n; i++) {
    const a = beforeStory.paragraphs[i], b = afterStory.paragraphs[i];
    if (Math.abs((a.pointSize || 0) - (b.pointSize || 0)) > 0.01) changed.push({ i, from: a.pointSize, to: b.pointSize, text: b.text.slice(0, 40) });
  }
  return { pass: changed.length === 0, detail: changed.length ? { changed } : 'point sizes unchanged' };
}

/** Item positions must not change unexpectedly. */
export function checkItemsUnmoved(before, after, { tol = 0.005 } = {}) {
  const pos = new Map();
  for (const p of before.pages) for (const it of p.items) pos.set(it.id, { page: p.name, b: it.b });
  const moved = [];
  const seen = new Set();
  for (const p of after.pages) for (const it of p.items) {
    seen.add(it.id);
    const o = pos.get(it.id);
    if (!o) continue;
    const d = Math.max(...it.b.map((x, i) => Math.abs(x - o.b[i])));
    if (o.page !== p.name || d > tol) moved.push({ id: it.id, type: it.type, fromPage: o.page, toPage: p.name, from: o.b.map((x) => +x.toFixed(3)), to: it.b.map((x) => +x.toFixed(3)) });
  }
  const vanished = [...pos.keys()].filter((id) => !seen.has(id));
  return { pass: moved.length === 0 && vanished.length === 0, detail: { moved, vanishedFromInspectedPages: vanished } };
}

/**
 * Paragraph styles after replacement must equal the template paragraph each one replaced.
 * expected: array of {styleName} (or null to skip) aligned with afterStory.paragraphs.
 */
export function checkStyleSequence(afterStory, expected) {
  const bad = [];
  if (afterStory.paragraphs.length !== expected.length) bad.push({ paragraphCount: afterStory.paragraphs.length, expected: expected.length });
  const n = Math.min(afterStory.paragraphs.length, expected.length);
  for (let i = 0; i < n; i++) {
    const e = expected[i]; if (!e) continue;
    const p = afterStory.paragraphs[i];
    if (p.style !== e.style) bad.push({ i, text: p.text.slice(0, 40), style: p.style, expected: e.style });
  }
  return { pass: bad.length === 0, detail: bad.length ? { mismatches: bad } : 'style sequence matches template' };
}

/** Vertical gap between end of text and the next fixed element must be preserved (± tol inches). */
export function checkGapPreserved(gapBefore, gapAfter, tol = 0.15) {
  const d = Math.abs(gapAfter - gapBefore);
  return { pass: d <= tol, detail: { gapBefore: +gapBefore.toFixed(3), gapAfter: +gapAfter.toFixed(3), diff: +d.toFixed(3), tol } };
}

export function storyText(story) {
  return story.paragraphs.map((p) => p.text).join('');
}
