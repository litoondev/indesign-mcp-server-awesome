import type { InDesignBridge } from "../bridge/index.js";
import {
  runLC,
  lcHandler,
  jsStr,
  jsNum,
  jsBool,
  jsBounds,
  jsNumArray,
  optStr,
  reqStr,
  assertReadableFile,
} from "./batchC_layoutKit.js";

const FIT: Record<string, string> = {
  fillProportionally: "FitOptions.FILL_PROPORTIONALLY",
  fitProportionally: "FitOptions.PROPORTIONALLY",
  fitContentToFrame: "FitOptions.CONTENT_TO_FRAME",
  fitFrameToContent: "FitOptions.FRAME_TO_CONTENT",
  centerContent: "FitOptions.CENTER_CONTENT",
};
const EMPTY_FIT: Record<string, string> = {
  fillProportionally: "EmptyFrameFittingOptions.FILL_PROPORTIONALLY",
  fitProportionally: "EmptyFrameFittingOptions.PROPORTIONALLY",
  fitContentToFrame: "EmptyFrameFittingOptions.CONTENT_TO_FRAME",
  none: "EmptyFrameFittingOptions.NONE",
};
const ALIGN: Record<string, string> = {
  topLeft: "AnchorPoint.TOP_LEFT_ANCHOR",
  topCenter: "AnchorPoint.TOP_CENTER_ANCHOR",
  topRight: "AnchorPoint.TOP_RIGHT_ANCHOR",
  centerLeft: "AnchorPoint.LEFT_CENTER_ANCHOR",
  center: "AnchorPoint.CENTER_ANCHOR",
  centerRight: "AnchorPoint.RIGHT_CENTER_ANCHOR",
  bottomLeft: "AnchorPoint.BOTTOM_LEFT_ANCHOR",
  bottomCenter: "AnchorPoint.BOTTOM_CENTER_ANCHOR",
  bottomRight: "AnchorPoint.BOTTOM_RIGHT_ANCHOR",
};
const WRAP: Record<string, string> = {
  none: "TextWrapModes.NONE",
  boundingBox: "TextWrapModes.BOUNDING_BOX_TEXT_WRAP",
  objectShape: "TextWrapModes.CONTOUR",
  jumpObject: "TextWrapModes.JUMP_OBJECT_TEXT_WRAP",
  jumpToNextColumn: "TextWrapModes.NEXT_COLUMN_TEXT_WRAP",
};
const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".tif", ".tiff", ".psd", ".ai", ".eps", ".pdf", ".gif", ".bmp", ".svg", ".indd"];

function pick(map: Record<string, string>, v: unknown, name: string): string {
  if (typeof v !== "string" || !map[v]) throw new Error(`${name} must be one of ${Object.keys(map).join(", ")} (got ${JSON.stringify(v)})`);
  return map[v];
}

const BOUNDS_DESC = "[top, left, bottom, right] in points, relative to the page's top-left corner";

/** Fill/stroke lines resolving swatches by exact name (fails before mutating when a swatch is missing). */
function swatchSets(varName: string, args: Record<string, unknown>): { pre: string; apply: string } {
  const pre: string[] = [];
  const apply: string[] = [];
  const fill = optStr(args.fillColor, "fillColor");
  const stroke = optStr(args.strokeColor, "strokeColor");
  if (fill) { pre.push(`var __fill = __lcSwatch(doc, ${jsStr(fill)});`); apply.push(`${varName}.fillColor = __fill;`); }
  if (stroke) { pre.push(`var __stroke = __lcSwatch(doc, ${jsStr(stroke)});`); apply.push(`${varName}.strokeColor = __stroke;`); }
  if (args.strokeWeight != null) apply.push(`${varName}.strokeWeight = ${jsNum(args.strokeWeight, "strokeWeight", { min: 0, max: 1000 })};`);
  return { pre: pre.join("\n"), apply: apply.join("\n") };
}

