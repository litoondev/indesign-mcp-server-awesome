import type { InDesignBridge } from "../bridge/index.js";
import path from "path";
import {
  assertSafeWritePath,
  guarded,
  jsJson,
  jsNum,
  jsStr,
  jsx,
  normalizeText,
  runTp,
  toJsxPath,
} from "./textPipelineShared.js";
import { REPLACE_PARAGRAPHS_JSX } from "./safeContent.js";

const TEMPLATE_JSX = jsx`
function __tp_onMaster(item) {
  try { var p = item.parent; while (p) { var t = __tp_type(p); if (t === 'MasterSpread') return true; if (t === 'Spread' || t === 'Document') return false; p = p.parent; } } catch (e) {}
  return false;
}
function __tp_isTocStory(story) { try { return story.storyType === StoryTypes.TOC_STORY; } catch (e) { return false; } }
// Story is cleared only when every container is on a document page (not a master) and it is not a TOC story.
function __tp_clearableStory(story) {
  if (__tp_isTocStory(story)) return false;
  var tc = story.textContainers;
  if (!tc.length) return false;
  for (var i = 0; i < tc.length; i++) if (__tp_onMaster(tc[i])) return false;
  return true;
}
function __tp_clearStoryKeepAnchors(story, placeholder) {
  var n = story.paragraphs.length, removed = 0;
  for (var i = n - 1; i >= 0; i--) removed += __tp_clearParagraphKeepAnchors(story, story.paragraphs[i], i === 0 ? placeholder : '');
  return removed;
}
// Non-anchored text frames on a page in allPageItems order, grouped frames included.
function __tp_pageFrames(page) {
  var all = page.allPageItems, out = [];
  for (var i = 0; i < all.length; i++) {
    var it = all[i];
    if (__tp_type(it) !== 'TextFrame' || __tp_isAnchored(it)) continue;
    out.push(it);
  }
  return out;
}
function __tp_framesByName(page, name) {
  var fr = __tp_pageFrames(page), hits = [];
  for (var i = 0; i < fr.length; i++) if (fr[i].name === name) hits.push(fr[i]);
  return hits;
}
function __tp_placeholderHit(tf) { try { return /Lorem|ipsum|dolor sit/i.test(__tp_str(tf.parentStory.contents)); } catch (e) { return false; } }
function __tp_pageMap(doc, from, max) {
  var out = [];
  for (var i = Math.max(0, from); i < doc.pages.length && out.length < max; i++) out.push(__tp_pageInfo(doc.pages[i]));
  return out;
}
`;

