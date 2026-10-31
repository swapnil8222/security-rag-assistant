import Document from "#app/models/Document.js";
import { OperationResult, StdClass } from "../types.js";
import AbstractOperation from "./AbstractOperation.js";
import Services from "../Services.js";

export default class StoreInVectorDbOperation extends AbstractOperation {
  public static readonly operationName: string  = 'storeInVectorDb';

  async performOperation(record: Document, extra: StdClass = {}): Promise<OperationResult> {
    if (record.metadata?.isSplit) {
      return this.successResponse('Skipped: file was split into chunks; the chunks are embedded instead.');
    }

    // Chroma only accepts string / number / boolean metadata values.
    const metadata: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(record.metadata ?? {})) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        metadata[key] = value;
      }
    }

    metadata.sha256 = record.sha256;
    if (record.filename) metadata.filename = record.filename;
    if (record.parentSha256) metadata.parentSha256 = record.parentSha256;

    await Services.vectorStore().getClient().delete({
      filter: { sha256: record.sha256 }
    });

    try {
      // The embedding model has a fixed context window: text longer than it
      // is rejected outright. Embed at most EMBED_MAX_CHARS characters; the
      // full text stays in the database and is what the RAG prompt uses.
      const maxChars = Number(process.env.EMBED_MAX_CHARS) || 4000;
      const content = String(record.content ?? '');
      const id = await Services.vectorStore().addDocument({
        pageContent: content.length > maxChars ? content.slice(0, maxChars) : content,
        metadata
      });

      if (id) {
        record.vectorStoreId = id;
        await record.save();
      }

      return this.successResponse('Data store in vector DB: ' + id);  
    } catch (error) {
      console.error('Failed to add document in vector store', error, {
        record, metadata
      });

      throw error;
    }
  }
}