import path from "node:path";
import { existsSync } from "node:fs";
import type { InDesignBridge } from "../bridge/index.js";
import { targetFromArgs } from "../bridge/documentTarget.js";
import { jsStr, jsNum, jsNumOr, jsInt, jsBool, oneOf } from "../bridge/jsStr.js";
import { assertSafeWritePath, isUnderWriteRoots, isProtectedBasename, SafetyError, getWriteRoots } from "../bridge/safety.js";

const DOC_ID = {
  type: ["string", "integer"],
  description: "Target document: full path (preferred), file name, or 0-based index. Omit for the front document.",
};

const SCOPE_SCHEMA = {
  type: "object",
  description:
    "Limit the operation to one story (storyId), one text frame (frameId) or the text frames on one page (pageIndex, 0-based). Omit for the whole document.",
  properties: {
    storyId: { type: "number" },
    frameId: { type: "number" },
    pageIndex: { type: "number" },
  },
};

/**
 * ExtendScript that defines `__targets` (objects supporting findText/changeText)
 * and `__scopeLabel` for the given scope. Frames on a page are ordered last to
 * first within each story so text reflowing out of an edited frame is never
 * processed twice.
 */
export function scopeTargetsCode(scope: unknown): string {
  const s = (scope && typeof scope === "object" ? scope : {}) as Record<string, unknown>;
  if (s.storyId !== undefined && s.storyId !== null) {
    return `
      var __st = doc.stories.itemByID(${jsInt(s.storyId, "scope.storyId")});
      if (!__st.isValid) throw new Error('Story id ' + ${jsInt(s.storyId, "scope.storyId")} + ' not found');
      var __targets = [__st];
      var __scopeLabel = 'story ' + __st.id;`;
  }
  if (s.frameId !== undefined && s.frameId !== null) {
    return `
      var __fr = __itemById(doc, ${jsInt(s.frameId, "scope.frameId")});
      if (!__fr || __fr.constructor.name !== 'TextFrame') throw new Error('Text frame id ' + ${jsInt(s.frameId, "scope.frameId")} + ' not found');
      var __targets = [__fr.texts[0]];
      var __scopeLabel = 'frame ' + __fr.id;`;
  }
  if (s.pageIndex !== undefined && s.pageIndex !== null) {
    return `
      var __pi = ${jsInt(s.pageIndex, "scope.pageIndex")};
      if (__pi >= doc.pages.length) throw new Error('pageIndex ' + __pi + ' out of range (0..' + (doc.pages.length - 1) + ')');
      var __pg = doc.pages[__pi];
      var __frs = [];
      var __all = __pg.allPageItems;
      for (var __k = 0; __k < __all.length; __k++) {
        if (__all[__k].constructor.name === 'TextFrame') {
          var __ix = -1;
          try { __ix = __all[__k].texts[0].index; } catch (__e) {}
          __frs.push({ f: __all[__k], story: __all[__k].parentStory.id, ix: __ix });
        }
      }
      __frs.sort(function (a, b) { return a.story !== b.story ? a.story - b.story : b.ix - a.ix; });
      var __targets = [];
      for (var __m = 0; __m < __frs.length; __m++) __targets.push(__frs[__m].f.texts[0]);
      var __scopeLabel = 'page ' + __pg.name;`;
  }
  return `
      var __targets = [doc];
      var __scopeLabel = 'document';`;
}

/**
 * Guarded undo / redo. Reads doc.undoName / doc.redoName BEFORE acting, so the
 * caller learns which step it reverts, refuses on an expected-name mismatch, and
 * reports {undone:false} instead of silently doing nothing (or reverting an
 * earlier unrelated step after a no-op tool call).
 */
function undoRedoScript(kind: "undo" | "redo", expectName: unknown): string {
  if (expectName !== undefined && expectName !== null && typeof expectName !== "string") {
    throw new Error(`${kind === "undo" ? "expectUndoName" : "expectRedoName"} must be a string`);
  }
  const expect = typeof expectName === "string" && expectName.trim() !== "" ? jsStr(expectName.trim()) : "null";
  const isUndo = kind === "undo";
  const nameProp = isUndo ? "undoName" : "redoName";
  const otherProp = isUndo ? "redoName" : "undoName";
  const canProp = isUndo ? "canUndo" : "canRedo";
  const doneKey = isUndo ? "undone" : "redone";
  const doneName = isUndo ? "undoneName" : "redoneName";
  const nextName = isUndo ? "nextUndoName" : "nextRedoName";
  const otherKey = isUndo ? "redoName" : "undoName";
  return `
    var doc = __resolveDocument();
    function __urName(prop) { try { var v = doc[prop]; return (v === null || v === undefined) ? '' : String(v); } catch (e) { return ''; } }
    var __expect = ${expect};
    var __name = __urName('${nameProp}');
    var __can = null;
    try { __can = doc.${canProp}; } catch (e) { __can = null; }
    var __pagesBefore = doc.pages.length;
    var __res;
    if (__can === false || __name.replace(/^\\s+|\\s+$/g, '') === '') {
      var __o = { ${doneKey}: false, reason: 'nothing to ${kind}', ${nextName}: __name || null, ${otherKey}: __urName('${otherProp}') || null, pagesBefore: __pagesBefore, pagesAfter: __pagesBefore };
      __res = __ok(__o);
    } else if (__expect !== null && __name.replace(/^\\s+|\\s+$/g, '') !== __expect) {
      __res = __fail('last ${kind} step is "' + __name + '", not "' + __expect + '"; nothing was ${isUndo ? "undone" : "redone"}.', 'UNDO_NAME_MISMATCH');
    } else {
      doc.${kind}();
      var __r = { ${doneKey}: true, ${doneName}: __name, ${nextName}: __urName('${nameProp}') || null, ${otherKey}: __urName('${otherProp}') || null, pagesBefore: __pagesBefore, pagesAfter: doc.pages.length };
      __res = __ok(__r);
    }
    __res;
  `;
}

