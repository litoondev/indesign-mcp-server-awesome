/**
 * JSON polyfill for ExtendScript (JSON is undefined in the DoScript context).
 *
 * Written with String.raw so the ExtendScript source reads exactly as below —
 * no doubled TypeScript escapes. Do not use backticks or "${" inside it.
 *
 * stringify:
 *  - strings: escapes ", \, every control character U+0000-U+001F (InDesign
 *    text contains U+0003, U+0007, U+0016, U+0018, U+0019 markers), DEL and
 *    U+2028/U+2029, so Node's JSON.parse always accepts the output.
 *  - numbers: NaN/Infinity -> null (as native JSON does).
 * parse: uses [].constructor.constructor (Function) instead of eval() so the
 * sanitizer conventions of the repo are respected.
 */
export const JSON_POLYFILL = String.raw`
if (typeof JSON === 'undefined') {
  JSON = {};
}

if (typeof JSON.stringify !== 'function') {
  JSON.__mcpQuote = function (s) {
    return '"' + String(s).replace(/[\x00-\x1f\x7f\u2028\u2029"\\]/g, function (c) {
      if (c === '"') return '\\"';
      if (c === '\\') return '\\\\';
      if (c === '\n') return '\\n';
      if (c === '\r') return '\\r';
      if (c === '\t') return '\\t';
      var h = c.charCodeAt(0).toString(16);
      while (h.length < 4) h = '0' + h;
      return '\\u' + h;
    }) + '"';
  };
  JSON.stringify = function (obj) {
    var type = typeof obj;
    if (obj === null) return 'null';
    if (type === 'undefined') return undefined;
    if (type === 'function') return undefined;
    if (type === 'string') return JSON.__mcpQuote(obj);
    if (type === 'number') return isFinite(obj) ? String(obj) : 'null';
    if (type === 'boolean') return String(obj);
    if (obj instanceof String) return JSON.__mcpQuote(obj.valueOf());
    if (obj instanceof Number) return isFinite(obj.valueOf()) ? String(obj.valueOf()) : 'null';
    if (obj instanceof Boolean) return String(obj.valueOf());

    if (obj instanceof Array) {
      var arr = [];
      for (var i = 0; i < obj.length; i++) {
        var v = JSON.stringify(obj[i]);
        arr.push(typeof v === 'undefined' ? 'null' : v);
      }
      return '[' + arr.join(',') + ']';
    }

    var keys = [];
    for (var key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        var val = JSON.stringify(obj[key]);
        if (typeof val !== 'undefined') {
          keys.push(JSON.__mcpQuote(key) + ':' + val);
        }
      }
    }
    return '{' + keys.join(',') + '}';
  };
}

if (typeof JSON.parse !== 'function') {
  JSON.parse = function (text) {
    var fn = [].constructor.constructor;
    return fn('return (' + text + ')')();
  };
}
`;