export function registerTemplateTools(bridge: InDesignBridge) {
  return {
    create_template_from_page: {
      description:
        "Save a copy of the document as a template (.indt stationery, or .indd). Text is cleared per paragraph keeping anchored icons, tabs " +
        "and paragraph returns (so styles survive); stories on master spreads and the TOC are left untouched. Only non-anchored placed images " +
        "are removed, and only when keepImages:false (default keeps them). The source document is not modified; the output path must be under " +
        "the write roots.",
      inputSchema: {
        type: "object" as const,
        properties: {
          outputPath: { type: "string", description: "Output .indt (or .indd) path under the write roots" },
          clearContent: { type: "boolean", description: "Clear text content (keep frames, anchors, tabs, returns). Default: true" },
          keepImages: { type: "boolean", description: "Keep placed images. Default: true" },
          placeholderText: { type: "string", description: "Text put into the first paragraph of each cleared story" },
          overwrite: { type: "boolean", description: "Allow replacing an existing file. Default false" },
        },
        required: ["outputPath"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () => {
          const out = assertSafeWritePath(args.outputPath, [".indt", ".indd"], { overwrite: args.overwrite === true });
          const isIndt = path.extname(out).toLowerCase() === ".indt";
          const tmp = assertSafeWritePath(
            path.join(path.dirname(out), `${path.basename(out, path.extname(out))}__tmp_${Date.now()}.indd`),
            [".indd"]
          );
          return runTp(
            bridge,
            args,
            jsx`
              var outF = new File(${jsStr(toJsxPath(out))}), tmpF = new File(${jsStr(toJsxPath(tmp))});
              doc.saveACopy(tmpF);
              var t = null, res = { clearedStories: 0, skippedStories: [], removedImages: 0, keptAnchoredImages: 0 };
              try {
                t = app.open(tmpF, false, OpenOptions.OPEN_ORIGINAL);
                if (${args.clearContent !== false}) {
                  for (var i = 0; i < t.stories.length; i++) {
                    var s = t.stories[i];
                    if (!__tp_clearableStory(s)) { res.skippedStories.push({ storyId: s.id, reason: __tp_isTocStory(s) ? 'toc' : 'master/no frames' }); continue; }
                    try { __tp_clearStoryKeepAnchors(s, ${jsStr(normalizeText(args.placeholderText ?? ""))}); res.clearedStories++; }
                    catch (e) { res.skippedStories.push({ storyId: s.id, reason: String(e) }); }
                  }
                }
                if (${args.keepImages === false}) {
                  for (var l = t.links.length - 1; l >= 0; l--) {
                    try {
                      var g = t.links[l].parent, fr = g.parent;
                      if (__tp_isAnchored(fr) || __tp_onMaster(fr)) { res.keptAnchoredImages++; continue; }
                      g.remove(); res.removedImages++;
                    } catch (e2) {}
                  }
                }
                t.save(outF, ${isIndt});
                res.path = String(outF.fsName);
                res.stationery = ${isIndt};
              } finally {
                try { if (t) t.close(SaveOptions.NO); } catch (e3) {}
                try { tmpF.remove(); } catch (e4) {}
              }
              return __ok(res);`,
            { prelude: TEMPLATE_JSX, timeoutMs: 600_000 }
          );
        }),
    },

    apply_template_content: {
      description:
        "Fill named/identified frames with content WITHOUT losing formatting. Each entry targets one frame: frameId, or frameName + pageIndex " +
        "(searched among all frames on that page incl. grouped ones; 0 or >1 matches is an error), or pageIndex + frameIndex. Content is " +
        "written through replace_paragraphs: `content` must have exactly as many paragraphs (\\r separated) as the template story from this " +
        "frame on, or give `edits` (replace_paragraphs edits). Otherwise the entry is a mismatch and nothing is written for it.",
      inputSchema: {
        type: "object" as const,
        properties: {
          contentMap: {
            type: "array",
            items: {
              type: "object",
              properties: {
                frameName: { type: "string", description: "Frame name (requires pageIndex)" },
                frameId: { type: "number" },
                pageIndex: { type: "number", description: "0-based page offset (with frameName or frameIndex)" },
                frameIndex: { type: "number", description: "Index in page.textFrames (top-level frames)" },
                content: { type: "string", description: "Text; one paragraph per template paragraph" },
                edits: { type: "array", items: { type: "object" }, description: "replace_paragraphs edits for this frame's story" },
                paragraphStyle: { type: "string", description: "Paragraph style (id/path/name) applied without clearing overrides" },
              },
            },
          },
          dryRun: { type: "boolean" },
        },
        required: ["contentMap"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () => {
          if (!Array.isArray(args.contentMap) || !args.contentMap.length) throw new Error("contentMap must be a non-empty array");
          const map = (args.contentMap as Record<string, unknown>[]).map((e, i) => {
            if (e.frameName !== undefined && (e.pageIndex === undefined || e.pageIndex === null)) throw new Error(`contentMap[${i}]: frameName requires pageIndex`);
            const o: Record<string, unknown> = { ...e };
            if (o.content !== undefined) o.content = normalizeText(o.content);
            if (Array.isArray(o.edits)) o.edits = (o.edits as Record<string, unknown>[]).map((x) => ({ ...x, text: x.text !== undefined ? normalizeText(x.text) : undefined, label: x.label !== undefined ? normalizeText(x.label) : undefined, value: x.value !== undefined ? normalizeText(x.value) : undefined }));
            return o;
          });
          const dry = args.dryRun === true;
          return runTp(
            bridge,
            args,
            jsx`
              var map = ${jsJson(map)}, results = [], dry = ${dry};
              for (var i = 0; i < map.length; i++) {
                var e = map[i], tf = null, page = null;
                try {
                  if (e.frameId !== undefined && e.frameId !== null) tf = __tp_requireTextFrame(doc, e.frameId);
                  else if (e.frameName !== undefined) {
                    page = __tp_requirePage(doc, e.pageIndex);
                    var hits = __tp_framesByName(page, e.frameName);
                    if (hits.length !== 1) { results.push({ index: i, success: false, error: hits.length + " frames named '" + e.frameName + "' on page index " + e.pageIndex }); continue; }
                    tf = hits[0];
                  } else if (e.pageIndex !== undefined && e.frameIndex !== undefined) {
                    page = __tp_requirePage(doc, e.pageIndex);
                    if (e.frameIndex < 0 || e.frameIndex >= page.textFrames.length) { results.push({ index: i, success: false, error: 'frameIndex out of range' }); continue; }
                    tf = page.textFrames[e.frameIndex];
                  } else { results.push({ index: i, success: false, error: 'give frameId, frameName+pageIndex or pageIndex+frameIndex' }); continue; }
                  var pg = null; try { pg = tf.parentPage; } catch (x) {}
                  var r;
                  if (e.edits) r = { result: __tp_replaceParagraphs(doc, tf.parentStory, e.edits, { keepLeadingAnchors: true, dryRun: dry }) };
                  else if (e.content !== undefined) r = __tp_fillFrameStory(doc, tf, e.content, dry);
                  else r = { result: null };
                  if (e.paragraphStyle && !dry) tf.paragraphs.everyItem().applyParagraphStyle(__tp_requireStyle(doc, 'paragraph', e.paragraphStyle), false);
                  var anchorsChanged = r.result && r.result.rollbackRequired;
                  results.push({ index: i, success: !r.mismatch && !anchorsChanged && (!r.result || r.result.mismatches.length === 0), frameId: tf.id, storyId: tf.parentStory.id,
                    page: pg && pg.isValid ? __tp_pageInfo(pg) : null, mismatch: r.mismatch || null,
                    mismatches: r.result ? r.result.mismatches : [], anchorsChanged: !!anchorsChanged,
                    overflows: tf.overflows, storyOverflows: tf.parentStory.overflows, placeholderHit: __tp_placeholderHit(tf) });
                } catch (err) { results.push({ index: i, success: false, error: String(err.message || err) }); }
              }
              return __ok({ results: results, allApplied: (function () { for (var k = 0; k < results.length; k++) if (!results[k].success) return false; return true; })() });`,
            { prelude: REPLACE_PARAGRAPHS_JSX + TEMPLATE_JSX, undoName: dry ? undefined : "apply_template_content", mutating: !dry }
          );
        }),
    },

    name_text_frames: {
      description: "Assign names to text frames (by frameId, or pageIndex + frameIndex into page.textFrames) for template mapping.",
      inputSchema: {
        type: "object" as const,
        properties: {
          nameMappings: {
            type: "array",
            items: {
              type: "object",
              properties: { frameId: { type: "number" }, pageIndex: { type: "number" }, frameIndex: { type: "number" }, name: { type: "string" } },
            },
          },
        },
        required: ["nameMappings"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () =>
          runTp(
            bridge,
            args,
            jsx`
              var mappings = ${jsJson(args.nameMappings ?? [])}, results = [];
              for (var i = 0; i < mappings.length; i++) {
                var m = mappings[i];
                try {
                  var tf = (m.frameId !== undefined && m.frameId !== null) ? __tp_requireTextFrame(doc, m.frameId) : __tp_requirePage(doc, m.pageIndex).textFrames[m.frameIndex];
                  if (!__tp_valid(tf)) throw new Error('frame not found');
                  tf.name = String(m.name);
                  results.push({ index: i, success: true, id: tf.id, name: tf.name });
                } catch (e) { results.push({ index: i, success: false, error: String(e.message || e) }); }
              }
              return __ok(results);`,
            { undoName: "name_text_frames", mutating: true }
          )
        ),
    },

    duplicate_page_with_content: {
      description:
        "Duplicate a page (or its whole spread with duplicateSpread:true, which keeps left/right parity) and fill the copy. contentMap " +
        "entries {frameIndex|frameName, content} are written through replace_paragraphs (one paragraph per template paragraph, empty " +
        "string clears). By default every text frame on the page must be mapped (requireAllFramesMapped) so no template text survives " +
        "silently. Returns per-frame {id, filled, overflows, placeholderHit}, the updated page map and a parity warning.",
      inputSchema: {
        type: "object" as const,
        properties: {
          sourcePageIndex: { type: "number", description: "Page to duplicate (0-based offset)" },
          contentMap: {
            type: "array",
            items: {
              type: "object",
              properties: {
                frameIndex: { type: "number", description: "Index among the page's frames (allPageItems order, grouped included)" },
                frameName: { type: "string" },
                content: { type: "string" },
              },
            },
          },
          count: { type: "number", description: "Number of copies (1-20). Default: 1" },
          requireAllFramesMapped: { type: "boolean", description: "Fail before duplicating if a frame is not in contentMap. Default true" },
          duplicateSpread: { type: "boolean", description: "Duplicate the whole spread (keeps facing parity). Default false" },
        },
        required: ["sourcePageIndex"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () => {
          const map = Array.isArray(args.contentMap)
            ? (args.contentMap as Record<string, unknown>[]).map((e) => ({ ...e, content: e.content !== undefined ? normalizeText(e.content) : undefined }))
            : [];
          const count = jsNum(args.count ?? 1, "count", { int: true, min: 1, max: 20 });
          return runTp(
            bridge,
            args,
            jsx`
              var srcPage = __tp_requirePage(doc, ${jsNum(args.sourcePageIndex, "sourcePageIndex", { int: true, min: 0 })});
              var map = ${jsJson(map)}, count = ${count}, requireAll = ${args.requireAllFramesMapped !== false}, spreadMode = ${args.duplicateSpread === true};
              function resolve(page, entry) {
                var fr = __tp_pageFrames(page);
                if (entry.frameName !== undefined) { var h = __tp_framesByName(page, entry.frameName); return h.length === 1 ? h[0] : null; }
                if (entry.frameIndex !== undefined) return fr[entry.frameIndex] || null;
                return null;
              }
              var srcFrames = __tp_pageFrames(srcPage), mapped = {};
              for (var i = 0; i < map.length; i++) { var f0 = resolve(srcPage, map[i]); if (!f0) return __fail('contentMap[' + i + '] does not resolve to exactly one frame on the source page'); mapped[f0.id] = true; }
              var unmapped = [];
              for (var u = 0; u < srcFrames.length; u++) {
                var sf = srcFrames[u];
                var startsHere = true;
                try { var pv = sf.previousTextFrame; startsHere = !(pv && pv.isValid); } catch (e) {}
                if (!mapped[sf.id] && startsHere && __tp_str(sf.parentStory.contents).replace(/[\s\uFFFC]/g, '') !== '') unmapped.push({ frameIndex: u, id: sf.id, name: sf.name || '', text: __tp_str(sf.texts[0].contents).substring(0, 80) });
              }
              if (requireAll && unmapped.length) return __fail('frames on the source page are not in contentMap (their template text would survive): ' + JSON.stringify(unmapped) + '. Map them (content "" clears) or pass requireAllFramesMapped:false.');
              var created = [], firstNew = null, added = 0, src = srcPage;
              for (var c = 0; c < count; c++) {
                var dup;
                if (spreadMode) {
                  var sp = src.parent, posInSpread = 0;
                  for (var q = 0; q < sp.pages.length; q++) if (sp.pages[q].id === src.id) posInSpread = q;
                  var nsp = sp.duplicate(LocationOptions.AFTER, sp);
                  dup = nsp.pages[posInSpread];
                  added += nsp.pages.length;
                } else {
                  dup = src.duplicate(LocationOptions.AFTER, src);
                  added += 1;
                }
                if (firstNew === null) firstNew = dup.documentOffset;
                var frames = [];
                for (var m = 0; m < map.length; m++) {
                  var tf = resolve(dup, map[m]);
                  if (!tf) { frames.push({ entry: m, filled: false, error: 'frame not found on duplicate' }); continue; }
                  var r = { filled: true };
                  if (map[m].content !== undefined) r = __tp_fillFrameStory(doc, tf, map[m].content, false);
                  frames.push({ entry: m, id: tf.id, filled: !!r.filled, mismatch: r.mismatch || (r.result && r.result.mismatches.length ? r.result.mismatches : null), overflows: tf.parentStory.overflows, placeholderHit: __tp_placeholderHit(tf) });
                }
                created.push({ page: __tp_pageInfo(dup), frames: frames });
                src = dup;
              }
              var warnings = [];
              if (doc.documentPreferences.facingPages && added % 2 === 1) warnings.push('facing-parity: ' + added + ' page(s) inserted; every later page switched left/right side. Use duplicateSpread:true or add an even number of pages.');
              return __ok({ created: created, pagesInserted: added, unmappedFrames: unmapped, pageMap: __tp_pageMap(doc, firstNew === null ? 0 : firstNew - 1, 60), pageCount: doc.pages.length, warnings: warnings });`,
            { prelude: REPLACE_PARAGRAPHS_JSX + TEMPLATE_JSX, undoName: "duplicate_page_with_content", mutating: true }
          );
        }),
    },

    clone_page_layout: {
      description:
        "Clone the layout of one page onto another (one undo step): copies every non-master-override item to the target at the same " +
        "page-relative position (correct on facing spreads), clears copied text while keeping anchored icons/tabs/returns (also inside " +
        "groups) and suffixes copied names with the target page name. clearTargetFirst (default true) removes existing target items " +
        "(overridden master items are reverted instead).",
      inputSchema: {
        type: "object" as const,
        properties: {
          sourcePageIndex: { type: "number" },
          targetPageIndex: { type: "number" },
          clearTargetFirst: { type: "boolean", description: "Remove existing items on target. Default: true" },
        },
        required: ["sourcePageIndex", "targetPageIndex"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () =>
          runTp(
            bridge,
            args,
            jsx`
              var src = __tp_requirePage(doc, ${jsNum(args.sourcePageIndex, "sourcePageIndex", { int: true, min: 0 })});
              var tgt = __tp_requirePage(doc, ${jsNum(args.targetPageIndex, "targetPageIndex", { int: true, min: 0 })});
              if (src.id === tgt.id) return __fail('source and target are the same page');
              var res = { removed: 0, reverted: 0, copied: [], skippedMasterOverrides: 0, warnings: [] };
              if (${args.clearTargetFirst !== false}) {
                for (var i = tgt.pageItems.length - 1; i >= 0; i--) {
                  var ti = tgt.pageItems[i];
                  try { if (__tp_isMasterOverride(ti)) { ti.removeOverride(); res.reverted++; } else { ti.remove(); res.removed++; } } catch (e) { res.warnings.push('could not remove ' + ti.id + ': ' + e); }
                }
              }
              try { tgt.appliedMaster = src.appliedMaster; } catch (e) {}
              try { tgt.marginPreferences.properties = src.marginPreferences.properties; } catch (e) {}
              var items = [];
              for (var j = 0; j < src.pageItems.length; j++) items.push(src.pageItems[j]);
              for (var k = 0; k < items.length; k++) {
                var item = items[k];
                if (__tp_isMasterOverride(item)) { res.skippedMasterOverrides++; continue; }
                var relB = __tp_spreadToPage(src, item.geometricBounds);
                var dup = item.duplicate();
                dup.move(tgt);
                var want = __tp_pageToSpread(tgt, relB), cur = dup.geometricBounds;
                dup.move(undefined, [want[1] - cur[1], want[0] - cur[0]]);
                var all = [dup];
                try { var nested = dup.allPageItems; for (var n = 0; n < nested.length; n++) all.push(nested[n]); } catch (e) {}
                for (var a = 0; a < all.length; a++) {
                  var it = all[a];
                  if (__tp_type(it) === 'TextFrame') { try { var sto = it.parentStory; for (var pp = sto.paragraphs.length - 1; pp >= 0; pp--) __tp_clearParagraphKeepAnchors(sto, sto.paragraphs[pp], ''); } catch (e) { res.warnings.push('text not cleared in ' + it.id + ': ' + e); } }
                  try { if (it.name) it.name = it.name + '_' + tgt.name; } catch (e) {}
                }
                var onPage = false;
                try { onPage = dup.parentPage && dup.parentPage.id === tgt.id; } catch (e) {}
                if (!onPage) res.warnings.push('copy of item ' + item.id + ' did not land on the target page');
                res.copied.push({ sourceId: item.id, newId: dup.id, onTargetPage: onPage });
              }
              res.target = __tp_pageInfo(tgt);
              return __ok(res);`,
            { prelude: TEMPLATE_JSX, undoName: "clone_page_layout", mutating: true }
          )
        ),
    },
  };
}
