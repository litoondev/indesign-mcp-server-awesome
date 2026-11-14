import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Shared PowerShell runner for Review-panel UI automation.
 *
 * Writes the action list to a temp JSON file and invokes
 * scripts/powershell/ui_automation.ps1. One PS spawn per batch keeps
 * Windows input events coherent (SetForegroundWindow, modifier key order,
 * mouse-down/up pairing).
 */

const SCRIPT_REL = path.join("scripts", "powershell", "ui_automation.ps1");

export type UiAction =
  | { type: "focus" }
  | { type: "sleep"; ms?: number }
  | { type: "move"; x: number; y: number }
  | { type: "click"; x: number; y: number; button?: "left" | "right"; double?: boolean; modifier?: "shift" | "ctrl" | "alt" | "cmd" }
  | { type: "type"; text: string }
  | { type: "key"; name: string }
  | { type: "wheel"; x: number; y: number; delta: number };

export interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface UiRunResult {
  success: boolean;
  completed?: Array<Record<string, unknown>>;
  error?: string;
  code?: string;
}

function resolveScript(): string {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
  const root = path.resolve(here, "..", "..", "..");
  return path.join(root, SCRIPT_REL);
}

function scratchDir(): string {
  return process.env.MCP_SCRATCHPAD ?? path.join(os.tmpdir(), "indesign-mcp");
}

export async function runUiActions(actions: UiAction[], opts?: { bounds?: Bounds; titleMatch?: string; defaultSleepMs?: number }): Promise<UiRunResult> {
  if (actions.length === 0) return { success: true, completed: [] };

  await fs.mkdir(scratchDir(), { recursive: true });
  const actionsPath = path.join(scratchDir(), `ui_actions_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  await fs.writeFile(actionsPath, JSON.stringify(actions), "utf8");

  const args = ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolveScript(), "-ActionsPath", actionsPath];
  if (opts?.bounds) args.push("-Bounds", JSON.stringify(opts.bounds));
  if (opts?.titleMatch) args.push("-TitleMatch", opts.titleMatch);
  if (typeof opts?.defaultSleepMs === "number" && Number.isFinite(opts.defaultSleepMs)) args.push("-DefaultSleepMs", String(Math.max(0, Math.round(opts.defaultSleepMs))));

  const { stdout, stderr, exitCode } = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const ps = spawn("powershell.exe", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    ps.stdout.on("data", (c) => (stdout += c.toString()));
    ps.stderr.on("data", (c) => (stderr += c.toString()));
    ps.on("error", reject);
    ps.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });

  // Best-effort cleanup — leave the file if the script failed, for forensics.
  if (exitCode === 0) {
    fs.unlink(actionsPath).catch(() => {});
  }

  const line = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? "";
  try {
    return JSON.parse(line) as UiRunResult;
  } catch {
    return {
      success: false,
      error: `ui_automation produced no parseable output (exit ${exitCode}). stderr: ${stderr.trim().slice(0, 500)}`,
      code: "UIA_NO_OUTPUT",
    };
  }
}

/**
 * Parse and validate a Bounds-shaped record from a tool-arg object.
 * Returns undefined if the arg wasn't provided, throws if it was provided
 * malformed. Caller enforces whether bounds are required.
 */
export function parseBounds(raw: unknown): Bounds | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") throw new Error("bounds must be an object { left, top, width, height }");
  const b = raw as Record<string, unknown>;
  const left = Number(b.left);
  const top = Number(b.top);
  const width = Number(b.width);
  const height = Number(b.height);
  if (![left, top, width, height].every((n) => Number.isFinite(n))) {
    throw new Error("bounds must have numeric left, top, width, height");
  }
  if (width <= 0 || height <= 0) throw new Error("bounds width/height must be positive");
  return { left, top, width, height };
}
