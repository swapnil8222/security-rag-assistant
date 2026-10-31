#!/usr/bin/env tsx
/**
 * Retrieval evaluation: does the pipeline fetch the right functions?
 *
 * Runs every question in eval/questions.json through the retrieval step
 * (no final LLM answer, so it is fast and deterministic apart from the
 * optional query rewriting) and reports hit rate and recall.
 *
 *   npm run eval                                 # all indexed code
 *   npm run eval -- --codebase nginx-1.30.0      # one code base only
 *   npm run eval -- --k 8 --refine               # top-8, with LLM query rewriting
 *
 * Each question is run twice: vector search only, and vector search plus
 * the exact symbol lookup (hybrid). Results are printed as a table and saved
 * to eval/results/<timestamp>.json so runs can be compared.
 *
 * Needs the same services as `npm run load-docs` (MySQL, Chroma, Ollama) and
 * an index that has already been built.
 */
import fs from 'fs';
import path from 'path';
import bootstrap from '#core/bootstrap.js';
import Services from '#app/libs/Services.js';
import { RagOptions, RetrievedSource } from '#app/libs/types.js';

type Question = { id: string; query: string; expected: string[] };

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}

const k = Number(arg('k', '6'));
const codebase = arg('codebase');
const refine = arg('refine') === 'true';
const file = arg('questions', 'eval/questions.json') as string;

const { questions } = JSON.parse(fs.readFileSync(file, 'utf8')) as { questions: Question[] };

await bootstrap();
const agent = Services.aiAgent();

function score(sources: RetrievedSource[], expected: string[]) {
  const found = new Set<string>();
  for (const s of sources) {
    const syms = String(s.symbols ?? '').split(/,\s*/);
    for (const e of expected) if (syms.includes(e)) found.add(e);
  }
  return { hit: found.size > 0, recall: found.size / expected.length, found: [...found] };
}

const modes: { name: string; symbolLookup: boolean }[] = [
  { name: 'vector', symbolLookup: false },
  { name: 'hybrid', symbolLookup: true },
];

const rows: Record<string, unknown>[] = [];
const totals: Record<string, { hits: number; recall: number }> = {};

for (const q of questions) {
  const row: Record<string, unknown> = { id: q.id };

  for (const mode of modes) {
    const options: RagOptions = {
      refineUserPrompt: refine,
      similaritySearchResults: k,
      model: null,
      codebase,
      symbolLookup: mode.symbolLookup,
    };
    const searchQuery = await agent.refineUserQuery(q.query, options);
    const { sources } = await agent.retrieve(q.query, searchQuery, options);
    const s = score(sources, q.expected);

    totals[mode.name] ??= { hits: 0, recall: 0 };
    totals[mode.name].hits += s.hit ? 1 : 0;
    totals[mode.name].recall += s.recall;

    row[`${mode.name} hit`] = s.hit ? 'yes' : 'no';
    row[`${mode.name} recall`] = s.recall.toFixed(2);
    row[`${mode.name}:detail`] = { searchQuery, found: s.found, sources };
  }
  rows.push(row);
}

console.log(`\nRetrieval evaluation: k=${k}, codebase=${codebase ?? 'all'}, refine=${refine}\n`);
console.table(rows.map((r) => Object.fromEntries(Object.entries(r).filter(([key]) => !key.includes(':detail')))));
for (const mode of modes) {
  const t = totals[mode.name];
  console.log(`${mode.name.padEnd(7)} hit rate ${t.hits}/${questions.length} (${((100 * t.hits) / questions.length).toFixed(0)}%), mean recall ${(t.recall / questions.length).toFixed(2)}`);
}

const outDir = path.resolve('eval/results');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(outFile, JSON.stringify({
  settings: {
    k, codebase, refine,
    llmModel: process.env.LLM_MODEL,
    refineModel: process.env.LLM_MODEL_REFINE_QUERY,
    embeddingModel: process.env.LLM_EMBEDDING_MODEL,
    collection: process.env.VECTOR_DB_COLLECTION_NAME,
    chunkSizeC: process.env.CHUNK_SIZE_C,
  },
  totals,
  rows,
}, null, 2));
console.log(`\nSaved: ${outFile}`);
process.exit(0);
