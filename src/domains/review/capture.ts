import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * review_capture_panel
 *
 * Capture the Adobe InDesign application window (or just its right-hand
 * panel column) to a PNG. Primary use: hand the image to a vision model so
 * it can read Share-for-Review comments without any Adobe API.
 *
 * Implementation runs scripts/powershell/window_capture.ps1 which uses
 * GDI BitBlt against the InDesign window. No clicks, no typing.
 *
 * Why this is a separate tool instead of baked into a workflow: capture is
 * cheap (~200 ms) and composable. Vision reads the image, the workflow
 * tool decides what to edit. Keeping capture standalone lets us swap the
 * backend (structured UXP cache, local LevelDB) without touching callers.
 */

const SCRIPT_REL = path.join("scripts", "powershell", "window_capture.ps1");

export interface CaptureResult {
  success: boolean;
  outPath?: string;
  region?: string;
  windowTitle?: string;
  windowBounds?: { left: number; top: number; width: number; height: number };
  captureBounds?: { left: number; top: number; width: number; height: number };
  error?: string;
  code?: string;
}

function resolveScript(): string {
  // src/domains/review/capture.ts → project root is three levels up at runtime
  // (dist/domains/review/capture.js → ../../.. → project root).
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
  const root = path.resolve(here, "..", "..", "..");
  return path.join(root, SCRIPT_REL);
}

function resolveOutPath(given: unknown, region: string): string {
  if (typeof given === "string" && given.trim().length > 0) return path.resolve(given);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `indesign_capture_${region}_${stamp}.png`;
  const scratch = process.env.MCP_SCRATCHPAD ?? path.join(os.tmpdir(), "indesign-mcp");
  return path.join(scratch, base);
}

function runPowerShell(script: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const ps = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
      { windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    ps.stdout.on("data", (c) => (stdout += c.toString()));
    ps.stderr.on("data", (c) => (stderr += c.toString()));
    ps.on("error", reject);
    ps.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });
}

export function registerReviewCaptureTools() {
  return {
    review_capture_panel: {
      description:
        "Screenshot the Adobe InDesign window to a PNG and return the file path plus window bounds. Use region='right' with panelWidth to grab just the docked panel column (where the Review panel lives). Read-only; does not click or type. Output path defaults to the MCP scratchpad.",
      inputSchema: {
        type: "object" as const,
        properties: {
          region: {
            type: "string",
            enum: ["full", "right"],
            description: "What to capture: 'full' the whole InDesign window (default), or 'right' the rightmost `panelWidth` pixels.",
          },
          panelWidth: {
            type: "integer",
            minimum: 120,
            maximum: 2000,
            description: "Width of the right-side slice when region='right'. Default 340 — covers the typical Review panel docked width. Ignored otherwise.",
          },
          outPath: {
            type: "string",
            description: "Absolute PNG output path. Defaults to a timestamped file in the MCP scratchpad.",
          },
          titleMatch: {
            type: "string",
            description: "Substring to match the window title. Default 'Adobe InDesign'. Useful if multiple InDesign windows are open.",
          },
        },
      },
      handler: async (args: Record<string, unknown>): Promise<CaptureResult> => {
        const region = args.region === "right" ? "right" : "full";
        const panelWidth = typeof args.panelWidth === "number" && Number.isFinite(args.panelWidth) ? Math.round(args.panelWidth) : 340;
        const titleMatch = typeof args.titleMatch === "string" && args.titleMatch.trim().length > 0 ? args.titleMatch.trim() : "Adobe InDesign";
        const outPath = resolveOutPath(args.outPath, region);

        await fs.mkdir(path.dirname(outPath), { recursive: true });

        const script = resolveScript();
        const psArgs = ["-OutPath", outPath, "-Region", region, "-PanelWidth", String(panelWidth), "-TitleMatch", titleMatch];

        const { stdout, stderr, exitCode } = await runPowerShell(script, psArgs);

        // Script prints exactly one JSON line on stdout.
        const line = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? "";
        let parsed: CaptureResult | undefined;
        try {
          parsed = line ? (JSON.parse(line) as CaptureResult) : undefined;
        } catch {
          parsed = undefined;
        }

        if (!parsed) {
          return {
            success: false,
            error: `capture script produced no parseable output (exit ${exitCode}). stderr: ${stderr.trim().slice(0, 500)}`,
            code: "CAPTURE_NO_OUTPUT",
          };
        }
        if (!parsed.success) return parsed;

        // Verify the file actually landed.
        try {
          const st = await fs.stat(parsed.outPath ?? outPath);
          if (st.size === 0) {
            return { success: false, error: "capture file is empty", code: "CAPTURE_EMPTY" };
          }
        } catch (e) {
          return { success: false, error: `capture file missing: ${(e as Error).message}`, code: "CAPTURE_MISSING" };
        }

        return parsed;
      },
    },
  };
}
