import type { InDesignBridge } from "../bridge/index.js";
import { guarded, jsJson, jsNum, jsStr, jsx, runTp } from "./textPipelineShared.js";
import { CT_PRELUDE, registerChapterThemeTools } from "./chapterTheme.js";

const KINDS = ["paragraph", "character", "object"] as const;
type Kind = (typeof KINDS)[number];

function mustKind(v: unknown): Kind {
  if (!KINDS.includes(v as Kind)) throw new Error(`styleType must be one of ${KINDS.join(", ")} (got ${JSON.stringify(v)})`);
  return v as Kind;
}

/** ExtendScript expression resolving a style (id, group path or unique name), or failing. */
function styleRef(kind: Kind, ref: unknown, what = "style"): string {
  if (ref === undefined || ref === null || ref === "") throw new Error(`${what} is required`);
  return `__tp_requireStyle(doc, '${kind}', ${typeof ref === "number" ? jsNum(ref, what, { int: true }) : jsStr(ref)})`;
}

function fontExpr(family: unknown, style: unknown): string {
  if (!family) return "";
  const name = style ? `${String(family)}\t${String(style)}` : String(family);
  return `var __f = app.fonts.itemByName(${jsStr(name)}); if (!__tp_valid(__f)) return __fail('font not installed: ' + ${jsStr(name.replace("\t", " "))}); s.appliedFont = __f;`;
}

const ALIGN: Record<string, string> = {
  left: "Justification.LEFT_ALIGN",
  center: "Justification.CENTER_ALIGN",
  right: "Justification.RIGHT_ALIGN",
  justify: "Justification.LEFT_JUSTIFIED",
  justifyFull: "Justification.FULLY_JUSTIFIED",
};

const n = (target: string, prop: string, v: unknown, name: string) => (v === undefined || v === null ? "" : `${target}.${prop} = ${jsNum(v, name)};`);
const b = (target: string, prop: string, v: unknown) => (v === undefined || v === null ? "" : `${target}.${prop} = ${v === true};`);
const has = (v: unknown) => v !== undefined && v !== null && v !== "";
const MAX_PARAGRAPHS = 1000;

/**
 * Property setter that records which property failed (e.g. paragraphBorderColor
 * on an InDesign version without paragraph borders) instead of aborting with an
 * anonymous error. The body checks __setErr afterwards.
 */
const SET_HELPER = jsx`
function __st_set(o, prop, v, errs) { try { o[prop] = v; } catch (e) { errs.push(prop + ': ' + String(e && e.message ? e.message : e)); } }
`;

/** Every enable* category of an ObjectStyle (InDesign CC). Unknown ones are skipped at runtime. */
const OBJECT_STYLE_CATEGORIES = [
  "enableFill", "enableStroke", "enableStrokeAndCornerOptions", "enableParagraphStyle", "enableTextFrameGeneralOptions",
  "enableTextFrameBaselineOptions", "enableTextFrameColumnRuleOptions", "enableTextFrameFootnoteOptions", "enableTextWrapAndOthers",
  "enableAnchoredObjectOptions", "enableStoryOptions", "enableTextFrameAutoSizingOptions", "enableFrameFittingOptions",
  "enableDimensionsAndPosition", "enableExportTagging", "enableObjectExportAltTextOptions", "enableObjectExportTaggedPdfOptions",
  "enableObjectExportEpubOptions",
  // effects: object / stroke / fill / content
  "enableTransparency", "enableDropShadow", "enableFeather", "enableInnerShadow", "enableOuterGlow", "enableInnerGlow",
  "enableBevelAndEmboss", "enableSatin", "enableDirectionalFeather", "enableGradientFeather",
  "enableStrokeTransparency", "enableStrokeDropShadow", "enableStrokeFeather", "enableStrokeInnerShadow", "enableStrokeOuterGlow",
  "enableStrokeInnerGlow", "enableStrokeBevelAndEmboss", "enableStrokeSatin", "enableStrokeDirectionalFeather", "enableStrokeGradientFeather",
  "enableFillTransparency", "enableFillDropShadow", "enableFillFeather", "enableFillInnerShadow", "enableFillOuterGlow",
  "enableFillInnerGlow", "enableFillBevelAndEmboss", "enableFillSatin", "enableFillDirectionalFeather", "enableFillGradientFeather",
  "enableContentTransparency", "enableContentDropShadow", "enableContentFeather", "enableContentInnerShadow", "enableContentOuterGlow",
  "enableContentInnerGlow", "enableContentBevelAndEmboss", "enableContentSatin", "enableContentDirectionalFeather", "enableContentGradientFeather",
];

