/**
 * Unit tests for the exact-identifier lookup used by hybrid retrieval.
 *
 * The SQL side cannot run without MySQL, so `likeMatches` below applies the
 * patterns with MySQL's LIKE rules (`%` any run, `_` any one character,
 * backslash escapes the next character). That checks the patterns themselves.
 *
 * Run with:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextCharBudget, escapeLike, extractCIdentifiers, packSections, parseVerdict, symbolLikePatterns, symbolsInclude } from '../src/app/libs/helpers.js';

/** MySQL LIKE semantics, default escape character `\`. */
function likeMatches(value: string, pattern: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) {
      re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (c === '%') {
      re += '[\\s\\S]*';
    } else if (c === '_') {
      re += '[\\s\\S]';
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`).test(value);
}

const anyPattern = (value: string, id: string) =>
  symbolLikePatterns(id).some((p) => likeMatches(value, p));

test('escapeLike escapes %, _ and backslash', () => {
  assert.equal(escapeLike('a_b%c\\d'), 'a\\_b\\%c\\\\d');
});

test('matches the symbol as the only, first, middle or last entry', () => {
  const id = 'ngx_http_script_copy_capture_code';
  assert.ok(anyPattern(id, id));
  assert.ok(anyPattern(`${id}, ngx_http_script_copy_capture_len_code`, id));
  assert.ok(anyPattern(`ngx_a, ${id}, ngx_b`, id));
  assert.ok(anyPattern(`ngx_http_script_copy_capture_len_code, ${id}`, id));
});

test('does not match longer names that contain the symbol', () => {
  const id = 'ngx_http_script_copy_capture_code';
  // the old `%id%` pattern matched all of these
  assert.ok(!anyPattern('ngx_http_script_copy_capture_code_v2', id));
  assert.ok(!anyPattern('my_ngx_http_script_copy_capture_code', id));
  assert.ok(!anyPattern('ngx_a, ngx_http_script_copy_capture_code_v2, ngx_b', id));
});

test('underscore is literal, not a one-character wildcard', () => {
  // with an unescaped pattern, `_` would match the `x` here
  assert.ok(!anyPattern('ngxhttp', 'ngx_http'));
  assert.ok(!anyPattern('ngx_http_script_regexXend_code', 'ngx_http_script_regex_end_code'));
});

test('symbolsInclude is an exact entry match', () => {
  assert.ok(symbolsInclude('ngx_a, ngx_b', 'ngx_b'));
  assert.ok(!symbolsInclude('ngx_a, ngx_bc', 'ngx_b'));
  assert.ok(!symbolsInclude(null, 'ngx_b'));
});

test('extractCIdentifiers keeps C names and ignores English words', () => {
  const ids = extractCIdentifiers('Does ngx_http_script_regex_end_code reset e->is_args before returning?');
  assert.deepEqual(ids, ['ngx_http_script_regex_end_code', 'is_args']);
});

test('parseVerdict reads the first verdict line, with or without markdown', () => {
  assert.equal(parseVerdict('VERDICT: NO\nBecause the length pass...'), 'NO');
  assert.equal(parseVerdict('**VERDICT:** yes\n...'), 'YES');
  assert.equal(parseVerdict('VERDICT: UNKNOWN'), 'UNKNOWN');
  assert.equal(parseVerdict('VERDICT: NO ... later VERDICT: YES'), 'NO');
  assert.equal(parseVerdict('The answer is no.'), 'NONE');
});

test('contextCharBudget leaves room for the prompt and the answer', () => {
  assert.equal(contextCharBudget(8192, 1500, 0), (8192 - 1500 - 1200) * 3);
  assert.equal(contextCharBudget(16384, 1500, 0), (16384 - 1500 - 1200) * 3);
  assert.equal(contextCharBudget(8192, 1500, 5000), 5000);
});

test('packSections keeps the best-ranked sections and drops the rest', () => {
  const s = ['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100)];
  const r = packSections(s, 205);
  assert.equal(r.kept, 2);
  assert.equal(r.dropped, 1);
  assert.ok(r.text.startsWith('a') && r.text.includes('b') && !r.text.includes('c'));
  assert.ok(r.chars <= 205);
  // the first section is kept even if it alone exceeds the budget
  assert.equal(packSections(['x'.repeat(500)], 100).kept, 1);
});
