import type { InDesignBridge } from "../bridge/index.js";
import type { ScriptResult } from "../types.js";
import fs from "fs";
import path from "path";
import {
  BACKUP_ROOT,
  assertSafeWritePath,
  guarded,
  isUnderWriteRoots,
  jsStr,
  jsx,
  runTp,
  toJsxPath,
  writeRoots,
} from "./textPipelineShared.js";
import { REPLACE_PARAGRAPHS_JSX, registerSafeContentTools } from "./safeContent.js";

// ─────────────────────────────────────────────────────────────────────────────
// DOCX
// ─────────────────────────────────────────────────────────────────────────────

export interface DocxRun { text: string; bold: boolean; italic: boolean }
export interface DocxParagraph { style: string; runs: DocxRun[]; text: string; allBold: boolean; isListItem: boolean }

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, "\u00A0")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Convert mammoth HTML into paragraphs of runs. Bold/italic are tracked per run
 * (a <strong> label no longer marks the whole paragraph bold), <br> becomes a
 * forced line break '\n' inside the run text, every <li> is its own paragraph.
 */
export function htmlToParagraphs(html: string): DocxParagraph[] {
  const out: DocxParagraph[] = [];
  const BLOCK: Record<string, string> = { p: "Normal", li: "List Paragraph", h1: "Heading 1", h2: "Heading 2", h3: "Heading 3", h4: "Heading 4", h5: "Heading 5", h6: "Heading 6", td: "Normal", th: "Normal" };
  let bold = 0;
  let italic = 0;
  let cur: { style: string; runs: DocxRun[]; isListItem: boolean } | null = null;
  const pushText = (t: string) => {
    if (!t) return;
    if (!cur) cur = { style: "Normal", runs: [], isListItem: false };
    const last = cur.runs[cur.runs.length - 1];
    const b = bold > 0;
    const i = italic > 0;
    if (last && last.bold === b && last.italic === i) last.text += t;
    else cur.runs.push({ text: t, bold: b, italic: i });
  };
  const flush = () => {
    if (!cur) return;
    const text = cur.runs.map((r) => r.text).join("");
    if (text.trim()) {
      const visible = cur.runs.filter((r) => r.text.trim());
      out.push({ style: cur.style, runs: cur.runs, text, allBold: visible.length > 0 && visible.every((r) => r.bold), isListItem: cur.isListItem });
    }
    cur = null;
  };
  const re = /<(\/?)([a-zA-Z0-9]+)[^>]*?(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[4] !== undefined) { pushText(decodeEntities(m[4])); continue; }
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (tag === "br") { pushText("\n"); continue; }
    if (tag === "strong" || tag === "b") { bold += closing ? -1 : 1; if (bold < 0) bold = 0; continue; }
    if (tag === "em" || tag === "i") { italic += closing ? -1 : 1; if (italic < 0) italic = 0; continue; }
    if (BLOCK[tag]) {
      if (closing) flush();
      else { flush(); cur = { style: BLOCK[tag], runs: [], isListItem: tag === "li" }; }
    }
  }
  flush();
  return out;
}

async function parseDocx(filePath: string): Promise<{ paragraphs: DocxParagraph[]; warnings: string[] }> {
  const mammoth = await import("mammoth");
  const buffer = fs.readFileSync(filePath);
  const htmlResult = await mammoth.convertToHtml(
    { buffer },
    { styleMap: ["p[style-name='List Paragraph'] => ul > li:fresh"] }
  );
  const warnings = (htmlResult.messages ?? []).map((m: { message: string }) => m.message).slice(0, 50);
  return { paragraphs: htmlToParagraphs(htmlResult.value), warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// TXT (plain and BRAC 'Style|BOLD|color|text')
// ─────────────────────────────────────────────────────────────────────────────

const BRAC_LINE_RE = /^[A-Za-z]+\|(BOLD)?\|[^|]*\|/;
const BRAC_HEADING_RE = /^(Service Provider|Objectives|Types of Services|Eligibility Criteria|Procedure to Access Service|Contact Details.*|All office Contact)\s*:?\s*$/i;

/** First ':' that is not part of http(s):// and not between two digits. */
export function splitLabelValue(text: string): { label: string; value: string } | null {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ":") continue;
    if (/https?$/i.test(text.slice(Math.max(0, i - 5), i)) && text.slice(i + 1, i + 3) === "//") continue;
    if (i > 0 && /\d/.test(text[i - 1]) && /\d/.test(text[i + 1] ?? "")) continue;
    const label = text.slice(0, i).trim();
    if (!label) return null;
    return { label, value: text.slice(i + 1).trim() };
  }
  return null;
}

