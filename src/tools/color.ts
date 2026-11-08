import type { InDesignBridge } from "../bridge/index.js";
import { runLC, lcHandler, jsStr, jsNum, jsBool, optStr, reqStr } from "./batchC_layoutKit.js";

const BUILT_IN_SWATCHES = ["None", "Paper", "Black", "Registration"];

const SPACE: Record<string, { lit: string; len: number; ranges: [number, number][] }> = {
  CMYK: { lit: "ColorSpace.CMYK", len: 4, ranges: [[0, 100], [0, 100], [0, 100], [0, 100]] },
  RGB: { lit: "ColorSpace.RGB", len: 3, ranges: [[0, 255], [0, 255], [0, 255]] },
  LAB: { lit: "ColorSpace.LAB", len: 3, ranges: [[0, 100], [-128, 127], [-128, 127]] },
};

export function registerColorTools(bridge: InDesignBridge) {
  return {
    list_swatches: {
      description: "List all color swatches in the document.",
      inputSchema: { type: "object" as const, properties: {} },
      handler: lcHandler(async () =>
        runLC(bridge, `
          var swatches = [];
          for (var i = 0; i < doc.swatches.length; i++) {
            var s = doc.swatches[i];
            var info = { id: s.id, name: s.name, type: s.constructor.name };
            try {
              if (s.constructor.name === 'Color') {
                info.space = String(s.space);
                info.model = String(s.model);
                info.colorValue = s.colorValue;
              }
            } catch (e) {}
            swatches.push(info);
          }
          return __ok(swatches);
        `)),
    },

    create_color_swatch: {
      description: "Create a new color swatch (CMYK 0-100, RGB 0-255, or LAB). Fails if a swatch with that name exists. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Swatch name" },
          colorSpace: { type: "string", enum: ["CMYK", "RGB", "LAB"], description: "Color space" },
          colorValues: {
            type: "array",
            items: { type: "number" },
            description: "Color values: CMYK [C,M,Y,K 0-100], RGB [R,G,B 0-255], LAB [L 0-100, a, b -128..127]",
          },
          colorModel: { type: "string", enum: ["process", "spot"], description: "Color model. Default: process" },
        },
        required: ["name", "colorSpace", "colorValues"],
      },
      handler: lcHandler(async (args) => {
        const name = reqStr(args.name, "name");
        const sp = SPACE[String(args.colorSpace)];
        if (!sp) throw new Error("colorSpace must be CMYK, RGB or LAB");
        const vals = args.colorValues;
        if (!Array.isArray(vals) || vals.length !== sp.len) throw new Error(`${args.colorSpace} needs exactly ${sp.len} colorValues`);
        const lit = "[" + vals.map((v, i) => jsNum(v, `colorValues[${i}]`, { min: sp.ranges[i][0], max: sp.ranges[i][1] })).join(",") + "]";
        const model = (optStr(args.colorModel, "colorModel") ?? "process").toLowerCase();
        if (model !== "process" && model !== "spot") throw new Error("colorModel must be process or spot");
        const modelLit = model === "spot" ? "ColorModel.SPOT" : "(ColorModel.PROCESS !== undefined ? ColorModel.PROCESS : 1886548851)";
        return runLC(bridge, `
          if (doc.swatches.itemByName(${jsStr(name)}).isValid) return __fail('A swatch named ' + ${jsStr(name)} + ' already exists');
          var c = doc.colors.add({ name: ${jsStr(name)}, model: ${modelLit}, space: ${sp.lit}, colorValue: ${lit} });
          return __ok({ created: true, id: c.id, name: c.name, colorValue: c.colorValue });
        `, { mutating: true, undoName: "MCP: Create Swatch" });
      }),
    },

    delete_swatch: {
      description: "Delete a swatch (exact name), optionally replacing its uses with another swatch. Built-in swatches are refused. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Swatch name to delete" },
          replacementSwatch: { type: "string", description: "Replacement swatch name" },
        },
        required: ["name"],
      },
      handler: lcHandler(async (args) => {
        const name = reqStr(args.name, "name");
        if (BUILT_IN_SWATCHES.includes(name)) throw new Error(`Refusing to delete built-in swatch '${name}'`);
        const repl = optStr(args.replacementSwatch, "replacementSwatch");
        if (repl === name) throw new Error("replacementSwatch must differ from the swatch being deleted");
        return runLC(bridge, `
          var s = __lcSwatch(doc, ${jsStr(name)});
          ${repl ? `var r = __lcSwatch(doc, ${jsStr(repl)}); s.remove(r);` : "s.remove();"}
          return __ok({ deleted: true, name: ${jsStr(name)}, replacedWith: ${repl ? jsStr(repl) : "null"} });
        `, { mutating: true, undoName: "MCP: Delete Swatch" });
      }),
    },

    create_gradient: {
      description: "Create a gradient swatch from existing color swatches (all stop colors are validated first). One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Gradient name" },
          type: { type: "string", enum: ["linear", "radial"], description: "Gradient type" },
          stops: {
            type: "array",
            items: {
              type: "object",
              properties: {
                color: { type: "string", description: "Swatch name" },
                position: { type: "number", description: "Stop position 0-100" },
                midpoint: { type: "number", description: "Midpoint 13-87. Default: 50" },
              },
            },
            description: "Gradient color stops (at least 2)",
          },
        },
        required: ["name", "type", "stops"],
      },
      handler: lcHandler(async (args) => {
        const name = reqStr(args.name, "name");
        if (!Array.isArray(args.stops) || args.stops.length < 2) throw new Error("stops must contain at least 2 stops");
        const stops = (args.stops as Record<string, unknown>[]).map((s, i) => {
          if (!s || typeof s !== "object") throw new Error(`stops[${i}] must be an object`);
          const color = reqStr(s.color, `stops[${i}].color`);
          const pos = jsNum(s.position, `stops[${i}].position`, { min: 0, max: 100 });
          const mid = s.midpoint != null ? jsNum(s.midpoint, `stops[${i}].midpoint`, { min: 13, max: 87 }) : "null";
          return `{ color: ${jsStr(color)}, position: ${pos}, midpoint: ${mid} }`;
        });
        const type = args.type === "radial" ? "GradientType.RADIAL" : "GradientType.LINEAR";
        return runLC(bridge, `
          if (doc.swatches.itemByName(${jsStr(name)}).isValid) return __fail('A swatch named ' + ${jsStr(name)} + ' already exists');
          var stops = [${stops.join(", ")}];
          var colors = [];
          for (var s = 0; s < stops.length; s++) colors.push(__lcSwatch(doc, stops[s].color));
          var g = doc.gradients.add();
          g.name = ${jsStr(name)};
          g.type = ${type};
          while (g.gradientStops.length < stops.length) g.gradientStops.add();
          for (var i = 0; i < stops.length; i++) {
            g.gradientStops[i].stopColor = colors[i];
            g.gradientStops[i].location = stops[i].position;
            if (stops[i].midpoint !== null && i > 0) g.gradientStops[i].midpoint = stops[i].midpoint;
          }
          return __ok({ created: true, id: g.id, name: g.name, stops: g.gradientStops.length });
        `, { mutating: true, undoName: "MCP: Create Gradient" });
      }),
    },

    list_layers: {
      description: "List all layers in the document (index 0 is the top layer).",
      inputSchema: { type: "object" as const, properties: {} },
      handler: lcHandler(async () =>
        runLC(bridge, `
          var layers = [];
          for (var i = 0; i < doc.layers.length; i++) {
            var l = doc.layers[i];
            layers.push({ index: i, id: l.id, name: l.name, visible: l.visible, locked: l.locked, printable: l.printable, color: String(l.layerColor), pageItems: l.pageItems.length });
          }
          return __ok(layers);
        `)),
    },

    create_layer: {
      description: "Create a new layer, optionally placed directly above an existing layer. Fails if the name exists. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Layer name" },
          color: { type: "string", description: "UI layer color name (e.g. 'Red', 'Light Blue')" },
          visible: { type: "boolean" },
          locked: { type: "boolean" },
          printable: { type: "boolean" },
          above: { type: "string", description: "Name of the layer to place the new layer above" },
        },
        required: ["name"],
      },
      handler: lcHandler(async (args) => {
        const name = reqStr(args.name, "name");
        const above = optStr(args.above, "above");
        const color = optStr(args.color, "color");
        const sets: string[] = [];
        if (args.visible != null) sets.push(`l.visible = ${jsBool(args.visible, true)};`);
        if (args.printable != null) sets.push(`l.printable = ${jsBool(args.printable, true)};`);
        if (args.locked != null) sets.push(`l.locked = ${jsBool(args.locked, false)};`);
        return runLC(bridge, `
          if (doc.layers.itemByName(${jsStr(name)}).isValid) return __fail('A layer named ' + ${jsStr(name)} + ' already exists');
          var ref = ${above ? `__lcLayer(doc, ${jsStr(above)})` : "null"};
          var uiColor = null;
          ${color ? `uiColor = UIColors[String(${jsStr(color)}).toUpperCase().replace(/[ -]+/g, '_')]; if (uiColor === undefined) return __fail('Unknown layer color ' + ${jsStr(color)});` : ""}
          var l = doc.layers.add({ name: ${jsStr(name)} });
          if (ref) l.move(LocationOptions.BEFORE, ref);
          if (uiColor !== null) l.layerColor = uiColor;
          ${sets.join("\n          ")}
          var idx = -1;
          for (var i = 0; i < doc.layers.length; i++) { if (doc.layers[i].id === l.id) idx = i; }
          return __ok({ created: true, id: l.id, name: l.name, index: idx });
        `, { mutating: true, undoName: "MCP: Create Layer" });
      }),
    },

    set_layer_properties: {
      description: "Set layer visibility, lock, printability or name (exact layer name). One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          layerName: { type: "string" },
          visible: { type: "boolean" },
          locked: { type: "boolean" },
          printable: { type: "boolean" },
          newName: { type: "string" },
        },
        required: ["layerName"],
      },
      handler: lcHandler(async (args) => {
        const layer = reqStr(args.layerName, "layerName");
        const newName = optStr(args.newName, "newName");
        const sets: string[] = [];
        if (args.visible != null) sets.push(`l.visible = ${jsBool(args.visible, true)};`);
        if (args.locked != null) sets.push(`l.locked = ${jsBool(args.locked, false)};`);
        if (args.printable != null) sets.push(`l.printable = ${jsBool(args.printable, true)};`);
        if (newName) sets.push(`if (doc.layers.itemByName(${jsStr(newName)}).isValid) return __fail('A layer named ' + ${jsStr(newName)} + ' already exists'); l.name = ${jsStr(newName)};`);
        if (!sets.length) throw new Error("Nothing to change");
        return runLC(bridge, `
          var l = __lcLayer(doc, ${jsStr(layer)});
          ${sets.join("\n          ")}
          return __ok({ updated: true, name: l.name, visible: l.visible, locked: l.locked, printable: l.printable });
        `, { mutating: true, undoName: "MCP: Layer Properties" });
      }),
    },

    delete_layer: {
      description: "Delete a layer AND every item on it (exact name). Refuses the last layer. Returns how many items were removed. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          layerName: { type: "string" },
        },
        required: ["layerName"],
      },
      handler: lcHandler(async (args) => {
        const layer = reqStr(args.layerName, "layerName");
        return runLC(bridge, `
          var l = __lcLayer(doc, ${jsStr(layer)});
          if (doc.layers.length === 1) return __fail('Refusing to delete the only layer');
          var count = l.allPageItems.length;
          l.remove();
          return __ok({ deleted: true, name: ${jsStr(layer)}, itemsRemoved: count });
        `, { mutating: true, undoName: "MCP: Delete Layer" });
      }),
    },

    get_unused_swatches: {
      description: "Find swatches that are not used in the document.",
      inputSchema: { type: "object" as const, properties: {} },
      handler: lcHandler(async () =>
        runLC(bridge, `
          var unused = doc.unusedSwatches;
          var result = [];
          for (var i = 0; i < unused.length; i++) { if (unused[i].name !== '') result.push(unused[i].name); }
          return __ok({ count: result.length, swatches: result });
        `)),
    },

    delete_unused_swatches: {
      description: "Delete all unused swatches (built-ins are kept). One undo step.",
      inputSchema: { type: "object" as const, properties: {} },
      handler: lcHandler(async () =>
        runLC(bridge, `
          var builtIn = ${JSON.stringify(BUILT_IN_SWATCHES)};
          var unused = doc.unusedSwatches;
          var deleted = [], failed = [];
          for (var i = unused.length - 1; i >= 0; i--) {
            var nm = unused[i].name, skip = (nm === '');
            for (var b = 0; b < builtIn.length; b++) { if (builtIn[b] === nm) skip = true; }
            if (skip) continue;
            try { unused[i].remove(); deleted.push(nm); } catch (e) { failed.push(nm); }
          }
          return __ok({ deleted: deleted.length, names: deleted, failed: failed });
        `, { mutating: true, undoName: "MCP: Delete Unused Swatches" })),
    },
  };
}
