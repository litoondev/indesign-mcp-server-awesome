import type { InDesignBridge } from "../bridge/index.js";
import { runLC, lcHandler, jsStr, jsNum, jsBool, optStr, reqStr } from "./batchC_layoutKit.js";

const LOC: Record<string, string> = {
  end: "LocationOptions.AT_END",
  beginning: "LocationOptions.AT_BEGINNING",
  after: "LocationOptions.AFTER",
  before: "LocationOptions.BEFORE",
};

/** Exactly one of pageIndex / pageName → ExtendScript expression resolving the page (throws on bad input). */
function pageSelector(args: Record<string, unknown>): string {
  const hasIdx = args.pageIndex !== undefined && args.pageIndex !== null;
  const name = optStr(args.pageName, "pageName");
  if (hasIdx === !!name) throw new Error("Pass exactly one of pageIndex (0-based) or pageName");
  return hasIdx ? `__lcPageAt(doc, ${jsNum(args.pageIndex, "pageIndex", { int: true, min: 0 })})` : `__lcPageByName(doc, ${jsStr(name)})`;
}

export function registerPageTools(bridge: InDesignBridge) {
  return {
    list_pages: {
      description:
        "List all pages with index, name, side (left/right/single), applied master and item counts. Bounds are in points (spread coordinates).",
      inputSchema: { type: "object" as const, properties: {} },
      handler: lcHandler(async () =>
        runLC(bridge, `
          var pages = [];
          for (var i = 0; i < doc.pages.length; i++) {
            var p = doc.pages[i];
            var mName = null;
            try { mName = (p.appliedMaster && p.appliedMaster.isValid) ? p.appliedMaster.name : null; } catch (e) {}
            pages.push({
              index: i,
              id: p.id,
              name: p.name,
              side: __lcSide(p),
              spreadBounds: __lcRoundArr(p.bounds),
              appliedMaster: mName,
              pageItems: p.pageItems.length,
              textFrames: p.textFrames.length,
              rectangles: p.rectangles.length,
              groups: p.groups.length
            });
          }
          return __ok(pages);
        `)),
    },

    add_page: {
      description:
        "Add pages. 'after'/'before' require referencePageIndex. The new pages get masterName, or (default) the reference page's master. Reports pages whose left/right side flipped; add pages in pairs to keep facing-page parity. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          count: { type: "number", description: "Number of pages to add (1-500). Default: 1" },
          at: {
            type: "string",
            enum: ["end", "beginning", "after", "before"],
            description: "Where to add pages. Default: end",
          },
          referencePageIndex: {
            type: "number",
            description: "0-based reference page index; required for after/before",
          },
          masterName: {
            type: "string",
            description: "Master spread name (e.g. 'A-Master', or '[None]'). Default: the reference page's master (last page for 'end', first page for 'beginning')",
          },
          failOnParityChange: {
            type: "boolean",
            description: "Refuse (before changing anything) if the insertion would flip the side of existing pages. Default: false (warn only)",
          },
        },
      },
      handler: lcHandler(async (args) => {
        const at = (optStr(args.at, "at") ?? "end").toLowerCase();
        if (!LOC[at]) throw new Error(`at must be one of end, beginning, after, before (got ${at})`);
        const count = jsNum(args.count ?? 1, "count", { int: true, min: 1, max: 500 });
        const needsRef = at === "after" || at === "before";
        if (needsRef && (args.referencePageIndex === undefined || args.referencePageIndex === null)) {
          throw new Error(`at='${at}' requires referencePageIndex`);
        }
        const refExpr = needsRef
          ? `__lcPageAt(doc, ${jsNum(args.referencePageIndex, "referencePageIndex", { int: true, min: 0 })})`
          : at === "beginning" ? "doc.pages[0]" : "doc.pages[doc.pages.length - 1]";
        const masterName = optStr(args.masterName, "masterName");
        return runLC(bridge, `
          var count = ${count};
          var ref = ${refExpr};
          var master = ${masterName ? `__lcMaster(doc, ${jsStr(masterName)})` : "ref.appliedMaster"};
          var at = ${jsStr(at)};
          var refOffset = ref.documentOffset;
          var pagesAfter = at === 'end' ? 0 : at === 'beginning' ? doc.pages.length : at === 'after' ? doc.pages.length - refOffset - 1 : doc.pages.length - refOffset;
          var facing = doc.documentPreferences.facingPages;
          var predictedFlip = facing && (count % 2 === 1) && pagesAfter > 0;
          if (predictedFlip && ${jsBool(args.failOnParityChange, false)}) {
            return __fail('Adding ' + count + ' page(s) here would flip the left/right side of ' + pagesAfter + ' existing page(s). Add an even number of pages, or pass failOnParityChange:false.');
          }
          var before = __lcSides(doc);
          var added = [];
          var anchor = ref;
          for (var i = 0; i < count; i++) {
            var p;
            if (at === 'end') p = doc.pages.add(LocationOptions.AT_END);
            else if (at === 'before') p = doc.pages.add(LocationOptions.BEFORE, ref);
            else if (at === 'beginning' && i === 0) p = doc.pages.add(LocationOptions.AT_BEGINNING);
            else p = doc.pages.add(LocationOptions.AFTER, anchor);
            p.appliedMaster = master;
            anchor = p;
            added.push(p);
          }
          var out = [];
          for (var j = 0; j < added.length; j++) {
            var ap = added[j];
            var mn = null;
            try { mn = (ap.appliedMaster && ap.appliedMaster.isValid) ? ap.appliedMaster.name : null; } catch (e) {}
            out.push({ index: ap.documentOffset, name: ap.name, side: __lcSide(ap), appliedMaster: mn });
          }
          return __ok({ added: out, totalPages: doc.pages.length, parity: __lcParity(doc, before) });
        `, { mutating: true, undoName: "MCP: Add Pages" });
      }),
    },

    delete_page: {
      description:
        "Delete exactly one page, identified by pageIndex (0-based) or pageName (must be unique). spread:true deletes the page's whole spread (keeps facing parity). Reports threaded stories that became overset and pages whose side flipped. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          pageIndex: { type: "number", description: "Page index (0-based)" },
          pageName: { type: "string", description: "Page name (e.g. '1', 'ii'); fails if several pages share it" },
          spread: { type: "boolean", description: "Delete every page of the page's spread. Default: false" },
          failOnParityChange: { type: "boolean", description: "Refuse (before deleting) if later pages would flip sides. Default: false" },
        },
      },
      handler: lcHandler(async (args) => {
        const sel = pageSelector(args);
        return runLC(bridge, `
          var page = ${sel};
          if (!page.isValid) return __fail('Page not found');
          var victims = [];
          if (${jsBool(args.spread, false)}) {
            for (var v = 0; v < page.parent.pages.length; v++) victims.push(page.parent.pages[v]);
          } else {
            victims.push(page);
          }
          if (victims.length >= doc.pages.length) return __fail('Refusing to delete every page of the document');
          var lastOffset = victims[victims.length - 1].documentOffset;
          var pagesAfter = doc.pages.length - lastOffset - 1;
          if (doc.documentPreferences.facingPages && victims.length % 2 === 1 && pagesAfter > 0 && ${jsBool(args.failOnParityChange, false)}) {
            return __fail('Deleting ' + victims.length + ' page(s) would flip the side of ' + pagesAfter + ' later page(s). Use spread:true, or failOnParityChange:false.');
          }
          var stories = {}, storyIds = [];
          var info = [];
          for (var k = 0; k < victims.length; k++) {
            var vp = victims[k];
            info.push({ index: vp.documentOffset, name: vp.name, side: __lcSide(vp), itemCount: vp.allPageItems.length });
            for (var t = 0; t < vp.textFrames.length; t++) {
              var tf = vp.textFrames[t];
              try {
                if (tf.previousTextFrame || tf.nextTextFrame) {
                  var sid = tf.parentStory.id;
                  if (!stories['s' + sid]) { stories['s' + sid] = tf.parentStory; storyIds.push(sid); }
                }
              } catch (e) {}
            }
          }
          var before = __lcSides(doc);
          for (var d = victims.length - 1; d >= 0; d--) victims[d].remove();
          var overset = [];
          for (var s = 0; s < storyIds.length; s++) {
            var st = stories['s' + storyIds[s]];
            try {
              if (st.isValid && st.textContainers.length > 0 && st.textContainers[st.textContainers.length - 1].overflows) overset.push(storyIds[s]);
            } catch (e) {}
          }
          return __ok({
            deleted: info,
            remainingPages: doc.pages.length,
            threadedStoriesAffected: storyIds,
            oversetStories: overset,
            warning: overset.length ? 'Deleting the page left threaded text overset in story ids ' + overset.join(', ') + '. Undo, or continue the story onto new pages.' : null,
            parity: __lcParity(doc, before)
          });
        `, { mutating: true, undoName: "MCP: Delete Page" });
      }),
    },

    move_page: {
      description: "Move a page before/after another page. Reports pages whose left/right side flipped. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          fromIndex: { type: "number", description: "Source page index (0-based)" },
          toIndex: { type: "number", description: "Destination (reference) page index (0-based)" },
          position: {
            type: "string",
            enum: ["before", "after"],
            description: "Place before or after the destination page. Default: after",
          },
        },
        required: ["fromIndex", "toIndex"],
      },
      handler: lcHandler(async (args) => {
        const from = jsNum(args.fromIndex, "fromIndex", { int: true, min: 0 });
        const to = jsNum(args.toIndex, "toIndex", { int: true, min: 0 });
        if (from === to) throw new Error("fromIndex and toIndex are the same page");
        const pos = (optStr(args.position, "position") ?? "after").toLowerCase();
        if (pos !== "before" && pos !== "after") throw new Error("position must be 'before' or 'after'");
        return runLC(bridge, `
          var page = __lcPageAt(doc, ${from});
          var dest = __lcPageAt(doc, ${to});
          var sideBefore = __lcSide(page);
          var before = __lcSides(doc);
          page.move(${LOC[pos]}, dest);
          return __ok({ moved: true, pageName: page.name, newIndex: page.documentOffset, sideBefore: sideBefore, sideAfter: __lcSide(page), parity: __lcParity(doc, before) });
        `, { mutating: true, undoName: "MCP: Move Page" });
      }),
    },

    duplicate_page: {
      description:
        "Duplicate a page (or its whole spread with spread:true). New pages are found by page-id difference (robust when InDesign reshuffles spreads). For each copy: new index, side, sourceSide (side of the page it was copied from), applied master, ids of all page items, ids of copied text frames containing Lorem/ipsum placeholder text. warnings[] lists placeholder text and every copy whose left/right side differs from its source (warning = first one). keepSide:true refuses (and leaves the document unchanged) when a copy would change side. Reports side flips of existing pages. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          pageIndex: { type: "number", description: "Page index to duplicate (0-based)" },
          toLocation: {
            type: "string",
            enum: ["after", "before", "end", "beginning", "afterPage", "beforePage"],
            description:
              "Where to place the duplicate: after/before the source page, at the end/beginning of the document, or after/before the page given by referencePageIndex (afterPage/beforePage). Default: after",
          },
          referencePageIndex: {
            type: "number",
            description: "0-based index of the reference page; required for toLocation afterPage/beforePage (with spread:true, the copy goes after/before that page's spread)",
          },
          spread: { type: "boolean", description: "Duplicate the page's whole spread (keeps facing parity). Default: false" },
          keepSide: {
            type: "boolean",
            description:
              "Refuse when any copy would land on a different side (left/right) than its source page; the copies are removed again inside the same script so the document is unchanged. Default: false (warn only)",
          },
        },
        required: ["pageIndex"],
      },
      handler: lcHandler(async (args) => {
        const idx = jsNum(args.pageIndex, "pageIndex", { int: true, min: 0 });
        const loc = (optStr(args.toLocation, "toLocation") ?? "after").toLowerCase();
        const LOC_DUP: Record<string, string> = {
          after: "after", before: "before", end: "end", beginning: "beginning", afterpage: "after", beforepage: "before",
        };
        if (!LOC_DUP[loc]) throw new Error("toLocation must be after, before, end, beginning, afterPage or beforePage");
        const usesRefPage = loc === "afterpage" || loc === "beforepage";
        const hasRef = args.referencePageIndex !== undefined && args.referencePageIndex !== null;
        if (usesRefPage && !hasRef) throw new Error(`toLocation '${args.toLocation}' requires referencePageIndex`);
        if (!usesRefPage && hasRef) throw new Error("referencePageIndex is only used with toLocation afterPage/beforePage");
        const refIdx = usesRefPage ? jsNum(args.referencePageIndex, "referencePageIndex", { int: true, min: 0 }) : "null";
        const locConst = LOC[LOC_DUP[loc]];
        const isEdge = loc === "end" || loc === "beginning";
        const spread = jsBool(args.spread, false);
        const keepSide = jsBool(args.keepSide, false);
        // Reference object: the source itself, or the reference page (its spread for spread mode).
        const pageRef = usesRefPage ? "refPage" : "page";
        const spreadRef = usesRefPage ? "refPage.parent" : "sp";
        const dupPage = isEdge ? `page.duplicate(${locConst})` : `page.duplicate(${locConst}, ${pageRef})`;
        const dupSpread = isEdge ? `sp.duplicate(${locConst})` : `sp.duplicate(${locConst}, ${spreadRef})`;
        return runLC(bridge, `
          var page = __lcPageAt(doc, ${idx});
          var refPage = ${usesRefPage ? `__lcPageAt(doc, ${refIdx})` : "null"};
          var isSpread = ${spread};
          var sp = page.parent;
          // Source pages (in order) and their sides, recorded BEFORE the duplicate.
          var srcPages = [];
          if (isSpread) { for (var s0 = 0; s0 < sp.pages.length; s0++) srcPages.push(sp.pages[s0]); } else { srcPages.push(page); }
          var srcInfo = [];
          for (var s1 = 0; s1 < srcPages.length; s1++) srcInfo.push({ index: srcPages[s1].documentOffset, name: srcPages[s1].name, side: __lcSide(srcPages[s1]) });
          var sourceSide = __lcSide(page);
          var pageCountBefore = doc.pages.length;
          var before = __lcSides(doc);
          var oldIds = {};
          var idList = doc.pages.everyItem().id;
          if (!(idList instanceof Array)) idList = [idList];
          for (var q = 0; q < idList.length; q++) oldIds['p' + idList[q]] = true;

          if (isSpread) { ${dupSpread}; } else { ${dupPage}; }

          // New pages = pages whose id did not exist before, in document order.
          var newPages = [];
          for (var np = 0; np < doc.pages.length; np++) {
            var cand = doc.pages[np];
            if (!oldIds['p' + cand.id]) newPages.push(cand);
          }
          newPages.sort(function (a, b) { return a.documentOffset - b.documentOffset; });

          var warnings = [];
          var sideMismatches = [];
          var out = [];
          for (var n = 0; n < newPages.length; n++) {
            var dp = newPages[n];
            var src = newPages.length === srcInfo.length ? srcInfo[n] : (srcInfo.length === 1 ? srcInfo[0] : null);
            var dside = __lcSide(dp);
            var ids = [], lorem = [], threaded = [];
            var items = dp.allPageItems;
            for (var k = 0; k < items.length; k++) {
              var it = items[k];
              ids.push(it.id);
              if (it.constructor.name === 'TextFrame') {
                if (__lcLorem(it)) lorem.push(it.id);
                try { if (it.previousTextFrame || it.nextTextFrame) threaded.push(it.id); } catch (e) {}
              }
            }
            var mn = null;
            try { mn = (dp.appliedMaster && dp.appliedMaster.isValid) ? dp.appliedMaster.name : null; } catch (e) {}
            var flipped = !!(src && src.side !== dside && src.side !== 'unknown' && dside !== 'unknown');
            out.push({
              id: dp.id, newIndex: dp.documentOffset, name: dp.name, side: dside,
              sourceIndex: src ? src.index : null, sourceSide: src ? src.side : null, sideChanged: flipped,
              appliedMaster: mn, allPageItemIds: ids, loremFrameIds: lorem, threadedFrameIds: threaded
            });
            if (flipped) {
              sideMismatches.push(n);
              warnings.push('Copy of a ' + src.side + '-hand page (source index ' + src.index + ') landed on a ' + dside + '-hand page (index ' + dp.documentOffset + '); use move_page or add a blank page to restore the side, or duplicate with keepSide:true / spread:true.');
            }
          }
          if (srcInfo.length !== newPages.length) {
            warnings.push('Expected ' + srcInfo.length + ' new page(s) but found ' + newPages.length + '; per-page sourceSide could not be matched reliably.');
          }

          if (${keepSide} && sideMismatches.length) {
            // Refuse: remove the copies again (same undo step, so the net change is nothing).
            for (var r = newPages.length - 1; r >= 0; r--) { try { newPages[r].remove(); } catch (eRm) {} }
            var restored = doc.pages.length === pageCountBefore;
            var par = __lcParity(doc, before);
            return __fail('keepSide: ' + warnings[0] + ' The duplicate was refused and the copies were removed' +
              (restored && par.flippedCount === 0 ? '; the document is unchanged (do not undo).' : ', but the document did not return to its previous state (pages ' + doc.pages.length + ' vs ' + pageCountBefore + ', ' + par.flippedCount + ' page(s) changed side); check it or undo "MCP: Duplicate Page".') +
              ' Try spread:true, a different toLocation/referencePageIndex, or add a blank page first.');
          }

          // Placeholder-text warnings first (the single 'warning' field used to carry only this one).
          var loremWarnings = [];
          for (var w = 0; w < out.length; w++) {
            if (out[w].loremFrameIds.length) loremWarnings.push('The copy at index ' + out[w].newIndex + ' contains placeholder (Lorem ipsum) text in frames ' + out[w].loremFrameIds.join(', ') + '; replace or remove it.');
          }
          warnings = loremWarnings.concat(warnings);
          var parity = __lcParity(doc, before);
          if (parity.warning) warnings.push(parity.warning);
          return __ok({
            duplicated: true,
            sourceIndex: ${idx},
            sourceSide: sourceSide,
            sourcePages: srcInfo,
            newPage: out.length ? out[0].name : null,
            newPageIds: (function () { var a = []; for (var z = 0; z < out.length; z++) a.push(out[z].id); return a; })(),
            pages: out,
            sideChanged: sideMismatches.length > 0,
            warning: warnings.length ? warnings[0] : null,
            warnings: warnings,
            parity: parity
          });
        `, { mutating: true, undoName: "MCP: Duplicate Page" });
      }),
    },

    apply_master: {
      description:
        "Apply a master spread to specific pages (pageIndices) or to every page (allPages:true). One of the two is required. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          masterName: { type: "string", description: "Master spread name (e.g. 'A-Master'), or '[None]'" },
          pageIndices: {
            type: "array",
            items: { type: "number" },
            description: "0-based page indices to apply the master to",
          },
          allPages: { type: "boolean", description: "Apply to all pages" },
        },
        required: ["masterName"],
      },
      handler: lcHandler(async (args) => {
        const masterName = reqStr(args.masterName, "masterName");
        const all = args.allPages === true;
        const hasIdx = Array.isArray(args.pageIndices) && args.pageIndices.length > 0;
        if (all === hasIdx) throw new Error("Pass exactly one of pageIndices (non-empty) or allPages:true");
        const indices = hasIdx
          ? "[" + (args.pageIndices as unknown[]).map((v, i) => jsNum(v, `pageIndices[${i}]`, { int: true, min: 0 })).join(",") + "]"
          : "null";
        return runLC(bridge, `
          var master = __lcMaster(doc, ${jsStr(masterName)});
          var indices = ${indices};
          var targets = [];
          if (indices === null) { for (var i = 0; i < doc.pages.length; i++) targets.push(doc.pages[i]); }
          else { for (var j = 0; j < indices.length; j++) targets.push(__lcPageAt(doc, indices[j])); }
          var applied = [];
          for (var k = 0; k < targets.length; k++) {
            var p = targets[k];
            var prev = null;
            try { prev = (p.appliedMaster && p.appliedMaster.isValid) ? p.appliedMaster.name : null; } catch (e) {}
            p.appliedMaster = master;
            applied.push({ index: p.documentOffset, name: p.name, previousMaster: prev });
          }
          return __ok({ applied: applied, masterName: master === NothingEnum.NOTHING ? '[None]' : master.name });
        `, { mutating: true, undoName: "MCP: Apply Master" });
      }),
    },

    list_master_spreads: {
      description: "List all master spreads in the document.",
      inputSchema: { type: "object" as const, properties: {} },
      handler: lcHandler(async () =>
        runLC(bridge, `
          var masters = [];
          for (var i = 0; i < doc.masterSpreads.length; i++) {
            var m = doc.masterSpreads[i];
            var basedOn = null;
            try { basedOn = (m.appliedMaster && m.appliedMaster.isValid) ? m.appliedMaster.name : null; } catch (e) {}
            masters.push({ id: m.id, name: m.name, namePrefix: m.namePrefix, baseName: m.baseName, basedOn: basedOn, pages: m.pages.length, pageItems: m.pageItems.length });
          }
          return __ok(masters);
        `)),
    },

    create_master_spread: {
      description: "Create a new master spread with the given prefix, base name and page count. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          namePrefix: { type: "string", description: "Prefix (e.g. 'B'); must not already be used" },
          baseName: { type: "string", description: "Base name (e.g. 'CustomMaster')" },
          basedOn: { type: "string", description: "Name of parent master to base on" },
          numPages: { type: "number", description: "Pages in the master (1-10). Default: InDesign's default (2 for facing documents)" },
        },
        required: ["namePrefix", "baseName"],
      },
      handler: lcHandler(async (args) => {
        const prefix = reqStr(args.namePrefix, "namePrefix");
        const base = reqStr(args.baseName, "baseName");
        const basedOn = optStr(args.basedOn, "basedOn");
        const numPages = args.numPages == null ? "null" : jsNum(args.numPages, "numPages", { int: true, min: 1, max: 10 });
        return runLC(bridge, `
          for (var i = 0; i < doc.masterSpreads.length; i++) {
            if (doc.masterSpreads[i].namePrefix === ${jsStr(prefix)}) return __fail('A master with prefix "' + ${jsStr(prefix)} + '" already exists: ' + doc.masterSpreads[i].name);
          }
          var parent = ${basedOn ? `__lcMaster(doc, ${jsStr(basedOn)})` : "null"};
          var ms = doc.masterSpreads.add();
          ms.namePrefix = ${jsStr(prefix)};
          ms.baseName = ${jsStr(base)};
          var n = ${numPages};
          if (n !== null) {
            while (ms.pages.length < n) ms.pages.add();
            while (ms.pages.length > n) ms.pages[-1].remove();
          }
          if (parent) ms.appliedMaster = parent;
          return __ok({ created: true, id: ms.id, name: ms.name, pages: ms.pages.length });
        `, { mutating: true, undoName: "MCP: Create Master Spread" });
      }),
    },

    get_page_items: {
      description:
        "Get items on a page. 'bounds' are page-relative points [top, left, bottom, right] measured from the page's top-left corner (the same convention the create/place tools accept); 'spreadBounds' are raw spread coordinates. includeNested also lists items inside groups and anchored objects.",
      inputSchema: {
        type: "object" as const,
        properties: {
          pageIndex: { type: "number", description: "Page index (0-based)" },
          includeNested: { type: "boolean", description: "Include grouped/anchored items (allPageItems). Default: false" },
        },
        required: ["pageIndex"],
      },
      handler: lcHandler(async (args) => {
        const idx = jsNum(args.pageIndex, "pageIndex", { int: true, min: 0 });
        return runLC(bridge, `
          var page = __lcPageAt(doc, ${idx});
          var list = [];
          if (${jsBool(args.includeNested, false)}) { list = page.allPageItems; }
          else { for (var pi = 0; pi < page.pageItems.length; pi++) list.push(page.pageItems[pi].getElements()[0]); }
          var items = [];
          for (var i = 0; i < list.length; i++) {
            var item = list[i];
            var type = item.constructor.name;
            var parentType = '';
            try { parentType = item.parent.constructor.name; } catch (e) {}
            var info = {
              id: item.id,
              type: type,
              name: item.name || '',
              parentType: parentType,
              bounds: __lcSpreadToPage(page, item.geometricBounds),
              spreadBounds: __lcRoundArr(item.geometricBounds),
              visible: item.visible,
              locked: item.locked
            };
            if (type === 'TextFrame') {
              try { info.contents = String(item.texts[0].contents).substring(0, 200); } catch (e) { info.contents = ''; }
              info.overflows = item.overflows;
              try { info.storyId = item.parentStory.id; info.threaded = !!(item.previousTextFrame || item.nextTextFrame); } catch (e) {}
            }
            if (type === 'Rectangle' || type === 'Oval' || type === 'Polygon') {
              try { info.hasFill = item.fillColor.name !== 'None'; } catch (e) {}
              try { info.hasStroke = item.strokeColor.name !== 'None'; } catch (e) {}
              info.hasImage = item.allGraphics.length > 0;
            }
            items.push(info);
          }
          return __ok({ pageIndex: ${idx}, pageName: page.name, side: __lcSide(page), items: items });
        `);
      }),
    },

    set_page_size: {
      description: "Change the size of one page (width/height in points). One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          pageIndex: { type: "number", description: "Page index (0-based)" },
          width: { type: "number", description: "New width in points" },
          height: { type: "number", description: "New height in points" },
        },
        required: ["pageIndex", "width", "height"],
      },
      handler: lcHandler(async (args) => {
        const idx = jsNum(args.pageIndex, "pageIndex", { int: true, min: 0 });
        const w = jsNum(args.width, "width", { min: 1, max: 15552 });
        const h = jsNum(args.height, "height", { min: 1, max: 15552 });
        return runLC(bridge, `
          var page = __lcPageAt(doc, ${idx});
          page.resize(CoordinateSpaces.INNER_COORDINATES, AnchorPoint.CENTER_ANCHOR, ResizeMethods.REPLACING_CURRENT_DIMENSIONS_WITH, [${w}, ${h}]);
          return __ok({ resized: true, pageName: page.name, spreadBounds: __lcRoundArr(page.bounds) });
        `, { mutating: true, undoName: "MCP: Set Page Size" });
      }),
    },

    set_page_margins: {
      description:
        "Set margins (points) for one page. On facing pages 'left' is the INSIDE margin and 'right' the OUTSIDE margin. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          pageIndex: { type: "number", description: "Page index (0-based)" },
          top: { type: "number" },
          bottom: { type: "number" },
          left: { type: "number", description: "Left margin, or inside margin on facing pages" },
          right: { type: "number", description: "Right margin, or outside margin on facing pages" },
          columns: { type: "number" },
          columnGutter: { type: "number" },
        },
        required: ["pageIndex"],
      },
      handler: lcHandler(async (args) => {
        const idx = jsNum(args.pageIndex, "pageIndex", { int: true, min: 0 });
        const sets: string[] = [];
        for (const k of ["top", "bottom", "left", "right"] as const) {
          if (args[k] != null) sets.push(`mp.${k} = ${jsNum(args[k], k, { min: 0 })};`);
        }
        if (args.columns != null) sets.push(`mp.columnCount = ${jsNum(args.columns, "columns", { int: true, min: 1, max: 216 })};`);
        if (args.columnGutter != null) sets.push(`mp.columnGutter = ${jsNum(args.columnGutter, "columnGutter", { min: 0 })};`);
        if (!sets.length) throw new Error("Nothing to change: pass at least one of top, bottom, left, right, columns, columnGutter");
        return runLC(bridge, `
          var page = __lcPageAt(doc, ${idx});
          var mp = page.marginPreferences;
          ${sets.join("\n          ")}
          return __ok({ updated: true, pageName: page.name, margins: { top: mp.top, bottom: mp.bottom, left: mp.left, right: mp.right, columns: mp.columnCount, gutter: mp.columnGutter } });
        `, { mutating: true, undoName: "MCP: Set Page Margins" });
      }),
    },

    get_page_sections: {
      description: "List all page sections (numbering sections) in the document.",
      inputSchema: { type: "object" as const, properties: {} },
      handler: lcHandler(async () =>
        runLC(bridge, `
          var sections = [];
          for (var i = 0; i < doc.sections.length; i++) {
            var s = doc.sections[i];
            var startName = '', startIndex = -1;
            try { startName = s.pageStart.name; startIndex = s.pageStart.documentOffset; } catch (e) {}
            sections.push({
              name: s.name,
              pageNumberStart: s.pageNumberStart,
              marker: s.marker,
              continueNumbering: s.continueNumbering,
              pageStart: startName,
              pageStartIndex: startIndex,
              sectionPrefix: s.sectionPrefix,
              pageNumberStyle: String(s.pageNumberStyle)
            });
          }
          return __ok(sections);
        `)),
    },

    navigate_to_page: {
      description: "Show a specific page in the document's layout window.",
      inputSchema: {
        type: "object" as const,
        properties: {
          pageIndex: { type: "number", description: "Page index (0-based)" },
        },
        required: ["pageIndex"],
      },
      handler: lcHandler(async (args) => {
        const idx = jsNum(args.pageIndex, "pageIndex", { int: true, min: 0 });
        return runLC(bridge, `
          var page = __lcPageAt(doc, ${idx});
          if (!doc.layoutWindows || doc.layoutWindows.length === 0) return __fail('Document "' + doc.name + '" has no open layout window');
          doc.layoutWindows[0].activePage = page;
          return __ok({ navigated: true, page: page.name, index: ${idx} });
        `);
      }),
    },
  };
}