export interface BracRecord {
  line: number;
  style: string | null;
  boldHint: boolean;
  color: string;
  text: string;
  isHeading: boolean;
  labelValue: { label: string; value: string } | null;
  malformed?: boolean;
}

export function parseBracTxt(content: string): BracRecord[] {
  const records: BracRecord[] = [];
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  lines.forEach((raw, i) => {
    if (!raw.trim()) return;
    const parts: string[] = [];
    let rest = raw;
    for (let k = 0; k < 3; k++) {
      const p = rest.indexOf("|");
      if (p < 0) break;
      parts.push(rest.slice(0, p));
      rest = rest.slice(p + 1);
    }
    if (parts.length < 3) {
      records.push({ line: i + 1, style: null, boldHint: false, color: "", text: raw, isHeading: false, labelValue: null, malformed: true });
      return;
    }
    const text = rest;
    const isHeading = BRAC_HEADING_RE.test(text.trim());
    records.push({
      line: i + 1,
      style: parts[0],
      boldHint: parts[1] === "BOLD",
      color: parts[2],
      text,
      isHeading,
      labelValue: isHeading ? null : splitLabelValue(text),
    });
  });
  return records;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV / XLSX
// ─────────────────────────────────────────────────────────────────────────────

async function parseCsv(filePath: string): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  const { parse } = await import("csv-parse/sync");
  const content = fs.readFileSync(filePath, "utf-8");
  const firstLine = content.split("\n")[0];
  const delimiter = firstLine.includes("\t") ? "\t" : firstLine.includes(";") ? ";" : ",";
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    delimiter,
    bom: true,
    relax_column_count: true,
  }) as Record<string, string>[];
  const headers = records.length > 0 ? Object.keys(records[0]) : [];
  return { headers, rows: records };
}

async function parseXlsx(filePath: string): Promise<{ sheets: { name: string; headers: string[]; rows: Record<string, string>[] }[] }> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.readFile(filePath);
  const sheets: { name: string; headers: string[]; rows: Record<string, string>[] }[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    const rows = jsonData.map((row) => {
      const cleaned: Record<string, string> = {};
      for (const [key, val] of Object.entries(row)) cleaned[key] = String(val ?? "").trim();
      return cleaned;
    });
    const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
    sheets.push({ name: sheetName, headers, rows });
  }
  return { sheets };
}

