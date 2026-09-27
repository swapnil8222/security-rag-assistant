import Document from "#app/models/Document.js";
import { RecursiveCharacterTextSplitter, SupportedTextSplitterLanguage } from "@langchain/textsplitters";
import { OperationResult, StdClass } from "../types.js";
import { EXT_TO_LANG } from "#app/settings.js";
import AbstractOperation from "./AbstractOperation.js";
import { calculateSHA256 } from "../helpers.js";
import DocumentRepo from "#app/repositories/DocumentRepo.js";
import CCodeSplitter from "../splitters/CCodeSplitter.js";

/** Extensions routed to the structure-aware C/C++ splitter. */
export const C_FAMILY_EXTENSIONS = ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx'];

export default class ChunkContentOperation extends AbstractOperation {
  public static readonly operationName: string  = 'chunkContent';

  async performOperation(record: Document, extra: StdClass = {}): Promise<OperationResult> {
    try {
      return await this.performChunking(record, extra);
    } catch (error) {
      console.error('Error occurred on chunking operation', error);
      return this.errorResponse('Error occurred on chunking operation', error);
    }
  }

  async performChunking(record: Document, extra: StdClass = {}): Promise<OperationResult> {
    const ext = record.metadata?.fileExtension ? (record.metadata?.fileExtension as string).toLowerCase() : 'txt';
    const isCFamily = C_FAMILY_EXTENSIONS.includes(ext);

    // C functions (especially in Nginx) are long; a bigger default keeps a whole
    // function - allocation, length computation and copy - in a single chunk.
    // Override with CHUNK_SIZE_C / CHUNK_OVERLAP_C in .env (values in characters).
    const chunkSize = extra.chunkSize as number
      || (isCFamily ? Number(process.env.CHUNK_SIZE_C) || 3000 : 2000);
    const chunkOverlap = extra.chunkOverlap as number
      || (isCFamily ? Number(process.env.CHUNK_OVERLAP_C) || 200 : 200);

    const lang = isCFamily ? (ext === 'c' || ext === 'h' ? 'c' : 'cpp') : this.getLanguageFromExt(ext);

    const recSplitter = isCFamily
      ? new CCodeSplitter({ chunkSize, chunkOverlap })
      : this.getSplitter(lang as SupportedTextSplitterLanguage | null, chunkSize, chunkOverlap);

    const splits = await recSplitter.createDocuments([record.content as string], [{
      language: lang,
      fileExtensions: ext
    }]);

    if (splits.length === 1) {
      return this.successResponse('Total split is 1. Skipping it.');
    }

    let splitCounter = 0;
    for (const split of splits) {
      splitCounter++;

      if (!record.filename) {
        continue;
      }

      const sha256 = calculateSHA256(split.pageContent);

      // if the filename/sha256 already exists with a status success, then continue
      if (await DocumentRepo.documentExists(record.filename, sha256)) {
        continue;
      }

      const splitMeta = split.metadata;

      if (splitMeta?.loc?.lines?.from && splitMeta?.loc?.lines?.to) {
        splitMeta.fromLine = splitMeta.loc.lines.from;
        splitMeta.toLine = splitMeta.loc.lines.to;
        delete splitMeta?.loc;
      }

      // store the split
      await DocumentRepo.create({
        sha256,
        filename: record.filename,
        content: split.pageContent,
        parentSha256: record.sha256,
        metadata: {
          ...splitMeta,
          splitNum: splitCounter + 1,
          splitTotal: splits.length
        },
        operations: {
          summarizeContent: 0,
          storeInVectorDb: 0
        }
      });
    }

    return this.successResponse('Chunks created');
  }

  getSplitter(lang: SupportedTextSplitterLanguage | null, chunkSize: number = 2000, chunkOverlap: number = 200) {
    if (lang) {
      return RecursiveCharacterTextSplitter.fromLanguage(lang, {
        chunkSize: chunkSize,
        chunkOverlap: chunkOverlap
      });
    }

    return new RecursiveCharacterTextSplitter({
      chunkSize: chunkSize,
      chunkOverlap: chunkOverlap
    });    
  }

  getLanguageFromExt(ext: string): SupportedTextSplitterLanguage | null {
    if (EXT_TO_LANG[ext]) {
      return EXT_TO_LANG[ext] as SupportedTextSplitterLanguage;
    }
    
    return null;
  }
}