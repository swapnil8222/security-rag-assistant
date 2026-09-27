#!/usr/bin/env tsx

import bootstrap from '#core/bootstrap.js';
import MasterOperation from '#app/libs/operations/MasterOperation.js';
import OperationRunner from '#app/libs/operations/OperationRunner.js';
import DocumentRepo from '#app/repositories/DocumentRepo.js';
import Document from '#app/models/Document.js';

await bootstrap();
console.log("Core bootstrap completed.");


console.log('---------------------------------------------------------');
console.log('|               STARTING MASTER OPERATION               |');
console.log('---------------------------------------------------------');
// Default: C/C++ sources and headers (e.g. the Nginx tree). Override with SCAN_EXTENSIONS=c,h,md
const extensions = (process.env.SCAN_EXTENSIONS || 'c,h')
  .split(',')
  .map((ext) => ext.trim().replace(/^\./, ''))
  .filter(Boolean);
console.log('Scanning ./source-code for extensions:', extensions.join(', '));

const loader = new MasterOperation(['./source-code'], extensions);
const chunks = await loader.loadDbMasterData(['chunkContent', 'summarizeContent', 'storeInVectorDb']);
const chunkIds = chunks.map((doc) => doc.id);

console.log(`MASTER OPERATION DONE. Chunks created: ${chunks.length}`, chunkIds);
console.log('---------------------------------------------------------');


console.log('---------------------------------------------------------');
console.log('|                   RUNNING OPERATIONS                   |');
console.log('---------------------------------------------------------');

await runOperations();

console.log('OPERATIONS PROCESS COMPLETED');
console.log('---------------------------------------------------------');



console.log('---------------------------------------------------------');
console.log('|               RUNNING FAILED OPERATIONS               |');
console.log('---------------------------------------------------------');

await runOperations(true);

console.log('RUNNING FAILED OPERATIONS COMPLETED');
console.log('---------------------------------------------------------');



async function runOperations(includeFailed: boolean = false) {
  const runner = new OperationRunner();

  while(true) {
    let doc = await DocumentRepo.getRandomToProcess(includeFailed);
    if (!doc) {
      break;
    }
  
    const opResult = await runner.run(doc);
    console.log('Operation done', opResult);
  }
}