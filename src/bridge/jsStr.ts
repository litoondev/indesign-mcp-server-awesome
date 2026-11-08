/**
 * Safe embedding of Node values into generated ExtendScript source.
 *
 * Every value a tool interpolates into a script MUST go through one of these.
 * Hand-rolled `'${value.replace(/'/g, "\\'")}'` escaping (the old pattern) let
 * backslashes, newlines, U+2028/U+2029 and `</script>`-style payloads break or
 * change the generated program.
 */

/**
 * A double-quoted ExtendScript string literal holding `String(v)` verbatim.
 * JSON.stringify escapes quotes, backslashes and control characters; U+2028 and
 * U+2029 are line terminators in the ES3 engine and are escaped explicitly.
 * GREP patterns keep their backslashes (they are escaped, then decoded back by
 * the ExtendScript parser).
 */
export function jsStr(v: unknown): string {
  return JSON.stringify(String(v ?? ""))
    .split(LINE_SEP)
    .join("\\u2028")
    .split(PARA_SEP)
    .join("\\u2029");
}

const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

/** jsStr, or the literal `null` when the value is null/undefined. */
export function jsStrOrNull(v: unknown): string {
  return v === null || v === undefined ? "null" : jsStr(v);
}

/**
 * A finite number literal. Accepts numbers and numeric strings (agents often
 * send "3"); anything else throws, so a malformed argument fails loudly in
 * Node instead of injecting code or NaN into the script.
 */
export function jsNum(v: unknown, name: string): string {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new Error(`Invalid number for '${name}': ${JSON.stringify(v)}`);
  }
  return String(n);
}

/** jsNum with a default used when the value is null/undefined. */
export function jsNumOr(v: unknown, def: number, name: string): string {
  return v === null || v === undefined ? jsNum(def, name) : jsNum(v, name);
}

/** A non-negative integer literal (indexes, ids, counts). */
export function jsInt(v: unknown, name: string): string {
  const s = jsNum(v, name);
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid non-negative integer for '${name}': ${JSON.stringify(v)}`);
  }
  return s;
}

/** `true`/`false` literal; null/undefined -> default; anything else throws. */
export function jsBool(v: unknown, def: boolean, name = "value"): string {
  if (v === null || v === undefined) return def ? "true" : "false";
  if (v === true || v === "true") return "true";
  if (v === false || v === "false") return "false";
  throw new Error(`Invalid boolean for '${name}': ${JSON.stringify(v)}`);
}

/** Array of strings as an ExtendScript array literal of jsStr literals. */
export function jsStrArray(v: unknown, name: string): string {
  if (!Array.isArray(v)) throw new Error(`'${name}' must be an array of strings`);
  return "[" + v.map((x) => jsStr(x)).join(",") + "]";
}

/** Validates that `v` is one of `allowed` (string enums); returns it. */
export function oneOf<T extends string>(v: unknown, allowed: readonly T[], def: T, name: string): T {
  if (v === null || v === undefined) return def;
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  throw new Error(`Invalid value for '${name}': ${JSON.stringify(v)}. Allowed: ${allowed.join(", ")}`);
}
