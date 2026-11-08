import type { InDesignBridge } from "../bridge/index.js";
import {
  runLC,
  lcHandler,
  jsStr,
  jsNum,
  jsBool,
  jsBounds,
  optStr,
  reqStr,
  assertSafeWritePath,
  assertReadableFile,
  looksLikeFolder,
} from "./batchC_layoutKit.js";

const JPEG_QUALITY: Record<string, string> = {
  minimum: "JPEGOptionsQuality.MINIMUM",
  low: "JPEGOptionsQuality.LOW",
  medium: "JPEGOptionsQuality.MEDIUM",
  high: "JPEGOptionsQuality.HIGH",
  maximum: "JPEGOptionsQuality.MAXIMUM",
};
const PNG_QUALITY: Record<string, string> = {
  low: "PNGQualityEnum.LOW",
  medium: "PNGQualityEnum.MEDIUM",
  high: "PNGQualityEnum.HIGH",
  maximum: "PNGQualityEnum.MAXIMUM",
};
const PDF_BITMAP_QUALITY: Record<string, string> = {
  minimum: "CompressionQuality.MINIMUM",
  low: "CompressionQuality.LOW",
  medium: "CompressionQuality.MEDIUM",
  high: "CompressionQuality.HIGH",
  maximum: "CompressionQuality.MAXIMUM",
};
const PDF_COLOR_SPACE: Record<string, string> = {
  unchanged: "PDFColorSpace.UNCHANGED_COLOR_SPACE",
  cmyk: "PDFColorSpace.CMYK",
  rgb: "PDFColorSpace.RGB",
  repurposeRGB: "PDFColorSpace.REPURPOSE_RGB",
  repurposeCMYK: "PDFColorSpace.REPURPOSE_CMYK",
};
const PDF_QUALITY_PRESET: Record<string, string> = {
  screen: "[Smallest File Size]",
  print: "[High Quality Print]",
  press: "[Press Quality]",
};

function pick(map: Record<string, string>, v: unknown, name: string): string {
  if (typeof v !== "string" || !map[v]) throw new Error(`${name} must be one of ${Object.keys(map).join(", ")} (got ${JSON.stringify(v)})`);
  return map[v];
}

/** pageRange (names / "+N" absolute) or pageIndices (0-based absolute) → ExtendScript literal of the page spec, or 'null' for all pages. */
function pageSpecLiteral(args: Record<string, unknown>): string {
  const range = optStr(args.pageRange, "pageRange");
  const idx = args.pageIndices;
  if (range && Array.isArray(idx) && idx.length) throw new Error("Pass pageRange or pageIndices, not both");
  if (Array.isArray(idx) && idx.length) {
    return jsStr(idx.map((v, i) => "+" + (Number(jsNum(v, `pageIndices[${i}]`, { int: true, min: 0 })) + 1)).join(","));
  }
  if (range) {
    if (range.length > 2000) throw new Error("pageRange is too long");
    return jsStr(range);
  }
  return "null";
}

