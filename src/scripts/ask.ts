#!/usr/bin/env tsx
/**
 * Ask the auditor one question from the command line and save the full run
 * (question, rewritten query, retrieved sources, context and answer) so it
 * can be quoted or reproduced later.
 *
 *   npm run ask -- "Is every write into the rewrite result buffer bounds-checked?"
 *   npm run ask -- --codebase nginx-1.30.0 --k 8 --refine "..."
 *
 * Output: printed to the terminal and saved to eval/transcripts/<timestamp>.md
 */
import fs from 'fs';
import path from 'path';
import bootstrap from '#core/bootstrap.js';
import Services from '#app/libs/Services.js';
import { RagOptions } from '#app/libs/types.js';

const argv = process.argv.slice(2);
const flags: Record<string, string> = {};
const words: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const next = argv[i + 1];
    if (next && !next.startsWith('--') && argv[i] !== '--refine' && argv[i] !== '--no-symbols') {
      flags[argv[i].slice(2)] = next;
      i++;
    } else {
      flags[argv[i].slice(2)] = 'true';
    }
  } else {
    words.push(argv[i]);
  }
}

const query = words.join(' ').trim();
if (!query) {
  console.error('Usage: npm run ask -- [--codebase NAME] [--k N] [--refine] [--no-symbols] "question"');
  process.exit(1);
}

await bootstrap();

const options: RagOptions = {
  refineUserPrompt: flags.refine === 'true',
  similaritySearchResults: Number(flags.k ?? 6),
  model: null,
  codebase: flags.codebase ?? null,
  symbolLookup: flags['no-symbols'] !== 'true',
};

const started = Date.now();
const result = await Services.aiAgent().rag(query, options);
const seconds = ((Date.now() - started) / 1000).toFixed(1);

const sourcesTable = result.sources
  .map((s, i) => `| ${i + 1} | ${s.via} | ${s.filename.replace(/^.*[\\/]source-code[\\/]/, '')} | ${s.fromLine ?? ''}-${s.toLine ?? ''} | ${s.isSummary ? 'summary' : 'code'} | ${s.symbols ?? ''} |`)
  .join('\n');

const md = `# RAG run ${new Date().toISOString()}

- **Question:** ${query}
- **Rewritten query:** ${result.refinedUserQuery}
- **Code base:** ${options.codebase ?? 'all'}  ·  **k:** ${options.similaritySearchResults}  ·  **symbol lookup:** ${options.symbolLookup}
- **Model:** ${process.env.LLM_MODEL}  ·  **Embeddings:** ${process.env.LLM_EMBEDDING_MODEL}  ·  **Time:** ${seconds}s

## Retrieved

| # | via | file | lines | kind | symbols |
|---|---|---|---|---|---|
${sourcesTable}

## Answer

${result.finalAnswer}

<details><summary>Context sent to the model</summary>

${result.contextData}

</details>
`;

console.log(md);

const outDir = path.resolve('eval/transcripts');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
fs.writeFileSync(outFile, md);
console.log(`Saved: ${outFile}`);
process.exit(0);