/** Find/change option assignments with save + restore. */
function findOptionsCode(args: Record<string, unknown>): { set: string; restore: string } {
  const set = `
      var __fco = app.findChangeTextOptions;
      var __prevOpts = {};
      var __optKeys = ['caseSensitive', 'wholeWord', 'includeHiddenLayers', 'includeLockedLayersForFind', 'includeLockedStoriesForFind', 'includeMasterPages', 'includeFootnotes'];
      for (var __o = 0; __o < __optKeys.length; __o++) { try { __prevOpts[__optKeys[__o]] = __fco[__optKeys[__o]]; } catch (__e) {} }
      __fco.caseSensitive = ${jsBool(args.caseSensitive, false, "caseSensitive")};
      __fco.wholeWord = ${jsBool(args.wholeWord, false, "wholeWord")};
      __fco.includeHiddenLayers = ${jsBool(args.includeHiddenLayers, false, "includeHiddenLayers")};
      __fco.includeLockedLayersForFind = false;
      __fco.includeLockedStoriesForFind = false;
      __fco.includeMasterPages = ${jsBool(args.includeMasterPages, false, "includeMasterPages")};
      __fco.includeFootnotes = ${jsBool(args.includeFootnotes, true, "includeFootnotes")};`;
  const restore = `
      app.findTextPreferences = NothingEnum.NOTHING;
      app.changeTextPreferences = NothingEnum.NOTHING;
      for (var __r in __prevOpts) { try { __fco[__r] = __prevOpts[__r]; } catch (__e) {} }`;
  return { set, restore };
}

/** Literal text for InDesign's text find: '^' is the metacharacter prefix; newlines are \r. */
export function literalFindText(s: string, useMetacharacters: boolean): string {
  const t = s.replace(/\r\n|\n/g, "\r");
  return useMetacharacters ? t : t.replace(/\^/g, "^^");
}