/** Shared JPEG/PNG exporter: exports page by page with EXPORT_RANGE, restoring the app export preferences afterwards. */
function imageExport(bridge: InDesignBridge, kind: "jpeg" | "png", args: Record<string, unknown>) {
  const raw = reqStr(args.outputPath, "outputPath");
  const folder = looksLikeFolder(raw);
  const exts = kind === "jpeg" ? [".jpg", ".jpeg"] : [".png"];
  const out = assertSafeWritePath(raw, exts, { folder, overwrite: args.overwrite !== false });
  const spec = pageSpecLiteral(args);
  const res = jsNum(args.resolution ?? 100, "resolution", { min: 36, max: 2400 });
  const maxPages = jsNum(args.maxPages ?? 20, "maxPages", { int: true, min: 1, max: 2000 });
  const prefsName = kind === "jpeg" ? "app.jpegExportPreferences" : "app.pngExportPreferences";
  const rangeProp = kind === "jpeg" ? "jpegExportRange" : "pngExportRange";
  const props = kind === "jpeg"
    ? ["exportResolution", "jpegQuality", "exportingSpread", "antiAlias", "useDocumentBleeds", "jpegExportRange", "pageString"]
    : ["exportResolution", "pngQuality", "exportingSpread", "antiAlias", "useDocumentBleeds", "transparentBackground", "pngExportRange", "pageString"];
  const sets: string[] = [`prefs.exportResolution = ${res};`];
  if (args.quality != null) {
    sets.push(kind === "jpeg"
      ? `prefs.jpegQuality = ${pick(JPEG_QUALITY, args.quality, "quality")};`
      : `prefs.pngQuality = ${pick(PNG_QUALITY, args.quality, "quality")};`);
  }
  sets.push(`prefs.exportingSpread = ${jsBool(args.spread, false)};`);
  if (args.antiAlias != null) sets.push(`prefs.antiAlias = ${jsBool(args.antiAlias, true)};`);
  if (args.includeBleed != null) sets.push(`prefs.useDocumentBleeds = ${jsBool(args.includeBleed, false)};`);
  if (kind === "png" && args.transparentBackground != null) sets.push(`prefs.transparentBackground = ${jsBool(args.transparentBackground, false)};`);
  const fmt = kind === "jpeg" ? "ExportFormat.JPG" : "ExportFormat.PNG_FORMAT";
  const ext = kind === "jpeg" ? (out.toLowerCase().endsWith(".jpeg") ? ".jpeg" : ".jpg") : ".png";

  return runLC(bridge, `
    var spec = ${spec};
    var offsets = [];
    if (spec === null) { for (var a = 0; a < doc.pages.length; a++) offsets.push(a); }
    else offsets = __lcResolvePageSpec(doc, spec);
    if (offsets.length === 0) return __fail('The page range resolved to no pages');
    if (offsets.length > ${maxPages}) return __fail('Refusing to export ' + offsets.length + ' pages (maxPages is ${maxPages}). Pass pageRange/pageIndices for the pages you need, or raise maxPages. Large exports can exceed the bridge timeout.');
    var folderMode = ${folder ? "true" : "false"};
    var outPath = ${jsStr(out)};
    var ext = ${jsStr(ext)};
    var docStem = String(doc.name).replace(/\\.ind[dt]$/i, '').replace(/[^A-Za-z0-9_. -]/g, '_');
    var stem = folderMode ? outPath.replace(/\\/+$/, '') + '/' + docStem : outPath.substr(0, outPath.length - ext.length);
    var spreadMode = ${jsBool(args.spread, false)};
    var single = !folderMode && offsets.length === 1;
    function pad(n) { var s = String(n); while (s.length < 3) s = '0' + s; return s; }
    var prefs = ${prefsName};
    var snap = __lcSnapPrefs(prefs, ${JSON.stringify(props)});
    var files = [], doneSpreads = {};
    var t0 = new Date().getTime();
    try {
      ${sets.join("\n      ")}
      prefs.${rangeProp} = ExportRangeOrAllPages.EXPORT_RANGE;
      for (var k = 0; k < offsets.length; k++) {
        var off = offsets[k];
        var pg = doc.pages[off];
        if (spreadMode) { var sid = 's' + pg.parent.id; if (doneSpreads[sid]) continue; doneSpreads[sid] = true; }
        var f = new File(single ? outPath : stem + '_p' + pad(off + 1) + ext);
        try {
          prefs.pageString = '+' + (off + 1);
          doc.exportFile(${fmt}, f, false);
        } catch (eAbs) {
          // Fallback: some versions only accept page names; use it when it is unambiguous.
          if (__lcPagesNamed(doc, pg.name).length !== 1) throw eAbs;
          prefs.pageString = pg.name;
          doc.exportFile(${fmt}, f, false);
        }
        files.push({ index: off, name: pg.name, side: __lcSide(pg), path: f.fsName, exists: f.exists });
      }
    } finally {
      __lcRestorePrefs(prefs, snap);
    }
    var missing = [];
    for (var m = 0; m < files.length; m++) { if (!files[m].exists) missing.push(files[m].path); }
    if (missing.length) return __fail('Export ran but these files were not written: ' + missing.join(', '));
    return __ok({ exported: true, format: ${jsStr(kind)}, resolution: ${res}, count: files.length, files: files, path: files.length ? files[0].path : null, ms: new Date().getTime() - t0 });
  `);
}

