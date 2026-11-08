import { JSON_POLYFILL } from "./jsonPolyfill.js";
import { getExtendScriptHelpers } from "./extendScriptHelpers.js";
import { writeRootsLiteral, protectedBasenamesLiteral, downloadsAllowedLiteral } from "./safety.js";

export interface WrapOptions {
  /** Full path (preferred), file name, or 0-based index. null = front document. */
  targetDocument?: string | number | null;
  /** Run the body as ONE undo step with this name (implies mutating). */
  undoName?: string;
  /**
   * Units the script's numbers are in. 'points' (default) sets
   * app.scriptPreferences.measurementUnit = POINTS for the duration of the
   * script; 'document' leaves the document's ruler units in effect.
   */
  units?: "points" | "document";
  /**
   * Before the body runs, assert the target document lives under the allowed
   * write roots and is not the protected master (throws "SAFETY: ...").
   */
  guardWrite?: boolean;
  /** Treat a script that returns nothing as an error (checked in Node). */
  expectResult?: boolean;
}

/**
 * Encodes code as a JavaScript string literal that the ES3 ExtendScript engine
 * parses. JSON.stringify leaves U+2028/U+2029 raw; they are line terminators
 * in ES3 and would break the literal.
 */
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

export function asStringLiteral(code: string): string {
  return JSON.stringify(code).split(LINE_SEP).join("\\u2028").split(PARA_SEP).join("\\u2029");
}

function hex4(c: string): string {
  return "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
}

/**
 * asStringLiteral, then every non-ASCII code unit escaped as \uXXXX, so the
 * literal (and therefore the generated .jsx) is pure ASCII and cannot be
 * mis-decoded with an ANSI codepage.
 */
export function asciiStringLiteral(code: string): string {
  const s = asStringLiteral(code);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c > 0x7e ? hex4(s[i]) : s[i];
  }
  return out;
}

function targetLiteral(t: WrapOptions["targetDocument"]): string {
  if (typeof t === "number" && Number.isInteger(t) && t >= 0) return String(t);
  if (typeof t === "string" && t.trim() !== "") return asStringLiteral(t.trim());
  return "null";
}

/**
 * Builds the bundle the outer runner evals:
 *
 *   polyfill + globals + helpers
 *   save userInteractionLevel / measurementUnit
 *   try {
 *     NEVER_INTERACT (+ POINTS), optional write guard,
 *     body (optionally inside app.doScript(..., UndoModes.ENTIRE_SCRIPT, name))
 *   } finally { restore both }
 *   __mcpRes;              <- completion value = the body's completion value
 *
 * The body is evaluated from a string literal so statement-style scripts
 * (`var doc = ...; JSON.stringify(x);`) keep their completion value.
 */
export function wrapExtendScript(code: string, options: WrapOptions = {}): string {
  const helpers = getExtendScriptHelpers();
  const units = options.units ?? "points";
  const bodyLit = asStringLiteral(code);

  const globals =
    `var __TARGET_DOCUMENT_ID = ${targetLiteral(options.targetDocument)};\n` +
    `var __MCP_WRITE_ROOTS = ${writeRootsLiteral()};\n` +
    `var __MCP_DOWNLOADS_ALLOWED = ${downloadsAllowedLiteral()};\n` +
    `var __MCP_PROTECTED = ${protectedBasenamesLiteral()};\n`;

  let run: string;
  if (options.undoName) {
    run = `
  var __mcpInnerErr = null;
  var __mcpInnerRes;
  app.doScript(function () {
    try {
      __mcpInnerRes = eval(${bodyLit});
    } catch (__e) {
      __mcpInnerErr = { message: String(__e && __e.message ? __e.message : __e), line: (__e && __e.line) ? __e.line : null };
    }
  }, ScriptLanguage.JAVASCRIPT, undefined, UndoModes.ENTIRE_SCRIPT, ${asStringLiteral(options.undoName)});
  if (__mcpInnerErr) {
    var __mcpE = new Error(__mcpInnerErr.message + ' (partial changes may remain; use undo)');
    __mcpE.line = __mcpInnerErr.line;
    throw __mcpE;
  }
  __mcpRes = __mcpInnerRes;`;
  } else {
    run = `
  __mcpRes = eval(${bodyLit});`;
  }

  return `${JSON_POLYFILL}
${globals}${helpers}
var __mcpRes;
var __mcpUIL = null;
var __mcpMU = null;
try { __mcpUIL = app.scriptPreferences.userInteractionLevel; } catch (__e0) {}
try { __mcpMU = app.scriptPreferences.measurementUnit; } catch (__e1) {}
try {
  app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
  ${units === "points" ? "if (__mcpMU !== null) app.scriptPreferences.measurementUnit = MeasurementUnits.POINTS;" : ""}
  ${options.guardWrite ? "if (app.documents.length > 0) __mcpAssertWritable(__resolveDocument());" : ""}
${run}
} finally {
  try { if (__mcpUIL !== null) app.scriptPreferences.userInteractionLevel = __mcpUIL; } catch (__e2) {}
  try { if (__mcpMU !== null) app.scriptPreferences.measurementUnit = __mcpMU; } catch (__e3) {}
}
__mcpRes;
`;
}
