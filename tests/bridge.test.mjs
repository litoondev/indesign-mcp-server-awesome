// Unit tests for the bridge layer. No InDesign needed: ExtendScript is simulated
// in a vm context with JSON deleted (as in the DoScript context).
// Run: npx tsx --test tests/bridge.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "mcp_bridge_test_"));
const RUNS = join(ROOT, "runs");
mkdirSync(RUNS, { recursive: true });
process.env.INDESIGN_MCP_WRITE_ROOTS = RUNS;

const { JSON_POLYFILL } = await import("../src/bridge/jsonPolyfill.js");
const { jsStr, jsNum, jsBool, jsInt } = await import("../src/bridge/jsStr.js");
const { parseScriptOutput, buildRunner } = await import("../src/bridge/index.js");
const { wrapExtendScript, asciiStringLiteral } = await import("../src/bridge/wrapExtendScript.js");
const { assertSafeWritePath, assertSafeWriteDir, isUnderWriteRoots, SafetyError } = await import("../src/bridge/safety.js");
const { isWritablePath: policyIsWritablePath, downloadsBlockReason: policyDownloadsBlockReason } = await import(
  "../src/tools/batchB_writePolicy.js"
);
const { getDocumentTarget } = await import("../src/bridge/documentTarget.js");
const { invokeTool, withDocumentIdSchema, formatToolResult } = await import("../src/bridge/toolDispatch.js");

/** A vm context that looks like ExtendScript's DoScript context: no JSON. */
function esContext(extra = {}) {
  const ctx = vm.createContext({ ...extra });
  vm.runInContext("delete this.JSON;", ctx);
  assert.equal(vm.runInContext("typeof JSON", ctx), "undefined");
  return ctx;
}

test("polyfill: control chars, U+2028, quotes, backslash round-trip; NaN -> null", () => {
  const ctx = esContext();
  vm.runInContext(JSON_POLYFILL, ctx);
  const s = '\u0007\u0016\u0003\uFFFC\u2028a"b\\c\u0000\u001f\u0018\u0019\n\r\t\u007f\u2029';
  ctx.__input = s;
  const out = vm.runInContext("JSON.stringify(__input)", ctx);
  assert.doesNotMatch(out, /[\u0000-\u001f\u2028\u2029]/, "no raw control chars / line separators");
  assert.equal(JSON.parse(out), s);

  const obj = vm.runInContext(
    "JSON.stringify({ a: NaN, b: Infinity, c: -Infinity, d: [1, undefined, function () {}, 'x'], e: null, f: true, 'k\"\\u0007': 2, g: undefined })",
    ctx
  );
  assert.deepEqual(JSON.parse(obj), { a: null, b: null, c: null, d: [1, null, null, "x"], e: null, f: true, 'k"\u0007': 2 });
  assert.equal(vm.runInContext("JSON.stringify(NaN)", ctx), "null");
  // parse (Function-based, no eval)
  const parsed = vm.runInContext(`JSON.parse('{"x":[1,2,"\\\\u0007"]}')`, ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), { x: [1, 2, "\u0007"] }); // cross-realm -> plain
});

test("jsStr round-trips tricky strings as ExtendScript literals", () => {
  for (const s of ["it's", 'say "hi"', "C:\\path\\to\\file.indd", "a\nb\rc\td", "\u2028\u2029", "</script>", "^p\\d+", "", "\u0007\u0016"]) {
    const lit = jsStr(s);
    assert.doesNotMatch(lit, /[\u2028\u2029]/);
    assert.equal(vm.runInNewContext(lit), s, `round trip ${JSON.stringify(s)}`);
  }
  assert.equal(jsStr(undefined), '""');
});

test("jsNum / jsInt / jsBool validate", () => {
  assert.equal(jsNum(3, "x"), "3");
  assert.equal(jsNum("4.5", "x"), "4.5");
  for (const bad of [NaN, Infinity, "abc", "", {}, null, undefined, "1;app.quit()"]) {
    assert.throws(() => jsNum(bad, "x"), /Invalid number/);
  }
  assert.throws(() => jsInt(-1, "i"));
  assert.throws(() => jsInt(1.5, "i"));
  assert.equal(jsBool(undefined, true), "true");
  assert.equal(jsBool("false", true), "false");
  assert.throws(() => jsBool("yes", false));
});