export function detectBracStructure(rows: Record<string, string>[]) {
  if (rows.length === 0) return { organizations: [], fieldMapping: {}, serviceColumns: [], unmappedColumns: [] };
  const headers = Object.keys(rows[0]);
  const fieldMapping: Record<string, string> = {};
  // Anchored: a header must BE the field (optionally with a short qualifier), not merely contain the word.
  const patterns: Record<string, RegExp[]> = {
    category: [/^(category|categories|part[\s_-]*heading|section|chapter)$/i],
    name: [/^(name|provider|service[\s_-]*provider|organi[sz]ation([\s_-]*name)?|org[\s_-]*name|institution|company)$/i],
    about: [/^(about|description|overview|summary|objectives?)$/i],
    address: [/^(address|location|office[\s_-]*address)$/i],
    phone: [/^(phone|telephone|tel|mobile|cell(phone)?|contact[\s_-]*(no|number)|hotline|helpline)$/i],
    email: [/^e-?mail([\s_-]*address)?$/i],
    website: [/^(website|web|url|web[\s_-]*site|site)$/i],
    fax: [/^fax$/i],
  };
  const used = new Set<string>();
  for (const [field, regexes] of Object.entries(patterns)) {
    const h = headers.find((hh) => !used.has(hh) && regexes.some((r) => r.test(hh.trim())));
    if (h) { fieldMapping[field] = h; used.add(h); }
  }
  const mapped = new Set(Object.values(fieldMapping));
  const serviceColumns = headers.filter((h) => /^(types?[\s_-]*of[\s_-]*)?services?\b/i.test(h.trim()) && !/name/i.test(h) && !mapped.has(h));
  const unmappedColumns = headers.filter((h) => !mapped.has(h) && !serviceColumns.includes(h) && !/^(sl|no|#|id|sn|row)\.?$/i.test(h.trim()));

  const organizations = rows.map((row) => {
    const org: {
      category?: string; name?: string; about?: string;
      services?: { name: string; description: string }[];
      details?: { label: string; value: string }[];
      contact?: { type: string; value: string }[];
      rawFields?: Record<string, string>;
    } = {};
    if (fieldMapping.category) org.category = row[fieldMapping.category];
    if (fieldMapping.name) org.name = row[fieldMapping.name];
    if (fieldMapping.about) org.about = row[fieldMapping.about];
    const contact: { type: string; value: string }[] = [];
    for (const t of ["address", "phone", "email", "website", "fax"]) {
      if (fieldMapping[t] && row[fieldMapping[t]]) contact.push({ type: t === "website" ? "web" : t, value: row[fieldMapping[t]] });
    }
    if (contact.length) org.contact = contact;
    const services = serviceColumns.filter((c) => row[c] && row[c].trim()).map((c) => ({ name: c, description: row[c] }));
    if (services.length) org.services = services;
    const details = unmappedColumns.filter((c) => row[c] && row[c].trim()).map((c) => ({ label: c, value: row[c] }));
    if (details.length) org.details = details;
    const rawFields: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) if (v && v.trim()) rawFields[k] = v;
    org.rawFields = rawFields;
    return org;
  });
  return { organizations, fieldMapping, serviceColumns, unmappedColumns };
}

// ─────────────────────────────────────────────────────────────────────────────
// Backups
// ─────────────────────────────────────────────────────────────────────────────

function listIndd(dir: string, depth: number, out: { path: string; sizeBytes: number; mtime: string }[]) {
  if (depth < 0 || !fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) listIndd(p, depth - 1, out);
    else if (/\.(indd|indt)$/i.test(ent.name)) {
      const st = fs.statSync(p);
      out.push({ path: p, sizeBytes: st.size, mtime: st.mtime.toISOString() });
    }
  }
}

async function backupDocument(bridge: InDesignBridge, args: Record<string, unknown>): Promise<ScriptResult> {
  return guarded(async () => {
    const info = await runTp(
      bridge,
      args,
      `var fsn = ''; try { if (doc.saved) fsn = String(doc.fullName.fsName); } catch (e) {}
       return __ok({ name: String(doc.name), saved: doc.saved, fsName: fsn, modified: doc.modified });`
    );
    if (!info.success) return info;
    const d = info.data as { name: string; saved: boolean; fsName: string; modified: boolean };
    const baseName = path.basename(d.name, path.extname(d.name)).replace(/[^A-Za-z0-9_.-]/g, "_") || "untitled";
    const dir = args.backupDir ? path.resolve(String(args.backupDir)) : path.join(BACKUP_ROOT, baseName);
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const label = args.label ? `_${String(args.label).replace(/[^a-zA-Z0-9_-]/g, "_")}` : "";
    const backupPath = assertSafeWritePath(path.join(dir, `${baseName}_backup_${stamp}${label}.indd`), [".indd"]);
    fs.mkdirSync(dir, { recursive: true });
    const t0 = Date.now();
    const r = await runTp(
      bridge,
      args,
      `var f = new File(${jsStr(toJsxPath(backupPath))});
       doc.saveACopy(f);
       return __ok({ backupPath: String(f.fsName), exists: f.exists });`,
      { timeoutMs: 600_000 }
    );
    if (!r.success) return r;
    const st = await fs.promises.stat(backupPath).catch(() => null);
    if (!st) return { success: false, error: `saveACopy reported success but ${backupPath} does not exist` };
    return {
      success: true,
      data: {
        backupPath,
        sizeBytes: st.size,
        sourceFsName: d.fsName,
        sourceHadUnsavedChanges: d.modified,
        elapsedMs: Date.now() - t0,
        note: "Backup written with doc.saveACopy (captures the in-memory state; the source document was not saved).",
      },
    };
  });
}