export function registerDocumentTools(bridge: InDesignBridge) {
  const long = () => bridge.longTimeout();

  return {
    probe_indesign: {
      description:
        "Cheap liveness check (10 s). Call this after any EXECUTION_TIMEOUT_STILL_RUNNING or INDESIGN_BUSY error, and repeat until it answers, BEFORE retrying anything. Returns InDesign version and open documents (with full paths); clears the busy lock when InDesign answers.",
      inputSchema: { type: "object" as const, properties: {} },
      handler: async () => bridge.probe(),
    },

    get_active_document: {
      description:
        "Get information about the target (default: front) document: name, full path, page count, dimensions (points), modification state, and whether it is inside the allowed write folders.",
      inputSchema: {
        type: "object" as const,
        properties: { document_id: DOC_ID },
      },
      handler: async (args: Record<string, unknown>) =>
        bridge.runScript(
          `
          var doc = __resolveDocument();
          var dp = doc.documentPreferences;
          var p = __docPath(doc);
          var idx = -1;
          var did = __mcpGet(function () { return doc.id; }, null);
          for (var i = 0; i < app.documents.length; i++) {
            var di = app.documents[i];
            if ((did !== null && __mcpGet(function () { return di.id; }, -1) === did) || (p && __docPath(di) === p)) { idx = i; break; }
          }
          JSON.stringify({
            index: idx,
            name: doc.name,
            fullName: p,
            writable: __mcpIsWritablePath(p),
            saved: __mcpGet(function () { return doc.saved; }, null),
            modified: __mcpGet(function () { return doc.modified; }, null),
            pageCount: doc.pages.length,
            spreadCount: doc.spreads.length,
            units: 'points',
            pageWidth: dp.pageWidth,
            pageHeight: dp.pageHeight,
            facingPages: dp.facingPages,
            slugTopOffset: __mcpGet(function () { return dp.slugTopOffset; }, null),
            bleedTop: __mcpGet(function () { return dp.documentBleedTopOffset; }, null),
            bleedBottom: __mcpGet(function () { return dp.documentBleedBottomOffset; }, null),
            bleedInside: __mcpGet(function () { return dp.documentBleedInsideOrLeftOffset; }, null),
            bleedOutside: __mcpGet(function () { return dp.documentBleedOutsideOrRightOffset; }, null),
            intent: __mcpGet(function () { return dp.intent.toString(); }, '')
          });
        `,
          { targetDocument: targetFromArgs(args), toolName: "get_active_document" }
        ),
    },

    create_document: {
      description:
        "Create a new (untitled) InDesign document. All sizes in points (1 inch = 72 pt). Does not change application-wide defaults. Save it with save_document + filePath inside the allowed write folders.",
      inputSchema: {
        type: "object" as const,
        properties: {
          width: { type: "number", description: "Page width in points. Default: 612 (8.5in)" },
          height: { type: "number", description: "Page height in points. Default: 792 (11in)" },
          facingPages: { type: "boolean", description: "Enable facing pages layout. Default: false" },
          marginTop: { type: "number", description: "Top margin in points. Default: 36" },
          marginBottom: { type: "number", description: "Bottom margin in points. Default: 36" },
          marginLeft: { type: "number", description: "Left/inside margin in points. Default: 36" },
          marginRight: { type: "number", description: "Right/outside margin in points. Default: 36" },
          columns: { type: "number", description: "Number of columns. Default: 1" },
          columnGutter: { type: "number", description: "Gutter between columns in points. Default: 12" },
          numPages: { type: "number", description: "Initial number of pages. Default: 1" },
          bleed: { type: "number", description: "Uniform bleed in points. Default: 0" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const w = jsNumOr(args.width, 612, "width");
        const h = jsNumOr(args.height, 792, "height");
        const facing = jsBool(args.facingPages, false, "facingPages");
        const pagesN = jsInt(args.numPages ?? 1, "numPages");
        const bleed = jsNumOr(args.bleed, 0, "bleed");
        const mt = jsNumOr(args.marginTop, 36, "marginTop");
        const mb = jsNumOr(args.marginBottom, 36, "marginBottom");
        const ml = jsNumOr(args.marginLeft, 36, "marginLeft");
        const mr = jsNumOr(args.marginRight, 36, "marginRight");
        const cols = jsInt(args.columns ?? 1, "columns");
        const gut = jsNumOr(args.columnGutter, 12, "columnGutter");
        return bridge.runScript(
          `
          var props = {
            facingPages: ${facing},
            pageWidth: ${w},
            pageHeight: ${h},
            pagesPerDocument: ${pagesN},
            documentBleedUniformSize: true,
            documentBleedTopOffset: ${bleed}
          };
          var doc = app.documents.add(true, undefined, { documentPreferences: props });
          // Re-apply on the document itself (never on app.documentPreferences) in case
          // this InDesign version ignored withProperties.
          var dp = doc.documentPreferences;
          dp.facingPages = props.facingPages;
          dp.pageWidth = props.pageWidth;
          dp.pageHeight = props.pageHeight;
          dp.pagesPerDocument = props.pagesPerDocument;
          try { dp.documentBleedUniformSize = true; dp.documentBleedTopOffset = ${bleed}; } catch (e) {}
          function setMargins(mp) {
            mp.top = ${mt}; mp.bottom = ${mb}; mp.left = ${ml}; mp.right = ${mr};
            mp.columnCount = ${cols}; mp.columnGutter = ${gut};
          }
          setMargins(doc.marginPreferences);
          for (var ms = 0; ms < doc.masterSpreads.length; ms++) {
            for (var mpg = 0; mpg < doc.masterSpreads[ms].pages.length; mpg++) setMargins(doc.masterSpreads[ms].pages[mpg].marginPreferences);
          }
          for (var pg = 0; pg < doc.pages.length; pg++) setMargins(doc.pages[pg].marginPreferences);
          JSON.stringify({ name: doc.name, pages: doc.pages.length, units: 'points' });
        `,
          { targetDocument: null, toolName: "create_document" }
        );
      },
    },

    open_document: {
      description:
        "Open an InDesign document (.indd, .indt, .idml) from a file path and show it in a window. Reading is allowed anywhere, but documents outside the allowed write folders are read-only for this server (saving and guarded edits are refused). The protected test master cannot be opened — copy it to a run folder first. Long timeout (10 min) for large books.",
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: { type: "string", description: "Full path to the InDesign file" },
        },
        required: ["filePath"],
      },
      handler: async (args: Record<string, unknown>) => {
        if (typeof args.filePath !== "string" || !args.filePath.trim()) throw new Error("filePath is required");
        const resolved = path.resolve(args.filePath.trim());
        const ext = path.extname(resolved).toLowerCase();
        if (![".indd", ".indt", ".idml"].includes(ext)) throw new Error(`Unsupported file type '${ext}'`);
        if (isProtectedBasename(resolved)) {
          throw new SafetyError(
            `refusing to open the protected test master (${resolved}). Copy it to ${getWriteRoots()[0] ?? "a run folder"}\\<label>.indd and open the copy.`
          );
        }
        if (!existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
        const warning = isUnderWriteRoots(resolved)
          ? null
          : `Opened outside the allowed write folders (${getWriteRoots().join("; ")}): this document is read-only for this server.`;
        if (warning) process.stderr.write(`[indesign-mcp] WARNING: ${warning} (${resolved})\n`);
        return bridge.runScript(
          `
          var f = new File(${jsStr(resolved)});
          if (!f.exists) throw new Error('File not found: ' + f.fsName);
          var doc = app.open(f, true);
          try { if (doc.windows.length === 0) doc.windows.add(); } catch (e) {}
          var p = __docPath(doc);
          var idx = -1;
          for (var i = 0; i < app.documents.length; i++) { if (p && __docPath(app.documents[i]) === p) { idx = i; break; } }
          JSON.stringify({ index: idx, name: doc.name, fullName: p, pages: doc.pages.length, writable: __mcpIsWritablePath(p), warning: ${warning ? jsStr(warning) : "null"} });
        `,
          { targetDocument: null, timeoutMs: long(), toolName: "open_document" }
        );
      },
    },

    save_document: {
      description:
        "Save the target document. Without filePath: saves in place (only allowed when the document is inside the allowed write folders). With filePath: Save As (.indd, or .indt to save as template) — the path must be inside the allowed write folders and must not exist unless overwrite:true. Long timeout (10 min).",
      inputSchema: {
        type: "object" as const,
        properties: {
          document_id: DOC_ID,
          filePath: { type: "string", description: "Optional new file path for Save As" },
          overwrite: { type: "boolean", description: "Allow Save As to replace an existing file. Default: false" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        if (args.filePath) {
          const target = assertSafeWritePath(args.filePath, [".indd", ".indt"], { overwrite: args.overwrite === true });
          const asTemplate = path.extname(target).toLowerCase() === ".indt";
          return bridge.runScript(
            `
            var doc = __resolveDocument();
            var f = new File(${jsStr(target)});
            doc.save(f, ${asTemplate ? "true" : "false"});
            JSON.stringify({ saved: true, path: f.fsName, asTemplate: ${asTemplate ? "true" : "false"} });
          `,
            { targetDocument: targetFromArgs(args), timeoutMs: long(), toolName: "save_document" }
          );
        }
        return bridge.runScript(
          `
          var doc = __resolveDocument();
          var p = __docPath(doc);
          if (!p) throw new Error('Document has never been saved; pass filePath (inside the allowed write folders).');
          __mcpAssertWritable(doc);
          doc.save();
          JSON.stringify({ saved: true, path: p });
        `,
          { targetDocument: targetFromArgs(args), timeoutMs: long(), mutating: true, toolName: "save_document" }
        );
      },
    },

    close_document: {
      description:
        "Close the target document. save: 'no' (default) closes without saving; 'yes' saves first (only allowed inside the allowed write folders). 'ask' is not supported because a modal dialog would block InDesign.",
      inputSchema: {
        type: "object" as const,
        properties: {
          document_id: DOC_ID,
          save: { type: "string", enum: ["no", "yes"], description: "Save behavior. Default: no" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        if (args.save === "ask") throw new Error("save:'ask' is not supported (it opens a modal dialog that blocks InDesign). Use 'no' or 'yes'.");
        const save = oneOf(args.save, ["no", "yes"] as const, "no", "save");
        return bridge.runScript(
          `
          var doc = __resolveDocument();
          var name = doc.name;
          var p = __docPath(doc);
          ${
            save === "yes"
              ? `if (!p) throw new Error('Untitled document: save it with save_document + filePath first.');
          __mcpAssertWritable(doc);
          doc.close(SaveOptions.YES);`
              : "doc.close(SaveOptions.NO);"
          }
          JSON.stringify({ closed: true, name: name, path: p, saved: ${save === "yes" ? "true" : "false"} });
        `,
          { targetDocument: targetFromArgs(args), timeoutMs: long(), toolName: "close_document" }
        );
      },
    },

    list_open_documents: {
      description: "List all open InDesign documents with index, name, full path (fullName) and whether each is inside the allowed write folders.",
      inputSchema: { type: "object" as const, properties: {} },
      handler: async () =>
        bridge.runScript(
          `
          var docs = [];
          var active = null;
          try { active = app.documents.length ? app.activeDocument.id : null; } catch (e) {}
          for (var i = 0; i < app.documents.length; i++) {
            var d = app.documents[i];
            var p = __docPath(d);
            docs.push({
              index: i,
              name: d.name,
              fullName: p,
              writable: __mcpIsWritablePath(p),
              active: active !== null && __mcpGet(function () { return d.id; }, -1) === active,
              saved: __mcpGet(function () { return d.saved; }, null),
              modified: __mcpGet(function () { return d.modified; }, null),
              pages: __mcpGet(function () { return d.pages.length; }, null)
            });
          }
          JSON.stringify(docs);
        `,
          { targetDocument: null, toolName: "list_open_documents" }
        ),
    },

    set_active_document: {
      description:
        "Bring an open document to the front. Prefer passing document_id to each tool instead — every tool accepts it. Accepts name (file name or full path) or index (0-based).",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Document file name or full path" },
          index: { type: "number", description: "Document index (0-based)" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const target =
          args.name !== undefined && args.name !== null && args.name !== ""
            ? jsStr(args.name)
            : jsInt(args.index ?? 0, "index");
        return bridge.runScript(
          `
          var doc = __findDocument(${target});
          if (!doc) throw new Error('Document not found: ' + ${target} + '. Open documents: ' + __openDocumentNames());
          app.activeDocument = doc;
          JSON.stringify({ active: doc.name, fullName: __docPath(doc) });
        `,
          { targetDocument: null, toolName: "set_active_document" }
        );
      },
    },

    get_document_preferences: {
      description: "Get document preferences: ruler units, ruler origin, baseline grid, document grid, language.",
      inputSchema: {
        type: "object" as const,
        properties: { document_id: DOC_ID },
      },
      handler: async (args: Record<string, unknown>) =>
        bridge.runScript(
          `
          var doc = __resolveDocument();
          var vp = doc.viewPreferences;
          var gp = doc.gridPreferences;
          JSON.stringify({
            measurementUnit: __mcpGet(function () { return vp.horizontalMeasurementUnits.toString(); }, ''),
            verticalUnit: __mcpGet(function () { return vp.verticalMeasurementUnits.toString(); }, ''),
            rulerOrigin: __mcpGet(function () { return vp.rulerOrigin.toString(); }, ''),
            note: 'Tools take and return points unless stated otherwise; the ruler units above are what the InDesign UI shows.',
            baselineGridStart: __mcpGet(function () { return gp.baselineStart; }, null),
            baselineGridIncrement: __mcpGet(function () { return gp.baselineDivision; }, null),
            gridShown: __mcpGet(function () { return gp.baselineGridShown; }, null),
            documentGridShown: __mcpGet(function () { return gp.documentGridShown; }, null),
            snapToGrid: __mcpGet(function () { return gp.documentGridSnapto; }, null),
            language: __mcpGet(function () { return doc.language ? doc.language.toString() : 'unknown'; }, 'unknown')
          });
        `,
          { targetDocument: targetFromArgs(args), toolName: "get_document_preferences" }
        ),
    },

    set_document_preferences: {
      description: "Set document preferences: page size, facing pages, bleed, slug. Values in points. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          document_id: DOC_ID,
          pageWidth: { type: "number", description: "Page width in points" },
          pageHeight: { type: "number", description: "Page height in points" },
          facingPages: { type: "boolean" },
          bleedTop: { type: "number" },
          bleedBottom: { type: "number" },
          bleedInside: { type: "number" },
          bleedOutside: { type: "number" },
          slugTop: { type: "number" },
          slugBottom: { type: "number" },
          slugInside: { type: "number" },
          slugOutside: { type: "number" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const map: [string, string][] = [
          ["pageWidth", "pageWidth"],
          ["pageHeight", "pageHeight"],
          ["bleedTop", "documentBleedTopOffset"],
          ["bleedBottom", "documentBleedBottomOffset"],
          ["bleedInside", "documentBleedInsideOrLeftOffset"],
          ["bleedOutside", "documentBleedOutsideOrRightOffset"],
          ["slugTop", "slugTopOffset"],
          ["slugBottom", "slugBottomOffset"],
          ["slugInside", "slugInsideOrLeftOffset"],
          ["slugOutside", "slugRightOrOutsideOffset"],
        ];
        const lines: string[] = [];
        if (args.facingPages !== undefined && args.facingPages !== null) {
          lines.push(`dp.facingPages = ${jsBool(args.facingPages, false, "facingPages")};`);
        }
        for (const [arg, prop] of map) {
          if (args[arg] !== undefined && args[arg] !== null) lines.push(`dp.${prop} = ${jsNum(args[arg], arg)};`);
        }
        return bridge.runScript(
          `
          var dp = __resolveDocument().documentPreferences;
          ${lines.join("\n          ")}
          JSON.stringify({ updated: ${lines.length} });
        `,
          { targetDocument: targetFromArgs(args), undoName: "Set Document Preferences", toolName: "set_document_preferences" }
        );
      },
    },

    get_document_fonts: {
      description: "List all fonts used in the target document with their status.",
      inputSchema: {
        type: "object" as const,
        properties: { document_id: DOC_ID },
      },
      handler: async (args: Record<string, unknown>) =>
        bridge.runScript(
          `
          var doc = __resolveDocument();
          var fonts = [];
          for (var i = 0; i < doc.fonts.length; i++) {
            var f = doc.fonts[i];
            fonts.push({
              name: __mcpGet(function () { return f.name; }, ''),
              fontFamily: __mcpGet(function () { return f.fontFamily; }, ''),
              fontStyleName: __mcpGet(function () { return f.fontStyleName; }, ''),
              status: __mcpGet(function () { return f.status.toString(); }, ''),
              fontType: __mcpGet(function () { return f.fontType.toString(); }, '')
            });
          }
          JSON.stringify(fonts);
        `,
          { targetDocument: targetFromArgs(args), toolName: "get_document_fonts" }
        ),
    },

    find_replace_text: {
      description:
        "Find and replace plain text in the target document, optionally limited to a story, a text frame or a page (scope). Literal by default ('^' is escaped, newlines become paragraph returns); set useMetacharacters:true to use InDesign ^-codes. Find/change options are set explicitly and restored afterwards. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          document_id: DOC_ID,
          findWhat: { type: "string", description: "Text to find" },
          changeTo: { type: "string", description: "Replacement text" },
          scope: SCOPE_SCHEMA,
          wholeWord: { type: "boolean", description: "Match whole word only. Default: false" },
          caseSensitive: { type: "boolean", description: "Case sensitive search. Default: false" },
          includeHiddenLayers: { type: "boolean", description: "Search hidden layers. Default: false" },
          includeMasterPages: { type: "boolean", description: "Search master pages. Default: false" },
          includeFootnotes: { type: "boolean", description: "Search footnotes. Default: true" },
          useMetacharacters: { type: "boolean", description: "Treat ^-codes (e.g. ^p, ^t) as InDesign metacharacters. Default: false" },
        },
        required: ["findWhat", "changeTo"],
      },
      handler: async (args: Record<string, unknown>) => {
        if (typeof args.findWhat !== "string" || args.findWhat === "") throw new Error("findWhat must be a non-empty string");
        if (typeof args.changeTo !== "string") throw new Error("changeTo must be a string");
        const meta = args.useMetacharacters === true;
        const opts = findOptionsCode(args);
        return bridge.runScript(
          `
          var doc = __resolveDocument();
          ${scopeTargetsCode(args.scope)}
          var __total = 0;
          ${opts.set}
          try {
            app.findTextPreferences = NothingEnum.NOTHING;
            app.changeTextPreferences = NothingEnum.NOTHING;
            app.findTextPreferences.findWhat = ${jsStr(literalFindText(args.findWhat, meta))};
            app.changeTextPreferences.changeTo = ${jsStr(literalFindText(args.changeTo, meta))};
            for (var t = 0; t < __targets.length; t++) {
              var res = __targets[t].changeText();
              __total += res.length;
            }
          } finally {
            ${opts.restore}
          }
          var __frResult = { replacements: __total, scope: __scopeLabel, noChange: __total === 0 };
          if (__total === 0) __frResult.note = 'No matches: nothing was changed. Do not call undo for this step (pass expectUndoName to undo if unsure).';
          JSON.stringify(__frResult);
        `,
          { targetDocument: targetFromArgs(args), undoName: "Find/Replace Text", toolName: "find_replace_text" }
        );
      },
    },

    find_text: {
      description:
        "Find occurrences of plain text in the target document (optionally scoped to a story, frame or page). Returns up to 100 hits with page, story id and frame id. Literal by default ('^' escaped).",
      inputSchema: {
        type: "object" as const,
        properties: {
          document_id: DOC_ID,
          findWhat: { type: "string", description: "Text to search for" },
          scope: SCOPE_SCHEMA,
          wholeWord: { type: "boolean" },
          caseSensitive: { type: "boolean" },
          includeMasterPages: { type: "boolean", description: "Default: false" },
          useMetacharacters: { type: "boolean", description: "Default: false" },
        },
        required: ["findWhat"],
      },
      handler: async (args: Record<string, unknown>) => {
        if (typeof args.findWhat !== "string" || args.findWhat === "") throw new Error("findWhat must be a non-empty string");
        const opts = findOptionsCode(args);
        return bridge.runScript(
          `
          var doc = __resolveDocument();
          ${scopeTargetsCode(args.scope)}
          var results = [];
          var total = 0;
          ${opts.set}
          try {
            app.findTextPreferences = NothingEnum.NOTHING;
            app.findTextPreferences.findWhat = ${jsStr(literalFindText(args.findWhat, args.useMetacharacters === true))};
            for (var tg = 0; tg < __targets.length; tg++) {
              var found = __targets[tg].findText();
              total += found.length;
              for (var i = 0; i < found.length && results.length < 100; i++) {
                var t = found[i];
                var fr = __mcpGet(function () { return t.parentTextFrames.length ? t.parentTextFrames[0] : null; }, null);
                results.push({
                  index: results.length,
                  contents: __mcpGet(function () { return t.contents; }, ''),
                  storyId: __mcpGet(function () { return t.parentStory.id; }, null),
                  frameId: fr ? __mcpGet(function () { return fr.id; }, null) : null,
                  parentPage: fr ? __mcpGet(function () { return fr.parentPage ? fr.parentPage.name : 'pasteboard'; }, 'unknown') : 'overset',
                  paragraphIndex: __mcpGet(function () { return t.paragraphs[0].index; }, -1)
                });
              }
            }
          } finally {
            ${opts.restore}
          }
          JSON.stringify({ total: total, scope: __scopeLabel, results: results });
        `,
          { targetDocument: targetFromArgs(args), toolName: "find_text" }
        );
      },
    },

    analyze_full_document: {
      description:
        "Comprehensive snapshot of the target document: pages, layers, master spreads, styles, swatches, fonts, links. Ideal for understanding a document before modifying it.",
      inputSchema: {
        type: "object" as const,
        properties: { document_id: DOC_ID },
      },
      handler: async (args: Record<string, unknown>) =>
        bridge.runScript(
          `
          var doc = __resolveDocument();
          var info = __getDocumentInfo(doc);
          info.units = 'points';

          var pages = [];
          for (var pi = 0; pi < doc.pages.length; pi++) {
            var pg = doc.pages[pi];
            var pgInfo = __getPageInfo(pg);
            pgInfo.itemCount = __mcpGet(function () { return pg.allPageItems.length; }, null);
            pgInfo.textFrameCount = __mcpGet(function () { return pg.textFrames.length; }, null);
            pages.push(pgInfo);
          }

          var layers = [];
          for (var li = 0; li < doc.layers.length; li++) {
            var lr = doc.layers[li];
            layers.push({ name: lr.name, visible: lr.visible, locked: lr.locked, index: li });
          }

          var masters = [];
          for (var mi = 0; mi < doc.masterSpreads.length; mi++) {
            var ms = doc.masterSpreads[mi];
            masters.push({ name: ms.name, namePrefix: ms.namePrefix, baseName: ms.baseName, pages: ms.pages.length });
          }

          var pStyles = [];
          var aps = doc.allParagraphStyles;
          for (var psi = 0; psi < aps.length; psi++) pStyles.push(__stylePath(aps[psi]));

          var cStyles = [];
          var acs = doc.allCharacterStyles;
          for (var csi = 0; csi < acs.length; csi++) cStyles.push(__stylePath(acs[csi]));

          var swatches = [];
          for (var si = 0; si < doc.swatches.length; si++) swatches.push(doc.swatches[si].name);

          var fonts = [];
          for (var fi = 0; fi < doc.fonts.length; fi++) {
            var ft = doc.fonts[fi];
            fonts.push({ name: __mcpGet(function () { return ft.name; }, ''), status: __mcpGet(function () { return ft.status.toString(); }, '') });
          }

          var links = [];
          for (var lki = 0; lki < doc.links.length; lki++) {
            var lk = doc.links[lki];
            links.push({ name: __mcpGet(function () { return lk.name; }, ''), status: __mcpGet(function () { return __linkStatus(lk); }, 'unknown'), filePath: __mcpGet(function () { return lk.filePath; }, '') });
          }

          JSON.stringify({
            document: info,
            pages: pages,
            layers: layers,
            masterSpreads: masters,
            paragraphStyles: pStyles,
            characterStyles: cStyles,
            swatches: swatches,
            fonts: fonts,
            links: links
          });
        `,
          { targetDocument: targetFromArgs(args), timeoutMs: long(), toolName: "analyze_full_document" }
        ),
    },

    analyze_layout: {
      description:
        "Analyze one page: every item (including grouped/anchored ones) with id, type, bounds (spread coordinates) and pageBounds (relative to the page's top-left), in points; text frames add content preview, overflow, story id and thread links; groups list their children.",
      inputSchema: {
        type: "object" as const,
        properties: {
          document_id: DOC_ID,
          pageIndex: { type: "number", description: "Page index (0-based). Default: 0" },
        },
      },
      handler: async (args: Record<string, unknown>) =>
        bridge.runScript(
          `
          var doc = __resolveDocument();
          var __pix = ${jsInt(args.pageIndex ?? 0, "pageIndex")};
          if (__pix >= doc.pages.length) throw new Error('pageIndex ' + __pix + ' out of range (0..' + (doc.pages.length - 1) + ')');
          var page = doc.pages[__pix];
          var pageInfo = __getPageInfo(page);
          var items = [];
          var all = page.allPageItems;
          for (var i = 0; i < all.length; i++) {
            var item = all[i];
            var info = __getItemInfo(item);
            var gb = __mcpGet(function () { return item.geometricBounds; }, null);
            if (gb) {
              var rb = __spreadToPage(page, gb);
              info.pageBounds = { top: rb[0], left: rb[1], bottom: rb[2], right: rb[3] };
            }
            if (info.itemType === 'TextFrame') {
              var c = __mcpGet(function () { return item.contents; }, '');
              info.contentPreview = c.length > 200 ? c.substring(0, 200) + '...' : c;
              info.overflows = __mcpGet(function () { return item.overflows; }, null);
              info.characterCount = __mcpGet(function () { return item.characters.length; }, null);
              info.paragraphCount = __mcpGet(function () { return item.paragraphs.length; }, null);
              info.storyId = __mcpGet(function () { return item.parentStory.id; }, null);
              info.previousTextFrameId = __mcpGet(function () { return item.previousTextFrame ? item.previousTextFrame.id : null; }, null);
              info.nextTextFrameId = __mcpGet(function () { return item.nextTextFrame ? item.nextTextFrame.id : null; }, null);
              info.appliedParagraphStyle = __mcpGet(function () { return item.paragraphs.length ? __stylePath(item.paragraphs[0].appliedParagraphStyle) : ''; }, '');
            }
            if (info.itemType === 'Rectangle' || info.itemType === 'Oval' || info.itemType === 'Polygon') {
              try {
                if (item.images && item.images.length > 0) {
                  var img = item.images[0];
                  info.hasImage = true;
                  info.imageLink = img.itemLink ? img.itemLink.name : '';
                  info.imageLinkStatus = img.itemLink ? __linkStatus(img.itemLink) : 'none';
                }
              } catch (e) {}
            }
            items.push(info);
          }
          JSON.stringify({ units: 'points', page: pageInfo, items: items, totalItems: items.length });
        `,
          { targetDocument: targetFromArgs(args), timeoutMs: long(), toolName: "analyze_layout" }
        ),
    },

    run_script: {
      description:
        "Execute arbitrary ExtendScript in InDesign. The completion value of the last statement is returned (use JSON.stringify or __ok(data)/__fail(msg)). Helpers: __resolveDocument(), __findDocument(), __docPath(doc), __itemById(doc,id), __findStyle(doc,'paragraph'|'character'|'object'|'table'|'cell', nameOrPathOrId), __stylePath(style), __spreadToPage(page,bounds), __pageToSpread(page,bounds), __findPage(), __getDocumentInfo(), __getPageInfo(), __getItemInfo(), __getBounds(), __linkStatus(), __mcpAssertWritable(doc), __ok(), __fail(). Dialogs are suppressed (NEVER_INTERACT). units: 'document' (default, ruler units) or 'points'.",
      inputSchema: {
        type: "object" as const,
        properties: {
          script: { type: "string", description: "ExtendScript code to execute." },
          document_id: DOC_ID,
          undoName: { type: "string", description: "Wrap the script in a single undo step with this name. Also enables the write-folder guard." },
          mutating: { type: "boolean", description: "The script changes the document: enables the write-folder guard. Implied by undoName." },
          units: { type: "string", enum: ["document", "points"], description: "Measurement units for numbers in the script. Default: document" },
          timeoutMs: { type: "number", description: "Timeout in ms (max 600000). Default: server default (120000)." },
        },
        required: ["script"],
      },
      handler: async (args: Record<string, unknown>) => {
        if (typeof args.script !== "string" || !args.script.trim()) throw new Error("script is required");
        const units = oneOf(args.units, ["document", "points"] as const, "document", "units");
        let timeoutMs: number | undefined;
        if (args.timeoutMs !== undefined && args.timeoutMs !== null) {
          timeoutMs = Math.min(Math.max(Number(jsNum(args.timeoutMs, "timeoutMs")), 1000), long());
        }
        return bridge.runScript(args.script, {
          targetDocument: targetFromArgs(args),
          undoName: typeof args.undoName === "string" && args.undoName ? args.undoName : undefined,
          mutating: args.mutating === true ? true : undefined,
          units,
          timeoutMs,
          toolName: "run_script",
        });
      },
    },

    undo: {
      description:
        "Undo the last undo step in the target document. Reads the step name first: returns {undone:false} when there is nothing to undo. Pass expectUndoName (e.g. 'MCP: Duplicate Page', 'Find/Replace Text') to refuse when the last step is something else, so a no-op tool call never makes you revert an earlier, unrelated step. Returns {undone, undoneName, nextUndoName, redoName, pagesBefore, pagesAfter}.",
      inputSchema: {
        type: "object" as const,
        properties: {
          document_id: DOC_ID,
          expectUndoName: {
            type: "string",
            description: "Only undo when the document's last undo step (doc.undoName) has exactly this name. Case-sensitive; surrounding whitespace is ignored.",
          },
        },
      },
      handler: async (args: Record<string, unknown>) =>
        bridge.runScript(undoRedoScript("undo", args.expectUndoName), {
          targetDocument: targetFromArgs(args),
          toolName: "undo",
        }),
    },

    redo: {
      description:
        "Redo the last undone step in the target document. Returns {redone:false} when there is nothing to redo. Pass expectRedoName to refuse when the next redo step has a different name. Returns {redone, redoneName, nextRedoName, undoName, pagesBefore, pagesAfter}.",
      inputSchema: {
        type: "object" as const,
        properties: {
          document_id: DOC_ID,
          expectRedoName: { type: "string", description: "Only redo when the next redo step has exactly this name." },
        },
      },
      handler: async (args: Record<string, unknown>) =>
        bridge.runScript(undoRedoScript("redo", args.expectRedoName), {
          targetDocument: targetFromArgs(args),
          toolName: "redo",
        }),
    },
  };
}
