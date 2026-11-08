import { spawn } from "node:child_process";
import { platform, tmpdir } from "node:os";
import { writeFileSync, unlinkSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ScriptResult, BridgeOptions } from "../types.js";
import { wrapExtendScript, asciiStringLiteral, type WrapOptions } from "./wrapExtendScript.js";
import { getDocumentTarget } from "./documentTarget.js";

const IS_WIN = platform() === "win32";
export const DEFAULT_TIMEOUT_MS = 120_000;
/** Timeout for open/save/close/export of the 930 MB book. */
export const LONG_TIMEOUT_MS = 600_000;
const PROBE_TIMEOUT_MS = 10_000;
/** UserInteractionLevels.NEVER_INTERACT (1699311169 is INTERACT_WITH_ALL). */
const NEVER_INTERACT = 1699640946;
const MAX_OUTPUT = 50 * 1024 * 1024;

export const BUSY_LOCK_FILE = join(tmpdir(), "mcp_indesign_busy.json");

const INDESIGN_PROGIDS = [
  "InDesign.Application.2026",
  "InDesign.Application.2025",
  "InDesign.Application.2024",
  "InDesign.Application.2023",
  "InDesign.Application",
];
const MAC_APPS = ["Adobe InDesign 2026", "Adobe InDesign 2025", "Adobe InDesign 2024", "Adobe InDesign"];

export type BridgeErrorCode =
  | "EXECUTION_TIMEOUT_STILL_RUNNING"
  | "INDESIGN_BUSY"
  | "UNPARSEABLE_RESULT"
  | "NO_RESULT"
  | "VOID_RESULT"
  | "SCRIPT_ERROR"
  | "SCRIPT_FAILED"
  | "DOSCRIPT_ERROR"
  | "CONNECT_FAILED"
  | "BRIDGE_ERROR";

/** ScriptResult plus a machine-readable error code and raw output snippet. */
export interface BridgeResult extends ScriptResult {
  code?: BridgeErrorCode | string;
  raw?: string;
  line?: number | null;
}

export interface RunOptions extends WrapOptions {
  /** Per-call timeout; default INDESIGN_MCP_TIMEOUT_MS or 120000. */
  timeoutMs?: number;
  /**
   * The script changes a document. Turns on the in-script write guard
   * (WrapOptions.guardWrite). Implied by undoName unless set to false.
   */
  mutating?: boolean;
  /** Recorded in the busy lock for diagnostics. */
  toolName?: string;
}

interface BusyLock {
  pid: number;
  startedAt: number;
  tool?: string;
  timeoutMs?: number;
  timedOut?: boolean;
  timedOutAt?: number;
  resultFile?: string;
}

interface ProcOutput {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
  spawnError?: string;
}

const BUSY_PATTERN =
  /0x80010001|0x8001010A|RPC_E_CALL_REJECTED|RPC_E_SERVERCALL_RETRYLATER|Call was rejected|application is busy/i;

function log(msg: string): void {
  try {
    process.stderr.write(`[indesign-bridge] ${msg}\n`);
  } catch {
    /* ignore */
  }
}

function psQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(): BusyLock | null {
  try {
    if (!existsSync(BUSY_LOCK_FILE)) return null;
    const v = JSON.parse(readFileSync(BUSY_LOCK_FILE, "utf-8"));
    return v && typeof v.pid === "number" ? (v as BusyLock) : null;
  } catch {
    return null;
  }
}

function writeLock(lock: BusyLock): void {
  try {
    writeFileSync(BUSY_LOCK_FILE, JSON.stringify(lock), "utf-8");
  } catch (e) {
    log(`could not write busy lock: ${(e as Error).message}`);
  }
}

function clearLock(expect?: BusyLock): void {
  try {
    if (expect) {
      const cur = readLock();
      if (!cur || cur.pid !== expect.pid || cur.startedAt !== expect.startedAt) return;
      if (cur.resultFile) {
        try {
          unlinkSync(cur.resultFile);
        } catch {
          /* ignore */
        }
      }
    }
    unlinkSync(BUSY_LOCK_FILE);
  } catch {
    /* ignore */
  }
}

/**
 * Turns the text the outer runner wrote into a ScriptResult. Never reports
 * unparseable JSON-looking output as success.
 */