async function restoreBackup(bridge: InDesignBridge, args: Record<string, unknown>): Promise<ScriptResult> {
  return guarded(async () => {
    const backupPath = path.resolve(String(args.backupPath ?? ""));
    if (!args.backupPath || !fs.existsSync(backupPath)) throw new Error(`backup not found: ${backupPath}`);
    if (!isUnderWriteRoots(backupPath)) throw new Error(`backupPath must be under the write roots (${writeRoots().join("; ")})`);
    const target = assertSafeWritePath(args.targetPath, [".indd"], { overwrite: true });
    if (target.toLowerCase() === backupPath.toLowerCase()) throw new Error("backupPath and targetPath are the same file");
    const closed = await runTp(
      bridge,
      args,
      `var target = ${jsStr(target)}.toLowerCase(), closed = [];
       for (var i = app.documents.length - 1; i >= 0; i--) {
         var d = app.documents[i], f = '';
         try { if (d.saved) f = String(d.fullName.fsName); } catch (e) {}
         if (f.toLowerCase() === target) { closed.push(String(d.name)); d.close(SaveOptions.NO); }
       }
       return __ok({ closed: closed });`,
      { noDocument: true }
    );
    if (!closed.success) return closed;
    await fs.promises.copyFile(backupPath, target);
    const opened = await runTp(
      bridge,
      args,
      `var f = new File(${jsStr(toJsxPath(target))});
       if (!f.exists) return __fail('restored file not found: ' + f.fsName);
       var d = app.open(f);
       return __ok({ name: String(d.name), fsName: String(d.fullName.fsName), pageCount: d.pages.length });`,
      { noDocument: true, timeoutMs: 600_000 }
    );
    if (!opened.success) return opened;
    return { success: true, data: { restoredFrom: backupPath, ...(opened.data as object), closedBeforeRestore: (closed.data as { closed: string[] }).closed } };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot
// ─────────────────────────────────────────────────────────────────────────────

const MAX_SNAPSHOT_PAGES = 4;

async function snapshotDocument(bridge: InDesignBridge, args: Record<string, unknown>): Promise<ScriptResult> {
  return guarded(async () => {
    const range = String(args.pageRange ?? "").trim();
    const m = /^(\d+)(?:-(\d+))?$/.exec(range);
    if (!m) throw new Error(`pageRange is required, e.g. '12' or '12-15' (1-based document page positions, max ${MAX_SNAPSHOT_PAGES} pages)`);
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : start;
    if (start < 1 || end < start) throw new Error(`invalid pageRange '${range}'`);
    if (end - start + 1 > MAX_SNAPSHOT_PAGES) throw new Error(`pageRange covers ${end - start + 1} pages; max ${MAX_SNAPSHOT_PAGES} per call — split it`);
    const withRuns = args.includeCharFormatting !== false;
    const withRaw = withRuns && args.includeRawSegments === true;
    const body = jsx`
      var s0 = ${start - 1}, e0 = ${end - 1}, withRuns = ${withRuns}, withRaw = ${withRaw};
      if (e0 >= doc.pages.length) return __fail('pageRange ends at ' + (e0 + 1) + ' but the document has ' + doc.pages.length + ' pages');
      var cache = {};
      function storyInfo(st) {
        if (cache[st.id]) return cache[st.id];
        var c = __tp_str(st.contents), starts = [0];
        for (var i = 0; i < c.length; i++) if (c.charAt(i) === '\r' && i + 1 < c.length) starts.push(i + 1);
        var ids = [];
        try { var tc = st.textContainers; for (var j = 0; j < tc.length; j++) ids.push(tc[j].id); } catch (e) {}
        cache[st.id] = { starts: starts, length: st.characters.length, overflows: st.overflows, frameIds: ids, paragraphCount: starts.length, anchoredCount: __tp_count(c, '\uFFFC') };
        return cache[st.id];
      }
      function paraIndex(si, idx) {
        var lo = 0, hi = si.starts.length - 1;
        while (lo < hi) { var mid = Math.floor((lo + hi + 1) / 2); if (si.starts[mid] <= idx) lo = mid; else hi = mid - 1; }
        return lo;
      }
      function rel(page, b) { var r = __tp_spreadToPage(page, b); return [__tp_round(r[0]), __tp_round(r[1]), __tp_round(r[2]), __tp_round(r[3])]; }
      var SKIP = { Image: 1, EPS: 1, PDF: 1, ImportedPage: 1, WMF: 1, PICT: 1, Graphic: 1 };
      var out = {
        documentName: String(doc.name),
        filePath: (function () { try { return doc.saved ? String(doc.fullName.fsName) : ''; } catch (e) { return ''; } })(),
        units: 'points',
        pageSize: { width: doc.documentPreferences.pageWidth, height: doc.documentPreferences.pageHeight },
        facingPages: doc.documentPreferences.facingPages,
        pageCount: doc.pages.length,
        pages: [], stories: {}
      };
      for (var pi = s0; pi <= e0; pi++) {
        var page = doc.pages[pi];
        var pd = __tp_pageInfo(page);
        pd.pageIndex = pi;
        pd.marginBox = rel(page, __tp_marginBox(page));
        pd.frames = []; pd.items = [];
        var all = page.allPageItems;
        for (var ii = 0; ii < all.length; ii++) {
          var it = all[ii], t = __tp_type(it);
          if (SKIP[t]) continue;
          var parentGroupId = __tp_type(it.parent) === 'Group' ? it.parent.id : null;
          var anchored = __tp_isAnchored(it);
          if (t !== 'TextFrame') {
            var fill = ''; try { fill = it.fillColor.name; } catch (e) {}
            var img = false, imgPath = '';
            try { img = it.allGraphics.length > 0; if (img) imgPath = String(it.allGraphics[0].itemLink.filePath); } catch (e) {}
            pd.items.push({ id: it.id, type: t, name: it.name || '', bounds: rel(page, it.geometricBounds), fillColor: fill, hasImage: img, imagePath: imgPath, parentGroupId: parentGroupId, anchored: anchored, layer: (function () { try { return it.itemLayer.name; } catch (e) { return ''; } })() });
            continue;
          }
          var tf = it, st = tf.parentStory, si = storyInfo(st);
          var ft = tf.texts[0];
          var fStart = ft.insertionPoints[0].index, fEnd = ft.insertionPoints[-1].index;
          var fr = {
            id: tf.id, name: tf.name || '', bounds: rel(page, tf.geometricBounds),
            storyId: st.id, storyParagraphIndex: paraIndex(si, fStart),
            frameCharStart: fStart, frameCharEnd: fEnd,
            prevFrameId: (function () { try { var p = tf.previousTextFrame; return p && p.isValid ? p.id : null; } catch (e) { return null; } })(),
            nextFrameId: (function () { try { var n = tf.nextTextFrame; return n && n.isValid ? n.id : null; } catch (e) { return null; } })(),
            overflows: tf.overflows, storyOverflows: si.overflows, storyLength: si.length,
            parentGroupId: parentGroupId, anchored: anchored,
            layer: (function () { try { return tf.itemLayer.name; } catch (e) { return ''; } })(),
            paragraphs: []
          };
          var paras = tf.paragraphs;
          for (var k = 0; k < paras.length; k++) {
            var p = paras[k];
            var pStart = p.insertionPoints[0].index, pEnd = p.insertionPoints[-1].index;
            var txt = __tp_str(p.contents);
            var ps = p.appliedParagraphStyle;
            var para = {
              storyParagraphIndex: paraIndex(si, pStart),
              style: __tp_stylePath(ps), styleId: ps.id,
              text: txt,
              anchoredCount: __tp_count(txt, '\uFFFC'), tabCount: __tp_count(txt, '\t'),
              continuedFromPreviousFrame: pStart < fStart, continuesInNextFrame: pEnd > fEnd
            };
            if (txt.length !== pEnd - pStart) para.specialCharacterMismatch = true;
            if (withRuns) {
              // Effective (composed) formatting: includes GREP and nested styles.
              para.segments = __tp_effectiveRuns(p, pStart, pEnd, true);
              if (withRaw) para.rawSegments = __tp_runs(p, pStart, pEnd, true);
              var lead = 0; while (lead < txt.length && (txt.charAt(lead) === '\uFFFC' || txt.charAt(lead) === '\t')) lead++;
              var colon = __tp_labelColon(txt, lead, txt.length);
              var r0 = __tp_runAt(para.segments, lead);
              if (colon > lead && r0 && (r0.bold || r0.medium) && r0.endExclusive >= colon) {
                para.label = { text: txt.substring(lead, colon), colonAt: colon, fontStyle: r0.fontStyle };
                if (withRaw) { var rr0 = __tp_runAt(para.rawSegments, lead); para.label.rawFontStyle = rr0 ? rr0.fontStyle : null; }
              }
              var cr = __sc_colonRules(p);
              if (cr.length) para.colonStyleRules = cr;
            }
            fr.paragraphs.push(para);
          }
          pd.frames.push(fr);
        }
        out.pages.push(pd);
      }
      out.stories = cache;
      for (var sid in out.stories) { delete out.stories[sid].starts; }
      var styles = [], aps = doc.allParagraphStyles;
      for (var s = 0; s < aps.length; s++) {
        var sty = aps[s], font = '', col = '';
        try { font = sty.appliedFont.name; } catch (e) {}
        try { col = sty.fillColor.name; } catch (e) {}
        var srec = { id: sty.id, name: sty.name, path: __tp_stylePath(sty), font: font, fontStyle: __tp_str(sty.fontStyle), size: sty.pointSize, color: col };
        var gs = __sc_styleRules(sty);
        if (gs.grepStyles.length) srec.grepStyles = gs.grepStyles;
        if (gs.nestedStyles.length) srec.nestedStyles = gs.nestedStyles;
        styles.push(srec);
      }
      out.paragraphStyles = styles;
      return __ok(out);`;
    return runTp(bridge, args, body, { prelude: REPLACE_PARAGRAPHS_JSX });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Chapter color registry (chapter_registry.json at project root)
// Tracks which Pantone color is assigned to each chapter so every new chapter
// gets its own unique color and the mapping is never lost between sessions.
// ─────────────────────────────────────────────────────────────────────────────

const CHAPTER_REGISTRY_PATH = path.resolve("chapter_registry.json");

interface ChapterEntry {
  chapterNumber: number;
  chapterName: string;
  colorId?: number;
  colorName?: string;
  pantoneCode?: string;
  masterId?: number;
  masterName?: string;
  registeredAt?: string;
}

function readRegistry(): ChapterEntry[] {
  try {
    if (!fs.existsSync(CHAPTER_REGISTRY_PATH)) return [];
    return JSON.parse(fs.readFileSync(CHAPTER_REGISTRY_PATH, "utf-8")) as ChapterEntry[];
  } catch {
    return [];
  }
}

function writeRegistry(entries: ChapterEntry[]): void {
  fs.writeFileSync(CHAPTER_REGISTRY_PATH, JSON.stringify(entries, null, 2), "utf-8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerContentTools(bridge: InDesignBridge) {
  return {
    backup_document: {
      description:
        "Back up the target document BEFORE content changes. Writes doc.saveACopy() (the in-memory state, the source is NOT saved) to " +
        "test_output/_backups/<docName>/<docName>_backup_<timestamp>[_label].indd by default. Returns {backupPath, sizeBytes, sourceFsName}. " +
        "Use restore_backup to roll a run copy back.",
      inputSchema: {
        type: "object" as const,
        properties: {
          document_id: { type: "string", description: "Optional document name. If omitted, uses the active document." },
          backupDir: { type: "string", description: "Directory for the backup; must be under the write roots. Default test_output/_backups/<docName>" },
          label: { type: "string", description: "Optional label added to the filename (e.g. 'before-ch1-replace')" },
        },
      },
      handler: async (args: Record<string, unknown>) => backupDocument(bridge, args),
    },

    restore_backup: {
      description:
        "Roll a run copy back to a backup: closes the target document if it is open (WITHOUT saving — unsaved changes are discarded), " +
        "copies backupPath over targetPath and reopens it. Both paths must be under the write roots; the pristine test master can never be a target.",
      inputSchema: {
        type: "object" as const,
        properties: {
          backupPath: { type: "string", description: "Backup .indd (from backup_document / list_backups)" },
          targetPath: { type: "string", description: "Run copy .indd to overwrite (e.g. test_fixtures/runs/<label>.indd)" },
        },
        required: ["backupPath", "targetPath"],
      },
      handler: async (args: Record<string, unknown>) => restoreBackup(bridge, args),
    },

    list_backups: {
      description: "List backup .indd files (newest first) with size and modification time. Default dir test_output/_backups (searched 2 levels deep).",
      inputSchema: {
        type: "object" as const,
        properties: { dir: { type: "string", description: "Directory under the write roots. Default test_output/_backups" } },
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () => {
          const dir = args.dir ? path.resolve(String(args.dir)) : BACKUP_ROOT;
          if (!isUnderWriteRoots(dir)) throw new Error(`dir must be under the write roots (${writeRoots().join("; ")})`);
          const files: { path: string; sizeBytes: number; mtime: string }[] = [];
          listIndd(dir, 2, files);
          files.sort((a, b) => b.mtime.localeCompare(a.mtime));
          return { success: true, data: { dir, count: files.length, files } };
        }),
    },

    parse_content_file: {
      description:
        "Parse a DOCX, CSV, XLSX or TXT content file locally. DOCX -> paragraphs [{style, runs:[{text,bold,italic}], text, allBold, isListItem}] " +
        "(<br> kept as '\\n'). TXT in the BRAC 'Style|BOLD|color|text' format (auto-detected, or format:'brac-txt') -> records " +
        "[{line, style, boldHint, color, text, isHeading, labelValue:{label,value}|null}] where labelValue splits at the first ':' that is not " +
        "part of http(s)://. CSV/XLSX -> rows plus an optional BRAC organisation structure with unmappedColumns.",
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: { type: "string", description: "Absolute path to the content file (DOCX, CSV, TSV, XLSX, XLS or TXT)" },
          sheetName: { type: "string", description: "For XLSX files: specific sheet name to parse. If omitted, parses all sheets." },
          format: { type: "string", enum: ["auto", "docx", "csv", "xlsx", "txt", "brac-txt"], description: "File format. Default: auto-detect" },
          detectStructure: { type: "boolean", description: "For CSV/XLSX: detect BRAC-style organisation structure. Default: true" },
        },
        required: ["filePath"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () => {
          const filePath = String(args.filePath ?? "");
          const sheetName = args.sheetName as string | undefined;
          const detectStructure = args.detectStructure !== false;
          if (!filePath || !fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
          const fmt = String(args.format ?? "auto");
          const ext = fmt === "auto" ? path.extname(filePath).toLowerCase() : fmt === "brac-txt" ? ".brac-txt" : `.${fmt}`;
          const stats = fs.statSync(filePath);
          const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
          const startTime = Date.now();
          let result: Record<string, unknown>;

          if (ext === ".doc") {
            throw new Error("Legacy .doc files are not supported (mammoth reads .docx only). Save the file as .docx first.");
          } else if (ext === ".docx") {
            const parsed = await parseDocx(filePath);
            result = { format: "docx", filePath, fileSizeMB, paragraphCount: parsed.paragraphs.length, content: parsed.paragraphs, warnings: parsed.warnings };
          } else if (ext === ".csv" || ext === ".tsv") {
            const parsed = await parseCsv(filePath);
            result = { format: "csv", filePath, fileSizeMB, headers: parsed.headers, rowCount: parsed.rows.length, rows: parsed.rows };
            if (detectStructure && parsed.rows.length > 0) result.structuredContent = detectBracStructure(parsed.rows);
          } else if (ext === ".xlsx" || ext === ".xls") {
            const parsed = await parseXlsx(filePath);
            const targetSheets = sheetName ? parsed.sheets.filter((s) => s.name === sheetName) : parsed.sheets;
            if (sheetName && targetSheets.length === 0) {
              throw new Error(`Sheet "${sheetName}" not found. Available: ${parsed.sheets.map((s) => s.name).join(", ")}`);
            }
            result = {
              format: "xlsx", filePath, fileSizeMB,
              sheetCount: parsed.sheets.length,
              allSheetNames: parsed.sheets.map((s) => s.name),
              sheets: targetSheets.map((s) => ({
                name: s.name, headers: s.headers, rowCount: s.rows.length, rows: s.rows,
                ...(detectStructure && s.rows.length ? { structuredContent: detectBracStructure(s.rows) } : {}),
              })),
            };
          } else if (ext === ".txt" || ext === ".brac-txt") {
            const content = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
            const firstLine = content.split(/\r?\n/).find((l) => l.trim()) ?? "";
            if (ext === ".brac-txt" || BRAC_LINE_RE.test(firstLine)) {
              const records = parseBracTxt(content);
              result = {
                format: "brac-txt", filePath, fileSizeMB,
                recordCount: records.length,
                malformedLines: records.filter((r) => r.malformed).map((r) => r.line),
                headingCount: records.filter((r) => r.isHeading).length,
                records,
              };
            } else {
              const lines = content.split(/\r?\n/);
              result = { format: "txt", filePath, fileSizeMB, lineCount: lines.length, content: lines };
            }
          } else {
            throw new Error(`Unsupported format: ${ext}. Supported: .docx, .csv, .tsv, .xlsx, .xls, .txt (brac-txt)`);
          }
          result.parseTimeMs = Date.now() - startTime;
          return { success: true, data: result };
        }),
    },

    snapshot_document: {
      description:
        "Snapshot up to 4 pages in one call (pageRange REQUIRED, 1-based, e.g. '12-15'). Per page: margin box, every item incl. grouped and " +
        "anchored ones, and per text frame: storyId, storyParagraphIndex, frameCharStart/End, prev/next frame ids, overflows/storyOverflows and " +
        "paragraphs with story-relative storyParagraphIndex, style id/path, text, anchoredCount, tabCount, EFFECTIVE formatting segments " +
        "[{start,endExclusive,text,fontStyle,fontName,pointSize,fillColor,charStyle,bold,medium,source:'effective'}] (paragraph-relative offsets, " +
        "clipped to the paragraph; they include GREP and nested-style formatting, i.e. what is rendered), the detected bold label and " +
        "colonStyleRules when a GREP/nested style of the paragraph keys on ':'. includeRawSegments:true adds rawSegments (local text-style " +
        "ranges, which ignore GREP/nested styles). paragraphStyles[] lists grepStyles/nestedStyles per style. Use storyId + " +
        "storyParagraphIndex with replace_paragraphs. All values in points.",
      inputSchema: {
        type: "object" as const,
        properties: {
          pageRange: { type: "string", description: "REQUIRED. '7' or '7-10' (1-based document page positions, max 4 pages)" },
          includeCharFormatting: { type: "boolean", description: "Include effective formatting segments. Default true" },
          includeRawSegments: { type: "boolean", description: "Also include rawSegments (text-style ranges, local formatting only). Default false" },
          document_id: { type: "string", description: "Optional document name. If omitted, uses the active document." },
        },
        required: ["pageRange"],
      },
      handler: async (args: Record<string, unknown>) => snapshotDocument(bridge, args),
    },

    register_chapter_color: {
      description:
        "Record a chapter's unique Pantone color (and optional master info) in the project's chapter_registry.json. Every new chapter MUST " +
        "get its own color — never reuse another chapter's color. Call this once you have confirmed the chapter's color with the user. " +
        "Re-calling with the same chapterNumber updates the entry. Returns the full registry after the write.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chapterNumber: { type: "number", description: "Chapter number (1-based)" },
          chapterName: { type: "string", description: "Human-readable chapter title, e.g. 'Access to Finance'" },
          colorId: { type: "number", description: "InDesign swatch id for the chapter colour" },
          colorName: { type: "string", description: "Swatch name, e.g. 'Pantone 7498 C'" },
          pantoneCode: { type: "string", description: "Pantone code, e.g. '7498 C'" },
          masterId: { type: "number", description: "Master spread id used for this chapter" },
          masterName: { type: "string", description: "Master spread name, e.g. '1-Access to Finance'" },
        },
        required: ["chapterNumber", "chapterName"],
      },
      handler: async (args: Record<string, unknown>) => {
        const entries = readRegistry();
        const idx = entries.findIndex((e) => e.chapterNumber === Number(args.chapterNumber));
        const entry: ChapterEntry = {
          chapterNumber: Number(args.chapterNumber),
          chapterName: String(args.chapterName),
          registeredAt: new Date().toISOString(),
        };
        if (args.colorId !== undefined) entry.colorId = Number(args.colorId);
        if (args.colorName !== undefined) entry.colorName = String(args.colorName);
        if (args.pantoneCode !== undefined) entry.pantoneCode = String(args.pantoneCode);
        if (args.masterId !== undefined) entry.masterId = Number(args.masterId);
        if (args.masterName !== undefined) entry.masterName = String(args.masterName);
        if (idx >= 0) entries[idx] = entry; else entries.push(entry);
        entries.sort((a, b) => a.chapterNumber - b.chapterNumber);
        writeRegistry(entries);
        return { success: true, data: { saved: entry, registry: entries, registryPath: CHAPTER_REGISTRY_PATH } };
      },
    },

    list_chapter_colors: {
      description:
        "Read the project's chapter_registry.json and return all registered chapters with their colors. Use this at the start of any " +
        "chapter job to check which colors are already assigned and which chapters still need a user-confirmed color. " +
        "Returns an empty array when no chapters have been registered yet.",
      inputSchema: { type: "object" as const, properties: {}, required: [] },
      handler: async (_args: Record<string, unknown>) => {
        const entries = readRegistry();
        return { success: true, data: { chapterCount: entries.length, chapters: entries, registryPath: CHAPTER_REGISTRY_PATH } };
      },
    },

    ...registerSafeContentTools(bridge),
  };
}
