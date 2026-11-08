import type { InDesignBridge } from "../bridge/index.js";
import {
  guarded,
  jsJson,
  jsNum,
  jsNumOpt,
  jsStr,
  jsx,
  normalizeText,
  runTp,
} from "./textPipelineShared.js";
import { CONTINUE_STORY_SCHEMA, continueStory } from "./safeContent.js";

/**
 * ExtendScript helpers for frame growth. Steps are in points (__tp_run forces
 * points); growth is capped at the page's bottom margin and, when pushing,
 * only items that horizontally overlap the frame (transitively) are moved.
 */
const FIT_JSX = jsx`
function __tp_pageOf(tf) {
  var pg = null;
  try { pg = tf.parentPage; } catch (e) {}
  if (!pg || !pg.isValid) throw new Error('frame ' + tf.id + ' is not on a page (pasteboard or overset)');
  return pg;
}
function __tp_hOverlap(a, b) { return Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 0.01; }
function __tp_movable(it) { return !__tp_onLockedLayer(it) && !__tp_isMasterOverride(it) && !__tp_isAnchored(it) && !(it.locked === true); }
// mode: 'push' (move stacked items below by the growth) or 'noOverlap' (stop above the nearest item below)
function __tp_expandFrame(tf, mode, maxGrowth) {
  var page = __tp_pageOf(tf);
  var mb = __tp_marginBox(page);
  var b = tf.geometricBounds, oldBottom = b[2];
  var story = tf.parentStory;
  var top = page.pageItems, below = [];
  for (var i = 0; i < top.length; i++) {
    var it = top[i];
    if (it.id === tf.id) continue;
    var ib = it.geometricBounds;
    if (ib[0] >= oldBottom - 0.01) below.push({ item: it, b: ib });
  }
  var pushed = [], limit = mb[2] - oldBottom, blockers = [];
  if (mode === 'push') {
    var frontier = [b], changed = true, used = {};
    while (changed) {
      changed = false;
      for (var j = 0; j < below.length; j++) {
        if (used[j]) continue;
        for (var f = 0; f < frontier.length; f++) {
          if (__tp_hOverlap(below[j].b, frontier[f]) && below[j].b[0] >= frontier[f][2] - 0.01) {
            used[j] = true; pushed.push(below[j]); frontier.push(below[j].b); changed = true; break;
          }
        }
      }
    }
    for (var p = 0; p < pushed.length; p++) {
      if (!__tp_movable(pushed[p].item)) blockers.push(pushed[p].item.id);
      limit = Math.min(limit, mb[2] - pushed[p].b[2]);
    }
    if (blockers.length) return { ok: false, growth: 0, mismatch: 'items below the frame are locked/master/anchored and cannot be pushed: ' + blockers.join(', ') + '; use continue_story' };
  } else {
    for (var q = 0; q < below.length; q++) {
      if (__tp_hOverlap(below[q].b, b)) limit = Math.min(limit, below[q].b[0] - oldBottom);
    }
  }
  if (maxGrowth !== null && maxGrowth !== undefined) limit = Math.min(limit, maxGrowth);
  if (limit <= 0.01) return { ok: false, growth: 0, mismatch: 'no room to grow frame ' + tf.id + ' inside the bottom margin' + (mode === 'push' ? ' (pushed stack would cross the margin)' : ' without overlapping the item below') + '; use continue_story' };
  function setG(g) { tf.geometricBounds = [b[0], b[1], oldBottom + g, b[3]]; story.recompose(); return !tf.overflows; }
  if (!setG(limit)) { setG(0); return { ok: false, growth: 0, mismatch: 'frame ' + tf.id + ' still overflows when grown by the maximum ' + __tp_round(limit) + 'pt allowed by the margin/stack; use continue_story' }; }
  var lo = 0, hi = limit;
  for (var it2 = 0; it2 < 12 && hi - lo > 0.5; it2++) { var mid = (lo + hi) / 2; if (setG(mid)) hi = mid; else lo = mid; }
  setG(hi);
  var ids = [];
  if (mode === 'push') for (var m = 0; m < pushed.length; m++) { pushed[m].item.move(undefined, [0, hi]); ids.push(pushed[m].item.id); }
  return { ok: true, growth: __tp_round(hi), pushed: ids };
}
function __tp_threadIds(story) { var ids = []; try { var tc = story.textContainers; for (var i = 0; i < tc.length; i++) ids.push(tc[i].id); } catch (e) {} return ids; }
function __tp_isLastInThread(tf) { try { var n = tf.nextTextFrame; return !(n && n.isValid); } catch (e) { return true; } }
`;

const FRAME_RANGE_JSX = jsx`
function __tp_frameRange(tf) { var t = tf.texts[0]; return { a: t.insertionPoints[0].index, b: t.insertionPoints[-1].index }; }
`;

const ALIGN: Record<string, string> = {
  left: "Justification.LEFT_ALIGN",
  center: "Justification.CENTER_ALIGN",
  right: "Justification.RIGHT_ALIGN",
  justify: "Justification.LEFT_JUSTIFIED",
  justifyLeft: "Justification.LEFT_JUSTIFIED",
  justifyCenter: "Justification.CENTER_JUSTIFIED",
  justifyRight: "Justification.RIGHT_JUSTIFIED",
  justifyFull: "Justification.FULLY_JUSTIFIED",
};

const AUTOSIZE: Record<string, string> = {
  off: "AutoSizingTypeEnum.OFF",
  height: "AutoSizingTypeEnum.HEIGHT_ONLY",
  width: "AutoSizingTypeEnum.WIDTH_ONLY",
  heightAndWidth: "AutoSizingTypeEnum.HEIGHT_AND_WIDTH",
  heightAndWidthProportional: "AutoSizingTypeEnum.HEIGHT_AND_WIDTH_PROPORTIONALLY",
};