export function parseScriptOutput(raw: string, opts: { expectResult?: boolean } = {}): BridgeResult {
  const trimmed = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).trim();
  if (!trimmed || trimmed === '{"__void":true}') {
    if (opts.expectResult) {
      return { success: false, code: "VOID_RESULT", error: "Script finished without returning a result" };
    }
    return { success: true };
  }
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    if (/^[[{]/.test(trimmed) || trimmed.includes('"__error"')) {
      return {
        success: false,
        code: "UNPARSEABLE_RESULT",
        error: "Unparseable ExtendScript result",
        raw: trimmed.slice(0, 2000),
      };
    }
    return { success: true, data: trimmed };
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const o = data as Record<string, unknown>;
    if (o.__error) {
      return {
        success: false,
        code: "SCRIPT_ERROR",
        error: String(o.message || "Unknown ExtendScript error"),
        line: typeof o.line === "number" ? o.line : null,
      };
    }
    if (o.ok === false) {
      return {
        success: false,
        code: typeof o.code === "string" ? o.code : "SCRIPT_FAILED",
        error: String(o.error ?? "Script reported failure"),
      };
    }
    if (o.ok === true && "data" in o) {
      return { success: true, data: o.data };
    }
  }
  return { success: true, data };
}

/**
 * Outer runner written to the .jsx: evals the (ASCII-only) bundle literal and
 * writes the completion value, or a JSON error object, to the result file.
 * The error JSON is built with a local escaper because the polyfill lives
 * inside the eval and may not have loaded.
 */
export function buildRunner(wrapped: string, resultPath: string): string {
  const lit = asciiStringLiteral(wrapped);
  const resLit = asciiStringLiteral(resultPath.replace(/\\/g, "/"));
  return (
    String.raw`var __mcpOut = '';
function __mcpQ(s) {
  s = String(s);
  var r = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c === 34) r += '\\"';
    else if (c === 92) r += '\\\\';
    else if (c < 32 || c > 126) { var h = c.toString(16); while (h.length < 4) h = '0' + h; r += '\\u' + h; }
    else r += s.charAt(i);
  }
  return '"' + r + '"';
}
try {
  var __mcpResult = eval(` +
    lit +
    String.raw`);
  if (typeof __mcpResult !== 'undefined' && __mcpResult !== null) {
    __mcpOut = String(__mcpResult);
  } else {
    __mcpOut = '{"__void":true}';
  }
} catch (__mcpErr) {
  var __mcpMsg = 'unknown error';
  try { __mcpMsg = String(__mcpErr && __mcpErr.message ? __mcpErr.message : __mcpErr); } catch (__x) {}
  var __mcpLine = null;
  try { if (__mcpErr && __mcpErr.line) __mcpLine = Number(__mcpErr.line); } catch (__y) {}
  __mcpOut = '{"__error":true,"message":' + __mcpQ(__mcpMsg) + ',"line":' + ((__mcpLine === null || isNaN(__mcpLine)) ? 'null' : String(__mcpLine)) + '}';
}
var __mcpF = new File(` +
    resLit +
    String.raw`);
__mcpF.encoding = 'UTF-8';
if (__mcpF.open('w')) { __mcpF.write(__mcpOut); __mcpF.close(); }
`
  );
}

