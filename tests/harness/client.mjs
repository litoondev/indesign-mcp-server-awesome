// ToolClient: calls compiled tool handlers inside a worker thread with a
// wall-clock guard. A hung call is reported as {timedOut:true} instead of
// blocking the harness forever; the worker (and its PowerShell child) is killed
// and a fresh worker is started for the next call.
import { Worker } from 'node:worker_threads';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function killChildProcesses() {
  // execSync in the worker spawns cmd.exe -> powershell.exe as children of this node process.
  try {
    const out = execSync(
      `powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId=${process.pid}' | Select-Object -ExpandProperty ProcessId"`,
      { encoding: 'utf-8', timeout: 30000 }
    );
    for (const pid of out.split(/\s+/).filter(Boolean)) {
      if (Number(pid) === process.pid) continue;
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', timeout: 30000 }); } catch {}
    }
  } catch {}
}

/** Parse whatever a handler returned into {success, data, error, raw}. */
export function normalize(result) {
  let r = result;
  if (typeof r === 'string') {
    try { r = JSON.parse(r); } catch { return { success: true, data: r, raw: result, note: 'string-not-json' }; }
    // backup_document style results: {success:true,...} or {error:true,message}
    if (r && r.error === true) return { success: false, error: r.message, raw: result };
    if (r && r.success === undefined) return { success: true, data: r, raw: result };
  }
  if (r && typeof r === 'object' && 'success' in r) {
    let data = r.data;
    let note;
    if (typeof data === 'string') {
      // bridge.parseResult falls back to the raw string when the ExtendScript JSON
      // polyfill emitted raw control chars (e.g. U+0016 table markers). Repair + parse.
      const t = data.trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          data = JSON.parse(t.replace(/[\u0000-\u001f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));
          note = 'json-repaired-control-chars';
          if (data && data.ok === true && 'data' in data) data = data.data;
          else if (data && data.ok === false) return { success: false, error: data.error, raw: result, note };
        } catch { /* keep string */ }
      }
    }
    if (r.success === false) return { success: false, error: r.error, code: r.code, raw: result };
    if (data && data.error === true) return { success: false, error: data.message, raw: result };
    return { success: true, data, raw: result, note };
  }
  return { success: true, data: r, raw: result };
}

export class ToolClient {
  constructor({ bridgeTimeout = 900000, defaultCallTimeout = 600000, log = () => {} } = {}) {
    this.bridgeTimeout = bridgeTimeout;
    this.defaultCallTimeout = defaultCallTimeout;
    this.log = log;
    this.seq = 0;
    this.calls = []; // per-call log {name, ms, ok, timedOut}
    this._spawn();
  }

  _spawn() {
    this.worker = new Worker(path.join(HERE, 'worker.mjs'), { workerData: { bridgeTimeout: this.bridgeTimeout } });
    this.pending = new Map();
    this.worker.on('message', (m) => {
      const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); p.resolve(m); }
    });
    this.worker.on('error', (e) => {
      for (const p of this.pending.values()) p.resolve({ ok: false, error: 'worker error: ' + e.message });
      this.pending.clear();
    });
  }

  async _send(msg, timeoutMs) {
    const id = ++this.seq;
    const worker = this.worker;
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(async () => {
        if (done) return;
        done = true;
        this.pending.delete(id);
        resolve({ ok: false, timedOut: true, error: `TIMEOUT after ${timeoutMs}ms (call hung)` });
        try { await worker.terminate(); } catch {}
        killChildProcesses();
        this._spawn();
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (m) => { if (done) return; done = true; clearTimeout(timer); resolve(m); },
      });
      worker.postMessage({ ...msg, id });
    });
  }

  async connect(timeoutMs = 120000) {
    return this._send({ type: 'connect' }, timeoutMs);
  }

  async listTools() {
    const m = await this._send({ type: 'list' }, 30000);
    return m.result;
  }

  /** Call a tool handler. Returns {ok, timedOut, ms, result, mcpText, norm}. */
  async call(name, args = {}, { timeoutMs } = {}) {
    const t0 = Date.now();
    const m = await this._send({ type: 'call', name, args }, timeoutMs ?? this.defaultCallTimeout);
    const ms = Date.now() - t0;
    const out = { name, ms, ok: m.ok, timedOut: !!m.timedOut, error: m.error, result: m.result, mcpText: m.mcpText };
    out.norm = m.ok ? normalize(m.result) : { success: false, error: m.error };
    this.calls.push({ name, ms, ok: out.norm.success, timedOut: out.timedOut });
    this.log(`  [${name}] ${ms}ms ${out.timedOut ? 'TIMEOUT' : out.norm.success ? 'ok' : 'FAIL: ' + String(out.norm.error).slice(0, 200)}`);
    return out;
  }

  /** Run an ExtendScript snippet through the run_script tool, targeting docName. */
  async script(code, { docName = null, timeoutMs, undoName } = {}) {
    const args = { script: code };
    if (docName) args.document_id = docName;
    if (undoName) args.undoName = undoName;
    const r = await this.call('run_script', args, { timeoutMs });
    if (!r.norm.success) {
      const e = new Error('run_script failed: ' + (r.norm.error || 'unknown'));
      e.call = r;
      throw e;
    }
    return r.norm.data;
  }

  async close() {
    try { await this.worker.terminate(); } catch {}
  }
}