test("parseScriptOutput never reports unparseable JSON as success", () => {
  const broken = '{"__error":true,"message":"line1\nline2"}';
  const r1 = parseScriptOutput(broken);
  assert.equal(r1.success, false);
  assert.equal(r1.code, "UNPARSEABLE_RESULT");
  assert.ok(r1.raw && r1.raw.length <= 2000);

  const r2 = parseScriptOutput('{"a":"\u0016"}'); // raw control char inside a string
  assert.equal(r2.success, false);
  assert.equal(r2.code, "UNPARSEABLE_RESULT");

  assert.equal(parseScriptOutput('[1,2').success, false);
  assert.deepEqual(parseScriptOutput('{"ok":true,"data":{"x":1}}'), { success: true, data: { x: 1 } });
  const f = parseScriptOutput('{"ok":false,"error":"nope","code":"X"}');
  assert.equal(f.success, false);
  assert.equal(f.error, "nope");
  assert.equal(f.code, "X");
  const e = parseScriptOutput('{"__error":true,"message":"boom","line":3}');
  assert.equal(e.success, false);
  assert.equal(e.code, "SCRIPT_ERROR");
  assert.equal(e.line, 3);
  assert.equal(parseScriptOutput('{"__void":true}').success, true);
  assert.equal(parseScriptOutput('{"__void":true}', { expectResult: true }).success, false);
  assert.deepEqual(parseScriptOutput("hello"), { success: true, data: "hello" });
  assert.deepEqual(parseScriptOutput("\uFEFF42"), { success: true, data: 42 });
});

/** Minimal InDesign DOM mock for running the generated runner in a vm. */
function mockInDesign(docPath) {
  const writes = {};
  const doc = { name: docPath.split(/[\\/]/).pop(), id: 7, fullName: { fsName: docPath } };
  const app = {
    scriptPreferences: { userInteractionLevel: "INTERACT_WITH_ALL", measurementUnit: "AUTO" },
    documents: Object.assign([doc], {}),
    activeDocument: doc,
    version: "21.0",
    undoSteps: [],
    doScript(fn, lang, args, mode, name) {
      this.undoSteps.push({ mode, name, uilDuring: this.scriptPreferences.userInteractionLevel });
      if (typeof fn === "function") return fn();
      throw new Error("string doScript not mocked");
    },
  };
  class File {
    constructor(p) { this.p = p; this.encoding = ""; }
    open() { return true; }
    write(s) { writes[this.p] = (writes[this.p] ?? "") + s; }
    close() {}
  }
  const ctx = esContext({
    app,
    File,
    UserInteractionLevels: { NEVER_INTERACT: "NEVER_INTERACT" },
    MeasurementUnits: { POINTS: "POINTS" },
    ScriptLanguage: { JAVASCRIPT: "JS" },
    UndoModes: { ENTIRE_SCRIPT: "ENTIRE" },
  });
  return { ctx, app, writes, doc };
}

function runGenerated(body, wrapOpts, docPath = join(RUNS, "a.indd")) {
  const m = mockInDesign(docPath);
  const resultPath = "C:/tmp/mcp_test.result";
  const runner = buildRunner(wrapExtendScript(body, wrapOpts), resultPath);
  assert.doesNotMatch(runner, /[^\u0000-\u007f]/, "runner must be pure ASCII");
  vm.runInContext(runner, m.ctx);
  return { ...m, raw: m.writes[resultPath], parsed: parseScriptOutput(m.writes[resultPath] ?? "", wrapOpts) };
}

test("runner: NEVER_INTERACT + POINTS during the body, restored after; completion value returned", () => {
  const r = runGenerated(
    "var d = __resolveDocument(); JSON.stringify({ uil: app.scriptPreferences.userInteractionLevel, mu: app.scriptPreferences.measurementUnit, name: d.name, s: '\u00e9\u2028\u0007' });",
    {}
  );
  assert.equal(r.parsed.success, true);
  assert.deepEqual(r.parsed.data, { uil: "NEVER_INTERACT", mu: "POINTS", name: "a.indd", s: "\u00e9\u2028\u0007" });
  assert.equal(r.app.scriptPreferences.userInteractionLevel, "INTERACT_WITH_ALL");
  assert.equal(r.app.scriptPreferences.measurementUnit, "AUTO");
});

test("runner: units 'document' leaves measurement units alone", () => {
  const r = runGenerated("JSON.stringify(app.scriptPreferences.measurementUnit)", { units: "document" });
  assert.equal(r.parsed.data, "AUTO");
});