export function registerStyleTools(bridge: InDesignBridge) {
  return {
    ...registerChapterThemeTools(bridge),

    list_paragraph_styles: {
      description: "List all paragraph styles (including styles inside style groups) with id, group path and key properties.",
      inputSchema: { type: "object" as const, properties: {} },
      handler: async (args: Record<string, unknown>) =>
        runTp(
          bridge,
          args,
          jsx`
            var all = doc.allParagraphStyles, styles = [];
            for (var i = 0; i < all.length; i++) {
              var s = all[i];
              try {
                styles.push({
                  id: s.id, name: s.name, path: __tp_stylePath(s),
                  basedOn: (function () { try { return s.basedOn && s.basedOn.name !== undefined ? __tp_stylePath(s.basedOn) : null; } catch (e) { return null; } })(),
                  nextStyle: (function () { try { return s.nextStyle ? __tp_stylePath(s.nextStyle) : null; } catch (e) { return null; } })(),
                  font: (function () { try { return s.appliedFont.name; } catch (e) { return ''; } })(),
                  fontStyle: __tp_str(s.fontStyle), fontSize: s.pointSize, leading: __tp_str(s.leading),
                  fillColor: (function () { try { return s.fillColor.name; } catch (e) { return ''; } })(),
                  justification: __tp_str(s.justification), spaceBefore: s.spaceBefore, spaceAfter: s.spaceAfter, hyphenation: s.hyphenation
                });
              } catch (e) {}
            }
            return __ok(styles);`
        ),
    },

    list_character_styles: {
      description: "List all character styles (including grouped ones) with id and group path.",
      inputSchema: { type: "object" as const, properties: {} },
      handler: async (args: Record<string, unknown>) =>
        runTp(
          bridge,
          args,
          jsx`
            var all = doc.allCharacterStyles, styles = [];
            for (var i = 0; i < all.length; i++) {
              var s = all[i];
              try {
                styles.push({
                  id: s.id, name: s.name, path: __tp_stylePath(s),
                  basedOn: (function () { try { return s.basedOn && s.basedOn.name !== undefined ? __tp_stylePath(s.basedOn) : null; } catch (e) { return null; } })(),
                  fontFamily: (function () { try { return __tp_str(s.appliedFont); } catch (e) { return ''; } })(),
                  fontStyle: __tp_str(s.fontStyle),
                  fontSize: __tp_str(s.pointSize),
                  fillColor: (function () { try { return s.fillColor.name; } catch (e) { return 'inherited'; } })()
                });
              } catch (e) {}
            }
            return __ok(styles);`
        ),
    },

    create_paragraph_style: {
      description:
        "Create a paragraph style (one undo step). groupPath ('Regular set/Color Reset') puts it in nested style groups, creating missing " +
        "groups; the name must be unique only inside that group. duplicateFrom copies an existing style (all its attributes) and then " +
        "applies the passed overrides, e.g. chapter colours. basedOn/nextStyle/duplicateFrom accept an id, group path or unique name; " +
        "fonts and swatches are validated before anything changes. Colour props: fillColor, paragraphShadingOn/Color/Tint, " +
        "paragraphBorderOn/Color, ruleAbove/ruleBelow + ruleAboveColor/ruleBelowColor (+Tint).",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Style name (no '/'; use groupPath)" },
          groupPath: { type: "string", description: "Style group path, e.g. 'Regular set/Color Reset'. Missing groups are created. Default: root, or the duplicateFrom style's group" },
          duplicateFrom: { type: "string", description: "Existing style to copy (id, group path or name) before applying the overrides" },
          paragraphShadingOn: { type: "boolean" },
          paragraphShadingColor: { type: "string", description: "Swatch name" },
          paragraphShadingTint: { type: "number", description: "0-100" },
          paragraphBorderOn: { type: "boolean" },
          paragraphBorderColor: { type: "string", description: "Swatch name" },
          ruleAboveColor: { type: "string", description: "Swatch name" },
          ruleAboveTint: { type: "number", description: "0-100" },
          ruleBelowColor: { type: "string", description: "Swatch name" },
          ruleBelowTint: { type: "number", description: "0-100" },
          basedOn: { type: "string", description: "Parent style (id, group path or name)" },
          nextStyle: { type: "string", description: "Next style (id, group path or name)" },
          fontFamily: { type: "string", description: "Font family (e.g., 'Helvetica Neue LT Pro')" },
          fontStyle: { type: "string", description: "Font style (e.g., '55 Roman', '75 Bold')" },
          fontSize: { type: "number", description: "Font size in points" },
          leading: { type: "number", description: "Leading in points (0 for auto)" },
          alignment: { type: "string", enum: Object.keys(ALIGN) },
          spaceBefore: { type: "number" },
          spaceAfter: { type: "number" },
          firstLineIndent: { type: "number" },
          leftIndent: { type: "number" },
          rightIndent: { type: "number" },
          hyphenation: { type: "boolean" },
          tracking: { type: "number" },
          fillColor: { type: "string", description: "Swatch name for text color" },
          dropCapLines: { type: "number" },
          dropCapCharacters: { type: "number" },
          keepWithNext: { type: "number" },
          keepAllLinesTogether: { type: "boolean" },
          ruleAbove: { type: "boolean" },
          ruleBelow: { type: "boolean" },
        },
        required: ["name"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () => {
          if (typeof args.name !== "string" || args.name.trim() === "") throw new Error("name is required");
          if (args.name.includes("/")) throw new Error("name must not contain '/'; put the group in groupPath");
          if (args.alignment && !ALIGN[String(args.alignment)]) throw new Error(`alignment must be one of ${Object.keys(ALIGN).join(", ")}`);
          const name = args.name.trim();
          const groupPath = typeof args.groupPath === "string" ? args.groupPath : "";
          const SW_PROPS = ["fillColor", "paragraphShadingColor", "paragraphBorderColor", "ruleAboveColor", "ruleBelowColor"] as const;
          const swResolve = SW_PROPS.filter((p) => has(args[p]))
            .map((p) => `sw.${p} = __ct_swatch(doc, ${jsJson(args[p])}, ${jsStr(p)});`)
            .join("\n");
          const swApply = SW_PROPS.filter((p) => has(args[p]))
            .map((p) => `__st_set(s, ${jsStr(p)}, sw.${p}, errs);`)
            .join("\n");
          const setN = (prop: string, v: unknown, label: string, o: { min?: number; max?: number } = {}) =>
            has(v) ? `__st_set(s, ${jsStr(prop)}, ${jsNum(v, label, o)}, errs);` : "";
          const setB = (prop: string, v: unknown) => (v === undefined || v === null ? "" : `__st_set(s, ${jsStr(prop)}, ${v === true}, errs);`);
          const fontName = has(args.fontFamily) ? (has(args.fontStyle) ? `${String(args.fontFamily)}\t${String(args.fontStyle)}` : String(args.fontFamily)) : "";
          return runTp(
            bridge,
            args,
            jsx`
              var errs = [], sw = {};
              // resolve and validate everything before the first change
              var src = ${has(args.duplicateFrom) ? styleRef("paragraph", args.duplicateFrom, "duplicateFrom") : "null"};
              var gp = ${jsStr(groupPath)}, useGroup = __ct_splitPath(gp).length > 0;
              var basedOn = ${has(args.basedOn) ? styleRef("paragraph", args.basedOn, "basedOn") : "null"};
              var nextSt = ${has(args.nextStyle) ? styleRef("paragraph", args.nextStyle, "nextStyle") : "null"};
              var font = null;
              ${fontName ? `font = app.fonts.itemByName(${jsStr(fontName)}); if (!__tp_valid(font)) return __fail('font not installed: ' + ${jsStr(fontName.replace("\t", " "))});` : ""}
              ${swResolve}
              var rep;
              if (src === null) {
                var g0 = useGroup ? __ct_styleGroup(doc, 'paragraph', gp, false) : { container: doc };
                var clash = __ct_localStyle(g0.container, 'paragraph', ${jsStr(name)});
                if (clash) return __fail('paragraph style already exists: ' + __tp_stylePath(clash) + ' (id ' + clash.id + ')');
              }
              var s;
              if (src !== null) {
                var dr = __ct_dupStyle(doc, 'paragraph', src, ${jsStr(name)}, gp, false); // throws on a name clash before duplicating
                s = dr.style; rep = dr.report;
              } else {
                var g1 = useGroup ? __ct_styleGroup(doc, 'paragraph', gp, true) : { container: doc, created: [] };
                s = g1.container.paragraphStyles.add({ name: ${jsStr(name)} });
                rep = { groupsCreated: g1.created };
              }
              if (basedOn !== null) __st_set(s, 'basedOn', basedOn, errs);
              if (nextSt !== null) __st_set(s, 'nextStyle', nextSt, errs);
              if (font !== null) __st_set(s, 'appliedFont', font, errs);
              ${!has(args.fontFamily) && has(args.fontStyle) ? `__st_set(s, 'fontStyle', ${jsStr(args.fontStyle)}, errs);` : ""}
              ${setN("pointSize", args.fontSize, "fontSize", { min: 0.1 })}
              ${!has(args.leading) ? "" : Number(args.leading) === 0 ? "__st_set(s, 'leading', Leading.AUTO, errs);" : setN("leading", args.leading, "leading", { min: 0 })}
              ${args.alignment ? `__st_set(s, 'justification', ${ALIGN[String(args.alignment)]}, errs);` : ""}
              ${setN("spaceBefore", args.spaceBefore, "spaceBefore")}
              ${setN("spaceAfter", args.spaceAfter, "spaceAfter")}
              ${setN("firstLineIndent", args.firstLineIndent, "firstLineIndent")}
              ${setN("leftIndent", args.leftIndent, "leftIndent")}
              ${setN("rightIndent", args.rightIndent, "rightIndent")}
              ${setB("hyphenation", args.hyphenation)}
              ${setN("tracking", args.tracking, "tracking")}
              ${setN("dropCapLines", args.dropCapLines, "dropCapLines", { min: 0 })}
              ${setN("dropCapCharacters", args.dropCapCharacters, "dropCapCharacters", { min: 0 })}
              ${setN("keepWithNext", args.keepWithNext, "keepWithNext", { min: 0 })}
              ${setB("keepAllLinesTogether", args.keepAllLinesTogether)}
              ${setB("ruleAbove", args.ruleAbove)}
              ${setB("ruleBelow", args.ruleBelow)}
              ${setB("paragraphShadingOn", args.paragraphShadingOn)}
              ${setN("paragraphShadingTint", args.paragraphShadingTint, "paragraphShadingTint", { min: 0, max: 100 })}
              ${setB("paragraphBorderOn", args.paragraphBorderOn)}
              ${setN("ruleAboveTint", args.ruleAboveTint, "ruleAboveTint", { min: 0, max: 100 })}
              ${setN("ruleBelowTint", args.ruleBelowTint, "ruleBelowTint", { min: 0, max: 100 })}
              ${swApply}
              var path = __tp_stylePath(s);
              if (errs.length) return __fail('paragraph style ' + path + ' (id ' + s.id + ') was created but these properties could not be set: ' + errs.join('; ') + ". Undo 'create_paragraph_style' to remove it.");
              function nm(p) { try { var v = s[p]; return v && v.name !== undefined ? v.name : (v === undefined ? null : String(v)); } catch (e) { return null; } }
              return __ok({ created: true, id: s.id, name: s.name, path: path,
                duplicatedFrom: src !== null ? __tp_stylePath(src) : null,
                groupsCreated: rep.groupsCreated || [],
                basedOn: (function () { try { return s.basedOn && s.basedOn.name !== undefined ? __tp_stylePath(s.basedOn) : null; } catch (e) { return null; } })(),
                nextStyle: (function () { try { return __tp_stylePath(s.nextStyle); } catch (e) { return null; } })(),
                colors: { fillColor: nm('fillColor'), paragraphShadingOn: nm('paragraphShadingOn'), paragraphShadingColor: nm('paragraphShadingColor'),
                  paragraphBorderOn: nm('paragraphBorderOn'), paragraphBorderColor: nm('paragraphBorderColor'),
                  ruleAbove: nm('ruleAbove'), ruleAboveColor: nm('ruleAboveColor'), ruleBelow: nm('ruleBelow'), ruleBelowColor: nm('ruleBelowColor') } });`,
            { undoName: "create_paragraph_style", mutating: true, prelude: SET_HELPER + CT_PRELUDE }
          );
        }),
    },

    create_character_style: {
      description: "Create a character style. basedOn accepts an id, group path or unique name; the font is validated.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Style name" },
          basedOn: { type: "string" },
          fontFamily: { type: "string" },
          fontStyle: { type: "string" },
          fontSize: { type: "number" },
          fillColor: { type: "string" },
          underline: { type: "boolean" },
          strikethrough: { type: "boolean" },
          tracking: { type: "number" },
          baselineShift: { type: "number" },
          position: { type: "string", enum: ["normal", "superscript", "subscript"] },
        },
        required: ["name"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () => {
          const POS: Record<string, string> = { normal: "Position.NORMAL", superscript: "Position.SUPERSCRIPT", subscript: "Position.SUBSCRIPT" };
          if (args.position && !POS[String(args.position)]) throw new Error("position must be normal, superscript or subscript");
          return runTp(
            bridge,
            args,
            jsx`
              if (__tp_findStyle(doc, 'character', ${jsStr(args.name)})) return __fail('character style already exists: ' + ${jsStr(args.name)});
              var s = doc.characterStyles.add({ name: ${jsStr(args.name)} });
              ${args.basedOn ? `s.basedOn = ${styleRef("character", args.basedOn, "basedOn")};` : ""}
              ${fontExpr(args.fontFamily, args.fontStyle)}
              ${!args.fontFamily && args.fontStyle ? `s.fontStyle = ${jsStr(args.fontStyle)};` : ""}
              ${n("s", "pointSize", args.fontSize, "fontSize")}
              ${args.fillColor ? `var sw = doc.swatches.itemByName(${jsStr(args.fillColor)}); if (!__tp_valid(sw)) return __fail('swatch not found: ' + ${jsStr(args.fillColor)}); s.fillColor = sw;` : ""}
              ${b("s", "underline", args.underline)}
              ${b("s", "strikeThru", args.strikethrough)}
              ${n("s", "tracking", args.tracking, "tracking")}
              ${n("s", "baselineShift", args.baselineShift, "baselineShift")}
              ${args.position ? `s.position = ${POS[String(args.position)]};` : ""}
              return __ok({ created: true, id: s.id, name: s.name, path: __tp_stylePath(s) });`,
            { undoName: "create_character_style", mutating: true }
          );
        }),
    },

    list_object_styles: {
      description: "List all object styles (including grouped ones) with id and group path.",
      inputSchema: { type: "object" as const, properties: {} },
      handler: async (args: Record<string, unknown>) =>
        runTp(
          bridge,
          args,
          jsx`
            var all = doc.allObjectStyles, styles = [];
            for (var i = 0; i < all.length; i++) {
              var s = all[i];
              try {
                styles.push({ id: s.id, name: s.name, path: __tp_stylePath(s),
                  basedOn: (function () { try { return s.basedOn && s.basedOn.name !== undefined ? __tp_stylePath(s.basedOn) : null; } catch (e) { return null; } })(),
                  fillColor: (function () { try { return s.fillColor.name; } catch (e) { return null; } })(),
                  strokeColor: (function () { try { return s.strokeColor.name; } catch (e) { return null; } })(),
                  enableFill: s.enableFill, enableStroke: s.enableStroke, enableTextFrameGeneralOptions: s.enableTextFrameGeneralOptions });
              } catch (e) {}
            }
            return __ok(styles);`
        ),
    },

    create_object_style: {
      description:
        "Create an object style for frames and shapes (one undo step). Every style category is first DISABLED (a new object style " +
        "otherwise enables fill/stroke/text-frame/effects categories with defaults, so a fill-only style would add a 1pt Black stroke); " +
        "then only the categories of the passed properties are enabled: fill (fillColor/fillTint), stroke (strokeColor/strokeWeight/" +
        "strokeTint), transparency (opacity). Returns the enabled categories.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Style name" },
          fillColor: { type: "string", description: "Fill swatch name ('None' allowed)" },
          fillTint: { type: "number", description: "Fill tint 0-100" },
          strokeColor: { type: "string", description: "Stroke swatch name ('None' allowed)" },
          strokeWeight: { type: "number", description: "Stroke weight in points" },
          strokeTint: { type: "number", description: "Stroke tint 0-100" },
          opacity: { type: "number", description: "Opacity 0-100 (enables the transparency category)" },
        },
        required: ["name"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () => {
          if (typeof args.name !== "string" || args.name.trim() === "") throw new Error("name is required");
          const wantFill = has(args.fillColor) || has(args.fillTint);
          const wantStroke = has(args.strokeColor) || has(args.strokeWeight) || has(args.strokeTint);
          const wantOpacity = has(args.opacity);
          return runTp(
            bridge,
            args,
            jsx`
              var errs = [];
              if (__ct_localStyle(doc, 'object', ${jsStr(args.name)})) return __fail('object style already exists: ' + ${jsStr(args.name)});
              ${has(args.fillColor) ? `var fc = __ct_swatch(doc, ${jsJson(args.fillColor)}, 'fillColor');` : ""}
              ${has(args.strokeColor) ? `var sc = __ct_swatch(doc, ${jsJson(args.strokeColor)}, 'strokeColor');` : ""}
              var s = doc.objectStyles.add({ name: ${jsStr(args.name)} });
              // 1) disable every category (explicit list + any other enable* boolean the DOM exposes)
              var cats = ${jsJson(OBJECT_STYLE_CATEGORIES)}, seen = {};
              try { var refl = s.reflect.properties; for (var r = 0; r < refl.length; r++) { var pn = String(refl[r].name); if (/^enable[A-Z]/.test(pn)) cats.push(pn); } } catch (eR) {}
              for (var c = 0; c < cats.length; c++) {
                if (seen[cats[c]]) continue; seen[cats[c]] = true;
                try { if (typeof s[cats[c]] === 'boolean') s[cats[c]] = false; } catch (eC) {}
              }
              // 2) enable only what was passed
              ${wantFill ? "__st_set(s, 'enableFill', true, errs);" : ""}
              ${has(args.fillColor) ? "__st_set(s, 'fillColor', fc, errs);" : ""}
              ${has(args.fillTint) ? `__st_set(s, 'fillTint', ${jsNum(args.fillTint, "fillTint", { min: 0, max: 100 })}, errs);` : ""}
              ${wantStroke ? "__st_set(s, 'enableStroke', true, errs);" : ""}
              ${has(args.strokeColor) ? "__st_set(s, 'strokeColor', sc, errs);" : ""}
              ${has(args.strokeWeight) ? `__st_set(s, 'strokeWeight', ${jsNum(args.strokeWeight, "strokeWeight", { min: 0 })}, errs);` : ""}
              ${has(args.strokeTint) ? `__st_set(s, 'strokeTint', ${jsNum(args.strokeTint, "strokeTint", { min: 0, max: 100 })}, errs);` : ""}
              ${wantOpacity ? `__st_set(s, 'enableTransparency', true, errs); try { s.transparencySettings.blendingSettings.opacity = ${jsNum(args.opacity, "opacity", { min: 0, max: 100 })}; } catch (eO) { errs.push('opacity: ' + eO.message); }` : ""}
              var enabled = [];
              for (var k in seen) { if (!seen.hasOwnProperty(k)) continue; try { if (s[k] === true) enabled.push(k); } catch (eK) {} }
              if (errs.length) return __fail('object style ' + s.name + ' (id ' + s.id + ') was created but these properties could not be set: ' + errs.join('; ') + ". Undo 'create_object_style' to remove it.");
              function nm(v) { try { return v && v.name !== undefined ? v.name : null; } catch (e) { return null; } }
              return __ok({ created: true, id: s.id, name: s.name, enabledCategories: enabled,
                fill: s.enableFill ? nm(s.fillColor) : null, stroke: s.enableStroke ? nm(s.strokeColor) : null,
                strokeWeight: s.enableStroke ? s.strokeWeight : null });`,
            { undoName: "create_object_style", mutating: true, prelude: SET_HELPER + CT_PRELUDE }
          );
        }),
    },

    apply_style: {
      description:
        "Apply a style (one undo step). styleName accepts an id, group path ('Group/Name') or unique name (styleId also accepted). " +
        "paragraph, story-relative (threaded stories): storyId (or frameId -> its parent story) + storyParagraphIndex [+ storyParagraphEnd, " +
        "inclusive]; paragraph, frame-relative: frameId + paragraphIndex, or allParagraphs:true. expectText guards the first target " +
        "paragraph (must start with it, else nothing changes). Returns before/after style per paragraph. Character formatting " +
        "(bold/roman runs) is kept: applyParagraphStyle(style, false). character: startCharIndex..endCharIndex (inclusive, " +
        "frame-relative) or the whole frame text. object: the item with frameId; returns fill/stroke/strokeWeight before and after. " +
        "clearOverrides (default false) clears only PARAGRAPH-level overrides by default; clearOverrideType:'all' clears everything " +
        "(for object styles clearOverrides removes the item's local overrides).",
      inputSchema: {
        type: "object" as const,
        properties: {
          styleType: { type: "string", enum: [...KINDS], description: "Type of style to apply" },
          styleName: { type: "string", description: "Style id, group path or unique name" },
          styleId: { type: "number", description: "Style id (alternative to styleName)" },
          frameId: { type: "number", description: "Frame / item ID (with storyParagraphIndex: resolved to its parent story)" },
          storyId: { type: "number", description: "Paragraph style: story id for story-relative indexes" },
          storyParagraphIndex: { type: "number", description: "Paragraph style: first story-relative paragraph index (0-based)" },
          storyParagraphEnd: { type: "number", description: `Paragraph style: last story-relative paragraph index, inclusive (default = storyParagraphIndex; at most ${MAX_PARAGRAPHS} paragraphs)` },
          expectText: { type: "string", description: "Paragraph style guard: the first target paragraph must start with this text" },
          paragraphIndex: { type: "number", description: "Paragraph style: frame-relative paragraph index" },
          allParagraphs: { type: "boolean", description: "Paragraph style: apply to every paragraph of the frame" },
          startCharIndex: { type: "number", description: "Character style: first character (inclusive)" },
          endCharIndex: { type: "number", description: "Character style: last character (inclusive)" },
          clearOverrides: { type: "boolean", description: "Clear local overrides. Default: false" },
          clearOverrideType: { type: "string", enum: ["paragraph", "character", "all"], description: "Which overrides to clear. Default paragraph" },
        },
        required: ["styleType"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () => {
          const kind = mustKind(args.styleType);
          const ref = args.styleId !== undefined && args.styleId !== null ? Number(jsNum(args.styleId, "styleId", { int: true })) : args.styleName;
          const sty = styleRef(kind, ref, "styleName/styleId");
          const fid = has(args.frameId) ? jsNum(args.frameId, "frameId", { int: true }) : null;
          if (kind === "object" && fid === null) throw new Error("object styles need frameId (the item id)");
          const OT: Record<string, string> = { paragraph: "OverrideType.PARAGRAPH_ONLY", character: "OverrideType.CHARACTER_ONLY", all: "OverrideType.ALL" };
          const ot = OT[String(args.clearOverrideType ?? "paragraph")];
          if (!ot) throw new Error("clearOverrideType must be paragraph, character or all");
          let body: string;
          if (kind === "object") {
            body = jsx`
              var item = __tp_requireItem(doc, ${fid}, 'item');
              var st = ${sty};
              function look(it) {
                function nm(v) { try { return v && v.name !== undefined ? String(v.name) : null; } catch (e) { return null; } }
                var o = { objectStyle: null, fill: null, fillTint: null, stroke: null, strokeWeight: null };
                try { o.objectStyle = __tp_stylePath(it.appliedObjectStyle); } catch (e0) {}
                try { o.fill = nm(it.fillColor); o.fillTint = it.fillTint; } catch (e1) {}
                try { o.stroke = nm(it.strokeColor); o.strokeWeight = it.strokeWeight; } catch (e2) {}
                return o;
              }
              var before = look(item);
              // applyObjectStyle keeps local overrides unless clearOverrides:true (setting appliedObjectStyle does not let us choose)
              item.applyObjectStyle(st, ${args.clearOverrides === true}, false);
              var after = look(item), changed = [];
              var keys = ['fill', 'fillTint', 'stroke', 'strokeWeight'];
              for (var k = 0; k < keys.length; k++) if (before[keys[k]] !== after[keys[k]]) changed.push(keys[k]);
              return __ok({ applied: true, kind: 'object', id: item.id, style: __tp_stylePath(st), clearOverrides: ${args.clearOverrides === true}, before: before, after: after, changed: changed });`;
          } else if (kind === "character") {
            if (fid === null) throw new Error("character styles need frameId");
            const hasRange = args.startCharIndex !== undefined && args.startCharIndex !== null;
            const s = hasRange ? jsNum(args.startCharIndex, "startCharIndex", { int: true, min: 0 }) : "null";
            const e = hasRange ? jsNum(args.endCharIndex ?? args.startCharIndex, "endCharIndex", { int: true, min: 0 }) : "null";
            body = jsx`
              var tf = __tp_requireTextFrame(doc, ${fid});
              var s = ${s}, e = ${e}, t;
              if (s !== null) {
                if (e < s || e >= tf.characters.length) return __fail('character range ' + s + '-' + e + ' outside the frame text (' + tf.characters.length + ' characters, inclusive indexes)');
                t = tf.characters.itemByRange(s, e);
              } else t = tf.texts[0];
              t.applyCharacterStyle(${sty});
              ${args.clearOverrides === true ? `t.clearOverrides(${ot});` : ""}
              return __ok({ applied: true, kind: 'character', range: s === null ? 'frame' : [s, e] });`;
          } else {
            const storyMode = has(args.storyParagraphIndex);
            const expect = has(args.expectText) ? jsStr(args.expectText) : "null";
            let select: string;
            if (storyMode) {
              if (!has(args.storyId) && fid === null) throw new Error("storyParagraphIndex needs storyId, or frameId (resolved to its parent story)");
              const sid = has(args.storyId) ? jsNum(args.storyId, "storyId", { int: true, min: 0 }) : "null";
              const a = Number(jsNum(args.storyParagraphIndex, "storyParagraphIndex", { int: true, min: 0 }));
              const z = has(args.storyParagraphEnd) ? Number(jsNum(args.storyParagraphEnd, "storyParagraphEnd", { int: true, min: 0 })) : a;
              if (z < a) throw new Error(`storyParagraphEnd (${z}) must be >= storyParagraphIndex (${a})`);
              if (z - a + 1 > MAX_PARAGRAPHS) throw new Error(`at most ${MAX_PARAGRAPHS} paragraphs per call (got ${z - a + 1})`);
              select = jsx`
                var story = __tp_requireStory(doc, ${sid}, ${fid === null ? "null" : fid});
                var np = story.paragraphs.length, a = ${a}, z = ${z};
                if (a >= np || z >= np) return __fail('story paragraph range ' + a + '-' + z + ' out of range (story ' + story.id + ' has ' + np + ' paragraphs, 0-based)');
                for (var i = a; i <= z; i++) { targets.push(story.paragraphs[i]); labels.push(i); }
                var indexKey = 'storyParagraphIndex', scopeInfo = { storyId: story.id };`;
            } else {
              if (fid === null) throw new Error("paragraph styles need frameId + paragraphIndex/allParagraphs, or storyId/frameId + storyParagraphIndex");
              const hasIdx = has(args.paragraphIndex);
              if (!hasIdx && args.allParagraphs !== true) throw new Error("paragraph styles need paragraphIndex, or allParagraphs:true to restyle every paragraph of the frame, or storyParagraphIndex for story-relative indexes");
              const idx = hasIdx ? jsNum(args.paragraphIndex, "paragraphIndex", { int: true, min: 0 }) : "null";
              select = jsx`
                var tf = __tp_requireTextFrame(doc, ${fid});
                var story = tf.parentStory, idx = ${idx};
                if (idx !== null) { if (idx >= tf.paragraphs.length) return __fail('paragraphIndex ' + idx + ' out of range (' + tf.paragraphs.length + ' paragraphs in frame)'); targets.push(tf.paragraphs[idx]); labels.push(idx); }
                else { if (tf.paragraphs.length > ${MAX_PARAGRAPHS}) return __fail('frame has ' + tf.paragraphs.length + ' paragraphs; at most ${MAX_PARAGRAPHS} per call'); for (var i = 0; i < tf.paragraphs.length; i++) { targets.push(tf.paragraphs[i]); labels.push(i); } }
                var indexKey = 'paragraphIndex', scopeInfo = { frameId: tf.id, storyId: story.id };`;
            }
            body = jsx`
              var st = ${sty}, targets = [], labels = [];
              ${select}
              function pstyle(p) { try { return __tp_stylePath(p.appliedParagraphStyle); } catch (e) { return null; } }
              function ptext(p) { try { return __tp_str(p.contents).replace(/[\r\n]+$/, '').substring(0, 60); } catch (e) { return ''; } }
              var expect = ${expect};
              if (expect !== null && targets.length) {
                var t0 = __tp_str(targets[0].contents);
                if (t0.substring(0, expect.length) !== expect) return __fail('expectText guard failed: ' + indexKey + ' ' + labels[0] + ' starts with ' + JSON.stringify(t0.substring(0, 80)) + ', expected ' + JSON.stringify(expect) + '. Nothing was changed.');
              }
              var before = [];
              for (var b = 0; b < targets.length; b++) before.push(pstyle(targets[b]));
              for (var j = 0; j < targets.length; j++) {
                targets[j].applyParagraphStyle(st, false);
                ${args.clearOverrides === true ? `targets[j].clearOverrides(${ot});` : ""}
              }
              var rows = [];
              for (var r = 0; r < targets.length && r < 200; r++) { var row = { text: ptext(targets[r]), before: before[r], after: pstyle(targets[r]) }; row[indexKey] = labels[r]; rows.push(row); }
              var res = { applied: true, kind: 'paragraph', style: __tp_stylePath(st), styleId: st.id, paragraphs: targets.length, details: rows,
                detailsTruncated: targets.length > rows.length, clearOverrides: ${args.clearOverrides === true ? jsStr(String(args.clearOverrideType ?? "paragraph")) : "false"},
                storyOverflows: story.overflows };
              for (var sk in scopeInfo) if (scopeInfo.hasOwnProperty(sk)) res[sk] = scopeInfo[sk];
              return __ok(res);`;
          }
          return runTp(bridge, args, body, { undoName: "apply_style", mutating: true });
        }),
    },

    delete_style: {
      description: "Delete a style (id, group path or unique name), optionally replacing its uses with another style. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          styleType: { type: "string", enum: [...KINDS] },
          styleName: { type: "string" },
          replacementStyle: { type: "string", description: "Style to replace with (id, group path or name)" },
        },
        required: ["styleType", "styleName"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () => {
          const kind = mustKind(args.styleType);
          return runTp(
            bridge,
            args,
            jsx`
              var s = ${styleRef(kind, args.styleName, "styleName")};
              var info = { id: s.id, path: __tp_stylePath(s) };
              ${args.replacementStyle ? `var rep = ${styleRef(kind, args.replacementStyle, "replacementStyle")}; if (rep.id === s.id) return __fail('replacement is the same style'); s.remove(rep); info.replacedWith = __tp_stylePath(rep);` : "s.remove();"}
              return __ok({ deleted: true, style: info });`,
            { undoName: "delete_style", mutating: true }
          );
        }),
    },

    import_styles: {
      description: "Import paragraph and character styles from another InDesign document (the source file is only read).",
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: { type: "string", description: "Path to source InDesign file" },
          conflictPolicy: { type: "string", enum: ["useExisting", "useIncoming"], description: "Name conflicts. Default: useExisting" },
        },
        required: ["filePath"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () =>
          runTp(
            bridge,
            args,
            jsx`
              var f = new File(${jsStr(String(args.filePath ?? "").replace(/\\/g, "/"))});
              if (!f.exists) return __fail('file not found: ' + f.fsName);
              var policy = ${(args.conflictPolicy ?? "useExisting") === "useIncoming" ? "GlobalClashResolutionStrategy.LOAD_ALL_WITH_OVERWRITE" : "GlobalClashResolutionStrategy.DO_NOT_LOAD_THE_STYLE"};
              doc.importStyles(ImportFormat.PARAGRAPH_STYLES_FORMAT, f, policy);
              doc.importStyles(ImportFormat.CHARACTER_STYLES_FORMAT, f, policy);
              return __ok({ imported: true, paragraphStyles: doc.allParagraphStyles.length, characterStyles: doc.allCharacterStyles.length });`,
            { undoName: "import_styles", mutating: true }
          )
        ),
    },

    list_grep_styles: {
      description: "List GREP styles of a paragraph style (id, group path or unique name).",
      inputSchema: {
        type: "object" as const,
        properties: { paragraphStyleName: { type: "string", description: "Paragraph style to inspect" } },
        required: ["paragraphStyleName"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () =>
          runTp(
            bridge,
            args,
            jsx`
              var s = ${styleRef("paragraph", args.paragraphStyleName, "paragraphStyleName")};
              var greps = [];
              for (var i = 0; i < s.nestedGrepStyles.length; i++) {
                var g = s.nestedGrepStyles[i];
                greps.push({ grepExpression: g.grepExpression, appliedCharacterStyle: (function () { try { return __tp_stylePath(g.appliedCharacterStyle); } catch (e) { return null; } })() });
              }
              return __ok(greps);`
          )
        ),
    },

    add_grep_style: {
      description: "Add a GREP style rule to a paragraph style.",
      inputSchema: {
        type: "object" as const,
        properties: {
          paragraphStyleName: { type: "string" },
          grepExpression: { type: "string", description: "GREP pattern" },
          characterStyleName: { type: "string", description: "Character style to apply" },
        },
        required: ["paragraphStyleName", "grepExpression", "characterStyleName"],
      },
      handler: async (args: Record<string, unknown>) =>
        guarded(async () =>
          runTp(
            bridge,
            args,
            jsx`
              var s = ${styleRef("paragraph", args.paragraphStyleName, "paragraphStyleName")};
              var cs = ${styleRef("character", args.characterStyleName, "characterStyleName")};
              s.nestedGrepStyles.add({ grepExpression: ${jsStr(args.grepExpression)}, appliedCharacterStyle: cs });
              return __ok({ added: true, count: s.nestedGrepStyles.length });`,
            { undoName: "add_grep_style", mutating: true }
          )
        ),
    },
  };
}