const SPECIAL: Record<string, string> = {
  pageNumber: "SpecialCharacters.AUTO_PAGE_NUMBER",
  nextPageNumber: "SpecialCharacters.NEXT_PAGE_NUMBER",
  previousPageNumber: "SpecialCharacters.PREVIOUS_PAGE_NUMBER",
  sectionMarker: "SpecialCharacters.SECTION_MARKER",
  bulletCharacter: "SpecialCharacters.BULLET_CHARACTER",
  emDash: "SpecialCharacters.EM_DASH",
  enDash: "SpecialCharacters.EN_DASH",
  nonBreakingHyphen: "SpecialCharacters.NONBREAKING_HYPHEN",
  discretionaryHyphen: "SpecialCharacters.DISCRETIONARY_HYPHEN",
  emSpace: "SpecialCharacters.EM_SPACE",
  enSpace: "SpecialCharacters.EN_SPACE",
  thinSpace: "SpecialCharacters.THIN_SPACE",
  hairSpace: "SpecialCharacters.HAIR_SPACE",
  nonBreakingSpace: "SpecialCharacters.NONBREAKING_SPACE",
  columnBreak: "SpecialCharacters.COLUMN_BREAK",
  frameBreak: "SpecialCharacters.FRAME_BREAK",
  pageBreak: "SpecialCharacters.PAGE_BREAK",
  oddPageBreak: "SpecialCharacters.ODD_PAGE_BREAK",
  evenPageBreak: "SpecialCharacters.EVEN_PAGE_BREAK",
  forcedLineBreak: "SpecialCharacters.FORCED_LINE_BREAK",
  tabCharacter: "SpecialCharacters.TAB_CHARACTER",
  rightIndentTab: "SpecialCharacters.RIGHT_INDENT_TAB",
  indentToHere: "SpecialCharacters.INDENT_HERE_TAB",
  endNestedStyle: "SpecialCharacters.END_NESTED_STYLE",
};

function bounds4(v: unknown, name = "bounds"): string {
  if (!Array.isArray(v) || v.length !== 4) throw new Error(`${name} must be [top, left, bottom, right] in points`);
  return "[" + v.map((x, i) => jsNum(x, `${name}[${i}]`)).join(",") + "]";
}

function mustEnum(map: Record<string, string>, v: unknown, name: string): string {
  const k = String(v);
  if (!Object.prototype.hasOwnProperty.call(map, k)) throw new Error(`${name} must be one of: ${Object.keys(map).join(", ")} (got ${JSON.stringify(v)})`);
  return map[k];
}

function optNumAssign(target: string, prop: string, v: unknown, name: string): string {
  return v === undefined || v === null ? "" : `${target}.${prop} = ${jsNum(v, name)};`;
}

function optBoolAssign(target: string, prop: string, v: unknown): string {
  return v === undefined || v === null ? "" : `${target}.${prop} = ${v === true};`;
}

