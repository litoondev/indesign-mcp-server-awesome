import type { InDesignBridge } from "../bridge/index.js";
import { runLC, lcHandler, jsStr, jsNum, jsBool, jsNumArray, optStr, reqStr } from "./batchC_layoutKit.js";

/**
 * Every table tool locates its table the same way: tableId (searched across all
 * stories) or frameId (+ tableIndex) where the frame is found by id even when it
 * is grouped or anchored. Cells are addressed with cells.itemByName("col:row"),
 * which stays correct when cells are merged (r*cols+c does not).
 */
function tableExpr(args: Record<string, unknown>): string {
  const tableId = args.tableId != null ? jsNum(args.tableId, "tableId", { int: true, min: 1 }) : "null";
  const frameId = args.frameId != null ? jsNum(args.frameId, "frameId", { int: true, min: 1 }) : "null";
  if (tableId === "null" && frameId === "null") throw new Error("Pass frameId (text frame containing the table) or tableId");
  const tableIndex = args.tableIndex != null ? jsNum(args.tableIndex, "tableIndex", { int: true, min: 0 }) : "0";
  return `__lcTable(doc, ${frameId}, ${tableIndex}, ${tableId})`;
}

const tableLocatorProps = {
  frameId: { type: "number", description: "Text frame id containing the table (grouped/anchored frames are found too)" },
  tableIndex: { type: "number", description: "Table index within the frame (0-based). Default: 0" },
  tableId: { type: "number", description: "Table id (alternative to frameId/tableIndex)" },
};

