/**
 * Unit tests for the C/C++ structure-aware splitter.
 *
 * Run with:  npm test
 * (uses Node's built-in test runner through tsx; no database, Ollama or
 * Chroma needed)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import CCodeSplitter from '../src/app/libs/splitters/CCodeSplitter.js';

/** Nginx style: return type on its own line, '{' and '}' in column 0. */
function nginxFunction(name: string, bodyLines: number, extra = ''): string {
  const body = Array.from({ length: bodyLines }, (_, i) => `    x += ${i};`).join('\n');
  return `static ngx_int_t\n${name}(ngx_http_request_t *r)\n{\n    ngx_int_t  x = 0;\n${extra}${body}\n\n    return x;\n}\n`;
}

test('keeps an nginx-style function whole and reports its name and lines', async () => {
  const src = nginxFunction('ngx_http_foo', 5);
  const chunks = await new CCodeSplitter({ chunkSize: 2000, chunkOverlap: 100 }).splitSource(src);

  assert.equal(chunks.length, 1);
  assert.match(chunks[0].symbols.join(','), /ngx_http_foo/);
  assert.equal(chunks[0].fromLine, 1);
  assert.ok(chunks[0].text.includes('return x;\n}'));
});

test('never splits a function that fits in one chunk', async () => {
  const src = [
    nginxFunction('ngx_a', 20),
    nginxFunction('ngx_b', 20),
    nginxFunction('ngx_c', 20),
  ].join('\n\n');
  // each function is ~300 chars, so at most two fit in a 700-char chunk
  const chunks = await new CCodeSplitter({ chunkSize: 700, chunkOverlap: 50 }).splitSource(src);

  for (const name of ['ngx_a', 'ngx_b', 'ngx_c']) {
    const holders = chunks.filter((c) => c.text.includes(`${name}(ngx_http_request_t *r)`));
    assert.equal(holders.length, 1, `${name} should live in exactly one chunk`);
    assert.ok(holders[0].text.includes(`${name}(ngx_http_request_t *r)\n{`));
  }
  assert.ok(chunks.every((c) => c.text.length <= 700));
});

test('ignores braces inside strings, char literals and comments', async () => {
  const tricky = '    char *s = "}}}{";\n    char c = \'}\';\n    /* } */\n    // }\n';
  const src = nginxFunction('ngx_tricky', 2, tricky) + '\n' + nginxFunction('ngx_after', 2);
  const chunks = await new CCodeSplitter({ chunkSize: 250, chunkOverlap: 20 }).splitSource(src);

  const first = chunks.find((c) => c.symbols.includes('ngx_tricky'));
  assert.ok(first, 'ngx_tricky chunk exists');
  assert.ok(first!.text.includes('return x;\n}'), 'ngx_tricky was not cut at a brace inside a string');
});

test('keeps a *_len_code / *_code pair together', async () => {
  const src = [
    'size_t\nngx_http_script_copy_capture_len_code(ngx_http_script_engine_t *e)\n{\n    return len;\n}\n',
    'void\nngx_http_script_copy_capture_code(ngx_http_script_engine_t *e)\n{\n    e->pos = ngx_copy(e->pos, p, len);\n}\n',
    nginxFunction('ngx_unrelated', 10),
  ].join('\n\n');
  // the pair is ~230 chars; a 300-char chunk fits the pair but not the pair + ngx_unrelated
  const chunks = await new CCodeSplitter({ chunkSize: 300, chunkOverlap: 20 }).splitSource(src);

  const pair = chunks.find((c) => c.symbols.includes('ngx_http_script_copy_capture_len_code'));
  assert.ok(pair);
  assert.ok(pair!.symbols.includes('ngx_http_script_copy_capture_code'), 'length and copy functions share a chunk');
});

test('splits an oversize function, prefixes the signature and keeps correct line numbers', async () => {
  const src = nginxFunction('ngx_huge', 300);
  const lines = src.split('\n');
  const chunks = await new CCodeSplitter({ chunkSize: 1000, chunkOverlap: 100 }).splitSource(src);

  assert.ok(chunks.length > 1);
  for (const [i, c] of chunks.entries()) {
    assert.ok(c.text.length <= 1000, `chunk ${i} is ${c.text.length} chars`);
    if (i > 0) assert.match(c.text, /^\/\* \[continued\] static ngx_int_t ngx_huge\(ngx_http_request_t \*r\) \*\//);
    const body = c.text.replace(/^\/\* \[continued\][^\n]*\n/, '');
    const firstLine = body.split('\n')[0];
    assert.equal(lines[c.fromLine - 1], firstLine, `chunk ${i} starts at its reported line`);
  }
});

test('covers every non-blank line, even with #if branches that unbalance braces', async () => {
  const src = `
#include <ngx_config.h>

typedef struct {
    ngx_str_t   name;
    ngx_uint_t  len;
} ngx_foo_t;

static ngx_int_t
ngx_bar(ngx_foo_t *f)
{
#if (NGX_HAVE_X)
    if (f->len) {
#else
    if (f->len > 1) {
#endif
        return 1;
    }

    return 0;
}

static void ngx_baz(void);
`;
  const chunks = await new CCodeSplitter({ chunkSize: 120, chunkOverlap: 20 }).splitSource(src);
  const lines = src.split('\n');
  const covered = new Set<number>();
  for (const c of chunks) for (let l = c.fromLine; l <= c.toLine; l++) covered.add(l);

  lines.forEach((line, i) => {
    if (line.trim()) assert.ok(covered.has(i + 1), `line ${i + 1} is covered: ${line}`);
  });
  const all = chunks.flatMap((c) => c.symbols);
  assert.ok(all.includes('ngx_foo_t'));
  assert.ok(all.includes('ngx_bar'));
});
