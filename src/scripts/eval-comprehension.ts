#!/usr/bin/env tsx
/**
 * Comprehension experiment: does giving the model the right source code stop
 * it making the mistakes an LLM made during the manual assessment of
 * CVE-2026-42945, on both the vulnerable and the patched code base?
 *
 * Every question in eval/comprehension.json is a yes/no claim with a ground
 * truth taken from the nginx source and from lab measurements. Each question
 * is asked in two modes:
 *
 *   closed  the model alone, no retrieved code (what it knows or guesses)
 *   rag     the full pipeline: symbol lookup + vector search on the question's
 *           code base (nginx-1.30.0 or nginx-1.30.1), then the auditor prompt
 *
 * The model must start with "VERDICT: YES|NO|UNKNOWN", so answers are scored
 * without a second "judge" model. For rag runs the script also records
 * whether retrieval returned the functions the answer depends on, so a wrong
 * answer can be blamed on retrieval or on reasoning.
 *
 *   npm run eval-comprehension                       # both modes, all questions
 *   npm run eval-comprehension -- --modes rag --k 8
 *   npm run eval-comprehension -- --runs 3           # repeat to see variance
 *   npm run eval-comprehension -- --only break-prevents,overflow-is-2n
 *
 * Needs: both code bases indexed (npm run load-docs), MySQL, Chroma, Ollama.
 * Set LLM_NUM_PREDICT to about 1500 so justifications are not cut short.
 * Output: a table, eval/comprehension-results/<timestamp>.json, and a
 * transcript of every answer (<timestamp>.md) for checking by hand.
 */
import fs from 'fs';
import path from 'path';
import { PromptTemplate } from '@langchain/core/prompts';
import bootstrap from '#core/bootstrap.js';
import Services from '#app/libs/Services.js';
import { RagOptions, RetrievedSource } from '#app/libs/types.js';
import { contextCharBudget, parseVerdict, stripThinking, Verdict } from '#app/libs/helpers.js';
import { PROMPT_CLOSED_BOOK, VERDICT_INSTRUCTION } from '#app/settings.js';

type Question = {
  id: string;
  query: string;
  answer: 'YES' | 'NO';
  codebase: string;
  expectedFunctions: string[];
  evidence: string;
  pair?: string;
  knownError?: boolean;
};

type Mode = 'closed' | 'rag';

type Run = {
  id: string;
  mode: Mode;
  run: number;
  verdict: Verdict;
  expected: 'YES' | 'NO';
  correct: boolean;
  retrievedExpected: string[] | null;   // rag only
  retrievalRecall: number | null;       // rag only
  contextSections: string | null;       // rag only: "kept/retrieved" sections that fit the window
  contextChars: number | null;          // rag only
  seconds: number;
  answer: string;
  sources: RetrievedSource[] | null;
};

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}

const k = Number(arg('k', '8'));
const runs = Math.max(1, Number(arg('runs', '1')));
const modes = String(arg('modes', 'closed,rag')).split(',').map((m) => m.trim()) as Mode[];
const only = arg('only')?.split(',').map((s) => s.trim()) ?? null;
const file = arg('questions', 'eval/comprehension.json') as string;

for (const m of modes) {
  if (m !== 'closed' && m !== 'rag') {
    console.error(`Unknown mode "${m}". Use closed, rag or closed,rag.`);
    process.exit(2);
  }
}

let { questions } = JSON.parse(fs.readFileSync(file, 'utf8')) as { questions: Question[] };
if (only) questions = questions.filter((q) => only.includes(q.id));
if (!questions.length) {
  console.error('No questions selected.');
  process.exit(2);
}

await bootstrap();
const agent = Services.aiAgent();
const model = Services.llmService().getDefaultLlm();
const closedChain = PromptTemplate.fromTemplate(PROMPT_CLOSED_BOOK).pipe(model);

function retrievedFunctions(sources: RetrievedSource[], expected: string[]): string[] {
  const found = new Set<string>();
  for (const s of sources) {
    const syms = String(s.symbols ?? '').split(/,\s*/);
    for (const e of expected) if (syms.includes(e)) found.add(e);
  }
  return [...found];
}

async function ask(q: Question, mode: Mode, run: number): Promise<Run> {
  const started = Date.now();
  const query = q.query + VERDICT_INSTRUCTION;
  let answer: string;
  let sources: RetrievedSource[] | null = null;
  let ctx: { kept: number; dropped: number; chars: number } | null = null;

  if (mode === 'closed') {
    answer = String(await closedChain.invoke({ userQuery: query }));
  } else {
    const options: RagOptions = {
      refineUserPrompt: false,
      similaritySearchResults: k,
      model: null,
      codebase: q.codebase,
      symbolLookup: true,
    };
    // Retrieve with the bare question: the verdict instruction would only add noise to the search.
    const retrieved = await agent.retrieve(q.query, q.query, options);
    sources = retrieved.sources;
    const block = await agent.buildContext(retrieved.searchResult);
    ctx = block;
    answer = await agent.getFinalAnswer(query, block.text, model);
  }

  answer = stripThinking(answer);
  const verdict = parseVerdict(answer);
  const found = sources ? retrievedFunctions(sources, q.expectedFunctions) : null;

  return {
    id: q.id,
    mode,
    run,
    verdict,
    expected: q.answer,
    correct: verdict === q.answer,
    retrievedExpected: found,
    retrievalRecall: found ? found.length / q.expectedFunctions.length : null,
    contextSections: ctx ? `${ctx.kept}/${ctx.kept + ctx.dropped}` : null,
    contextChars: ctx ? ctx.chars : null,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    answer,
    sources,
  };
}