test("runner: error messages with newlines/quotes become valid error JSON; prefs restored", () => {
  const r = runGenerated("throw new Error('bad\\nthing \"quoted\" \\u0007');", {});
  assert.equal(r.parsed.success, false);
  assert.equal(r.parsed.code, "SCRIPT_ERROR");
  assert.equal(r.parsed.error, 'bad\nthing "quoted" \u0007');
  assert.equal(r.app.scriptPreferences.userInteractionLevel, "INTERACT_WITH_ALL");
});

test("runner: undoName -> one doScript ENTIRE_SCRIPT step, inner result and inner __fail cross back", () => {
  const ok = runGenerated("JSON.stringify({ v: 1 });", { undoName: "Step" });
  assert.deepEqual(ok.parsed, { success: true, data: { v: 1 } });
  assert.equal(ok.app.undoSteps.length, 1);
  assert.equal(ok.app.undoSteps[0].mode, "ENTIRE");
  assert.equal(ok.app.undoSteps[0].name, "Step");
  assert.equal(ok.app.undoSteps[0].uilDuring, "NEVER_INTERACT");

  const failed = runGenerated("__fail('no anchors');", { undoName: "Step" });
  assert.equal(failed.parsed.success, false);
  assert.equal(failed.parsed.error, "no anchors");

  const thrown = runGenerated("throw new Error('mid-way');", { undoName: "Step" });
  assert.equal(thrown.parsed.success, false);
  assert.match(thrown.parsed.error, /mid-way \(partial changes may remain; use undo\)/);

  const v = runGenerated("var x = 1;", { undoName: "Step", expectResult: true });
  assert.equal(v.parsed.success, false);
  assert.equal(v.parsed.code, "VOID_RESULT");
});

test("runner: guardWrite refuses documents outside the write roots and the master", () => {
  const inside = runGenerated("JSON.stringify('changed')", { guardWrite: true }, join(RUNS, "copy.indd"));
  assert.equal(inside.parsed.success, true);
  const outside = runGenerated("JSON.stringify('changed')", { guardWrite: true }, "C:\\Users\\x\\Downloads\\BRAC.indd");
  assert.equal(outside.parsed.success, false);
  assert.match(outside.parsed.error, /^SAFETY: /);
  const outsideRoot = runGenerated("JSON.stringify('changed')", { guardWrite: true }, "D:\\elsewhere\\BRAC.indd");
  assert.match(outsideRoot.parsed.error, /^SAFETY: document outside allowed run folders/);
  const master = runGenerated("JSON.stringify('changed')", { guardWrite: true }, join(RUNS, "BRAC_TEST_MASTER.indd"));
  assert.equal(master.parsed.success, false);
});

test("document targeting: path, numeric string index, ambiguous names", () => {
  const m = mockInDesign(join(RUNS, "a.indd"));
  const docB = { name: "same.indd", id: 2, fullName: { fsName: "D:\\one\\same.indd" } };
  const docC = { name: "same.indd", id: 3, fullName: { fsName: "D:\\two\\same.indd" } };
  m.app.documents.push(docB, docC);
  const run = (target) => {
    const runner = buildRunner(wrapExtendScript("JSON.stringify(__resolveDocument().id)", { targetDocument: target }), "R");
    delete m.writes.R;
    vm.runInContext(runner, m.ctx);
    return parseScriptOutput(m.writes.R);
  };
  assert.equal(run("d:/TWO/same.indd").data, 3);
  assert.equal(run("1").data, 2);
  assert.equal(run(0).data, 7);
  assert.equal(run("a.indd").data, 7);
  const amb = run("same.indd");
  assert.equal(amb.success, false);
  assert.match(amb.error, /ambiguous document_id/);
  const missing = run("nope.indd");
  assert.equal(missing.success, false);
  assert.match(missing.error, /is not open/);
});

test("asciiStringLiteral escapes everything non-ASCII", () => {
  const lit = asciiStringLiteral("\u00e9\u2028\uFEFF\u{1F600}");
  assert.doesNotMatch(lit, /[^\u0000-\u007f]/);
  assert.equal(vm.runInNewContext(lit), "\u00e9\u2028\uFEFF\u{1F600}");
});

