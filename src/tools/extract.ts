import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import type { InDesignBridge } from "../bridge/index.js";
import type { ToolDef } from "../bridge/toolDispatch.js";

/**
 * MCP wrapper over the brac_extract Python package.
 *
 * The Python extractor is the authoritative reader — it preserves every
 * character (comma, full stop, soft hyphen, trailing space) from .docx/.xlsx/
 * .pdf. These tools just shell out to it, return the JSON path (or payload),
 * and never touch an open InDesign document.
 */

const PYTHON_DIR = path.resolve(process.cwd(), "python");
const DEFAULT_PY = process.env.BRAC_EXTRACT_PY ?? (process.platform === "win32" ? "py" : "python3");

function runPython(args: string[]): { ok: boolean; stdout: string; stderr: string; code: number } {
  const env = { ...process.env, PYTHONPATH: [PYTHON_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) };
  const res = spawnSync(DEFAULT_PY, ["-m", "brac_extract", ...args], {
    env,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: res.status === 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "", code: res.status ?? -1 };
}

export function registerExtractTools(_bridge: InDesignBridge): Record<string, ToolDef> {
  return {
    extract_source: {
      description:
        "Extract exact-character content from a .docx/.xlsx/.pdf into a JSON file via the brac_extract Python package. Every codepoint of the source is preserved and hashed per item. Returns {out, items, codepoints, sha256}.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Absolute path to the .docx/.xlsx/.pdf to extract." },
          out: { type: "string", description: "Where to write the JSON. Default: test_output/extract/<source-stem>.json" },
          verify: { type: "boolean", description: "Re-extract after writing and compare hashes. Default: true." },
        },
        required: ["source"],
      },
      handler: async (args) => {
        const source = String(args.source ?? "");
        if (!source) return { ok: false, error: "source is required", code: "BAD_ARG" };
        if (!fs.existsSync(source)) return { ok: false, error: `source not found: ${source}`, code: "NOT_FOUND" };

        const ext = path.extname(source).toLowerCase();
        if (![".docx", ".xlsx", ".pdf"].includes(ext)) {
          return { ok: false, error: `unsupported extension: ${ext}`, code: "UNSUPPORTED" };
        }

        const stem = path.basename(source, ext).replace(/[^\w.\-]+/g, "_");
        const out = String(args.out ?? path.resolve(process.cwd(), "test_output", "extract", `${stem}.json`));
        fs.mkdirSync(path.dirname(out), { recursive: true });

        const verify = args.verify !== false;
        const cliArgs = [source, "--out", out];
        if (verify) cliArgs.push("--verify");

        const r = runPython(cliArgs);
        if (!r.ok) {
          return { ok: false, error: r.stderr.trim() || r.stdout.trim() || `python exited ${r.code}`, code: r.code === 3 ? "VERIFY_MISMATCH" : "EXTRACT_FAILED" };
        }

        // The last JSON line on stdout is the summary.
        const lines = r.stdout.trim().split(/\r?\n/).filter(Boolean);
        let summary: Record<string, unknown> = {};
        try {
          summary = JSON.parse(lines[lines.length - 1]);
        } catch {
          summary = { raw: r.stdout };
        }
        return { ok: true, data: { out, ...summary } };
      },
    },

    read_extracted: {
      description:
        "Load an extraction JSON produced by extract_source. Optional filters: kind (paragraph|table|sheet|page), idPrefix, page range. Returns the matching items without reopening the source file.",
      inputSchema: {
        type: "object",
        properties: {
          json: { type: "string", description: "Path to the extraction JSON." },
          kind: { type: "string", enum: ["paragraph", "table", "sheet", "page"] },
          idPrefix: { type: "string" },
          limit: { type: "integer", minimum: 1 },
        },
        required: ["json"],
      },
      handler: async (args) => {
        const jsonPath = String(args.json ?? "");
        if (!fs.existsSync(jsonPath)) return { ok: false, error: `json not found: ${jsonPath}`, code: "NOT_FOUND" };
        const doc = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
        let items: Array<Record<string, unknown>> = doc.items ?? [];
        if (args.kind) items = items.filter((it) => it.kind === args.kind);
        if (args.idPrefix) {
          const p = String(args.idPrefix);
          items = items.filter((it) => String(it.id ?? "").startsWith(p));
        }
        if (args.limit) items = items.slice(0, Number(args.limit));
        return { ok: true, data: { source: doc.source, totals: doc.totals, items } };
      },
    },

    verify_extracted: {
      description:
        "Re-run the extractor against the source named in the JSON and report any item whose SHA-256 drifted. Use this before placing content when the source file may have changed.",
      inputSchema: {
        type: "object",
        properties: { json: { type: "string" } },
        required: ["json"],
      },
      handler: async (args) => {
        const jsonPath = String(args.json ?? "");
        if (!fs.existsSync(jsonPath)) return { ok: false, error: `json not found: ${jsonPath}`, code: "NOT_FOUND" };
        const r = runPython(["--verify-json", jsonPath]);
        try {
          const parsed = JSON.parse(r.stdout.trim() || r.stderr.trim());
          return { ok: parsed.ok === true, data: parsed };
        } catch {
          return { ok: false, error: r.stderr.trim() || r.stdout.trim() || `python exited ${r.code}`, code: "VERIFY_FAILED" };
        }
      },
    },
  };
}