const results: Run[] = [];
const total = questions.length * modes.length * runs;
for (let run = 1; run <= runs; run++) {
  for (const q of questions) {
    for (const mode of modes) {
      process.stdout.write(`[${results.length + 1}/${total}] ${mode.padEnd(6)} ${q.id} ... `);
      const r = await ask(q, mode, run);
      results.push(r);
      console.log(`${r.verdict} (expected ${r.expected}) ${r.correct ? 'correct' : 'WRONG'}  ${r.seconds}s`);
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const byId = new Map(questions.map((q) => [q.id, q]));
const pct = (a: number, b: number) => (b ? `${a}/${b} (${Math.round((100 * a) / b)}%)` : '-');

type Summary = Record<string, string>;
const summary: Record<string, Summary> = {};

for (const mode of modes) {
  const rs = results.filter((r) => r.mode === mode);
  const known = rs.filter((r) => byId.get(r.id)?.knownError);
  const answered = rs.filter((r) => r.verdict === 'YES' || r.verdict === 'NO');

  // A pair counts only if both versions are right in the same run.
  const pairIds = [...new Set(questions.map((q) => q.pair).filter(Boolean))] as string[];
  let pairsTotal = 0;
  let pairsRight = 0;
  for (let run = 1; run <= runs; run++) {
    for (const p of pairIds) {
      const members = rs.filter((r) => r.run === run && byId.get(r.id)?.pair === p);
      if (members.length < 2) continue;
      pairsTotal++;
      if (members.every((r) => r.correct)) pairsRight++;
    }
  }

  const s: Summary = {
    accuracy: pct(rs.filter((r) => r.correct).length, rs.length),
    'corrections-log questions': pct(known.filter((r) => r.correct).length, known.length),
    'vulnerable/patched pairs': pct(pairsRight, pairsTotal),
    'gave a verdict': pct(answered.length, rs.length),
  };

  if (mode === 'rag') {
    const fullRetrieval = rs.filter((r) => r.retrievalRecall === 1);
    s['retrieval complete'] = pct(fullRetrieval.length, rs.length);
    s['correct when retrieval complete'] = pct(fullRetrieval.filter((r) => r.correct).length, fullRetrieval.length);
  }
  summary[mode] = s;
}

console.log(`\nComprehension experiment: ${questions.length} questions, modes=${modes.join(',')}, runs=${runs}, k=${k}, model=${process.env.LLM_MODEL}, LLM_NUM_CTX=${process.env.LLM_NUM_CTX}, context limit=${contextCharBudget()} chars\n`);
console.table(questions.map((q) => {
  const row: Record<string, string> = { id: q.id, expected: q.answer };
  for (const mode of modes) {
    const rs = results.filter((r) => r.id === q.id && r.mode === mode);
    row[mode] = rs.map((r) => (r.correct ? r.verdict : `${r.verdict}✗`)).join(' ');
    if (mode === 'rag') {
      row['rag retrieval'] = rs.map((r) => `${r.retrievedExpected?.length ?? 0}/${q.expectedFunctions.length}`).join(' ');
    }
  }
  return row;
}));
console.table(summary);

// ---------------------------------------------------------------------------
// Save results and a transcript for checking by hand
// ---------------------------------------------------------------------------

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.resolve('eval/comprehension-results');
fs.mkdirSync(outDir, { recursive: true });

const settings = {
  k, runs, modes,
  contextMaxChars: contextCharBudget(),
  numCtx: process.env.LLM_NUM_CTX,
  llmModel: process.env.LLM_MODEL,
  embeddingModel: process.env.LLM_EMBEDDING_MODEL,
  numPredict: process.env.LLM_NUM_PREDICT,
  temperature: process.env.LLM_TEMPERATURE,
  collection: process.env.VECTOR_DB_COLLECTION_NAME,
};
fs.writeFileSync(path.join(outDir, `${stamp}.json`), JSON.stringify({ settings, summary, results }, null, 2));

const md = [
  `# Comprehension run ${new Date().toISOString()}`,
  '',
  `Model \`${settings.llmModel}\` · k ${k} · runs ${runs} · modes ${modes.join(', ')}`,
  '',
  '## Summary',
  '',
  '| | ' + modes.join(' | ') + ' |',
  '|---|' + modes.map(() => '---').join('|') + '|',
  ...Object.keys(summary[modes.at(-1) as Mode]).map((key) =>
    `| ${key} | ${modes.map((m) => summary[m][key] ?? '-').join(' | ')} |`),
  '',
  '## Answers',
  '',
  'Check each one by hand: a correct verdict with wrong reasoning is still wrong.',
  '',
  ...results.map((r) => {
    const q = byId.get(r.id) as Question;
    return [
      `### ${r.id} · ${r.mode} · run ${r.run} · ${r.correct ? 'correct' : 'WRONG'}`,
      '',
      `**Question (${q.codebase}):** ${q.query}`,
      '',
      `**Expected:** ${q.answer} — ${q.evidence}`,
      '',
      r.mode === 'rag'
        ? `**Retrieved expected functions:** ${r.retrievedExpected?.join(', ') || 'none'} (of ${q.expectedFunctions.join(', ')}) · **context:** ${r.contextSections} sections, ${r.contextChars} chars\n`
        : '',
      '**Answer:**',
      '',
      r.answer.split('\n').map((l) => `> ${l}`).join('\n'),
      '',
    ].join('\n');
  }),
].join('\n');
fs.writeFileSync(path.join(outDir, `${stamp}.md`), md);

console.log(`\nSaved: eval/comprehension-results/${stamp}.json and .md`);
process.exit(0);