export function registerImageTools(bridge: InDesignBridge) {
  return {
    place_image: {
      description:
        `Place an image into a new graphic frame on a page. bounds are ${BOUNDS_DESC} (default [36, 36, 300, 300]). Fails before creating anything if the file does not exist. One undo step.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          filePath: { type: "string", description: "Absolute path to the image file" },
          pageIndex: { type: "number", description: "Page index (0-based)" },
          bounds: { type: "array", items: { type: "number" }, description: `Frame bounds ${BOUNDS_DESC}` },
          fitOption: {
            type: "string",
            enum: [...Object.keys(FIT), "none"],
            description: "How to fit the image in the frame. Default: fillProportionally",
          },
        },
        required: ["filePath", "pageIndex"],
      },
      handler: lcHandler(async (args) => {
        const file = assertReadableFile(args.filePath, IMAGE_EXTS);
        const idx = jsNum(args.pageIndex, "pageIndex", { int: true, min: 0 });
        const bounds = jsBounds(args.bounds ?? [36, 36, 300, 300]);
        const fitName = optStr(args.fitOption, "fitOption") ?? "fillProportionally";
        const fit = fitName === "none" ? "" : `rect.fit(${pick(FIT, fitName, "fitOption")});`;
        return runLC(bridge, `
          var page = __lcPageAt(doc, ${idx});
          var f = new File(${jsStr(file)});
          if (!f.exists) return __fail('Image file not found: ' + f.fsName);
          var rect = page.rectangles.add();
          rect.geometricBounds = __lcPageToSpread(page, ${bounds});
          rect.place(f, false);
          ${fit}
          var img = rect.allGraphics.length > 0 ? rect.allGraphics[0] : null;
          var linkName = '';
          try { linkName = img && img.itemLink ? img.itemLink.name : ''; } catch (e) {}
          var eff = [], act = [];
          try { eff = img.effectivePpi; act = img.actualPpi; } catch (e) {}
          return __ok({ frameId: rect.id, bounds: __lcSpreadToPage(page, rect.geometricBounds), imageName: linkName, effectivePpi: eff, actualPpi: act });
        `, { mutating: true, undoName: "MCP: Place Image" });
      }),
    },

    list_images: {
      description: "List all placed images/links in the document with their status, frame id and page.",
      inputSchema: { type: "object" as const, properties: {} },
      handler: lcHandler(async () =>
        runLC(bridge, `
          var images = [];
          for (var i = 0; i < doc.links.length; i++) {
            var link = doc.links[i];
            var graphic = link.parent, frame = null, pageName = null, pageIndex = null;
            try { frame = graphic.parent; } catch (e) {}
            try { var pg = graphic.parentPage || (frame ? frame.parentPage : null); if (pg) { pageName = pg.name; pageIndex = pg.documentOffset; } } catch (e) {}
            images.push({
              index: i,
              linkId: link.id,
              name: link.name,
              filePath: link.filePath,
              status: __linkStatus(link),
              size: link.size,
              graphicId: graphic ? graphic.id : null,
              frameId: frame && frame.id ? frame.id : null,
              parentPage: pageName,
              pageIndex: pageIndex
            });
          }
          return __ok(images);
        `)),
    },

    relink_image: {
      description: "Relink a placed image (by linkId or linkIndex from list_images) to a new file. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          linkId: { type: "number", description: "Link id from list_images (preferred)" },
          linkIndex: { type: "number", description: "Link index from list_images" },
          newFilePath: { type: "string", description: "Absolute path to the new image file" },
        },
        required: ["newFilePath"],
      },
      handler: lcHandler(async (args) => {
        const file = assertReadableFile(args.newFilePath, IMAGE_EXTS, "newFilePath");
        const hasId = args.linkId != null;
        if (hasId === (args.linkIndex != null)) throw new Error("Pass exactly one of linkId or linkIndex");
        const sel = hasId
          ? `doc.links.itemByID(${jsNum(args.linkId, "linkId", { int: true, min: 1 })})`
          : `doc.links[${jsNum(args.linkIndex, "linkIndex", { int: true, min: 0 })}]`;
        return runLC(bridge, `
          var link = ${sel};
          if (!link || !link.isValid) return __fail('Link not found (document has ' + doc.links.length + ' links)');
          var f = new File(${jsStr(file)});
          if (!f.exists) return __fail('File not found: ' + f.fsName);
          link = link.relink(f) || link;
          try { link.update(); } catch (e) {}
          return __ok({ relinked: true, linkId: link.id, name: link.name, status: __linkStatus(link) });
        `, { mutating: true, undoName: "MCP: Relink Image" });
      }),
    },

    update_all_links: {
      description: "Update all out-of-date links in the document. One undo step.",
      inputSchema: { type: "object" as const, properties: {} },
      handler: lcHandler(async () =>
        runLC(bridge, `
          var updated = 0, failed = [];
          for (var i = 0; i < doc.links.length; i++) {
            if (doc.links[i].status === LinkStatus.LINK_OUT_OF_DATE) {
              try { doc.links[i].update(); updated++; } catch (e) { failed.push(doc.links[i].name); }
            }
          }
          return __ok({ updatedCount: updated, failed: failed, totalLinks: doc.links.length });
        `, { mutating: true, undoName: "MCP: Update Links" })),
    },

    fit_image: {
      description: "Fit an image within its frame (frame found by id, including grouped/anchored frames). One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          frameId: { type: "number", description: "Frame id containing the image" },
          fitOption: { type: "string", enum: Object.keys(FIT) },
        },
        required: ["frameId", "fitOption"],
      },
      handler: lcHandler(async (args) => {
        const id = jsNum(args.frameId, "frameId", { int: true, min: 1 });
        const fit = pick(FIT, args.fitOption, "fitOption");
        return runLC(bridge, `
          var frame = __lcRequireItem(doc, ${id}, 'Frame');
          frame.fit(${fit});
          return __ok({ fitted: true, bounds: __lcRelBounds(frame), spreadBounds: __lcRoundArr(frame.geometricBounds) });
        `, { mutating: true, undoName: "MCP: Fit Image" });
      }),
    },

    set_image_frame_fitting: {
      description: "Set a frame's fitting options (auto-fit, empty-frame fitting, alignment). One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          frameId: { type: "number" },
          autoFit: { type: "boolean", description: "Enable auto-fit" },
          fittingOnEmptyFrame: { type: "string", enum: Object.keys(EMPTY_FIT) },
          fittingAlignment: { type: "string", enum: Object.keys(ALIGN) },
        },
        required: ["frameId"],
      },
      handler: lcHandler(async (args) => {
        const id = jsNum(args.frameId, "frameId", { int: true, min: 1 });
        const sets: string[] = [];
        if (args.autoFit != null) sets.push(`fp.autoFit = ${jsBool(args.autoFit, false)};`);
        if (args.fittingOnEmptyFrame != null) sets.push(`fp.fittingOnEmptyFrame = ${pick(EMPTY_FIT, args.fittingOnEmptyFrame, "fittingOnEmptyFrame")};`);
        if (args.fittingAlignment != null) sets.push(`fp.fittingAlignment = ${pick(ALIGN, args.fittingAlignment, "fittingAlignment")};`);
        if (!sets.length) throw new Error("Nothing to change: pass autoFit, fittingOnEmptyFrame or fittingAlignment");
        return runLC(bridge, `
          var frame = __lcRequireItem(doc, ${id}, 'Frame');
          var fp = frame.frameFittingOptions;
          ${sets.join("\n          ")}
          return __ok({ updated: true, frameId: frame.id });
        `, { mutating: true, undoName: "MCP: Frame Fitting" });
      }),
    },

    create_rectangle: {
      description: `Create a rectangle on a page. bounds are ${BOUNDS_DESC}. Swatches are matched by exact name. One undo step.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          pageIndex: { type: "number", description: "Page index (0-based)" },
          bounds: { type: "array", items: { type: "number" }, description: BOUNDS_DESC },
          fillColor: { type: "string", description: "Swatch name" },
          strokeColor: { type: "string" },
          strokeWeight: { type: "number" },
          cornerRadius: { type: "number" },
          opacity: { type: "number", description: "Opacity 0-100" },
        },
        required: ["pageIndex", "bounds"],
      },
      handler: lcHandler(async (args) => {
        const idx = jsNum(args.pageIndex, "pageIndex", { int: true, min: 0 });
        const bounds = jsBounds(args.bounds);
        const sw = swatchSets("rect", args);
        const extra: string[] = [];
        if (args.cornerRadius != null) {
          const r = jsNum(args.cornerRadius, "cornerRadius", { min: 0 });
          extra.push(`rect.topLeftCornerOption = rect.topRightCornerOption = rect.bottomLeftCornerOption = rect.bottomRightCornerOption = CornerOptions.ROUNDED_CORNER;`);
          extra.push(`rect.topLeftCornerRadius = rect.topRightCornerRadius = rect.bottomLeftCornerRadius = rect.bottomRightCornerRadius = ${r};`);
        }
        if (args.opacity != null) extra.push(`rect.transparencySettings.blendingSettings.opacity = ${jsNum(args.opacity, "opacity", { min: 0, max: 100 })};`);
        return runLC(bridge, `
          var page = __lcPageAt(doc, ${idx});
          ${sw.pre}
          var rect = page.rectangles.add();
          rect.geometricBounds = __lcPageToSpread(page, ${bounds});
          ${sw.apply}
          ${extra.join("\n          ")}
          return __ok({ id: rect.id, bounds: __lcSpreadToPage(page, rect.geometricBounds) });
        `, { mutating: true, undoName: "MCP: Create Rectangle" });
      }),
    },

    create_oval: {
      description: `Create an oval on a page. bounds are ${BOUNDS_DESC}. One undo step.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          pageIndex: { type: "number", description: "Page index (0-based)" },
          bounds: { type: "array", items: { type: "number" }, description: BOUNDS_DESC },
          fillColor: { type: "string" },
          strokeColor: { type: "string" },
          strokeWeight: { type: "number" },
        },
        required: ["pageIndex", "bounds"],
      },
      handler: lcHandler(async (args) => {
        const idx = jsNum(args.pageIndex, "pageIndex", { int: true, min: 0 });
        const bounds = jsBounds(args.bounds);
        const sw = swatchSets("oval", args);
        return runLC(bridge, `
          var page = __lcPageAt(doc, ${idx});
          ${sw.pre}
          var oval = page.ovals.add();
          oval.geometricBounds = __lcPageToSpread(page, ${bounds});
          ${sw.apply}
          return __ok({ id: oval.id, bounds: __lcSpreadToPage(page, oval.geometricBounds) });
        `, { mutating: true, undoName: "MCP: Create Oval" });
      }),
    },

    create_line: {
      description: "Draw a line between two points [x, y] given in points relative to the page's top-left corner. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          pageIndex: { type: "number", description: "Page index (0-based)" },
          startPoint: { type: "array", items: { type: "number" }, description: "[x, y] start point, page-relative points" },
          endPoint: { type: "array", items: { type: "number" }, description: "[x, y] end point, page-relative points" },
          strokeColor: { type: "string" },
          strokeWeight: { type: "number" },
          strokeType: { type: "string", description: "Stroke style name (e.g. 'Dashed')" },
        },
        required: ["pageIndex", "startPoint", "endPoint"],
      },
      handler: lcHandler(async (args) => {
        const idx = jsNum(args.pageIndex, "pageIndex", { int: true, min: 0 });
        const a = jsNumArray(args.startPoint, "startPoint", 2);
        const b = jsNumArray(args.endPoint, "endPoint", 2);
        const sw = swatchSets("line", args);
        const strokeType = optStr(args.strokeType, "strokeType");
        return runLC(bridge, `
          var page = __lcPageAt(doc, ${idx});
          ${sw.pre}
          ${strokeType ? `var __st = doc.strokeStyles.itemByName(${jsStr(strokeType)}); if (!__st.isValid) return __fail('Stroke style ' + ${jsStr(strokeType)} + ' not found');` : ""}
          var line = page.graphicLines.add();
          line.paths[0].pathPoints[0].anchor = __lcPagePoint(page, ${a});
          line.paths[0].pathPoints[1].anchor = __lcPagePoint(page, ${b});
          ${sw.apply}
          ${strokeType ? "line.strokeType = __st;" : ""}
          return __ok({ id: line.id, bounds: __lcSpreadToPage(page, line.geometricBounds) });
        `, { mutating: true, undoName: "MCP: Create Line" });
      }),
    },

    set_text_wrap: {
      description: "Set text wrap on a page item (found by id, including grouped/anchored). Offsets in points. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          frameId: { type: "number", description: "Page item id" },
          wrapType: { type: "string", enum: Object.keys(WRAP) },
          offset: { type: "number", description: "Uniform offset in points" },
          offsetTop: { type: "number" },
          offsetBottom: { type: "number" },
          offsetLeft: { type: "number" },
          offsetRight: { type: "number" },
        },
        required: ["frameId", "wrapType"],
      },
      handler: lcHandler(async (args) => {
        const id = jsNum(args.frameId, "frameId", { int: true, min: 1 });
        const mode = pick(WRAP, args.wrapType, "wrapType");
        const lines: string[] = [];
        if (args.offset != null) {
          const o = jsNum(args.offset, "offset");
          lines.push(`off = [${o}, ${o}, ${o}, ${o}];`);
        }
        // TextWrapOffset order is [top, left, bottom, right].
        const sides: [string, number][] = [["offsetTop", 0], ["offsetLeft", 1], ["offsetBottom", 2], ["offsetRight", 3]];
        for (const [k, i] of sides) {
          if (args[k] != null) lines.push(`off[${i}] = ${jsNum(args[k], k)};`);
        }
        return runLC(bridge, `
          var item = __lcRequireItem(doc, ${id}, 'Page item');
          var tw = item.textWrapPreferences;
          tw.textWrapMode = ${mode};
          var off = tw.textWrapOffset;
          ${lines.join("\n          ")}
          ${lines.length ? "tw.textWrapOffset = off;" : ""}
          return __ok({ updated: true, offset: tw.textWrapOffset });
        `, { mutating: true, undoName: "MCP: Text Wrap" });
      }),
    },

    group_items: {
      description: "Group page items (by id) that sit directly on the same spread. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          itemIds: { type: "array", items: { type: "number" }, description: "Page item ids to group (2 or more)" },
        },
        required: ["itemIds"],
      },
      handler: lcHandler(async (args) => {
        if (!Array.isArray(args.itemIds) || args.itemIds.length < 2) throw new Error("itemIds must list at least 2 ids");
        const ids = jsNumArray(args.itemIds, "itemIds", undefined, { int: true, min: 1 });
        return runLC(bridge, `
          var ids = ${ids};
          var items = [];
          for (var i = 0; i < ids.length; i++) items.push(__lcRequireItem(doc, ids[i], 'Page item'));
          var parent = items[0].parent;
          for (var j = 1; j < items.length; j++) {
            if (items[j].parent !== parent && items[j].parent.id !== parent.id) return __fail('Item ' + ids[j] + ' is not on the same spread/level as item ' + ids[0] + ' (grouped or anchored items cannot be grouped again)');
          }
          if (!parent.groups) return __fail('Items are inside a ' + parent.constructor.name + '; only items placed directly on a spread can be grouped');
          var group = parent.groups.add(items);
          return __ok({ groupId: group.id, itemCount: group.pageItems.length });
        `, { mutating: true, undoName: "MCP: Group Items" });
      }),
    },

    ungroup_items: {
      description: "Ungroup a group (found by id). One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          groupId: { type: "number", description: "Group id" },
        },
        required: ["groupId"],
      },
      handler: lcHandler(async (args) => {
        const id = jsNum(args.groupId, "groupId", { int: true, min: 1 });
        return runLC(bridge, `
          var group = __lcRequireItem(doc, ${id}, 'Group', 'Group');
          var items = [];
          for (var i = 0; i < group.pageItems.length; i++) items.push(group.pageItems[i].id);
          group.ungroup();
          return __ok({ ungrouped: true, itemIds: items });
        `, { mutating: true, undoName: "MCP: Ungroup" });
      }),
    },

    transform_item: {
      description: "Move (relative, points), scale (percent), rotate or shear a page item found by id. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          itemId: { type: "number", description: "Page item id" },
          moveX: { type: "number", description: "Horizontal move in points" },
          moveY: { type: "number", description: "Vertical move in points" },
          scaleX: { type: "number", description: "Horizontal scale percentage" },
          scaleY: { type: "number", description: "Vertical scale percentage" },
          rotation: { type: "number", description: "Rotation angle in degrees" },
          shearAngle: { type: "number" },
        },
        required: ["itemId"],
      },
      handler: lcHandler(async (args) => {
        const id = jsNum(args.itemId, "itemId", { int: true, min: 1 });
        const lines: string[] = [];
        if (args.moveX != null || args.moveY != null) {
          lines.push(`item.move(undefined, [${jsNum(args.moveX ?? 0, "moveX")}, ${jsNum(args.moveY ?? 0, "moveY")}]);`);
        }
        if (args.rotation != null) lines.push(`item.rotationAngle = ${jsNum(args.rotation, "rotation", { min: -360, max: 360 })};`);
        if (args.shearAngle != null) lines.push(`item.shearAngle = ${jsNum(args.shearAngle, "shearAngle", { min: -89, max: 89 })};`);
        if (args.scaleX != null || args.scaleY != null) {
          lines.push(`item.horizontalScale = ${jsNum(args.scaleX ?? 100, "scaleX", { min: 0.1, max: 100000 })}; item.verticalScale = ${jsNum(args.scaleY ?? 100, "scaleY", { min: 0.1, max: 100000 })};`);
        }
        if (!lines.length) throw new Error("Nothing to change: pass moveX/moveY, scaleX/scaleY, rotation or shearAngle");
        return runLC(bridge, `
          var item = __lcRequireItem(doc, ${id}, 'Page item');
          if (item.locked) return __fail('Item ' + ${id} + ' is locked');
          ${lines.join("\n          ")}
          return __ok({ transformed: true, bounds: __lcRelBounds(item), spreadBounds: __lcRoundArr(item.geometricBounds) });
        `, { mutating: true, undoName: "MCP: Transform Item" });
      }),
    },

    delete_item: {
      description: "Delete a page item by id (including grouped/anchored items). Refuses locked items. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          itemId: { type: "number", description: "Page item id" },
        },
        required: ["itemId"],
      },
      handler: lcHandler(async (args) => {
        const id = jsNum(args.itemId, "itemId", { int: true, min: 1 });
        return runLC(bridge, `
          var item = __lcRequireItem(doc, ${id}, 'Page item');
          if (item.locked) return __fail('Item ' + ${id} + ' is locked');
          var type = item.constructor.name, parentType = '';
          try { parentType = item.parent.constructor.name; } catch (e) {}
          item.remove();
          return __ok({ deleted: true, id: ${id}, type: type, parentType: parentType });
        `, { mutating: true, undoName: "MCP: Delete Item" });
      }),
    },

    duplicate_item: {
      description:
        "Duplicate a page item, optionally onto another page at the same page-relative position, then offset by offsetX/offsetY points. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          itemId: { type: "number" },
          targetPageIndex: { type: "number", description: "Target page index (0-based). Omit to duplicate in place." },
          offsetX: { type: "number", description: "X offset in points. Default: 0" },
          offsetY: { type: "number", description: "Y offset in points. Default: 0" },
        },
        required: ["itemId"],
      },
      handler: lcHandler(async (args) => {
        const id = jsNum(args.itemId, "itemId", { int: true, min: 1 });
        const target = args.targetPageIndex != null ? jsNum(args.targetPageIndex, "targetPageIndex", { int: true, min: 0 }) : "null";
        const dx = jsNum(args.offsetX ?? 0, "offsetX");
        const dy = jsNum(args.offsetY ?? 0, "offsetY");
        return runLC(bridge, `
          var item = __lcRequireItem(doc, ${id}, 'Page item');
          var srcPage = item.parentPage;
          var tIdx = ${target};
          var dup;
          if (tIdx !== null) {
            var tp = __lcPageAt(doc, tIdx);
            if (!srcPage) return __fail('Item ' + ${id} + ' is not on a page (pasteboard/anchored); cannot map its position to another page');
            var rel = __lcSpreadToPage(srcPage, item.geometricBounds);
            dup = item.duplicate(tp);
            var abs = __lcPageToSpread(tp, rel);
            dup.move([abs[1], abs[0]]);
          } else {
            dup = item.duplicate();
          }
          if (${dx} !== 0 || ${dy} !== 0) dup.move(undefined, [${dx}, ${dy}]);
          return __ok({ duplicateId: dup.id, bounds: __lcRelBounds(dup), page: dup.parentPage ? dup.parentPage.name : null });
        `, { mutating: true, undoName: "MCP: Duplicate Item" });
      }),
    },

    set_item_layer: {
      description: "Move a page item to a different layer (exact layer name). One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          itemId: { type: "number" },
          layerName: { type: "string" },
        },
        required: ["itemId", "layerName"],
      },
      handler: lcHandler(async (args) => {
        const id = jsNum(args.itemId, "itemId", { int: true, min: 1 });
        const layer = reqStr(args.layerName, "layerName");
        return runLC(bridge, `
          var item = __lcRequireItem(doc, ${id}, 'Page item');
          var l = __lcLayer(doc, ${jsStr(layer)});
          if (l.locked) return __fail('Layer ' + l.name + ' is locked');
          item.itemLayer = l;
          return __ok({ moved: true, id: ${id}, layer: l.name });
        `, { mutating: true, undoName: "MCP: Set Item Layer" });
      }),
    },
  };
}