test("safety: write roots, master, overwrite", () => {
  assert.equal(isUnderWriteRoots(join(RUNS, "x.indd")), true);
  assert.equal(isUnderWriteRoots(join(ROOT, "x.indd")), false);
  assert.ok(assertSafeWritePath(join(RUNS, "new.indd"), [".indd"]).endsWith("new.indd"));
  assert.throws(() => assertSafeWritePath(join(ROOT, "x.indd"), [".indd"]), /SAFETY: path outside/);
  assert.throws(() => assertSafeWritePath(join(RUNS, "..", "x.indd"), [".indd"]), /SAFETY/);
  assert.throws(() => assertSafeWritePath(join(RUNS, "brac_test_master.INDD"), [".indd"]), /protected test master/);
  assert.throws(() => assertSafeWritePath(join(RUNS, "x.pdf"), [".indd"]), /extension/);
  const existing = join(RUNS, "exists.indd");
  writeFileSync(existing, "x");
  assert.throws(() => assertSafeWritePath(existing, [".indd"]), /already exists/);
  assert.ok(assertSafeWritePath(existing, [".indd"], { overwrite: true }));
  assert.throws(() => assertSafeWriteDir("C:\\Users\\x\\Downloads"), /SAFETY/);
});

/** Runs fn with INDESIGN_MCP_WRITE_ROOTS temporarily set to `roots`. */
function withRoots(roots, fn) {
  const prev = process.env.INDESIGN_MCP_WRITE_ROOTS;
  process.env.INDESIGN_MCP_WRITE_ROOTS = roots;
  try {
    return fn();
  } finally {
    process.env.INDESIGN_MCP_WRITE_ROOTS = prev;
  }
}

test("safety: Downloads rule holds even when a parent folder is a write root (qa-r2-05)", () => {
  withRoots("C:\\Users\\X;I:\\Indesign\\test_output", () => {
    assert.throws(() => assertSafeWritePath("C:\\Users\\X\\Downloads\\a.indd", [".indd"]), (e) => e instanceof SafetyError && /Downloads/.test(e.message));
    assert.throws(() => assertSafeWriteDir("C:\\Users\\X\\Downloads\\out"), (e) => e instanceof SafetyError && /Downloads/.test(e.message));
    assert.throws(() => assertSafeWriteDir("C:\\Users\\X\\Downloads"), SafetyError);
    assert.equal(isUnderWriteRoots("C:\\Users\\X\\Downloads\\Brac\\a.indd"), false);
    assert.equal(policyIsWritablePath("C:\\Users\\X\\Downloads\\a.indd"), false);
    assert.ok(policyDownloadsBlockReason("C:\\Users\\X\\Downloads\\a.indd"));
    // Outside Downloads the parent root still works.
    assert.equal(isUnderWriteRoots("C:\\Users\\X\\Documents\\a.indd"), true);
    assert.ok(assertSafeWriteDir("C:\\Users\\X\\Documents\\out"));
  });
  withRoots("C:\\Users\\X\\Downloads\\Brac;I:\\Indesign\\test_output", () => {
    assert.ok(assertSafeWritePath("C:\\Users\\X\\Downloads\\Brac\\a.indd", [".indd"]).endsWith("a.indd"));
    assert.ok(assertSafeWriteDir("C:\\Users\\X\\Downloads\\Brac\\out"));
    assert.equal(policyDownloadsBlockReason("C:\\Users\\X\\Downloads\\Brac\\a.indd"), null);
    // A sibling inside the same Downloads folder is still refused.
    assert.throws(() => assertSafeWritePath("C:\\Users\\X\\Downloads\\other\\a.indd", [".indd"]), SafetyError);
  });
  withRoots("C:\\Users\\X\\Downloads;I:\\Indesign\\test_output", () => {
    assert.ok(assertSafeWriteDir("C:\\Users\\X\\Downloads\\out"));
  });
});

test("runner: in-script guard applies the Downloads rule (__MCP_DOWNLOADS_ALLOWED)", () => {
  const dlDoc = join(ROOT, "Downloads", "BRAC.indd");
  const allowedDoc = join(ROOT, "Downloads", "Brac", "BRAC.indd");
  withRoots(`${ROOT};${RUNS}`, () => {
    const r = runGenerated("JSON.stringify('changed')", { guardWrite: true }, dlDoc);
    assert.equal(r.parsed.success, false);
    assert.match(r.parsed.error, /^SAFETY: refusing to modify a document under a Downloads folder/);
    const w = runGenerated("JSON.stringify(__mcpIsWritablePath(" + JSON.stringify(dlDoc) + "))", {}, dlDoc);
    assert.equal(w.parsed.data, false);
    const sib = runGenerated("JSON.stringify('changed')", { guardWrite: true }, join(ROOT, "other", "x.indd"));
    assert.equal(sib.parsed.success, true, "parent root still covers non-Downloads folders");
  });
  withRoots(`${join(ROOT, "Downloads", "Brac")};${RUNS}`, () => {
    const ok = runGenerated("JSON.stringify('changed')", { guardWrite: true }, allowedDoc);
    assert.equal(ok.parsed.success, true);
    const blocked = runGenerated("JSON.stringify('changed')", { guardWrite: true }, dlDoc);
    assert.equal(blocked.parsed.success, false);
  });
});

