#!/usr/bin/env tsx
/**
 * Offline chunking benchmark: CCodeSplitter vs LangChain's C++ splitter.
 *
 * Needs no database, Ollama or Chroma. Usage:
 *
 *   npm run chunk-stats -- source-code/nginx-1.30.0/src [chunkSize]
 *
 * Reports, for each splitter:
 *   - number of chunks and the largest chunk
 *   - non-blank source lines not covered by any chunk
 *   - "function integrity": of the functions that fit in one chunk, how many
 *     are found complete (signature to closing brace) inside a single chunk
 *
 * Functions are detected independently of either splitter, using Nginx's
 * coding style: the function name starts in column 0 followed by '(', the
 * body opens with '{' in column 0 and closes with '}' in column 0.
 */
import fs from 'fs';
import path from 'path';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import CCodeSplitter from '../app/libs/splitters/CCodeSplitter.js';

const root = process.argv[2];
const chunkSize = Number(process.argv[3] || process.env.CHUNK_SIZE_C || 3000);
const chunkOverlap = Number(process.env.CHUNK_OVERLAP_C || 200);

if (!root || !fs.existsSync(root)) {
  console.error('Usage: npm run chunk-stats -- <folder with .c/.h files> [chunkSize]');
  process.exit(1);
}

function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(p, out);
    else if (/\.[ch]$/.test(entry.name)) out.push(p);
  }
  return out;
}

type Fn = { name: string; text: string };

function nginxStyleFunctions(lines: string[]): Fn[] {
  const fns: Fn[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([a-z_][a-z0-9_]*)\(/);
    if (!m) continue;
    let open = i;
    while (open < lines.length && lines[open] !== '{') {
      if (/;\s*$/.test(lines[open])) { open = -1; break; } // prototype
      open++;
    }
    if (open < 0 || open >= lines.length) continue;
    let close = open + 1;
    while (close < lines.length && lines[close] !== '}') close++;
    if (close >= lines.length) continue;
    // include the return-type line above the name
    fns.push({ name: m[1], text: lines.slice(Math.max(0, i - 1), close + 1).join('\n') });
  }
  return fns;
}

const files = listFiles(root);
const ours = new CCodeSplitter({ chunkSize, chunkOverlap });
const baseline = RecursiveCharacterTextSplitter.fromLanguage('cpp', { chunkSize, chunkOverlap });

const stats = {
  files: files.length,
  functions: 0,
  functionsThatFit: 0,
  ccode: { chunks: 0, maxChunk: 0, uncoveredLines: 0, wholeFunctions: 0 },
  langchainCpp: { chunks: 0, maxChunk: 0, wholeFunctions: 0 },
};

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');

  const a = await ours.splitSource(src);
  const b = await baseline.splitText(src);

  stats.ccode.chunks += a.length;
  stats.langchainCpp.chunks += b.length;
  for (const c of a) stats.ccode.maxChunk = Math.max(stats.ccode.maxChunk, c.text.length);
  for (const c of b) stats.langchainCpp.maxChunk = Math.max(stats.langchainCpp.maxChunk, c.length);

  const covered = new Set<number>();
  for (const c of a) for (let l = c.fromLine; l <= c.toLine; l++) covered.add(l);
  lines.forEach((line, i) => { if (line.trim() && !covered.has(i + 1)) stats.ccode.uncoveredLines++; });

  for (const fn of nginxStyleFunctions(lines)) {
    stats.functions++;
    if (fn.text.length > chunkSize) continue;
    stats.functionsThatFit++;
    if (a.some((c) => c.text.includes(fn.text))) stats.ccode.wholeFunctions++;
    if (b.some((c) => c.includes(fn.text))) stats.langchainCpp.wholeFunctions++;
  }
}

const pct = (n: number) => `${((100 * n) / Math.max(1, stats.functionsThatFit)).toFixed(1)}%`;

console.log(`Folder: ${root}   chunkSize=${chunkSize}   chunkOverlap=${chunkOverlap}\n`);
console.table({
  'CCodeSplitter': {
    chunks: stats.ccode.chunks,
    'largest chunk': stats.ccode.maxChunk,
    'whole functions': `${stats.ccode.wholeFunctions}/${stats.functionsThatFit} (${pct(stats.ccode.wholeFunctions)})`,
  },
  'LangChain cpp': {
    chunks: stats.langchainCpp.chunks,
    'largest chunk': stats.langchainCpp.maxChunk,
    'whole functions': `${stats.langchainCpp.wholeFunctions}/${stats.functionsThatFit} (${pct(stats.langchainCpp.wholeFunctions)})`,
  },
});
console.log(`Files: ${stats.files}. Functions found: ${stats.functions}, of which ${stats.functionsThatFit} fit in one chunk.`);
console.log(`Non-blank lines not covered by any CCodeSplitter chunk: ${stats.ccode.uncoveredLines}`);
