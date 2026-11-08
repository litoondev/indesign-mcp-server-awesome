#!/usr/bin/env node
// Offline unit checks (no InDesign) for round-4 fixes in dist/tools/safeContent.js:
//   r4-B3  GREP multi-colon guard: per-paragraph colon count (\r split); only GREPs whose ':' comes
//          AFTER a greedy '.+'/'.*' (e.g. '.+(?<=:)') are "bold up to the LAST colon"; '(?=:).+' is not.
// Usage: node tests/harness/unit_r4.mjs   (run `npm run build` first)
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const mod = await import(pathToFileURL(path.join(ROOT, 'dist', 'tools', 'safeContent.js')).href);
const src = String(mod.REPLACE_PARAGRAPHS_JSX);

// Evaluate the ExtendScript helper definitions in plain JS. __sc_paraColonRules is redefined after the
// source (a later function declaration wins) so the rules come from the test instead of InDesign objects.
const make = new Function('RULES', `
  function __tp_str(v) { if (typeof v === 'string') return v; try { return String(v); } catch (e) { return ''; } }
  function __tp_count(s, ch) { var n = 0; for (var i = 0; i < s.length; i++) if (s.charAt(i) === ch) n++; return n; }
  function __tp_stylePath(s) { return String(s && s.name || s); }
  ${src}
  function __sc_paraColonRules() { return RULES.current; }
  return { greedy: __sc_greedyColonRule, span: __sc_colonRuleSpan, guard: __sc_grepGuard };
`);
const RULES = { current: [] };
const H = make(RULES);

const results = [];
const rec = (name, ok, info) => { results.push({ name, ok: !!ok, info }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + JSON.stringify(info)}`); };
const g = (ex) => ({ kind: 'grep', grepExpression: ex, characterStyle: 'Bold', characterFontStyle: '75 Bold' });

rec("'.+(?<=:)' is greedy-to-last-colon", !!H.greedy([g('.+(?<=:)')]), {});
rec("'^.*:' is greedy-to-last-colon", !!H.greedy([g('^.*:')]), {});
rec("'(?=:).+' is NOT greedy-to-last-colon (starts at the first colon)", H.greedy([g('(?=:).+')]) === null, {});
rec("'^.+?:' (lazy) is NOT greedy-to-last-colon", H.greedy([g('^.+?:')]) === null, {});
rec("'[^:]+:' is NOT greedy-to-last-colon", H.greedy([g('[^:]+:')]) === null, {});
rec("span of '(?=:).+' says 'from the first \":\" on'", /from the first ":" on/.test(H.span(g('(?=:).+'))), H.span(g('(?=:).+')));
rec("span of '.+(?<=:)' says 'LAST \":\"'", /LAST ":"/.test(H.span(g('.+(?<=:)'))), H.span(g('.+(?<=:)')));

// Guard: template paragraph already has one ':' (so only the multi-colon rule can fire).
const tpl = 'Service: description';
RULES.current = [g('.+(?<=:)')];
let r = H.guard({}, null, 'Contact info', tpl, 'A: one\rB: two\rC: three\rD: four', false, {});
rec('greedy GREP: 4 paragraphs joined with \\r, one ":" each -> no refusal (per-paragraph count)', r === null, r);
r = H.guard({}, null, 'Contact info', tpl, 'Hotline: 10:00-17:00', false, {});
rec('greedy GREP: one paragraph with 3 ":" -> refusal with multiColon (value part named)', !!(r && r.extra && r.extra.multiColon && r.extra.multiColon.colonCount === 3 && /10:00/.test(r.extra.multiColon.valuePartBold) && /LAST ":"/.test(r.err)), r);
r = H.guard({}, null, 'Contact info', tpl, 'A: one\rHotline: 10:00', false, {});
rec('greedy GREP: \\r-split edit, paragraph 1 has 2 ":" -> refusal names paragraph 1 of the edit', !!(r && r.extra.multiColon && r.extra.multiColon.paragraphOfEdit === 1 && r.extra.multiColon.colonCount === 2 && /paragraph 1 of the edit/.test(r.err)), r);
RULES.current = [g('(?=:).+')];
r = H.guard({}, null, 'Service Name Numbered W', tpl, 'BNSK: Legal aid: free', false, {});
rec("'(?=:).+' GREP: 2 \":\" in one paragraph -> no multi-colon refusal", r === null, r);
r = H.guard({}, null, 'Service Name Numbered W', 'Service description', 'BNSK: Legal aid', false, {});
rec("'(?=:).+' GREP, template without ':' -> refusal that describes the span as 'from the first \":\" on' (not LAST)", !!(r && /from the first ":" on/.test(r.err) && !/LAST/.test(r.err)), r);
const holder = {};
RULES.current = [g('.+(?<=:)')];
r = H.guard({}, null, 'Contact info', tpl, 'Hotline: 10:00-17:00', true, holder);
rec('acceptGrepEffects -> null + warning + holder.grepMultiColon', r === null && /acceptGrepEffects:true/.test(holder.grepWarning || '') && !!holder.grepMultiColon, holder);

const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