test("dispatch: document_id injected into schemas and bound for the handler", async () => {
  const schema = withDocumentIdSchema("some_tool", { type: "object", properties: { a: { type: "string" } } });
  assert.deepEqual(schema.properties.document_id.type, ["string", "integer"]);
  assert.equal(withDocumentIdSchema("probe_indesign", { type: "object", properties: {} }).properties.document_id, undefined);

  const tool = {
    description: "",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { success: true, data: { target: getDocumentTarget() } };
    },
  };
  const [a, b] = await Promise.all([invokeTool(tool, { document_id: "C:\\x\\a.indd" }), invokeTool(tool, { document_id: 2 })]);
  assert.deepEqual(JSON.parse(a.content[0].text), { target: "C:\\x\\a.indd" });
  assert.deepEqual(JSON.parse(b.content[0].text), { target: 2 });
  assert.deepEqual(JSON.parse((await invokeTool(tool, {})).content[0].text), { target: null });
});

test("dispatch: failures become isError", async () => {
  assert.equal(formatToolResult({ success: false, error: "x", code: "INDESIGN_BUSY" }).isError, true);
  assert.equal(JSON.parse(formatToolResult({ success: false, error: "x", code: "INDESIGN_BUSY" }).content[0].text).code, "INDESIGN_BUSY");
  assert.equal(formatToolResult(JSON.stringify({ error: true, message: "m" })).isError, true);
  assert.equal(formatToolResult({ error: true, message: "m" }).isError, true);
  assert.equal(formatToolResult({ success: true, data: { error: true, message: "m" } }).isError, true);
  assert.equal(formatToolResult({ success: true, data: { x: 1 } }).isError, undefined);
  assert.equal(formatToolResult({ success: true, data: { x: 1 } }).content[0].text, '{"x":1}');
  // Failure diagnostics reach the caller (qa-r2-01).
  const withData = formatToolResult({ success: false, error: "x", data: { blocker: { reasons: ["r"] } } });
  assert.equal(withData.isError, true);
  const wd = JSON.parse(withData.content[0].text);
  assert.equal(wd.ok, false);
  assert.equal(wd.error, "x");
  assert.equal(wd.data.blocker.reasons[0], "r");
  const rawKept = JSON.parse(formatToolResult({ success: false, error: "u", code: "UNPARSEABLE_RESULT", raw: "{bad", data: { n: 1 } }).content[0].text);
  assert.equal(rawKept.raw, "{bad");
  assert.equal(rawKept.data.n, 1);
  assert.equal(rawKept.code, "UNPARSEABLE_RESULT");
  const fromString = formatToolResult(JSON.stringify({ ok: false, error: "y", code: "MISMATCH", data: { mismatches: [{ i: 2 }] }, raw: "r" }));
  assert.equal(fromString.isError, true);
  const fs1 = JSON.parse(fromString.content[0].text);
  assert.equal(fs1.error, "y");
  assert.equal(fs1.code, "MISMATCH");
  assert.equal(fs1.data.mismatches[0].i, 2);
  assert.equal(fs1.raw, "r");
  const errTrue = JSON.parse(formatToolResult(JSON.stringify({ error: true, message: "m", data: { k: 1 } })).content[0].text);
  assert.equal(errTrue.data.k, 1);
  assert.equal("data" in JSON.parse(formatToolResult({ success: false, error: "nodata" }).content[0].text), false);
  // Success path unchanged.
  assert.equal(formatToolResult({ success: true, data: { blocker: null } }).content[0].text, '{"blocker":null}');
  assert.equal(formatToolResult('{"ok":true,"data":1}').content[0].text, '{"ok":true,"data":1}');
  assert.equal(formatToolResult("plain").content[0].text, "plain");
  assert.equal(formatToolResult("[1,2]").content[0].text, "[1,2]");
  const thrown = await invokeTool({ description: "", inputSchema: { type: "object", properties: {} }, handler: async () => { const e = new Error("SAFETY: no"); e.code = "SAFETY"; throw e; } }, {});
  assert.equal(thrown.isError, true);
  assert.equal(JSON.parse(thrown.content[0].text).code, "SAFETY");
});
