// Static check (no InDesign): ExtendScript mis-evaluates unparenthesised chained
// ternaries (a ? x : b ? y : z), see round-4 F2. This scans the ExtendScript code
// inside jsx`...` template strings of src/**/*.ts and fails on any chained
// ternary whose inner ternary is not wrapped in parentheses.
//
//   node tests/harness/lint_ternary.mjs [files...]
//
// Exit code 1 when a violation is found.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(n)) out.push(p);
  }
  return out;
}

// Extract jsx`...` blocks: [{ start line, text }]. ${...} interpolations are blanked.
function jsxBlocks(src) {
  const out = [];
  let i = 0;
  while ((i = src.indexOf('jsx`', i)) >= 0) {
    let j = i + 4, depth = 0, text = '';
    for (; j < src.length; j++) {
      const c = src[j];
      if (depth === 0 && c === '\\') { text += c + src[j + 1]; j++; continue; }
      if (depth === 0 && c === '`') break;
      if (c === '$' && src[j + 1] === '{' && depth === 0) { depth = 1; text += '0'; j++; continue; }
      if (depth > 0) { if (c === '{') depth++; else if (c === '}') depth--; if (c === '\n') text += '\n'; continue; }
      text += c;
    }
    out.push({ line: src.slice(0, i).split('\n').length, text });
    i = j + 1;
  }
  return out;
}

// Blank string literals, regex literals and comments (keeps newlines and length roughly).
function strip(code) {
  let o = '', i = 0, prevSig = '';
  while (i < code.length) {
    const c = code[i], n = code[i + 1];
    if (c === '/' && n === '/') { while (i < code.length && code[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) { if (code[i] === '\n') o += '\n'; i++; } i += 2; continue; }
    if (c === '"' || c === "'") {
      i++; while (i < code.length && code[i] !== c && code[i] !== '\n') { if (code[i] === '\\') i++; i++; }
      i++; o += '""'; prevSig = '"'; continue;
    }
    if (c === '/' && /[=(,:;!&|?{}\[\n]|^$|return$/.test(prevSig)) {
      i++; let cls = false;
      while (i < code.length && code[i] !== '\n') { if (code[i] === '\\') { i += 2; continue; } if (code[i] === '[') cls = true; else if (code[i] === ']') cls = false; else if (code[i] === '/' && !cls) break; i++; }
      i++; while (/[a-z]/i.test(code[i] || '')) i++;
      o += '0'; prevSig = '0'; continue;
    }
    o += c;
    if (!/\s/.test(c)) prevSig = /[A-Za-z_$0-9]/.test(c) ? (/return$/.test((o.match(/[A-Za-z_$]+$/) || [''])[0]) ? 'return' : 'w') : c;
    i++;
  }
  return o;
}

function check(code) {
  const bad = [];
  // stack of frames per bracket depth: { q: open ternaries count, inElse: bool }
  const stack = [{ q: 0, inElse: false }];
  let line = 1;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '\n') { line++; continue; }
    const top = stack[stack.length - 1];
    if (c === '(' || c === '[' || c === '{') { stack.push({ q: 0, inElse: false }); continue; }
    if (c === ')' || c === ']' || c === '}') { if (stack.length > 1) stack.pop(); continue; }
    if (c === ';' || c === ',') { top.q = 0; top.inElse = false; continue; }
    if (c === '?') {
      if (code[i + 1] === '?' || code[i + 1] === '.') { i++; continue; }
      if (top.inElse) bad.push(line);
      top.q++;
      continue;
    }
    if (c === ':' && top.q > 0) { top.q--; top.inElse = true; continue; }
  }
  return bad;
}

const files = process.argv.length > 2 ? process.argv.slice(2) : walk(join(ROOT, 'src'));
let total = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const b of jsxBlocks(src)) {
    const lines = check(strip(b.text));
    for (const l of [...new Set(lines)]) {
      const abs = b.line + l - 1;
      total++;
      console.log(`${relative(ROOT, f)}:${abs}: unparenthesised chained ternary in ExtendScript: ${src.split('\n')[abs - 1].trim().slice(0, 160)}`);
    }
  }
}
if (total) { console.log(`\n${total} violation(s). Wrap the inner ternary in parentheses: a ? x : (b ? y : z)`); process.exit(1); }
console.log('lint_ternary: no unparenthesised chained ternaries in jsx`...` ExtendScript blocks');