const imageExportProps = {
  outputPath: {
    type: "string",
    description:
      "Absolute output path inside the write roots (default test_fixtures\\runs and test_output). A file path exports that file for a single page (multiple pages get _pNNN suffixes); a folder path (trailing slash or no extension) writes <docname>_pNNN.<ext> per page.",
  },
  pageRange: {
    type: "string",
    description: "Pages to export: page names ('1-3,7') or absolute 1-based positions with '+' ('+5,+7-+9'). Default: all pages (subject to maxPages)",
  },
  pageIndices: { type: "array", items: { type: "number" }, description: "0-based absolute page indices (alternative to pageRange)" },
  resolution: { type: "number", description: "DPI. Default: 100 (preview quality)" },
  spread: { type: "boolean", description: "Export whole spreads instead of single pages. Default: false" },
  antiAlias: { type: "boolean" },
  includeBleed: { type: "boolean", description: "Include document bleed. Default: InDesign's current setting" },
  maxPages: { type: "number", description: "Safety cap on number of pages exported in one call. Default: 20" },
  overwrite: { type: "boolean", description: "Replace an existing file. Default: true" },
};

export function registerExportTools(bridge: InDesignBridge) {
  return {
    export_pdf: {
      description:
        "Export the document (or a page range) as PDF. App PDF export preferences are restored afterwards. A preset (or quality shortcut) is passed to InDesign; marks/bleed/quality options then apply only where the preset does not define them.",
      inputSchema: {
        type: "object" as const,
        properties: {
          outputPath: { type: "string", description: "Absolute .pdf path inside the write roots" },
          preset: { type: "string", description: "PDF export preset name (e.g. '[High Quality Print]'); see list_pdf_presets" },
          quality: { type: "string", enum: ["screen", "print", "press"], description: "Preset shortcut: screen=[Smallest File Size], print=[High Quality Print], press=[Press Quality]" },
          pageRange: { type: "string", description: "Page range by page names ('1-5,8') or absolute '+N'. Default: all pages" },
          pageIndices: { type: "array", items: { type: "number" }, description: "0-based absolute page indices (alternative to pageRange)" },
          spreads: { type: "boolean", description: "Export as spreads" },
          bleed: { type: "boolean", description: "Use document bleed" },
          slug: { type: "boolean", description: "Include slug area" },
          cropMarks: { type: "boolean" },
          registrationMarks: { type: "boolean" },
          colorBars: { type: "boolean" },
          pageInfo: { type: "boolean" },
          jpegQuality: { type: "string", enum: ["minimum", "low", "medium", "high", "maximum"], description: "Color/grayscale bitmap compression quality" },
          colorSpace: { type: "string", enum: ["unchanged", "cmyk", "rgb", "repurposeRGB", "repurposeCMYK"] },
          includeHyperlinks: { type: "boolean" },
          includeBookmarks: { type: "boolean" },
          interactivePDF: { type: "boolean", description: "Export as interactive PDF (only pageRange applies). Default: false" },
          overwrite: { type: "boolean", description: "Replace an existing file. Default: true" },
        },
        required: ["outputPath"],
      },
      handler: lcHandler(async (args) => {
        const out = assertSafeWritePath(args.outputPath, [".pdf"], { overwrite: args.overwrite !== false });
        const spec = pageSpecLiteral(args);
        let presetName = optStr(args.preset, "preset");
        if (!presetName && args.quality != null) presetName = pick(PDF_QUALITY_PRESET, args.quality, "quality");
        if (args.interactivePDF === true) {
          return runLC(bridge, `
            var f = new File(${jsStr(out)});
            var prefs = app.interactivePDFExportPreferences;
            var snap = __lcSnapPrefs(prefs, ['pageRange']);
            try {
              var spec = ${spec};
              prefs.pageRange = spec === null ? PageRange.ALL_PAGES : spec;
              doc.exportFile(ExportFormat.INTERACTIVE_PDF, f, false);
            } finally { __lcRestorePrefs(prefs, snap); }
            if (!f.exists) return __fail('InDesign did not write ' + f.fsName);
            return __ok({ exported: true, interactive: true, path: f.fsName });
          `);
        }
        const sets: string[] = [];
        const bool = (key: string, prop: string) => {
          if (args[key] != null) sets.push(`prefs.${prop} = ${jsBool(args[key], false)};`);
        };
        bool("spreads", "exportReaderSpreads");
        bool("bleed", "useDocumentBleedWithPDF");
        bool("slug", "includeSlugWithPDF");
        bool("cropMarks", "cropMarks");
        bool("registrationMarks", "registrationMarks");
        bool("colorBars", "colorBars");
        bool("pageInfo", "pageInformationMarks");
        bool("includeHyperlinks", "includeHyperlinks");
        bool("includeBookmarks", "includeBookmarks");
        if (args.jpegQuality != null) {
          const q = pick(PDF_BITMAP_QUALITY, args.jpegQuality, "jpegQuality");
          sets.push(`prefs.colorBitmapQuality = ${q};`, `prefs.grayscaleBitmapQuality = ${q};`);
        }
        if (args.colorSpace != null) sets.push(`prefs.pdfColorSpace = ${pick(PDF_COLOR_SPACE, args.colorSpace, "colorSpace")};`);
        const props = [
          "pageRange", "exportReaderSpreads", "useDocumentBleedWithPDF", "includeSlugWithPDF", "cropMarks",
          "registrationMarks", "colorBars", "pageInformationMarks", "includeHyperlinks", "includeBookmarks",
          "colorBitmapQuality", "grayscaleBitmapQuality", "pdfColorSpace",
        ];
        return runLC(bridge, `
          var f = new File(${jsStr(out)});
          var preset = null;
          ${presetName ? `
          preset = app.pdfExportPresets.itemByName(${jsStr(presetName)});
          if (!preset.isValid) {
            var names = [];
            for (var i = 0; i < app.pdfExportPresets.length; i++) names.push(app.pdfExportPresets[i].name);
            return __fail('PDF preset ' + ${jsStr(presetName)} + ' not found. Available: ' + names.join(', '));
          }` : ""}
          var prefs = app.pdfExportPreferences;
          var snap = __lcSnapPrefs(prefs, ${JSON.stringify(props)});
          try {
            var spec = ${spec};
            prefs.pageRange = spec === null ? PageRange.ALL_PAGES : spec;
            ${sets.join("\n            ")}
            if (preset) doc.exportFile(ExportFormat.PDF_TYPE, f, false, preset);
            else doc.exportFile(ExportFormat.PDF_TYPE, f, false);
          } finally {
            __lcRestorePrefs(prefs, snap);
          }
          if (!f.exists) return __fail('InDesign did not write ' + f.fsName);
          return __ok({ exported: true, path: f.fsName, preset: preset ? preset.name : null, pageRange: spec === null ? 'all' : spec,
            note: (preset && ${sets.length} > 0) ? 'A preset was used; options the preset defines take precedence over the individual options passed.' : null });
        `);
      }),
    },

    export_epub: {
      description: "Export the document as reflowable EPUB.",
      inputSchema: {
        type: "object" as const,
        properties: {
          outputPath: { type: "string", description: "Absolute .epub path inside the write roots" },
          coverOption: { type: "string", enum: ["firstPage", "externalImage", "none"] },
          coverImagePath: { type: "string", description: "Cover image (required for coverOption externalImage)" },
          overwrite: { type: "boolean", description: "Replace an existing file. Default: true" },
        },
        required: ["outputPath"],
      },
      handler: lcHandler(async (args) => {
        const out = assertSafeWritePath(args.outputPath, [".epub"], { overwrite: args.overwrite !== false });
        const cover = optStr(args.coverOption, "coverOption");
        let coverSets = "";
        if (cover) {
          const map: Record<string, string> = { firstPage: "EpubCover.FIRST_PAGE", externalImage: "EpubCover.EXTERNAL_IMAGE", none: "EpubCover.NONE" };
          coverSets = `ep.epubCover = ${pick(map, cover, "coverOption")};`;
          if (cover === "externalImage") {
            const img = assertReadableFile(args.coverImagePath, [".jpg", ".jpeg", ".png", ".gif"], "coverImagePath");
            coverSets += ` ep.coverImageFile = ${jsStr(img)};`;
          }
        }
        return runLC(bridge, `
          var f = new File(${jsStr(out)});
          var ep = doc.epubExportPreferences;
          var snap = __lcSnapPrefs(ep, ['epubCover', 'coverImageFile']);
          try {
            ${coverSets}
            doc.exportFile(ExportFormat.EPUB, f, false);
          } finally { __lcRestorePrefs(ep, snap); }
          if (!f.exists) return __fail('InDesign did not write ' + f.fsName);
          return __ok({ exported: true, path: f.fsName });
        `);
      }),
    },

    export_idml: {
      description: "Export the document as IDML (InDesign Markup Language). Refuses .indd/.indt output paths.",
      inputSchema: {
        type: "object" as const,
        properties: {
          outputPath: { type: "string", description: "Absolute .idml path inside the write roots" },
          overwrite: { type: "boolean", description: "Replace an existing file. Default: true" },
        },
        required: ["outputPath"],
      },
      handler: lcHandler(async (args) => {
        const out = assertSafeWritePath(args.outputPath, [".idml"], { overwrite: args.overwrite !== false });
        return runLC(bridge, `
          var f = new File(${jsStr(out)});
          doc.exportFile(ExportFormat.INDESIGN_MARKUP, f, false);
          if (!f.exists) return __fail('InDesign did not write ' + f.fsName);
          return __ok({ exported: true, path: f.fsName });
        `);
      }),
    },

    export_jpeg: {
      description:
        "Export pages as JPEG (default 100 dpi preview). Only the requested pages are rendered (EXPORT_RANGE, page by page); app JPEG export preferences are restored afterwards. Returns one file per page with its page name and side.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...imageExportProps,
          quality: { type: "string", enum: ["minimum", "low", "medium", "high", "maximum"] },
        },
        required: ["outputPath"],
      },
      handler: lcHandler(async (args) => imageExport(bridge, "jpeg", args)),
    },

    export_png: {
      description:
        "Export pages as PNG (default 100 dpi preview). Only the requested pages are rendered (EXPORT_RANGE, page by page); app PNG export preferences are restored afterwards.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...imageExportProps,
          quality: { type: "string", enum: ["low", "medium", "high", "maximum"] },
          transparentBackground: { type: "boolean" },
        },
        required: ["outputPath"],
      },
      handler: lcHandler(async (args) => imageExport(bridge, "png", args)),
    },

    export_html: {
      description: "Export the document as HTML. Refuses .indd/.indt output paths.",
      inputSchema: {
        type: "object" as const,
        properties: {
          outputPath: { type: "string", description: "Absolute .html path inside the write roots" },
          overwrite: { type: "boolean", description: "Replace an existing file. Default: true" },
        },
        required: ["outputPath"],
      },
      handler: lcHandler(async (args) => {
        const out = assertSafeWritePath(args.outputPath, [".html", ".htm"], { overwrite: args.overwrite !== false });
        return runLC(bridge, `
          var f = new File(${jsStr(out)});
          doc.exportFile(ExportFormat.HTML, f, false);
          if (!f.exists) return __fail('InDesign did not write ' + f.fsName);
          return __ok({ exported: true, path: f.fsName });
        `);
      }),
    },

    package_document: {
      description:
        "Package the document with fonts, linked graphics and a report into a folder inside the write roots. Does not repoint the document's links unless updateGraphicLinks is true.",
      inputSchema: {
        type: "object" as const,
        properties: {
          outputFolder: { type: "string", description: "Absolute folder path inside the write roots (created if missing)" },
          copyFonts: { type: "boolean", description: "Include fonts. Default: true" },
          copyLinkedGraphics: { type: "boolean", description: "Include linked images. Default: true" },
          updateGraphicLinks: { type: "boolean", description: "Repoint the document's links at the packaged copies (modifies the document). Default: false" },
          includeHiddenLayers: { type: "boolean", description: "Collect fonts/links on hidden layers. Default: false" },
          createReport: { type: "boolean", description: "Create a package report. Default: true" },
          instructions: { type: "string", description: "Instructions / version comments text" },
        },
        required: ["outputFolder"],
      },
      handler: lcHandler(async (args) => {
        const folder = assertSafeWritePath(args.outputFolder, [], { folder: true });
        const instructions = optStr(args.instructions, "instructions") ?? "";
        // packageForPrint(to, copyingFonts, copyingLinkedGraphics, copyingProfiles, updatingGraphics,
        //   includingHiddenLayers, ignorePreflightErrors, creatingReport, includeIdml, includePdf,
        //   pdfStyle, useDocumentHyphenationExceptionsOnly, versionComments, forceSave)
        return runLC(bridge, `
          var folder = new Folder(${jsStr(folder)});
          if (!folder.exists && !folder.create()) return __fail('Cannot create package folder ' + folder.fsName);
          var ok = doc.packageForPrint(
            folder,
            ${jsBool(args.copyFonts, true)},
            ${jsBool(args.copyLinkedGraphics, true)},
            true,
            ${jsBool(args.updateGraphicLinks, false)},
            ${jsBool(args.includeHiddenLayers, false)},
            true,
            ${jsBool(args.createReport, true)},
            false,
            false,
            '',
            false,
            ${jsStr(instructions)},
            false
          );
          if (ok === false) return __fail('InDesign refused to package the document into ' + folder.fsName + ' (packageForPrint returned false).');
          return __ok({ packaged: true, folder: folder.fsName, fileCount: folder.getFiles().length });
        `, args.updateGraphicLinks === true ? { mutating: true } : {});
      }),
    },

    list_pdf_presets: {
      description: "List available PDF export presets.",
      inputSchema: { type: "object" as const, properties: {} },
      handler: lcHandler(async () =>
        runLC(bridge, `
          var presets = [];
          for (var i = 0; i < app.pdfExportPresets.length; i++) presets.push(app.pdfExportPresets[i].name);
          return __ok(presets);
        `, { needsDocument: false })),
    },

    import_word: {
      description:
        "Place a Word/RTF file into a new text frame on a page (bounds in points relative to the page's top-left; default: the page's margin box). Refuses if the frame would overlap existing items unless allowOverlap. With autoflow, overflow is threaded into NEW pages inserted after the current page (same master), never onto existing pages; capped by maxNewPages and stops when a new frame receives no text. Returns overset status. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: { type: "string", description: "Absolute path to the .docx/.doc/.rtf file" },
          pageIndex: { type: "number", description: "Target page (0-based)" },
          bounds: { type: "array", items: { type: "number" }, description: "Frame bounds [top, left, bottom, right] in points, relative to the page's top-left" },
          preserveStyles: { type: "boolean", description: "Preserve Word local formatting. Default: true" },
          removeFormatting: { type: "boolean", description: "Strip all Word formatting. Default: false" },
          autoflow: { type: "boolean", description: "Thread overflow into new pages. Default: false" },
          maxNewPages: { type: "number", description: "Cap on pages autoflow may add (1-200). Default: 200" },
          allowOverlap: { type: "boolean", description: "Allow the first frame to overlap existing items on the page. Default: false" },
        },
        required: ["filePath", "pageIndex"],
      },
      handler: lcHandler(async (args) => {
        const file = assertReadableFile(args.filePath, [".docx", ".doc", ".rtf"]);
        const idx = jsNum(args.pageIndex, "pageIndex", { int: true, min: 0 });
        const box = args.bounds != null ? jsBounds(args.bounds) : "null";
        const maxNew = jsNum(args.maxNewPages ?? 200, "maxNewPages", { int: true, min: 1, max: 200 });
        const removeFmt = args.removeFormatting === true;
        const preserve = args.preserveStyles !== false;
        return runLC(bridge, `
          var page = __lcPageAt(doc, ${idx});
          var f = new File(${jsStr(file)});
          if (!f.exists) return __fail('File not found: ' + f.fsName);
          var box = ${box};
          if (box === null) box = __lcMarginBox(page);
          var hits = __lcOverlaps(page, box);
          if (hits.length && !${jsBool(args.allowOverlap, false)}) {
            return __fail('The new frame would overlap ' + hits.length + ' existing item(s) on page ' + page.name + ' (' + JSON.stringify(hits.slice(0, 10)) + '). Pass bounds for an empty area, use an empty page, or allowOverlap:true.');
          }
          var before = __lcSides(doc);
          var wp = app.wordRTFImportPreferences;
          var snap = __lcSnapPrefs(wp, ['preserveLocalOverrides', 'removeFormatting']);
          var tf;
          try {
            ${removeFmt
              ? "try { wp.removeFormatting = true; } catch (e) {} wp.preserveLocalOverrides = false;"
              : preserve ? "try { wp.removeFormatting = false; } catch (e) {} wp.preserveLocalOverrides = true;" : ""}
            tf = page.textFrames.add();
            tf.geometricBounds = __lcPageToSpread(page, box);
            tf.place(f, false);
          } finally {
            __lcRestorePrefs(wp, snap);
          }
          var frames = [tf.id], added = [], stopReason = null;
          var cur = tf, curPage = page;
          if (${jsBool(args.autoflow, false)}) {
            while (true) {
              try { cur.parentStory.recompose(); } catch (e) {}
              if (!cur.overflows) break;
              if (added.length >= ${maxNew}) { stopReason = 'Reached maxNewPages (${maxNew})'; break; }
              var np = doc.pages.add(LocationOptions.AFTER, curPage);
              try { np.appliedMaster = curPage.appliedMaster; } catch (e) {}
              var ntf = np.textFrames.add();
              ntf.geometricBounds = __lcPageToSpread(np, __lcMarginBox(np));
              cur.nextTextFrame = ntf;
              try { ntf.parentStory.recompose(); } catch (e) {}
              if (ntf.characters.length === 0) {
                ntf.remove();
                np.remove();
                stopReason = 'No progress: the next piece of the story (e.g. an oversized table, image or unbreakable line) does not fit an empty page frame';
                break;
              }
              added.push({ index: np.documentOffset, name: np.name, side: __lcSide(np), frameId: ntf.id });
              frames.push(ntf.id);
              cur = ntf;
              curPage = np;
            }
          }
          var overset = false;
          try { overset = cur.overflows; } catch (e) {}
          return __ok({
            placed: true,
            storyId: tf.parentStory.id,
            frameIds: frames,
            pagesAdded: added,
            overset: overset,
            stopReason: stopReason,
            warning: overset ? 'Text is still overset after the last frame; content is hidden.' : null,
            totalPages: doc.pages.length,
            parity: __lcParity(doc, before)
          });
        `, { mutating: true, undoName: "MCP: Import Word" });
      }),
    },

    import_xml: {
      description: "Import an XML file into the document's structure. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: { type: "string", description: "Absolute path to the .xml file" },
        },
        required: ["filePath"],
      },
      handler: lcHandler(async (args) => {
        const file = assertReadableFile(args.filePath, [".xml"]);
        return runLC(bridge, `
          var f = new File(${jsStr(file)});
          doc.importXML(f);
          return __ok({ imported: true, path: f.fsName });
        `, { mutating: true, undoName: "MCP: Import XML" });
      }),
    },

    place_text_file: {
      description:
        "Place a .txt/.rtf/.docx file. With frameId, the frame's WHOLE STORY is replaced (all threaded frames, formatting, anchored icons); this is refused when the frame is threaded or the story contains anchored objects/tables unless replaceStory:true. Without frameId a new frame is created on pageIndex (bounds in points relative to the page's top-left). Returns story length before/after. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: { type: "string", description: "Absolute path to the text file" },
          frameId: { type: "number", description: "Existing text frame id. If omitted, a new frame is created." },
          replaceStory: { type: "boolean", description: "Confirm replacing a threaded/complex story. Default: false" },
          pageIndex: { type: "number", description: "Page for a new frame (0-based). Required without frameId" },
          bounds: { type: "array", items: { type: "number" }, description: "New frame bounds [top, left, bottom, right], points relative to the page. Default: margin box" },
          allowOverlap: { type: "boolean", description: "Allow a new frame to overlap existing items. Default: false" },
        },
        required: ["filePath"],
      },
      handler: lcHandler(async (args) => {
        const file = assertReadableFile(args.filePath, [".txt", ".rtf", ".docx", ".doc"]);
        if (args.frameId != null) {
          const id = jsNum(args.frameId, "frameId", { int: true, min: 1 });
          return runLC(bridge, `
            var f = new File(${jsStr(file)});
            var tf = __lcRequireItem(doc, ${id}, 'Text frame', 'TextFrame');
            var st = tf.parentStory;
            var lenBefore = st.characters.length;
            var reasons = [];
            if (tf.previousTextFrame) reasons.push('the frame is threaded from frame ' + tf.previousTextFrame.id);
            if (tf.nextTextFrame) reasons.push('the frame threads into frame ' + tf.nextTextFrame.id);
            if (String(st.contents).indexOf('\\uFFFC') >= 0) reasons.push('the story contains anchored objects (icons/graphics)');
            if (st.tables.length > 0) reasons.push('the story contains ' + st.tables.length + ' table(s)');
            if (reasons.length && !${jsBool(args.replaceStory, false)}) {
              return __fail('Refusing to replace story ' + st.id + ' (' + lenBefore + ' characters, ' + st.textContainers.length + ' frame(s)): ' + reasons.join('; ') + '. Placing a file replaces the entire story and drops its formatting. Pass replaceStory:true to do it anyway, or use a paragraph-level replace tool.');
            }
            tf.place(f, false);
            var st2 = tf.parentStory;
            return __ok({ placed: true, frameId: tf.id, storyId: st2.id, storyLengthBefore: lenBefore, storyLengthAfter: st2.characters.length, overflows: st2.textContainers[st2.textContainers.length - 1].overflows });
          `, { mutating: true, undoName: "MCP: Place Text File" });
        }
        if (args.pageIndex == null) throw new Error("pageIndex is required when frameId is not given");
        const idx = jsNum(args.pageIndex, "pageIndex", { int: true, min: 0 });
        const box = args.bounds != null ? jsBounds(args.bounds) : "null";
        return runLC(bridge, `
          var f = new File(${jsStr(file)});
          var page = __lcPageAt(doc, ${idx});
          var box = ${box};
          if (box === null) box = __lcMarginBox(page);
          var hits = __lcOverlaps(page, box);
          if (hits.length && !${jsBool(args.allowOverlap, false)}) {
            return __fail('The new frame would overlap ' + hits.length + ' existing item(s) on page ' + page.name + ' (' + JSON.stringify(hits.slice(0, 10)) + '). Pass bounds for an empty area or allowOverlap:true.');
          }
          var tf = page.textFrames.add();
          tf.geometricBounds = __lcPageToSpread(page, box);
          tf.place(f, false);
          return __ok({ placed: true, frameId: tf.id, storyId: tf.parentStory.id, storyLengthBefore: 0, storyLengthAfter: tf.parentStory.characters.length, overflows: tf.overflows, bounds: __lcSpreadToPage(page, tf.geometricBounds) });
        `, { mutating: true, undoName: "MCP: Place Text File" });
      }),
    },
  };
}
