import type { InDesignBridge } from "../bridge/index.js";
import { targetFromArgs } from "../bridge/documentTarget.js";
import { jsStr, jsInt, jsBool, jsStrArray, oneOf } from "../bridge/jsStr.js";
import { assertSafeWriteDir } from "../bridge/safety.js";
import { literalFindText } from "./document.js";

const DOC_ID = {
  type: ["string", "integer"],
  description: "Target document: full path (preferred), file name, or 0-based index. Omit for the front document.",
};

const DOCUMENT_NAMES = {
  type: "array",
  items: { type: "string" },
  description: "Documents to include when allDocuments is true: full paths (preferred) or file names.",
};

/**
 * ExtendScript defining `__docs`: the targeted document by default; with
 * allDocuments:true the explicitly listed documentNames (required when
 * `requireNames`), or every open document for read-only tools.
 */
function docsSelectionCode(args: Record<string, unknown>, requireNames: boolean): string {
  const names = Array.isArray(args.documentNames) && args.documentNames.length > 0 ? args.documentNames : null;
  if (args.allDocuments === true || (names && args.allDocuments !== false)) {
    if (!names) {
      if (requireNames) {
        throw new Error("allDocuments:true requires documentNames[] (full paths preferred) listing every document to change.");
      }
      return `var __docs = []; for (var __d = 0; __d < app.documents.length; __d++) __docs.push(app.documents[__d]);`;
    }
    return `
      var __docs = [];
      var __want = ${jsStrArray(names, "documentNames")};
      for (var __w = 0; __w < __want.length; __w++) {
        var __dd = __findDocument(__want[__w]);
        if (!__dd) throw new Error('Document not open: ' + __want[__w] + '. Open documents: ' + __openDocumentNames());
        __docs.push(__dd);
      }`;
  }
  return `var __docs = [__resolveDocument()];`;
}

/** Pre-checks every selected document before anything is changed. */
const ASSERT_ALL_WRITABLE = `for (var __a = 0; __a < __docs.length; __a++) __mcpAssertWritable(__docs[__a]);`;

function safeFileStem(): string {
  return `function __stem(doc) { return String(doc.name).replace(/\\.(indd|indt|idml)$/i, '').replace(/[\\\\\\/:*?"<>|]/g, '_'); }`;
}