export function registerTextTools(bridge: InDesignBridge) {
  return {
    create_text_frame: {
      description:
        "Create a text frame on a page. bounds [top,left,bottom,right] are in points, relative to the PAGE's top-left corner " +
        "(converted to spread coordinates internally, so facing pages work).",
      inputSchema: {
        type: "object" as const,
        properties: {
          pageIndex: { type: "number", description: "Page index (0-based document offset). Default: 0" },
          bounds: { type: "array", items: { type: "number" }, description: "[top, left, bottom, right] in points, page-relative" },
          content: { type: "string", description: "Text content (\\r = paragraph, \\n = forced line break)" },
          paragraphStyle: { type: "string", description: "Paragraph style: id, group path or unique name" },
          characterStyle: { type: "string", description: "Character style: id, group path or unique name" },
          columns: { type: "number", description: "Number of text columns" },
          columnGutter: { type: "number", description: "Column gutter in points" },
        },
        required: ["bounds"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () =>
          runTp(
            bridge,
            args,
            jsx`
              var page = __tp_requirePage(doc, ${jsNum(args.pageIndex ?? 0, "pageIndex", { int: true, min: 0 })});
              var ps = ${args.paragraphStyle ? `__tp_requireStyle(doc, 'paragraph', ${jsStr(args.paragraphStyle)})` : "null"};
              var cs = ${args.characterStyle ? `__tp_requireStyle(doc, 'character', ${jsStr(args.characterStyle)})` : "null"};
              var tf = page.textFrames.add();
              tf.geometricBounds = __tp_pageToSpread(page, ${bounds4(args.bounds)});
              ${args.columns !== undefined ? `tf.textFramePreferences.textColumnCount = ${jsNum(args.columns, "columns", { int: true, min: 1 })};` : ""}
              ${optNumAssign("tf.textFramePreferences", "textColumnGutter", args.columnGutter, "columnGutter")}
              ${args.content !== undefined ? `__tp_writeAt(tf.parentStory, 0, 0, ${jsStr(normalizeText(args.content))});` : ""}
              if (ps) tf.parentStory.paragraphs.everyItem().applyParagraphStyle(ps, false);
              if (cs) tf.parentStory.texts[0].applyCharacterStyle(cs);
              tf.parentStory.recompose();
              return __ok({ id: tf.id, storyId: tf.parentStory.id, page: __tp_pageInfo(page), bounds: __tp_spreadToPage(page, tf.geometricBounds), overflows: tf.overflows });`,
            { undoName: "create_text_frame", mutating: true }
          )
        ),
    },

    get_text_frame_content: {
      description:
        "Get a text frame's text. With frameId: the text IN THIS FRAME plus storyId, storyLength, frameTextLength, frameCharStart/End, " +
        "the thread chain and overflow flags; includeRuns:true adds text-style ranges (frame-relative offsets). Without frameId: lists every " +
        "text frame on pageIndex, including frames inside groups.",
      inputSchema: {
        type: "object" as const,
        properties: {
          frameId: { type: "number", description: "Text frame ID" },
          pageIndex: { type: "number", description: "Page index (0-based) to list frames on" },
          maxLength: { type: "number", description: "Max characters of text to return. Default: 5000" },
          includeRuns: { type: "boolean", description: "Include textStyleRanges of the frame text. Default false" },
        },
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () => {
          const maxLen = jsNum(args.maxLength ?? 5000, "maxLength", { int: true, min: 1 });
          if (args.frameId !== undefined) {
            return runTp(
              bridge,
              args,
              jsx`
                var tf = __tp_requireTextFrame(doc, ${jsNum(args.frameId, "frameId", { int: true })});
                var st = tf.parentStory, fr = __tp_frameRange(tf);
                var c = __tp_str(tf.texts[0].contents), max = ${maxLen};
                var ids = __tp_threadIds(st), pos = -1;
                for (var i = 0; i < ids.length; i++) if (ids[i] === tf.id) pos = i;
                var out = {
                  id: tf.id, storyId: st.id,
                  contents: c.length > max ? c.substring(0, max) + '...[truncated]' : c,
                  frameTextLength: fr.b - fr.a, frameCharStart: fr.a, frameCharEnd: fr.b,
                  storyLength: st.characters.length,
                  paragraphCount: tf.paragraphs.length,
                  anchoredCount: __tp_count(c, '\uFFFC'),
                  overflows: tf.overflows, storyOverflows: st.overflows,
                  threadFrameIds: ids, indexInThread: pos
                };
                if (${args.includeRuns === true}) out.runs = __tp_runs(tf.texts[0], fr.a, fr.b, true);
                return __ok(out);`,
              { prelude: FIT_JSX + FRAME_RANGE_JSX }
            );
          }
          return runTp(
            bridge,
            args,
            jsx`
              var page = __tp_requirePage(doc, ${jsNum(args.pageIndex ?? 0, "pageIndex", { int: true, min: 0 })});
              var all = page.allPageItems, frames = [];
              for (var i = 0; i < all.length; i++) {
                if (__tp_type(all[i]) !== 'TextFrame') continue;
                var tf = all[i], c = __tp_str(tf.texts[0].contents);
                frames.push({ id: tf.id, storyId: tf.parentStory.id, name: tf.name || '', contents: c.length > 200 ? c.substring(0, 200) + '...' : c,
                  bounds: __tp_spreadToPage(page, tf.geometricBounds), overflows: tf.overflows, storyOverflows: tf.parentStory.overflows,
                  inGroup: __tp_type(tf.parent) === 'Group', anchored: __tp_isAnchored(tf) });
              }
              return __ok({ page: __tp_pageInfo(page), frames: frames });`
          );
        }),
    },

    set_text_frame_content: {
      description:
        "Replace or append PLAIN text in a frame's story. REFUSES (unless mode:'replace_all_plain') when the target text contains anchored " +
        "objects (icons) or more than one formatting run, because a plain replace wipes bold labels, icons and tabs — use replace_paragraphs " +
        "for formatted BRAC content. scope 'story' (default for the first frame of a thread) replaces the whole story including overset text; " +
        "'frame' replaces only this frame's text (required explicitly for a mid-thread frame). append adds at the end of the story. " +
        "Font sizes are never changed unless autoFit:true AND allowShrink:true.",
      inputSchema: {
        type: "object" as const,
        properties: {
          frameId: { type: "number", description: "Text frame ID" },
          content: { type: "string", description: "New text (\\r = paragraph, \\n = forced line break)" },
          append: { type: "boolean", description: "Append to the end of the story instead of replacing. Default: false" },
          scope: { type: "string", enum: ["story", "frame"], description: "What to replace (see description)" },
          mode: { type: "string", enum: ["safe", "replace_all_plain"], description: "safe (default) refuses on formatted/anchored text" },
          autoFit: { type: "boolean", description: "If the story overflows afterwards, shrink proportionally — only with allowShrink:true" },
          allowShrink: { type: "boolean", description: "Permit font-size reduction for autoFit. Default false" },
          minFontSize: { type: "number", description: "Minimum font size when shrinking. Default: 6" },
        },
        required: ["frameId", "content"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () => {
          const text = normalizeText(args.content);
          const scope = args.scope === undefined ? null : String(args.scope);
          if (scope !== null && scope !== "story" && scope !== "frame") throw new Error("scope must be 'story' or 'frame'");
          const mode = String(args.mode ?? "safe");
          if (mode !== "safe" && mode !== "replace_all_plain") throw new Error("mode must be 'safe' or 'replace_all_plain'");
          const minFont = jsNum(args.minFontSize ?? 6, "minFontSize", { min: 1 });
          return runTp(
            bridge,
            args,
            jsx`
              var tf = __tp_requireTextFrame(doc, ${jsNum(args.frameId, "frameId", { int: true })});
              var st = tf.parentStory, warnings = [];
              var text = ${jsStr(text)};
              var scope = ${scope === null ? "null" : jsStr(scope)};
              if (${args.append === true}) {
                var end = st.insertionPoints[-1].index;
                __tp_writeAt(st, end, end, text);
                scope = 'append';
              } else {
                var prev = null; try { prev = tf.previousTextFrame; } catch (e) {}
                var isFirst = !(prev && prev.isValid);
                if (scope === null) {
                  if (!isFirst) return __fail('frame ' + tf.id + ' is in the middle of a thread (previous frame ' + prev.id + '); pass scope:"frame" to replace only this frame\'s text or scope:"story" to replace the whole story');
                  scope = 'story';
                }
                var a, b, runCount;
                if (scope === 'story') { a = 0; b = st.insertionPoints[-1].index; runCount = st.textStyleRanges.length; }
                else { var fr = __tp_frameRange(tf); a = fr.a; b = fr.b; runCount = tf.texts[0].textStyleRanges.length; }
                var sc = __tp_str(st.contents);
                var cur = sc.substring(a, b);
                if (scope === 'frame' && b < sc.length && cur.charAt(cur.length - 1) === '\r') { b = b - 1; cur = cur.substring(0, cur.length - 1); }
                var anchors = __tp_count(cur, '\uFFFC');
                if (${jsStr(mode)} !== 'replace_all_plain' && (anchors > 0 || runCount > 1)) {
                  return __fail('refusing to overwrite formatted text: the ' + scope + ' has ' + anchors + ' anchored object(s) and ' + runCount + ' formatting run(s); a plain replace would wipe bold labels, icons and tabs. Use replace_paragraphs, or pass mode:"replace_all_plain" to deliberately replace everything as plain text.');
                }
                __tp_writeAt(st, a, b, text);
                if (scope === 'frame') warnings.push('only this frame\'s text was replaced; text in later frames / overset text was kept');
              }
              st.recompose();
              var shrink = null;
              if (${args.autoFit === true} && st.overflows) {
                if (${args.allowShrink === true}) {
                  var last = st.textContainers[st.textContainers.length - 1];
                  shrink = __tp_shrinkStory(st, last, ${minFont}, 0.5, 8, warnings);
                } else {
                  warnings.push('story overflows; fonts were not shrunk (allowShrink is false). Use continue_story to thread the overflow to new pages.');
                }
              }
              var fr2 = __tp_frameRange(tf);
              return __ok({ id: tf.id, storyId: st.id, scope: scope, storyLength: st.characters.length, frameTextLength: fr2.b - fr2.a,
                storyOverflows: st.overflows, frameOverflows: tf.overflows, threadFrameIds: __tp_threadIds(st), shrink: shrink, warnings: warnings });`,
            { prelude: FIT_JSX + FRAME_RANGE_JSX, undoName: "set_text_frame_content", mutating: true }
          );
        }),
    },

    format_text: {
      description:
        "Apply character formatting to a frame's text. startIndex/endIndex are INCLUSIVE character indexes relative to the start of THIS " +
        "frame's text (omit both for the whole frame text). fontStyle alone changes only the style (e.g. 'Bold', '75 Bold'); fontFamily alone " +
        "keeps each run's own style. Fonts are validated; values are read back and returned.",
      inputSchema: {
        type: "object" as const,
        properties: {
          frameId: { type: "number", description: "Text frame ID" },
          startIndex: { type: "number", description: "First character (inclusive, frame-relative)" },
          endIndex: { type: "number", description: "Last character (inclusive, frame-relative). Default: startIndex" },
          fontFamily: { type: "string", description: "Font family (e.g. 'Helvetica Neue LT Pro')" },
          fontStyle: { type: "string", description: "Font style (e.g. '75 Bold', '55 Roman')" },
          fontSize: { type: "number", description: "Font size in points" },
          leading: { type: "number", description: "Leading in points (0 for auto)" },
          tracking: { type: "number" },
          kerning: { type: "string", description: "'metrics', 'optical', 'none' or a number (thousandths of an em)" },
          fillColor: { type: "string", description: "Swatch name" },
          underline: { type: "boolean" },
          strikethrough: { type: "boolean" },
          allCaps: { type: "boolean" },
          smallCaps: { type: "boolean" },
          superscript: { type: "boolean" },
          subscript: { type: "boolean" },
          baselineShift: { type: "number" },
          horizontalScale: { type: "number" },
          verticalScale: { type: "number" },
          skew: { type: "number" },
        },
        required: ["frameId"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () => {
          const hasRange = args.startIndex !== undefined && args.startIndex !== null;
          const s = hasRange ? jsNum(args.startIndex, "startIndex", { int: true, min: 0 }) : "null";
          const e = hasRange ? jsNum(args.endIndex ?? args.startIndex, "endIndex", { int: true, min: 0 }) : "null";
          let kern = "";
          if (args.kerning !== undefined && args.kerning !== null) {
            const k = String(args.kerning).toLowerCase();
            const cands: Record<string, string[]> = {
              metrics: ["$ID/Metrics", "$ID/Metric", "Metrics"],
              optical: ["$ID/Optical", "Optical"],
              none: ["$ID/None", "None"],
            };
            if (cands[k]) {
              kern = `var km = ${jsJson(cands[k])}, kok = false;
                for (var ki = 0; ki < km.length && !kok; ki++) { try { t.kerningMethod = km[ki]; kok = true; } catch (ke) {} }
                if (!kok) return __fail('could not set kerning method ' + ${jsStr(k)});`;
            } else {
              kern = `t.kerningValue = ${jsNum(args.kerning, "kerning")};`;
            }
          }
          const fam = args.fontFamily ? String(args.fontFamily) : null;
          const sty = args.fontStyle ? String(args.fontStyle) : null;
          let font = "";
          if (fam && sty) {
            font = `var f = app.fonts.itemByName(${jsStr(fam + "\t" + sty)});
              if (!__tp_valid(f)) return __fail('font not installed: ' + ${jsStr(fam + " " + sty)});
              t.appliedFont = f;`;
          } else if (fam) {
            font = `var rr = __tp_runs(t, t.insertionPoints[0].index, t.insertionPoints[-1].index, false);
              var base = t.insertionPoints[0].index;
              for (var ri = rr.length - 1; ri >= 0; ri--) {
                var ff = app.fonts.itemByName(${jsStr(fam)} + '\t' + rr[ri].fontStyle);
                if (!__tp_valid(ff)) return __fail('font ' + ${jsStr(fam)} + ' has no style ' + rr[ri].fontStyle + ' (run ' + ri + '); pass fontStyle explicitly');
                tf.parentStory.characters.itemByRange(base + rr[ri].start, base + rr[ri].endExclusive - 1).appliedFont = ff;
              }`;
          } else if (sty) {
            font = `t.fontStyle = ${jsStr(sty)};
              if (__tp_str(t.fontStyle) !== ${jsStr(sty)}) return __fail('font style ' + ${jsStr(sty)} + ' is not available for the current font');`;
          }
          const leading =
            args.leading === undefined || args.leading === null
              ? ""
              : Number(args.leading) === 0
                ? "t.leading = Leading.AUTO;"
                : `t.leading = ${jsNum(args.leading, "leading", { min: 0 })};`;
          const pos = (v: unknown, on: string) => (v === undefined || v === null ? "" : `t.position = ${v ? on : "Position.NORMAL"};`);
          const caps = (v: unknown, on: string) => (v === undefined || v === null ? "" : `t.capitalization = ${v ? on : "Capitalization.NORMAL"};`);
          return runTp(
            bridge,
            args,
            jsx`
              var tf = __tp_requireTextFrame(doc, ${jsNum(args.frameId, "frameId", { int: true })});
              var n = tf.characters.length, s = ${s}, e = ${e};
              var t;
              if (s !== null) {
                if (e < s) return __fail('endIndex < startIndex');
                if (e >= n) return __fail('endIndex ' + e + ' is past the end of the frame text (' + n + ' characters, 0-based inclusive)');
                t = tf.characters.itemByRange(s, e);
              } else {
                if (n === 0) return __fail('frame has no text');
                t = tf.texts[0];
              }
              ${font}
              ${optNumAssign("t", "pointSize", args.fontSize, "fontSize")}
              ${leading}
              ${optNumAssign("t", "tracking", args.tracking, "tracking")}
              ${kern}
              ${args.fillColor ? `var sw = doc.swatches.itemByName(${jsStr(args.fillColor)}); if (!__tp_valid(sw)) return __fail('swatch not found: ' + ${jsStr(args.fillColor)}); t.fillColor = sw;` : ""}
              ${optBoolAssign("t", "underline", args.underline)}
              ${optBoolAssign("t", "strikeThru", args.strikethrough)}
              ${caps(args.allCaps, "Capitalization.ALL_CAPS")}
              ${caps(args.smallCaps, "Capitalization.SMALL_CAPS")}
              ${pos(args.superscript, "Position.SUPERSCRIPT")}
              ${pos(args.subscript, "Position.SUBSCRIPT")}
              ${optNumAssign("t", "baselineShift", args.baselineShift, "baselineShift")}
              ${optNumAssign("t", "horizontalScale", args.horizontalScale, "horizontalScale")}
              ${optNumAssign("t", "verticalScale", args.verticalScale, "verticalScale")}
              ${optNumAssign("t", "skew", args.skew, "skew")}
              var rb = function (fn) { try { var v = fn(); return (v instanceof Array) ? 'mixed' : v; } catch (x) { return null; } };
              return __ok({ formatted: true, range: s === null ? 'frame' : [s, e],
                fontName: rb(function () { return t.appliedFont.name; }), fontStyle: rb(function () { return __tp_str(t.fontStyle); }),
                pointSize: rb(function () { return t.pointSize; }), tracking: rb(function () { return t.tracking; }),
                fillColor: rb(function () { return t.fillColor.name; }), kerningMethod: rb(function () { return __tp_str(t.kerningMethod); }),
                runs: __tp_runs(t, t.insertionPoints[0].index, t.insertionPoints[-1].index, false).length });`,
            { undoName: "format_text", mutating: true }
          );
        }),
    },

    set_paragraph_formatting: {
      description:
        "Apply paragraph formatting to one paragraph (paragraphIndex, relative to this frame) or all paragraphs of the frame. " +
        "paragraphStyle accepts an id, group path or unique name and is applied WITHOUT clearing local overrides.",
      inputSchema: {
        type: "object" as const,
        properties: {
          frameId: { type: "number", description: "Text frame ID" },
          paragraphIndex: { type: "number", description: "Paragraph index within the frame. Omit for all paragraphs" },
          alignment: { type: "string", enum: Object.keys(ALIGN) },
          leftIndent: { type: "number" },
          rightIndent: { type: "number" },
          firstLineIndent: { type: "number" },
          lastLineIndent: { type: "number" },
          spaceBefore: { type: "number" },
          spaceAfter: { type: "number" },
          dropCapLines: { type: "number" },
          dropCapCharacters: { type: "number" },
          hyphenation: { type: "boolean" },
          keepWithNext: { type: "number" },
          keepAllLinesTogether: { type: "boolean" },
          paragraphStyle: { type: "string", description: "Paragraph style id, group path or unique name" },
        },
        required: ["frameId"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () => {
          const target =
            args.paragraphIndex !== undefined && args.paragraphIndex !== null
              ? `(function () { var i = ${jsNum(args.paragraphIndex, "paragraphIndex", { int: true, min: 0 })}; if (i >= tf.paragraphs.length) throw new Error('paragraphIndex ' + i + ' out of range (' + tf.paragraphs.length + ' paragraphs in frame)'); return tf.paragraphs[i]; })()`
              : "tf.paragraphs.everyItem()";
          return runTp(
            bridge,
            args,
            jsx`
              var tf = __tp_requireTextFrame(doc, ${jsNum(args.frameId, "frameId", { int: true })});
              var p = ${target};
              ${args.alignment ? `p.justification = ${mustEnum(ALIGN, args.alignment, "alignment")};` : ""}
              ${optNumAssign("p", "leftIndent", args.leftIndent, "leftIndent")}
              ${optNumAssign("p", "rightIndent", args.rightIndent, "rightIndent")}
              ${optNumAssign("p", "firstLineIndent", args.firstLineIndent, "firstLineIndent")}
              ${optNumAssign("p", "lastLineIndent", args.lastLineIndent, "lastLineIndent")}
              ${optNumAssign("p", "spaceBefore", args.spaceBefore, "spaceBefore")}
              ${optNumAssign("p", "spaceAfter", args.spaceAfter, "spaceAfter")}
              ${optNumAssign("p", "dropCapLines", args.dropCapLines, "dropCapLines")}
              ${optNumAssign("p", "dropCapCharacters", args.dropCapCharacters, "dropCapCharacters")}
              ${optBoolAssign("p", "hyphenation", args.hyphenation)}
              ${optNumAssign("p", "keepWithNext", args.keepWithNext, "keepWithNext")}
              ${optBoolAssign("p", "keepAllLinesTogether", args.keepAllLinesTogether)}
              ${args.paragraphStyle ? `p.applyParagraphStyle(__tp_requireStyle(doc, 'paragraph', ${jsStr(args.paragraphStyle)}), false);` : ""}
              tf.parentStory.recompose();
              return __ok({ formatted: true, overflows: tf.overflows, storyOverflows: tf.parentStory.overflows });`,
            { undoName: "set_paragraph_formatting", mutating: true }
          );
        }),
    },

    thread_text_frames: {
      description: "Thread (link) two text frames so text flows from source to target.",
      inputSchema: {
        type: "object" as const,
        properties: {
          sourceFrameId: { type: "number", description: "Source text frame ID" },
          targetFrameId: { type: "number", description: "Target text frame ID" },
        },
        required: ["sourceFrameId", "targetFrameId"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () =>
          runTp(
            bridge,
            args,
            jsx`
              var src = __tp_requireTextFrame(doc, ${jsNum(args.sourceFrameId, "sourceFrameId", { int: true })});
              var tgt = __tp_requireTextFrame(doc, ${jsNum(args.targetFrameId, "targetFrameId", { int: true })});
              src.nextTextFrame = tgt;
              src.parentStory.recompose();
              return __ok({ threaded: true, source: src.id, target: tgt.id, storyId: src.parentStory.id, threadFrameIds: __tp_threadIds(src.parentStory), storyOverflows: src.parentStory.overflows });`,
            { prelude: FIT_JSX, undoName: "thread_text_frames", mutating: true }
          )
        ),
    },

    unthread_text_frame: {
      description: "Break the thread AFTER this frame (text that flowed on stays in the story and may become overset).",
      inputSchema: {
        type: "object" as const,
        properties: { frameId: { type: "number", description: "Text frame ID" } },
        required: ["frameId"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () =>
          runTp(
            bridge,
            args,
            jsx`
              var tf = __tp_requireTextFrame(doc, ${jsNum(args.frameId, "frameId", { int: true })});
              tf.nextTextFrame = NothingEnum.NOTHING;
              tf.parentStory.recompose();
              return __ok({ unthreaded: true, id: tf.id, storyOverflows: tf.parentStory.overflows });`,
            { undoName: "unthread_text_frame", mutating: true }
          )
        ),
    },

    get_text_frame_info: {
      description: "Detailed info about a text frame (also grouped/anchored frames): threading, overflow, story, columns, insets, auto-size.",
      inputSchema: {
        type: "object" as const,
        properties: { frameId: { type: "number", description: "Text frame ID" } },
        required: ["frameId"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () =>
          runTp(
            bridge,
            args,
            jsx`
              var tf = __tp_requireTextFrame(doc, ${jsNum(args.frameId, "frameId", { int: true })});
              var pg = null; try { pg = tf.parentPage; } catch (e) {}
              var nx = null, pv = null;
              try { if (tf.nextTextFrame && tf.nextTextFrame.isValid) nx = tf.nextTextFrame.id; } catch (e) {}
              try { if (tf.previousTextFrame && tf.previousTextFrame.isValid) pv = tf.previousTextFrame.id; } catch (e) {}
              var tp = tf.textFramePreferences;
              return __ok({
                id: tf.id, name: tf.name, storyId: tf.parentStory.id,
                bounds: pg && pg.isValid ? __tp_spreadToPage(pg, tf.geometricBounds) : tf.geometricBounds,
                boundsArePageRelative: !!(pg && pg.isValid),
                overflows: tf.overflows, storyOverflows: tf.parentStory.overflows,
                characterCount: tf.characters.length, paragraphCount: tf.paragraphs.length, lineCount: tf.lines.length,
                nextTextFrame: nx, previousTextFrame: pv, threadFrameIds: __tp_threadIds(tf.parentStory),
                page: pg && pg.isValid ? __tp_pageInfo(pg) : null,
                inGroup: __tp_type(tf.parent) === 'Group', anchored: __tp_isAnchored(tf),
                columns: tp.textColumnCount, columnGutter: tp.textColumnGutter,
                insetSpacing: [tp.insetSpacing[0], tp.insetSpacing[1], tp.insetSpacing[2], tp.insetSpacing[3]],
                verticalJustification: String(tp.verticalJustification), autoSizingType: String(tp.autoSizingType)
              });`,
            { prelude: FIT_JSX }
          )
        ),
    },

    resize_text_frame: {
      description: "Set a text frame's bounds [top,left,bottom,right] in points relative to the frame's current PAGE.",
      inputSchema: {
        type: "object" as const,
        properties: {
          frameId: { type: "number", description: "Text frame ID" },
          bounds: { type: "array", items: { type: "number" }, description: "New page-relative bounds in points" },
        },
        required: ["frameId", "bounds"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () =>
          runTp(
            bridge,
            args,
            jsx`
              var tf = __tp_requireTextFrame(doc, ${jsNum(args.frameId, "frameId", { int: true })});
              var pg = __tp_pageOf(tf);
              tf.geometricBounds = __tp_pageToSpread(pg, ${bounds4(args.bounds)});
              tf.parentStory.recompose();
              var mb = __tp_marginBox(pg), b = tf.geometricBounds;
              var outside = b[0] < mb[0] - 0.5 || b[1] < mb[1] - 0.5 || b[2] > mb[2] + 0.5 || b[3] > mb[3] + 0.5;
              return __ok({ resized: true, bounds: __tp_spreadToPage(pg, b), overflows: tf.overflows, outsideMargins: outside });`,
            { prelude: FIT_JSX, undoName: "resize_text_frame", mutating: true }
          )
        ),
    },

    auto_size_text_frame: {
      description:
        "Set auto-sizing for a text frame. Reference point is TOP_CENTER (grows downward); for height-based types the maximum height is " +
        "capped at the page's bottom margin when InDesign supports it. Returns resulting bounds and overflow.",
      inputSchema: {
        type: "object" as const,
        properties: {
          frameId: { type: "number", description: "Text frame ID" },
          autoSizeType: { type: "string", enum: Object.keys(AUTOSIZE), description: "Auto-size type" },
        },
        required: ["frameId", "autoSizeType"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () => {
          const type = mustEnum(AUTOSIZE, args.autoSizeType, "autoSizeType");
          return runTp(
            bridge,
            args,
            jsx`
              var tf = __tp_requireTextFrame(doc, ${jsNum(args.frameId, "frameId", { int: true })});
              var pg = __tp_pageOf(tf), tp = tf.textFramePreferences, warnings = [];
              try { tp.autoSizingReferencePoint = AutoSizingReferenceEnum.TOP_CENTER_POINT; } catch (e) { warnings.push('could not set reference point: ' + e); }
              tp.autoSizingType = ${type};
              var maxApplied = false;
              if (${args.autoSizeType !== "off" && args.autoSizeType !== "width"}) {
                var mb = __tp_marginBox(pg), maxH = mb[2] - tf.geometricBounds[0];
                try { tp.useMaximumHeightForAutoSizing = true; tp.maximumHeightForAutoSizing = maxH; maxApplied = true; } catch (e2) { warnings.push('this InDesign version has no maximum auto-size height; check the frame bottom against the margin'); }
              }
              tf.parentStory.recompose();
              return __ok({ updated: true, bounds: __tp_spreadToPage(pg, tf.geometricBounds), overflows: tf.overflows, maxHeightApplied: maxApplied, warnings: warnings });`,
            { prelude: FIT_JSX, undoName: "auto_size_text_frame", mutating: true }
          );
        }),
    },

    insert_special_character: {
      description: "Insert a special character before characterIndex (relative to this frame's text) or at the end of the story.",
      inputSchema: {
        type: "object" as const,
        properties: {
          frameId: { type: "number", description: "Text frame ID" },
          characterIndex: { type: "number", description: "Insert before this frame-relative character. Omit for end of story" },
          specialChar: { type: "string", enum: Object.keys(SPECIAL), description: "Special character type to insert" },
        },
        required: ["frameId", "specialChar"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () => {
          const ch = mustEnum(SPECIAL, args.specialChar, "specialChar");
          const idx = args.characterIndex === undefined || args.characterIndex === null ? "null" : jsNum(args.characterIndex, "characterIndex", { int: true, min: 0 });
          return runTp(
            bridge,
            args,
            jsx`
              var tf = __tp_requireTextFrame(doc, ${jsNum(args.frameId, "frameId", { int: true })});
              var idx = ${idx}, ip;
              if (idx === null) ip = tf.parentStory.insertionPoints[-1];
              else { if (idx > tf.characters.length) return __fail('characterIndex past the end of the frame text'); ip = tf.insertionPoints[idx]; }
              ip.contents = ${ch};
              return __ok({ inserted: true, storyOverflows: tf.parentStory.overflows });`,
            { undoName: "insert_special_character", mutating: true }
          );
        }),
    },

    set_text_frame_options: {
      description: "Set text frame options: vertical justification, inset spacing (points), ignore text wrap, first baseline offset.",
      inputSchema: {
        type: "object" as const,
        properties: {
          frameId: { type: "number", description: "Text frame ID" },
          verticalJustification: { type: "string", enum: ["top", "center", "bottom", "justify"] },
          insetTop: { type: "number" },
          insetBottom: { type: "number" },
          insetLeft: { type: "number" },
          insetRight: { type: "number" },
          ignoreTextWrap: { type: "boolean" },
          firstBaselineOffset: { type: "string", enum: ["ascent", "capHeight", "leading", "emBox", "xHeight", "fixed"] },
        },
        required: ["frameId"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () => {
          const VJ: Record<string, string> = {
            top: "VerticalJustification.TOP_ALIGN",
            center: "VerticalJustification.CENTER_ALIGN",
            bottom: "VerticalJustification.BOTTOM_ALIGN",
            justify: "VerticalJustification.JUSTIFY_ALIGN",
          };
          const FBO: Record<string, string> = {
            ascent: "FirstBaseline.ASCENT_OFFSET",
            capHeight: "FirstBaseline.CAP_HEIGHT",
            leading: "FirstBaseline.LEADING_OFFSET",
            emBox: "FirstBaseline.EMBOX_HEIGHT",
            xHeight: "FirstBaseline.X_HEIGHT",
            fixed: "FirstBaseline.FIXED_HEIGHT",
          };
          const anyInset = ["insetTop", "insetBottom", "insetLeft", "insetRight"].some((k) => args[k] !== undefined && args[k] !== null);
          return runTp(
            bridge,
            args,
            jsx`
              var tf = __tp_requireTextFrame(doc, ${jsNum(args.frameId, "frameId", { int: true })});
              var prefs = tf.textFramePreferences;
              ${args.verticalJustification ? `prefs.verticalJustification = ${mustEnum(VJ, args.verticalJustification, "verticalJustification")};` : ""}
              ${anyInset ? `var cur = prefs.insetSpacing; prefs.insetSpacing = [${args.insetTop != null ? jsNum(args.insetTop, "insetTop") : "cur[0]"}, ${args.insetLeft != null ? jsNum(args.insetLeft, "insetLeft") : "cur[1]"}, ${args.insetBottom != null ? jsNum(args.insetBottom, "insetBottom") : "cur[2]"}, ${args.insetRight != null ? jsNum(args.insetRight, "insetRight") : "cur[3]"}];` : ""}
              ${optBoolAssign("prefs", "ignoreWrap", args.ignoreTextWrap)}
              ${args.firstBaselineOffset ? `prefs.firstBaselineOffset = ${mustEnum(FBO, args.firstBaselineOffset, "firstBaselineOffset")};` : ""}
              tf.parentStory.recompose();
              return __ok({ updated: true, overflows: tf.overflows });`,
            { undoName: "set_text_frame_options", mutating: true }
          );
        }),
    },

    fit_text_to_frame: {
      description:
        "Fix overflow of ONE frame (the last frame of its story). expandFrame (default) grows the frame downward (binary search, <=12 " +
        "recomposes) but never past the bottom margin and never over the item below it; if that is not enough nothing is changed and a " +
        "mismatch suggests continue_story. shrinkFont/both require allowShrink:true and scale every run of the story by one factor (each " +
        "change reported as a warning).",
      inputSchema: {
        type: "object" as const,
        properties: {
          frameId: { type: "number", description: "Text frame ID" },
          method: { type: "string", enum: ["expandFrame", "shrinkFont", "both"], description: "Default: expandFrame" },
          allowShrink: { type: "boolean", description: "Required for shrinkFont/both. Default false" },
          minFontSize: { type: "number", description: "Minimum font size in points. Default: 6" },
          maxShrinkRatio: { type: "number", description: "Smallest allowed scale factor. Default 0.8" },
          maxExpand: { type: "number", description: "Max growth in points (also capped by the margin). Default: no extra cap" },
        },
        required: ["frameId"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () => {
          const method = String(args.method ?? "expandFrame");
          if (!["expandFrame", "shrinkFont", "both"].includes(method)) throw new Error("method must be expandFrame, shrinkFont or both");
          if (method !== "expandFrame" && args.allowShrink !== true) throw new Error(`method '${method}' changes font sizes; pass allowShrink:true to permit it`);
          const minFont = jsNum(args.minFontSize ?? 6, "minFontSize", { min: 1 });
          const ratio = jsNum(args.maxShrinkRatio ?? 0.8, "maxShrinkRatio", { min: 0.3, max: 1 });
          const maxExpand = jsNumOpt(args.maxExpand, "maxExpand", { min: 0 });
          return runTp(
            bridge,
            args,
            jsx`
              var tf = __tp_requireTextFrame(doc, ${jsNum(args.frameId, "frameId", { int: true })});
              var st = tf.parentStory, warnings = [], res = { id: tf.id, storyId: st.id, method: ${jsStr(method)}, changes: [], mismatches: [] };
              if (!__tp_isLastInThread(tf)) return __fail('frame ' + tf.id + ' is not the last frame of its story; fit the last frame (' + st.textContainers[st.textContainers.length - 1].id + ') or use continue_story');
              st.recompose();
              if (!tf.overflows) { res.message = 'No overflow detected'; res.overflow = false; return __ok(res); }
              var fitted = false;
              if (${jsStr(method)} !== 'shrinkFont') {
                var ex = __tp_expandFrame(tf, 'noOverlap', ${maxExpand});
                if (ex.ok) { fitted = true; res.changes.push({ action: 'expanded', growth: ex.growth }); }
                else res.mismatches.push(ex.mismatch);
              }
              if (!fitted && ${jsStr(method)} !== 'expandFrame') {
                var sh = __tp_shrinkStory(st, tf, ${minFont}, ${ratio}, 8, warnings);
                if (sh.fitted) { fitted = true; res.changes.push({ action: 'shrunk', scale: sh.scale }); }
                else res.mismatches.push('shrinking to ' + ${ratio} + ' of the original size is not enough; nothing changed; use continue_story');
              }
              st.recompose();
              res.overflow = tf.overflows; res.didFit = fitted; res.warnings = warnings;
              if (!fitted) res.suggestion = 'continue_story {storyId: ' + st.id + '}';
              return __ok(res);`,
            { prelude: FIT_JSX, undoName: "fit_text_to_frame", mutating: true }
          );
        }),
    },

    reflow_page_layout: {
      description:
        "Reflow ONE page after content changes. For each overset text frame that ends its story (top to bottom): grow it downward and push " +
        "ONLY the items stacked below it that horizontally overlap it (transitively), keeping their gaps; growth stops at the bottom margin. " +
        "If the content still does not fit, nothing is changed for that frame and a mismatch suggests continue_story. Fonts are only shrunk " +
        "with allowShrink:true (proportionally per run, each change reported). Prefer pageIndex; pageName fails if it matches several pages.",
      inputSchema: {
        type: "object" as const,
        properties: {
          pageIndex: { type: "number", description: "Page index (0-based document offset)" },
          pageName: { type: "string", description: "Page name (must be unique in the document)" },
          allowShrink: { type: "boolean", description: "Permit proportional font shrinking when growth is not enough. Default false" },
          minFontSize: { type: "number", description: "Minimum font size when shrinking. Default: 6" },
          maxShrinkRatio: { type: "number", description: "Smallest allowed scale factor. Default 0.8" },
        },
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () => {
          if ((args.pageIndex === undefined || args.pageIndex === null) && !args.pageName) throw new Error("pageIndex (preferred) or pageName is required");
          const pageExpr =
            args.pageIndex !== undefined && args.pageIndex !== null
              ? `__tp_requirePage(doc, ${jsNum(args.pageIndex, "pageIndex", { int: true, min: 0 })})`
              : `__tp_pageByName(doc, ${jsStr(args.pageName)})`;
          const minFont = jsNum(args.minFontSize ?? 6, "minFontSize", { min: 1 });
          const ratio = jsNum(args.maxShrinkRatio ?? 0.8, "maxShrinkRatio", { min: 0.3, max: 1 });
          return runTp(
            bridge,
            args,
            jsx`
              var page = ${pageExpr};
              var t0 = __tp_now(), warnings = [], changes = [], mismatches = [];
              var frames = [];
              for (var i = 0; i < page.textFrames.length; i++) frames.push(page.textFrames[i]);
              frames.sort(function (a, b) { return a.geometricBounds[0] - b.geometricBounds[0]; });
              var partial = false;
              for (var f = 0; f < frames.length; f++) {
                if (__tp_now() - t0 > 100000) { partial = true; warnings.push('stopped by the 100 s guard; call again'); break; }
                var tf = frames[f], st = tf.parentStory;
                st.recompose();
                if (!tf.overflows) continue;
                if (!__tp_isLastInThread(tf)) continue;
                var ex = __tp_expandFrame(tf, 'push', null);
                if (ex.ok) { changes.push({ frame: tf.id, action: 'expanded', growth: ex.growth, pushed: ex.pushed }); continue; }
                if (${args.allowShrink === true}) {
                  var sh = __tp_shrinkStory(st, tf, ${minFont}, ${ratio}, 8, warnings);
                  if (sh.fitted) { changes.push({ frame: tf.id, action: 'shrunk', scale: sh.scale }); continue; }
                }
                mismatches.push({ frame: tf.id, storyId: st.id, reason: ex.mismatch, suggestion: 'continue_story {storyId: ' + st.id + '}' });
              }
              var still = [];
              var all = page.allPageItems;
              for (var k = 0; k < all.length; k++) if (__tp_type(all[k]) === 'TextFrame' && all[k].parentStory.overflows && __tp_isLastInThread(all[k])) still.push({ frame: all[k].id, storyId: all[k].parentStory.id });
              return __ok({ page: __tp_pageInfo(page), changes: changes, mismatches: mismatches, warnings: warnings, stillOverset: still, partial: partial });`,
            { prelude: FIT_JSX, undoName: "reflow_page_layout", mutating: true }
          );
        }),
    },

    // continue_story itself is registered from safeContent.ts (via registerContentTools).
    cascade_reflow: {
      description:
        "DEPRECATED alias of continue_story. Requires storyId (or frameId). The old behaviour (moving footers/decorations to other pages, " +
        "shifting every item on the next page, shrinking fonts, appending pages at the end of the book) has been removed.",
      inputSchema: CONTINUE_STORY_SCHEMA,
      handler: async (args: Record<string, unknown>) => continueStory(bridge, args),
    },

    check_overset_text: {
      description: "List every overset story in the document (includes frames inside groups and anchored frames).",
      inputSchema: { type: "object" as const, properties: {} },
      handler: async (args: Record<string, unknown>) =>
        runTp(
          bridge,
          args,
          jsx`
            var overset = [];
            for (var i = 0; i < doc.stories.length; i++) {
              var story = doc.stories[i];
              if (!story.overflows) continue;
              var frames = [];
              for (var j = 0; j < story.textContainers.length; j++) {
                var c = story.textContainers[j], pg = null;
                try { pg = c.parentPage; } catch (e) {}
                frames.push({ id: c.id, page: pg && pg.isValid ? pg.name : null, documentOffset: pg && pg.isValid ? pg.documentOffset : null, inGroup: __tp_type(c.parent) === 'Group' });
              }
              overset.push({ storyId: story.id, characterCount: story.characters.length, frames: frames });
            }
            return __ok({ oversetStories: overset.length, details: overset });`
        ),
    },
  };
}