export function registerTableTools(bridge: InDesignBridge) {
  return {
    create_table: {
      description:
        "Create a table at the end of a text frame's text, with optional column widths (points) and content ([row][col], header rows first). One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          frameId: { type: "number", description: "Text frame id to place the table in" },
          rows: { type: "number", description: "Number of body rows" },
          columns: { type: "number", description: "Number of columns" },
          headerRows: { type: "number", description: "Number of header rows. Default: 0" },
          footerRows: { type: "number", description: "Number of footer rows. Default: 0" },
          columnWidths: { type: "array", items: { type: "number" }, description: "Width for each column in points" },
          data: {
            type: "array",
            items: { type: "array", items: { type: "string" } },
            description: "2D array of cell contents [row][col]; row 0 is the first header row when headerRows > 0",
          },
        },
        required: ["frameId", "rows", "columns"],
      },
      handler: lcHandler(async (args) => {
        const frameId = jsNum(args.frameId, "frameId", { int: true, min: 1 });
        const rows = jsNum(args.rows, "rows", { int: true, min: 1, max: 1000 });
        const cols = jsNum(args.columns, "columns", { int: true, min: 1, max: 200 });
        const hdr = jsNum(args.headerRows ?? 0, "headerRows", { int: true, min: 0, max: 100 });
        const ftr = jsNum(args.footerRows ?? 0, "footerRows", { int: true, min: 0, max: 100 });
        const widths = args.columnWidths != null ? jsNumArray(args.columnWidths, "columnWidths", undefined, { min: 1 }) : "null";
        let data = "null";
        if (args.data != null) {
          if (!Array.isArray(args.data) || !args.data.every((r) => Array.isArray(r))) throw new Error("data must be an array of arrays of strings");
          data = "[" + (args.data as unknown[][]).map((r) => "[" + r.map((c) => jsStr(c ?? "")).join(",") + "]").join(",") + "]";
        }
        return runLC(bridge, `
          var tf = __lcRequireItem(doc, ${frameId}, 'Text frame', 'TextFrame');
          var ip = tf.insertionPoints[-1];
          var chars = tf.characters.length;
          if (chars > 0) {
            var last = String(tf.characters[-1].contents);
            if (last !== '\\r') { ip.contents = '\\r'; ip = tf.insertionPoints[-1]; }
          }
          var table = ip.tables.add();
          table.columnCount = ${cols};
          table.bodyRowCount = ${rows};
          table.headerRowCount = ${hdr};
          table.footerRowCount = ${ftr};
          var widths = ${widths};
          if (widths) { for (var c = 0; c < widths.length && c < table.columns.length; c++) table.columns[c].width = widths[c]; }
          var data = ${data};
          var skipped = 0;
          if (data) {
            for (var r = 0; r < data.length; r++) {
              for (var k = 0; k < data[r].length; k++) {
                if (r >= table.rows.length || k >= table.columns.length) { skipped++; continue; }
                __lcCell(table, r, k).contents = data[r][k];
              }
            }
          }
          return __ok({ id: table.id, rows: table.rows.length, columns: table.columns.length, skippedCells: skipped, frameOverflows: tf.overflows });
        `, { mutating: true, undoName: "MCP: Create Table" });
      }),
    },

    get_table_info: {
      description:
        "Get table dimensions, column widths, merged cells and (optionally) cell contents as a [row][column] grid; cells covered by a merge are null.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...tableLocatorProps,
          includeContent: { type: "boolean", description: "Include cell contents. Default: true" },
          maxRows: { type: "number", description: "Max rows to return content for. Default: 50" },
        },
      },
      handler: lcHandler(async (args) => {
        const t = tableExpr(args);
        const maxRows = jsNum(args.maxRows ?? 50, "maxRows", { int: true, min: 1, max: 5000 });
        return runLC(bridge, `
          var table = ${t};
          var info = {
            id: table.id,
            bodyRowCount: table.bodyRowCount,
            headerRowCount: table.headerRowCount,
            footerRowCount: table.footerRowCount,
            columnCount: table.columns.length,
            totalRows: table.rows.length,
            columnWidths: [],
            merged: []
          };
          for (var c = 0; c < table.columns.length; c++) info.columnWidths.push(__lcRound(table.columns[c].width));
          var grid = null, maxR = Math.min(table.rows.length, ${maxRows});
          if (${jsBool(args.includeContent, true)}) {
            grid = [];
            for (var r = 0; r < maxR; r++) { var row = []; for (var cc = 0; cc < table.columns.length; cc++) row.push(null); grid.push(row); }
          }
          for (var i = 0; i < table.cells.length; i++) {
            var cell = table.cells[i];
            var parts = String(cell.name).split(':');
            var col = parseInt(parts[0], 10), rw = parseInt(parts[1], 10);
            if (cell.rowSpan > 1 || cell.columnSpan > 1) info.merged.push({ row: rw, column: col, rowSpan: cell.rowSpan, columnSpan: cell.columnSpan });
            if (grid && rw < maxR) grid[rw][col] = String(cell.contents).substring(0, 500);
          }
          if (grid) info.cells = grid;
          return __ok(info);
        `);
      }),
    },

    set_table_cell: {
      description:
        "Set the text of one table cell addressed by row/column (0-based, header rows included). Merged cells are handled: addressing any position inside a merge targets the merged cell. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...tableLocatorProps,
          row: { type: "number", description: "Row index (0-based)" },
          column: { type: "number", description: "Column index (0-based)" },
          content: { type: "string", description: "Cell content (use \\r for a new paragraph)" },
        },
        required: ["row", "column", "content"],
      },
      handler: lcHandler(async (args) => {
        const t = tableExpr(args);
        const row = jsNum(args.row, "row", { int: true, min: 0 });
        const col = jsNum(args.column, "column", { int: true, min: 0 });
        if (typeof args.content !== "string") throw new Error("content must be a string");
        return runLC(bridge, `
          var table = ${t};
          var cell = __lcCell(table, ${row}, ${col});
          var before = String(cell.contents);
          cell.contents = ${jsStr(args.content)};
          return __ok({ updated: true, cell: cell.name, previousContent: before.substring(0, 200), cellOverflows: cell.overflows });
        `, { mutating: true, undoName: "MCP: Set Table Cell" });
      }),
    },

    format_table: {
      description: "Format table borders, alternating fills, header fill, row height and cell insets (points). Swatches by exact name. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...tableLocatorProps,
          borderColor: { type: "string", description: "Swatch name for the table border" },
          borderWeight: { type: "number" },
          alternatingFills: { type: "boolean", description: "Enable alternating row fills" },
          fillColor1: { type: "string", description: "First alternating fill swatch" },
          fillColor2: { type: "string", description: "Second alternating fill swatch" },
          fillTint1: { type: "number", description: "Tint for first fill (0-100)" },
          fillTint2: { type: "number", description: "Tint for second fill (0-100)" },
          headerFillColor: { type: "string", description: "Fill swatch for header rows" },
          rowHeight: { type: "number", description: "Minimum row height in points for all rows" },
          cellInsetTop: { type: "number" },
          cellInsetBottom: { type: "number" },
          cellInsetLeft: { type: "number" },
          cellInsetRight: { type: "number" },
        },
      },
      handler: lcHandler(async (args) => {
        const t = tableExpr(args);
        const pre: string[] = [];
        const sets: string[] = [];
        const sw = (key: string, v: string) => {
          const name = optStr(args[key], key);
          if (name) pre.push(`var ${v} = __lcSwatch(doc, ${jsStr(name)});`);
          return !!name;
        };
        if (args.borderWeight != null) {
          const w = jsNum(args.borderWeight, "borderWeight", { min: 0, max: 100 });
          sets.push(`table.topBorderStrokeWeight = table.bottomBorderStrokeWeight = table.leftBorderStrokeWeight = table.rightBorderStrokeWeight = ${w};`);
        }
        if (sw("borderColor", "bc")) sets.push(`table.topBorderStrokeColor = table.bottomBorderStrokeColor = table.leftBorderStrokeColor = table.rightBorderStrokeColor = bc;`);
        if (args.alternatingFills != null) sets.push(`table.alternatingFills = ${args.alternatingFills === true ? "AlternatingFillsTypes.ALTERNATING_ROWS" : "AlternatingFillsTypes.NO_ALTERNATING_PATTERN"};`);
        if (sw("fillColor1", "f1")) sets.push(`table.startRowFillColor = f1;`);
        if (args.fillTint1 != null) sets.push(`table.startRowFillTint = ${jsNum(args.fillTint1, "fillTint1", { min: 0, max: 100 })};`);
        if (sw("fillColor2", "f2")) sets.push(`table.endRowFillColor = f2;`);
        if (args.fillTint2 != null) sets.push(`table.endRowFillTint = ${jsNum(args.fillTint2, "fillTint2", { min: 0, max: 100 })};`);
        if (sw("headerFillColor", "hf")) sets.push(`for (var h = 0; h < table.headerRowCount; h++) table.rows[h].fillColor = hf;`);
        if (args.rowHeight != null) {
          const h = jsNum(args.rowHeight, "rowHeight", { min: 0.5, max: 10000 });
          sets.push(`for (var rr = 0; rr < table.rows.length; rr++) { table.rows[rr].autoGrow = true; table.rows[rr].minimumHeight = ${h}; }`);
        }
        for (const [k, p] of [["cellInsetTop", "topInset"], ["cellInsetBottom", "bottomInset"], ["cellInsetLeft", "leftInset"], ["cellInsetRight", "rightInset"]]) {
          if (args[k] != null) sets.push(`table.cells.everyItem().${p} = ${jsNum(args[k], k, { min: 0 })};`);
        }
        if (!sets.length) throw new Error("Nothing to change");
        return runLC(bridge, `
          var table = ${t};
          ${pre.join("\n          ")}
          ${sets.join("\n          ")}
          return __ok({ formatted: true, tableId: table.id });
        `, { mutating: true, undoName: "MCP: Format Table" });
      }),
    },

    add_table_row: {
      description: "Add rows to a table at the end/beginning or before/after referenceRow (0-based). One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...tableLocatorProps,
          count: { type: "number", description: "Number of rows to add. Default: 1" },
          position: { type: "string", enum: ["end", "beginning", "after", "before"] },
          referenceRow: { type: "number", description: "Reference row index for after/before" },
        },
      },
      handler: lcHandler(async (args) => {
        const t = tableExpr(args);
        const count = jsNum(args.count ?? 1, "count", { int: true, min: 1, max: 1000 });
        const pos = (optStr(args.position, "position") ?? "end").toLowerCase();
        const ref = args.referenceRow != null ? jsNum(args.referenceRow, "referenceRow", { int: true, min: 0 }) : null;
        if ((pos === "after" || pos === "before") && ref === null) throw new Error(`position '${pos}' requires referenceRow`);
        const loc = pos === "beginning" ? "LocationOptions.AT_BEGINNING" : pos === "before" ? "LocationOptions.BEFORE" : pos === "after" ? "LocationOptions.AFTER" : "LocationOptions.AT_END";
        return runLC(bridge, `
          var table = ${t};
          ${ref !== null ? `if (${ref} >= table.rows.length) return __fail('referenceRow ${ref} out of range (table has ' + table.rows.length + ' rows)'); var refRow = table.rows[${ref}];` : ""}
          var added = [];
          for (var i = 0; i < ${count}; i++) {
            var r = ${ref !== null ? `table.rows.add(${loc}, refRow)` : `table.rows.add(${loc})`};
            ${pos === "after" && ref !== null ? "refRow = r;" : ""}
            added.push(r.index);
          }
          return __ok({ rows: table.rows.length, addedRowIndices: added });
        `, { mutating: true, undoName: "MCP: Add Table Row" });
      }),
    },

    add_table_column: {
      description: "Add columns to a table at the end/beginning or before/after referenceColumn (0-based). One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...tableLocatorProps,
          count: { type: "number", description: "Number of columns to add. Default: 1" },
          width: { type: "number", description: "Column width in points" },
          position: { type: "string", enum: ["end", "beginning", "after", "before"] },
          referenceColumn: { type: "number" },
        },
      },
      handler: lcHandler(async (args) => {
        const t = tableExpr(args);
        const count = jsNum(args.count ?? 1, "count", { int: true, min: 1, max: 200 });
        const pos = (optStr(args.position, "position") ?? "end").toLowerCase();
        const ref = args.referenceColumn != null ? jsNum(args.referenceColumn, "referenceColumn", { int: true, min: 0 }) : null;
        if ((pos === "after" || pos === "before") && ref === null) throw new Error(`position '${pos}' requires referenceColumn`);
        const loc = pos === "beginning" ? "LocationOptions.AT_BEGINNING" : pos === "before" ? "LocationOptions.BEFORE" : pos === "after" ? "LocationOptions.AFTER" : "LocationOptions.AT_END";
        const width = args.width != null ? jsNum(args.width, "width", { min: 1 }) : null;
        return runLC(bridge, `
          var table = ${t};
          ${ref !== null ? `if (${ref} >= table.columns.length) return __fail('referenceColumn ${ref} out of range (table has ' + table.columns.length + ' columns)'); var refCol = table.columns[${ref}];` : ""}
          for (var i = 0; i < ${count}; i++) {
            var col = ${ref !== null ? `table.columns.add(${loc}, refCol)` : `table.columns.add(${loc})`};
            ${pos === "after" && ref !== null ? "refCol = col;" : ""}
            ${width !== null ? `col.width = ${width};` : ""}
          }
          return __ok({ columns: table.columns.length });
        `, { mutating: true, undoName: "MCP: Add Table Column" });
      }),
    },

    delete_table_row: {
      description: "Delete a row (0-based) from a table. Refuses to delete the last remaining row. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...tableLocatorProps,
          rowIndex: { type: "number", description: "Row index to delete (0-based)" },
        },
        required: ["rowIndex"],
      },
      handler: lcHandler(async (args) => {
        const t = tableExpr(args);
        const idx = jsNum(args.rowIndex, "rowIndex", { int: true, min: 0 });
        return runLC(bridge, `
          var table = ${t};
          if (${idx} >= table.rows.length) return __fail('rowIndex ${idx} out of range (table has ' + table.rows.length + ' rows)');
          if (table.rows.length === 1) return __fail('Refusing to delete the only row of the table');
          var text = '';
          try { text = String(table.rows[${idx}].contents).substring(0, 200); } catch (e) {}
          table.rows[${idx}].remove();
          return __ok({ deleted: true, deletedRowText: text, remainingRows: table.rows.length });
        `, { mutating: true, undoName: "MCP: Delete Table Row" });
      }),
    },

    delete_table_column: {
      description: "Delete a column (0-based) from a table. Refuses to delete the last remaining column. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...tableLocatorProps,
          columnIndex: { type: "number" },
        },
        required: ["columnIndex"],
      },
      handler: lcHandler(async (args) => {
        const t = tableExpr(args);
        const idx = jsNum(args.columnIndex, "columnIndex", { int: true, min: 0 });
        return runLC(bridge, `
          var table = ${t};
          if (${idx} >= table.columns.length) return __fail('columnIndex ${idx} out of range (table has ' + table.columns.length + ' columns)');
          if (table.columns.length === 1) return __fail('Refusing to delete the only column of the table');
          table.columns[${idx}].remove();
          return __ok({ deleted: true, remainingColumns: table.columns.length });
        `, { mutating: true, undoName: "MCP: Delete Table Column" });
      }),
    },

    merge_table_cells: {
      description: "Merge the rectangular range of cells from (startRow,startCol) to (endRow,endCol), 0-based. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...tableLocatorProps,
          startRow: { type: "number" },
          startCol: { type: "number" },
          endRow: { type: "number" },
          endCol: { type: "number" },
        },
        required: ["startRow", "startCol", "endRow", "endCol"],
      },
      handler: lcHandler(async (args) => {
        const t = tableExpr(args);
        const sr = Number(jsNum(args.startRow, "startRow", { int: true, min: 0 }));
        const sc = Number(jsNum(args.startCol, "startCol", { int: true, min: 0 }));
        const er = Number(jsNum(args.endRow, "endRow", { int: true, min: 0 }));
        const ec = Number(jsNum(args.endCol, "endCol", { int: true, min: 0 }));
        if (er < sr || ec < sc) throw new Error("endRow/endCol must be >= startRow/startCol");
        if (er === sr && ec === sc) throw new Error("The range is a single cell; nothing to merge");
        return runLC(bridge, `
          var table = ${t};
          var startCell = __lcCell(table, ${sr}, ${sc});
          var endCell = __lcCell(table, ${er}, ${ec});
          table.cells.itemByRange(startCell, endCell).merge();
          var merged = __lcCell(table, ${sr}, ${sc});
          return __ok({ merged: true, cell: merged.name, rowSpan: merged.rowSpan, columnSpan: merged.columnSpan });
        `, { mutating: true, undoName: "MCP: Merge Cells" });
      }),
    },

    format_table_cell: {
      description: "Format one cell (row/column 0-based, merge-aware): fill, edge strokes, vertical justification, paragraph style (name or Group/Name). One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...tableLocatorProps,
          row: { type: "number" },
          column: { type: "number" },
          fillColor: { type: "string" },
          fillTint: { type: "number" },
          topStrokeWeight: { type: "number" },
          bottomStrokeWeight: { type: "number" },
          leftStrokeWeight: { type: "number" },
          rightStrokeWeight: { type: "number" },
          verticalJustification: { type: "string", enum: ["top", "center", "bottom"] },
          paragraphStyle: { type: "string" },
        },
        required: ["row", "column"],
      },
      handler: lcHandler(async (args) => {
        const t = tableExpr(args);
        const row = jsNum(args.row, "row", { int: true, min: 0 });
        const col = jsNum(args.column, "column", { int: true, min: 0 });
        const vj: Record<string, string> = {
          top: "VerticalJustification.TOP_ALIGN",
          center: "VerticalJustification.CENTER_ALIGN",
          bottom: "VerticalJustification.BOTTOM_ALIGN",
        };
        const pre: string[] = [];
        const sets: string[] = [];
        const fill = optStr(args.fillColor, "fillColor");
        if (fill) { pre.push(`var fc = __lcSwatch(doc, ${jsStr(fill)});`); sets.push("cell.fillColor = fc;"); }
        if (args.fillTint != null) sets.push(`cell.fillTint = ${jsNum(args.fillTint, "fillTint", { min: 0, max: 100 })};`);
        for (const [k, p] of [["topStrokeWeight", "topEdgeStrokeWeight"], ["bottomStrokeWeight", "bottomEdgeStrokeWeight"], ["leftStrokeWeight", "leftEdgeStrokeWeight"], ["rightStrokeWeight", "rightEdgeStrokeWeight"]]) {
          if (args[k] != null) sets.push(`cell.${p} = ${jsNum(args[k], k, { min: 0, max: 100 })};`);
        }
        if (args.verticalJustification != null) {
          const v = vj[String(args.verticalJustification)];
          if (!v) throw new Error("verticalJustification must be top, center or bottom");
          sets.push(`cell.verticalJustification = ${v};`);
        }
        const ps = optStr(args.paragraphStyle, "paragraphStyle");
        if (ps) { pre.push(`var pst = __lcFindStyle(doc, 'paragraph', ${jsStr(ps)});`); sets.push("cell.texts[0].appliedParagraphStyle = pst;"); }
        if (!sets.length) throw new Error("Nothing to change");
        return runLC(bridge, `
          var table = ${t};
          var cell = __lcCell(table, ${row}, ${col});
          ${pre.join("\n          ")}
          ${sets.join("\n          ")}
          return __ok({ formatted: true, cell: cell.name });
        `, { mutating: true, undoName: "MCP: Format Cell" });
      }),
    },

    apply_table_style: {
      description: "Apply a table style (name or Group/Name) to a table. One undo step.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...tableLocatorProps,
          tablestyle: { type: "string", description: "Table style name" },
          clearOverrides: { type: "boolean" },
        },
        required: ["tablestyle"],
      },
      handler: lcHandler(async (args) => {
        const t = tableExpr(args);
        const name = reqStr(args.tablestyle, "tablestyle");
        return runLC(bridge, `
          var table = ${t};
          var st = __lcFindStyle(doc, 'table', ${jsStr(name)});
          table.appliedTableStyle = st;
          ${args.clearOverrides === true ? "table.clearTableStyleOverrides();" : ""}
          return __ok({ applied: true, style: __lcStylePath(st) });
        `, { mutating: true, undoName: "MCP: Apply Table Style" });
      }),
    },

    list_table_styles: {
      description: "List all table and cell styles in the document (with Group/Name paths).",
      inputSchema: { type: "object" as const, properties: {} },
      handler: lcHandler(async () =>
        runLC(bridge, `
          var tStyles = [], cStyles = [];
          for (var i = 0; i < doc.allTableStyles.length; i++) tStyles.push({ id: doc.allTableStyles[i].id, name: doc.allTableStyles[i].name, path: __lcStylePath(doc.allTableStyles[i]) });
          for (var j = 0; j < doc.allCellStyles.length; j++) cStyles.push({ id: doc.allCellStyles[j].id, name: doc.allCellStyles[j].name, path: __lcStylePath(doc.allCellStyles[j]) });
          return __ok({ tableStyles: tStyles, cellStyles: cStyles });
        `)),
    },
  };
}