export function registerBatchTools(bridge: InDesignBridge) {
  const long = () => bridge.longTimeout();

  return {
    batch_export_pdf: {
      description:
        "Export the targeted document (default) or, with allDocuments:true, the listed documentNames (or all open documents) as PDF into outputFolder (must be inside the allowed write folders). Existing PDFs are not overwritten unless overwrite:true.",
      inputSchema: {
        type: "object" as const,
        properties: {
          document_id: DOC_ID,
          outputFolder: { type: "string", description: "Output folder for PDFs" },
          preset: { type: "string", description: "PDF preset name" },
          allDocuments: { type: "boolean", description: "Export several documents. Default: false" },
          documentNames: DOCUMENT_NAMES,
          pageRange: { type: "string", description: "InDesign page range, e.g. '1-4,7'. Default: all pages" },
          overwrite: { type: "boolean", description: "Replace existing PDFs. Default: false" },
        },
        required: ["outputFolder"],
      },
      handler: async (args: Record<string, unknown>) => {
        const folder = assertSafeWriteDir(args.outputFolder);
        return bridge.runScript(
          `
          ${docsSelectionCode(args, false)}
          ${safeFileStem()}
          var folder = new Folder(${jsStr(folder)});
          if (!folder.exists && !folder.create()) throw new Error('Cannot create folder ' + folder.fsName);
          var preset = null;
          ${
            args.preset
              ? `preset = app.pdfExportPresets.itemByName(${jsStr(args.preset)});
          if (!preset.isValid) throw new Error('PDF preset not found: ' + ${jsStr(args.preset)});`
              : ""
          }
          var prevRange = app.pdfExportPreferences.pageRange;
          var results = [];
          try {
            app.pdfExportPreferences.pageRange = ${args.pageRange ? jsStr(args.pageRange) : "PageRange.ALL_PAGES"};
            for (var i = 0; i < __docs.length; i++) {
              var doc = __docs[i];
              try {
                var f = new File(folder.fsName + '/' + __stem(doc) + '.pdf');
                if (f.exists && !${jsBool(args.overwrite, false, "overwrite")}) { results.push({ doc: doc.name, exported: false, error: 'exists: ' + f.fsName }); continue; }
                if (preset) doc.exportFile(ExportFormat.PDF_TYPE, f, false, preset);
                else doc.exportFile(ExportFormat.PDF_TYPE, f, false);
                results.push({ doc: doc.name, exported: true, path: f.fsName });
              } catch (e) {
                results.push({ doc: doc.name, exported: false, error: e.message });
              }
            }
          } finally {
            try { app.pdfExportPreferences.pageRange = prevRange; } catch (e) {}
          }
          JSON.stringify(results);
        `,
          { targetDocument: targetFromArgs(args), timeoutMs: long(), toolName: "batch_export_pdf" }
        );
      },
    },

    batch_export_jpeg: {
      description:
        "Export the targeted document (default) or, with allDocuments:true, the listed documentNames (or all open documents) as JPEG into outputFolder (inside the allowed write folders). InDesign appends page numbers per page.",
      inputSchema: {
        type: "object" as const,
        properties: {
          document_id: DOC_ID,
          outputFolder: { type: "string" },
          resolution: { type: "number", description: "DPI. Default: 150" },
          quality: { type: "string", enum: ["minimum", "low", "medium", "high", "maximum"] },
          allDocuments: { type: "boolean", description: "Export several documents. Default: false" },
          documentNames: DOCUMENT_NAMES,
        },
        required: ["outputFolder"],
      },
      handler: async (args: Record<string, unknown>) => {
        const folder = assertSafeWriteDir(args.outputFolder);
        const qualityMap: Record<string, string> = {
          minimum: "JPEGOptionsQuality.MINIMUM",
          low: "JPEGOptionsQuality.LOW",
          medium: "JPEGOptionsQuality.MEDIUM",
          high: "JPEGOptionsQuality.HIGH",
          maximum: "JPEGOptionsQuality.MAXIMUM",
        };
        const quality = args.quality === undefined ? null : oneOf(args.quality, ["minimum", "low", "medium", "high", "maximum"] as const, "high", "quality");
        return bridge.runScript(
          `
          ${docsSelectionCode(args, false)}
          ${safeFileStem()}
          var folder = new Folder(${jsStr(folder)});
          if (!folder.exists && !folder.create()) throw new Error('Cannot create folder ' + folder.fsName);
          app.jpegExportPreferences.exportResolution = ${jsInt(args.resolution ?? 150, "resolution")};
          ${quality ? `app.jpegExportPreferences.jpegQuality = ${qualityMap[quality]};` : ""}
          var results = [];
          for (var d = 0; d < __docs.length; d++) {
            var doc = __docs[d];
            try {
              var f = new File(folder.fsName + '/' + __stem(doc) + '.jpg');
              doc.exportFile(ExportFormat.JPG, f, false);
              results.push({ doc: doc.name, exported: true, path: f.fsName });
            } catch (e) {
              results.push({ doc: doc.name, exported: false, error: e.message });
            }
          }
          JSON.stringify(results);
        `,
          { targetDocument: targetFromArgs(args), timeoutMs: long(), toolName: "batch_export_jpeg" }
        );
      },
    },

    batch_find_replace: {
      description:
        "Find and replace in the targeted document (default). To change several documents pass allDocuments:true AND documentNames[] (full paths preferred); every listed document must be inside the allowed write folders. Text mode is literal unless useMetacharacters; GREP mode passes the pattern unchanged (backslashes preserved). Options are set explicitly and restored. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          document_id: DOC_ID,
          findWhat: { type: "string" },
          changeTo: { type: "string" },
          caseSensitive: { type: "boolean", description: "Text mode only (use (?i) in GREP). Default: false" },
          wholeWord: { type: "boolean", description: "Text mode only. Default: false" },
          useGrep: { type: "boolean", description: "Use GREP search. Default: false" },
          useMetacharacters: { type: "boolean", description: "Text mode: treat ^-codes as metacharacters. Default: false" },
          includeMasterPages: { type: "boolean", description: "Default: false" },
          allDocuments: { type: "boolean", description: "Change the documents listed in documentNames. Default: false" },
          documentNames: DOCUMENT_NAMES,
        },
        required: ["findWhat", "changeTo"],
      },
      handler: async (args: Record<string, unknown>) => {
        if (typeof args.findWhat !== "string" || args.findWhat === "") throw new Error("findWhat must be a non-empty string");
        if (typeof args.changeTo !== "string") throw new Error("changeTo must be a string");
        const grep = args.useGrep === true;
        const meta = args.useMetacharacters === true;
        const masters = jsBool(args.includeMasterPages, false, "includeMasterPages");
        const findLit = jsStr(grep ? args.findWhat : literalFindText(args.findWhat, meta));
        const changeLit = jsStr(grep ? args.changeTo : literalFindText(args.changeTo, meta));
        const optsObj = grep ? "app.findChangeGrepOptions" : "app.findChangeTextOptions";
        const prefs = grep ? ["findGrepPreferences", "changeGrepPreferences"] : ["findTextPreferences", "changeTextPreferences"];
        return bridge.runScript(
          `
          ${docsSelectionCode(args, true)}
          ${ASSERT_ALL_WRITABLE}
          var __fco = ${optsObj};
          var __keys = ${grep ? "['includeHiddenLayers','includeLockedLayersForFind','includeLockedStoriesForFind','includeMasterPages','includeFootnotes']" : "['caseSensitive','wholeWord','includeHiddenLayers','includeLockedLayersForFind','includeLockedStoriesForFind','includeMasterPages','includeFootnotes']"};
          var __prev = {};
          for (var k = 0; k < __keys.length; k++) { try { __prev[__keys[k]] = __fco[__keys[k]]; } catch (e) {} }
          var results = [];
          try {
            ${
              grep
                ? ""
                : `__fco.caseSensitive = ${jsBool(args.caseSensitive, false, "caseSensitive")};
            __fco.wholeWord = ${jsBool(args.wholeWord, false, "wholeWord")};`
            }
            __fco.includeHiddenLayers = false;
            __fco.includeLockedLayersForFind = false;
            __fco.includeLockedStoriesForFind = false;
            __fco.includeMasterPages = ${masters};
            __fco.includeFootnotes = true;
            app.${prefs[0]} = NothingEnum.NOTHING;
            app.${prefs[1]} = NothingEnum.NOTHING;
            app.${prefs[0]}.findWhat = ${findLit};
            app.${prefs[1]}.changeTo = ${changeLit};
            for (var d = 0; d < __docs.length; d++) {
              var doc = __docs[d];
              try {
                var found = doc.${grep ? "changeGrep" : "changeText"}();
                results.push({ doc: doc.name, path: __docPath(doc), replacements: found.length });
              } catch (e) {
                results.push({ doc: doc.name, path: __docPath(doc), error: e.message });
              }
            }
          } finally {
            app.${prefs[0]} = NothingEnum.NOTHING;
            app.${prefs[1]} = NothingEnum.NOTHING;
            for (var r in __prev) { try { __fco[r] = __prev[r]; } catch (e) {} }
          }
          JSON.stringify(results);
        `,
          {
            targetDocument: targetFromArgs(args),
            undoName: "Batch Find/Replace",
            guardWrite: false, // every selected document is checked in-script
            mutating: true,
            timeoutMs: long(),
            toolName: "batch_find_replace",
          }
        );
      },
    },

    batch_apply_style: {
      description:
        "Apply a paragraph or character style to text matching a GREP pattern in the targeted document. styleName accepts a style id, 'Group/Name' path or exact name. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          document_id: DOC_ID,
          findPattern: { type: "string", description: "GREP pattern to match text" },
          styleName: { type: "string", description: "Style id, 'Group/Name' path, or exact name" },
          styleType: { type: "string", enum: ["paragraph", "character"], description: "Style type" },
          includeMasterPages: { type: "boolean", description: "Default: false" },
        },
        required: ["findPattern", "styleName", "styleType"],
      },
      handler: async (args: Record<string, unknown>) => {
        if (typeof args.findPattern !== "string" || args.findPattern === "") throw new Error("findPattern must be a non-empty string");
        const kind = oneOf(args.styleType, ["paragraph", "character"] as const, "paragraph", "styleType");
        return bridge.runScript(
          `
          var doc = __resolveDocument();
          var style = __findStyle(doc, ${jsStr(kind)}, ${jsStr(args.styleName)});
          var __fco = app.findChangeGrepOptions;
          var __keys = ['includeHiddenLayers','includeLockedLayersForFind','includeLockedStoriesForFind','includeMasterPages','includeFootnotes'];
          var __prev = {};
          for (var k = 0; k < __keys.length; k++) { try { __prev[__keys[k]] = __fco[__keys[k]]; } catch (e) {} }
          var count = 0;
          try {
            __fco.includeHiddenLayers = false;
            __fco.includeLockedLayersForFind = false;
            __fco.includeLockedStoriesForFind = false;
            __fco.includeMasterPages = ${jsBool(args.includeMasterPages, false, "includeMasterPages")};
            __fco.includeFootnotes = true;
            app.findGrepPreferences = NothingEnum.NOTHING;
            app.changeGrepPreferences = NothingEnum.NOTHING;
            app.findGrepPreferences.findWhat = ${jsStr(args.findPattern)};
            ${kind === "paragraph" ? "app.changeGrepPreferences.appliedParagraphStyle = style;" : "app.changeGrepPreferences.appliedCharacterStyle = style;"}
            count = doc.changeGrep().length;
          } finally {
            app.findGrepPreferences = NothingEnum.NOTHING;
            app.changeGrepPreferences = NothingEnum.NOTHING;
            for (var r in __prev) { try { __fco[r] = __prev[r]; } catch (e) {} }
          }
          JSON.stringify({ applied: true, style: __stylePath(style), styleId: style.id, matches: count });
        `,
          { targetDocument: targetFromArgs(args), undoName: "Batch Apply Style", toolName: "batch_apply_style" }
        );
      },
    },

    batch_update_links: {
      description:
        "Update out-of-date links in the targeted document (default). For several documents pass allDocuments:true AND documentNames[]; every listed document must be inside the allowed write folders. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          document_id: DOC_ID,
          allDocuments: { type: "boolean", description: "Update the documents listed in documentNames. Default: false" },
          documentNames: DOCUMENT_NAMES,
        },
      },
      handler: async (args: Record<string, unknown>) =>
        bridge.runScript(
          `
          ${docsSelectionCode(args, true)}
          ${ASSERT_ALL_WRITABLE}
          var results = [];
          for (var d = 0; d < __docs.length; d++) {
            var doc = __docs[d];
            var updated = 0, failed = 0;
            for (var i = 0; i < doc.links.length; i++) {
              try {
                if (doc.links[i].status === LinkStatus.LINK_OUT_OF_DATE) {
                  doc.links[i].update();
                  updated++;
                }
              } catch (e) { failed++; }
            }
            results.push({ doc: doc.name, path: __docPath(doc), updatedLinks: updated, failed: failed, totalLinks: doc.links.length });
          }
          JSON.stringify(results);
        `,
          {
            targetDocument: targetFromArgs(args),
            undoName: "Batch Update Links",
            guardWrite: false, // every selected document is checked in-script
            mutating: true,
            timeoutMs: long(),
            toolName: "batch_update_links",
          }
        ),
    },

    batch_package: {
      description:
        "Package the targeted document (default) or, with allDocuments:true, the listed documentNames (or all open documents) into one sub-folder each of outputFolder (inside the allowed write folders). Does not save the source documents.",
      inputSchema: {
        type: "object" as const,
        properties: {
          document_id: DOC_ID,
          outputFolder: { type: "string", description: "Base output folder" },
          copyFonts: { type: "boolean", description: "Default: true" },
          copyLinkedGraphics: { type: "boolean", description: "Default: true" },
          includeHiddenLayers: { type: "boolean", description: "Default: false" },
          createReport: { type: "boolean", description: "Default: true" },
          allDocuments: { type: "boolean", description: "Package several documents. Default: false" },
          documentNames: DOCUMENT_NAMES,
        },
        required: ["outputFolder"],
      },
      handler: async (args: Record<string, unknown>) => {
        const folder = assertSafeWriteDir(args.outputFolder);
        return bridge.runScript(
          `
          ${docsSelectionCode(args, false)}
          ${safeFileStem()}
          var baseFolder = new Folder(${jsStr(folder)});
          if (!baseFolder.exists && !baseFolder.create()) throw new Error('Cannot create folder ' + baseFolder.fsName);
          var results = [];
          for (var i = 0; i < __docs.length; i++) {
            var doc = __docs[i];
            try {
              var docFolder = new Folder(baseFolder.fsName + '/' + __stem(doc));
              if (!docFolder.exists) docFolder.create();
              // packageForPrint(to, copyingFonts, copyingLinkedGraphics, copyingProfiles, updatingGraphics,
              //   includingHiddenLayers, ignorePreflightErrors, creatingReport, includeIdml, includePdf,
              //   pdfStyle, useDocumentHyphenationExceptionsOnly, versionComments, forceSave)
              var ok = doc.packageForPrint(
                docFolder,
                ${jsBool(args.copyFonts, true, "copyFonts")},
                ${jsBool(args.copyLinkedGraphics, true, "copyLinkedGraphics")},
                true,
                false,
                ${jsBool(args.includeHiddenLayers, false, "includeHiddenLayers")},
                true,
                ${jsBool(args.createReport, true, "createReport")},
                false,
                false,
                '',
                false,
                '',
                false
              );
              if (ok === false) results.push({ doc: doc.name, packaged: false, error: 'packageForPrint returned false' });
              else results.push({ doc: doc.name, packaged: true, folder: docFolder.fsName });
            } catch (e) {
              results.push({ doc: doc.name, packaged: false, error: e.message });
            }
          }
          JSON.stringify(results);
        `,
          { targetDocument: targetFromArgs(args), timeoutMs: long(), toolName: "batch_package" }
        );
      },
    },

    batch_preflight: {
      description:
        "Read-only checks on the targeted document (default) or all/listed open documents: overset stories, missing fonts, missing/modified links.",
      inputSchema: {
        type: "object" as const,
        properties: {
          document_id: DOC_ID,
          allDocuments: { type: "boolean", description: "Check all open documents (or documentNames). Default: false" },
          documentNames: DOCUMENT_NAMES,
        },
      },
      handler: async (args: Record<string, unknown>) =>
        bridge.runScript(
          `
          ${docsSelectionCode(args, false)}
          var results = [];
          for (var d = 0; d < __docs.length; d++) {
            var doc = __docs[d];
            var issues = { oversetText: [], missingFonts: [], missingLinks: [], modifiedLinks: [] };
            for (var i = 0; i < doc.stories.length; i++) {
              var st = doc.stories[i];
              if (__mcpGet(function () { return st.overflows; }, false)) {
                var containers = __mcpGet(function () { return st.textContainers; }, []);
                var lastFrame = containers.length ? containers[containers.length - 1] : null;
                issues.oversetText.push({
                  storyId: st.id,
                  lastFrameId: lastFrame ? __mcpGet(function () { return lastFrame.id; }, null) : null,
                  lastFramePage: lastFrame ? __mcpGet(function () { return lastFrame.parentPage ? lastFrame.parentPage.name : 'pasteboard'; }, 'unknown') : 'none'
                });
              }
            }
            for (var j = 0; j < doc.fonts.length; j++) {
              var fnt = doc.fonts[j];
              if (__mcpGet(function () { return fnt.status !== FontStatus.INSTALLED; }, false)) {
                issues.missingFonts.push({ name: fnt.name, status: __mcpGet(function () { return fnt.status.toString(); }, '') });
              }
            }
            for (var l = 0; l < doc.links.length; l++) {
              var lk = doc.links[l];
              var ls = __mcpGet(function () { return lk.status; }, null);
              if (ls === LinkStatus.LINK_MISSING) issues.missingLinks.push(lk.name);
              else if (ls === LinkStatus.LINK_OUT_OF_DATE) issues.modifiedLinks.push(lk.name);
            }
            results.push({ doc: doc.name, path: __docPath(doc), issues: issues });
          }
          JSON.stringify(results);
        `,
          { targetDocument: targetFromArgs(args), timeoutMs: long(), toolName: "batch_preflight" }
        ),
    },

    batch_close_all: {
      description:
        "Close open documents. Default: closes WITHOUT saving, and only documents inside the allowed write folders (run copies). includeOthers:true also closes other documents — those are never saved. saveOption 'yes' saves only documents inside the write folders. 'ask' is not supported (modal dialog).",
      inputSchema: {
        type: "object" as const,
        properties: {
          saveOption: { type: "string", enum: ["no", "yes"], description: "Save before closing (write-folder documents only). Default: no" },
          includeOthers: { type: "boolean", description: "Also close documents outside the write folders (without saving). Default: false" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        if (args.saveOption === "ask") throw new Error("saveOption:'ask' is not supported (it opens a modal dialog that blocks InDesign). Use 'no' or 'yes'.");
        const save = oneOf(args.saveOption, ["no", "yes"] as const, "no", "saveOption");
        const others = jsBool(args.includeOthers, false, "includeOthers");
        return bridge.runScript(
          `
          var closed = [], kept = [], errors = [];
          for (var i = app.documents.length - 1; i >= 0; i--) {
            var d = app.documents[i];
            var name = d.name;
            var p = __docPath(d);
            var writable = __mcpIsWritablePath(p);
            if (!writable && !${others}) { kept.push({ name: name, path: p, reason: 'outside write folders (pass includeOthers:true to close without saving)' }); continue; }
            try {
              var doSave = ${save === "yes" ? "true" : "false"} && writable;
              d.close(doSave ? SaveOptions.YES : SaveOptions.NO);
              closed.push({ name: name, path: p, saved: doSave });
            } catch (e) {
              errors.push({ name: name, path: p, error: e.message });
            }
          }
          JSON.stringify({ closed: closed, kept: kept, errors: errors });
        `,
          { targetDocument: null, timeoutMs: long(), toolName: "batch_close_all" }
        );
      },
    },
  };
}