export class InDesignBridge {
  private progId: string | null = null;
  private macApp: string | null = null;
  private timeout: number;
  private connected = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: BridgeOptions = {}) {
    this.timeout = options.timeout ?? (Number(process.env.INDESIGN_MCP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
    if (options.indesignVersion) {
      this.progId = `InDesign.Application.${options.indesignVersion}`;
    }
  }

  /** Default per-call timeout in ms. */
  get defaultTimeoutMs(): number {
    return this.timeout;
  }

  /** Timeout for long operations (open/save/close/export): max(600 s, default). */
  longTimeout(): number {
    return Math.max(LONG_TIMEOUT_MS, this.timeout);
  }

  async connect(): Promise<string> {
    if (IS_WIN) return this.connectWindows();
    return this.connectMac();
  }

  private async connectWindows(): Promise<string> {
    const ids = this.progId ? [this.progId] : INDESIGN_PROGIDS;
    const ps = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ids = @(${ids.map(psQuote).join(",")})
foreach ($id in $ids) {
  $t = $null
  try { $t = [type]::GetTypeFromProgID($id) } catch { $t = $null }
  if ($t -ne $null) {
    try {
      $app = New-Object -ComObject $id
      $n = $app.Name
      $uil = 'OK'
      try { $app.ScriptPreferences.UserInteractionLevel = ${NEVER_INTERACT} } catch { $uil = 'ERR ' + $_.Exception.Message }
      Write-Output ('CONNECT_OK|' + $id + '|' + $n + '|' + $uil)
      exit 0
    } catch {
      Write-Output ('CONNECT_FAIL|' + $id + '|' + $_.Exception.Message)
    }
  }
}
Write-Output 'CONNECT_NONE'
`;
    const out = await this.runPowerShell(ps, this.timeout);
    const line = out.stdout.split(/\r?\n/).find((l) => l.startsWith("CONNECT_OK|"));
    if (line) {
      const [, id, name, uil] = line.split("|");
      this.progId = id;
      this.connected = true;
      if (uil && uil !== "OK") log(`could not set NEVER_INTERACT at connect (${uil}); each script sets it itself`);
      return `Connected to ${name || "InDesign"} via ${id}`;
    }
    const fails = out.stdout
      .split(/\r?\n/)
      .filter((l) => l.startsWith("CONNECT_FAIL|"))
      .join("; ");
    if (out.timedOut) throw new Error(`Timed out connecting to InDesign after ${this.timeout} ms`);
    throw new Error(
      `Cannot connect to InDesign (${fails || "no registered InDesign COM ProgID"}). Ensure it is installed and has been launched at least once.`
    );
  }

  private async connectMac(): Promise<string> {
    for (const appName of MAC_APPS) {
      const out = await this.runProcess("osascript", ["-e", `tell application "${appName}" to get name`], this.timeout);
      if (!out.timedOut && out.exitCode === 0) {
        this.macApp = appName;
        this.connected = true;
        return `Connected to ${appName} on macOS`;
      }
    }
    throw new Error("Cannot connect to InDesign on macOS. Ensure it is installed.");
  }

  /** Serializes all InDesign calls of this process (InDesign is single-threaded). */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async runScript(script: string, options: RunOptions = {}): Promise<BridgeResult> {
    return this.enqueue(async () => {
      try {
        if (!this.connected) await this.connect();
        const busy = await this.checkBusyLock();
        if (busy) return busy;
        return await this.execute(script, options, true);
      } catch (err) {
        return {
          success: false,
          code: (err as { code?: string }).code ?? "BRIDGE_ERROR",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });
  }

  /**
   * Cheap liveness check: a 10 s DoScript of app.documents.length. Clears a
   * busy lock left by a timed-out call when InDesign answers.
   */
  async probe(): Promise<BridgeResult> {
    return this.enqueue(async () => {
      try {
        if (!this.connected) await this.connect();
        const lock = readLock();
        const r = await this.probeInternal();
        if (r.success && lock) clearLock(lock);
        if (r.success && r.data && typeof r.data === "object") {
          (r.data as Record<string, unknown>).clearedBusyLock = !!lock;
        }
        return r;
      } catch (err) {
        return { success: false, code: "CONNECT_FAILED", error: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  private probeInternal(): Promise<BridgeResult> {
    return this.execute(
      `var __d = [];
       for (var __i = 0; __i < app.documents.length; __i++) {
         __d.push({ index: __i, name: app.documents[__i].name, fullName: __docPath(app.documents[__i]) });
       }
       JSON.stringify({ responsive: true, version: String(app.version), documents: app.documents.length, openDocuments: __d });`,
      { timeoutMs: PROBE_TIMEOUT_MS, targetDocument: null, units: "document", toolName: "probe" },
      false
    );
  }

  /** Returns an INDESIGN_BUSY result when a previous call may still be running. */
  private async checkBusyLock(): Promise<BridgeResult | null> {
    const lock = readLock();
    if (!lock) return null;
    const age = Date.now() - lock.startedAt;
    if (!lock.timedOut && lock.pid === process.pid) {
      // Our own calls are serialized; a lock from this pid is a leftover.
      clearLock(lock);
      return null;
    }
    if (!lock.timedOut && pidAlive(lock.pid) && age < (lock.timeoutMs ?? this.timeout) + 60_000) {
      return {
        success: false,
        code: "INDESIGN_BUSY",
        error: `InDesign is busy: another MCP server process (pid ${lock.pid}) is running '${lock.tool ?? "a script"}' since ${new Date(lock.startedAt).toISOString()}. Wait and call probe_indesign.`,
      };
    }
    // Timed out, or the owner died mid-call: only proceed once InDesign answers.
    const p = await this.probeInternal();
    if (p.success) {
      clearLock(lock);
      return null;
    }
    return {
      success: false,
      code: "INDESIGN_BUSY",
      error: `InDesign has not answered since '${lock.tool ?? "a script"}' (started ${new Date(lock.startedAt).toISOString()}) ${lock.timedOut ? "timed out" : "was interrupted"}. It may still be executing or showing a modal dialog. Dismiss any dialog in InDesign, then call probe_indesign until it answers. Probe: ${p.error ?? "no answer"}`,
    };
  }

  private async execute(script: string, options: RunOptions, useLock: boolean): Promise<BridgeResult> {
    const timeoutMs = options.timeoutMs ?? this.timeout;
    const targetDocument = options.targetDocument === undefined ? getDocumentTarget() : options.targetDocument;
    const mutating = options.mutating ?? !!options.undoName;
    const wrapOpts: WrapOptions = {
      targetDocument,
      undoName: options.undoName,
      units: options.units,
      guardWrite: options.guardWrite ?? mutating,
      expectResult: options.expectResult,
    };

    const base = join(tmpdir(), `mcp_indesign_${process.pid}_${randomUUID()}`);
    const tempFile = `${base}.jsx`;
    const resultFile = `${base}.result`;
    const wrapped = wrapExtendScript(script, wrapOpts);
    // UTF-8 BOM; the runner itself is pure ASCII.
    writeFileSync(tempFile, String.fromCharCode(0xfeff) + buildRunner(wrapped, resultFile), "utf-8");

    const lock: BusyLock = {
      pid: process.pid,
      startedAt: Date.now(),
      tool: options.toolName,
      timeoutMs,
      resultFile,
    };
    if (useLock) writeLock(lock);

    let out: ProcOutput;
    try {
      out = IS_WIN ? await this.doScriptWindows(tempFile, timeoutMs) : await this.doScriptMac(tempFile, timeoutMs);
    } catch (e) {
      if (useLock) clearLock(lock);
      try {
        unlinkSync(tempFile);
      } catch {
        /* ignore */
      }
      throw e;
    }

    // Deleting the .jsx on timeout also stops a still-queued DoScript from running late.
    try {
      unlinkSync(tempFile);
    } catch {
      /* ignore */
    }

    if (out.timedOut && !existsSync(resultFile)) {
      if (useLock) writeLock({ ...lock, timedOut: true, timedOutAt: Date.now() });
      return {
        success: false,
        code: "EXECUTION_TIMEOUT_STILL_RUNNING",
        error: `Timed out after ${Math.round(timeoutMs / 1000)} s. InDesign may still be executing the script and may already have changed the document. Do NOT retry; call probe_indesign until it answers.`,
      };
    }

    try {
      if (existsSync(resultFile)) {
        const raw = readFileSync(resultFile, "utf-8");
        return parseScriptOutput(raw, { expectResult: options.expectResult });
      }
      const m = /DOSCRIPT_ERR: ([\s\S]*)/.exec(out.stdout);
      const detail = (m ? m[1] : out.spawnError || out.stderr || out.stdout).trim().slice(0, 2000);
      if (BUSY_PATTERN.test(detail)) {
        return {
          success: false,
          code: "INDESIGN_BUSY",
          error: `InDesign is busy (modal dialog or previous script still running): ${detail}`,
        };
      }
      if (m) return { success: false, code: "DOSCRIPT_ERROR", error: `DoScript failed: ${detail}` };
      return {
        success: false,
        code: "NO_RESULT",
        error: `ExtendScript produced no result${detail ? `: ${detail}` : ""}`,
      };
    } finally {
      try {
        unlinkSync(resultFile);
      } catch {
        /* ignore */
      }
      if (useLock) clearLock(lock);
    }
  }

  private doScriptWindows(tempFile: string, timeoutMs: number): Promise<ProcOutput> {
    const ps = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  $app = New-Object -ComObject ${psQuote(this.progId ?? "InDesign.Application")}
  $fso = New-Object -ComObject 'Scripting.FileSystemObject'
  $f = $fso.GetFile(${psQuote(tempFile)})
  $null = $app.DoScript($f, 1246973031)
  Write-Output 'DOSCRIPT_OK'
} catch {
  Write-Output ('DOSCRIPT_ERR: ' + $_.Exception.Message)
}`;
    return this.runPowerShell(ps, timeoutMs);
  }

  private doScriptMac(tempFile: string, timeoutMs: number): Promise<ProcOutput> {
    const app = this.macApp ?? "Adobe InDesign";
    const as = `tell application "${app}" to do script (POSIX file "${tempFile.replace(/"/g, '\\"')}") language javascript`;
    return this.runProcess("osascript", ["-e", as], timeoutMs);
  }

  private runPowerShell(script: string, timeoutMs: number): Promise<ProcOutput> {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return this.runProcess(
      "powershell.exe",
      ["-NoLogo", "-NonInteractive", "-NoProfile", "-EncodedCommand", encoded],
      timeoutMs
    );
  }

  /** Async child process with stdin closed, output capture and a Node-side timer. */
  private runProcess(cmd: string, args: string[], timeoutMs: number): Promise<ProcOutput> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const finish = (exitCode: number | null, spawnError?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), timedOut, exitCode, spawnError });
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      } catch (e) {
        resolve({ stdout: "", stderr: "", timedOut: false, exitCode: null, spawnError: (e as Error).message });
        return;
      }
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        // Do not wait for 'close' forever if the process ignores the signal.
        setTimeout(() => finish(null), 2000).unref?.();
      }, timeoutMs);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (d: string) => {
        if (stdout.length < MAX_OUTPUT) stdout += d;
      });
      child.stderr?.on("data", (d: string) => {
        if (stderr.length < MAX_OUTPUT) stderr += d;
      });
      child.on("error", (e) => finish(null, e.message));
      child.on("close", (code) => finish(code));
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  getPlatform(): "windows" | "mac" {
    return IS_WIN ? "windows" : "mac";
  }
}
