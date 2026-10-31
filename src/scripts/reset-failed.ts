#!/usr/bin/env tsx
/**
 * Re-queue work that failed or produced a bad summary, so that the next
 * `npm run load-docs` redoes it.
 *
 *   npm run reset-failed                 # failed records + summaries over 4000 chars
 *   npm run reset-failed -- --long 3000  # different length threshold for bad summaries
 *
 * What it does:
 *  - A failed or over-long SUMMARY record is deleted (and its vector, if it was
 *    stored), and the code chunk it summarized is marked "summarize again".
 *  - Any other failed record has its unfinished operations reset to pending.
 *
 * Nothing is re-chunked and finished work is kept.
 */
import bootstrap from '#core/bootstrap.js';
import Services from '#app/libs/Services.js';
import Document from '#app/models/Document.js';

const i = process.argv.indexOf('--long');
const longLimit = i >= 0 ? Number(process.argv[i + 1]) : 4000;

await bootstrap();

const all: Document[] = await Document.findAll();
const badSummaries = all.filter((d) => d.metadata?.summaryOf
  && (d.status === Document.DOCUMENT_STATUS.ERROR || String(d.content ?? '').length > longLimit));
const otherFailed = all.filter((d) => !d.metadata?.summaryOf && d.status === Document.DOCUMENT_STATUS.ERROR);

let chunksRequeued = 0;
for (const summary of badSummaries) {
  const source = all.find((d) => d.sha256 === summary.metadata?.summaryOf);
  if (source) {
    source.operations = { ...(source.operations ?? {}), summarizeContent: 0 };
    source.status = Document.DOCUMENT_STATUS.TO_PROCESS;
    source.errorCount = 0;
    await source.save();
    chunksRequeued++;
  }
  if (summary.vectorStoreId) {
    try { await Services.vectorStore().deleteById(summary.vectorStoreId); } catch { /* not stored */ }
  }
  await summary.destroy();
}

for (const doc of otherFailed) {
  const ops = { ...(doc.operations ?? {}) };
  for (const key of Object.keys(ops)) {
    if (ops[key] !== Document.OPERATION_STATUS.SUCCESS) ops[key] = 0;
  }
  doc.operations = ops;
  doc.status = Document.DOCUMENT_STATUS.TO_PROCESS;
  doc.errorCount = 0;
  await doc.save();
}

console.log(`Bad summaries removed: ${badSummaries.length} (over ${longLimit} chars or failed)`);
console.log(`Code chunks queued to be summarized again: ${chunksRequeued}`);
console.log(`Other failed records reset: ${otherFailed.length}`);
console.log('Now run: npm run load-docs');
process.exit(0);
