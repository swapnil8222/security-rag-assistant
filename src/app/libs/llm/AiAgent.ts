import { PromptTemplate } from "@langchain/core/prompts";
import { PROMPT_FOR_SUMMARIZING_CODE, PROMPT_FOR_SUMMARIZING_TEXT, PROMPT_FOR_REFINING_PROMPT, PROMPT_USER_QUERY_AND_DATA_CONTEXT } from "#app/settings.js";
import { RagOptions, RetrievedSource, StdClass } from "../types.js";
import { extractCIdentifiers, stripThinking } from "../helpers.js";
import { Op } from "sequelize";
import Services from "../Services.js";
import LlmServiceInterface from "./LlmServiceInterface.js";
import { BaseLLM } from "@langchain/core/language_models/llms";
import { DocumentInterface } from "@langchain/core/documents";
import Document from "#app/models/Document.js";


export default class AiAgent {
  private llmService: LlmServiceInterface;

  constructor(llmService: LlmServiceInterface) {
    this.llmService = llmService;
  }

  async summarizeText(inputText: string, contextInfo: string = ''): Promise<string> {
    return await this.summarize(PROMPT_FOR_SUMMARIZING_TEXT, inputText, contextInfo);
  }

  async describeCode(inputText: string, contextInfo: string = ''): Promise<string> {
    return await this.summarize(PROMPT_FOR_SUMMARIZING_CODE, inputText, contextInfo);
  }

  async summarize(template: string, inputText: string, contextInfo: string = ''): Promise<string> {
    const prompt = new PromptTemplate({
      inputVariables: ['contextInfo', 'inputText'],
      template,
    });

    const chain = prompt.pipe(this.llmService.getDefaultLlm());

    if (contextInfo.trim().length) {
      contextInfo = `Context Information:\n${contextInfo}`;
    }

    return await chain.invoke({
      contextInfo,
      inputText
    });
  }

  async refinePrompt(userQuestion: string, model: BaseLLM): Promise<string> {

    const promptTemplate = PromptTemplate.fromTemplate(
      PROMPT_FOR_REFINING_PROMPT
    );

    const chain = promptTemplate.pipe(model);

    return await chain.invoke({ userQuestion });
  }

  async rag(userQuery: string, options: RagOptions) {
    // 1) refine user prompt
    const refinedUserQuery = await this.refineUserQuery(userQuery, options);

    // 2) hybrid retrieval: exact symbol lookup + vector similarity search
    const { searchResult, sources } = await this.retrieve(userQuery, refinedUserQuery, options);

    // 3) foreach result retrieve the related piece (code <-> summary)
    const contextData = await this.getChunksForFinalQuestionAsText(searchResult);

    // 4) combine the user query and the data from the vector store in a prompt and send it to the LLM
    const model = Services.llmService().getDefaultLlm();
    const finalAnswer = stripThinking(await this.getFinalAnswer(userQuery, contextData, model));

    return {
      userQuery,
      refinedUserQuery,
      codebase: options.codebase ?? null,
      sources,
      searchResult,
      contextData,
      finalAnswer
    }
  }

  /**
   * Retrieval step of the RAG pipeline, without the final LLM call. Used by
   * rag() and by the retrieval evaluation script.
   *
   * Embeddings are good at meaning ("where is the URI escaped?") but weak at
   * exact identifiers: a question naming `ngx_http_script_copy_capture_code`
   * may not retrieve that function. So C identifiers in the question are
   * also looked up directly in the chunk metadata (the `symbols` field that
   * CCodeSplitter writes), and those chunks are put first.
   */
  async retrieve(userQuery: string, searchQuery: string, options: RagOptions): Promise<{
    searchResult: DocumentInterface<Record<string, any>>[],
    sources: RetrievedSource[],
  }> {
    const filter = options.codebase ? { codebase: options.codebase } : undefined;

    const symbolHits = options.symbolLookup === false
      ? []
      : await this.findChunksDefiningSymbols(extractCIdentifiers(userQuery), options.codebase ?? null);

    const vectorStore = Services.vectorStore().getClient();
    const vectorHits = await vectorStore.similaritySearch(searchQuery, options.similaritySearchResults, filter);

    const seen = new Set<string>();
    const searchResult: DocumentInterface<Record<string, any>>[] = [];
    const sources: RetrievedSource[] = [];

    for (const [via, hits] of [['symbol', symbolHits], ['vector', vectorHits]] as const) {
      for (const hit of hits) {
        const sha = hit.metadata?.sha256 as string;
        if (!sha || seen.has(sha)) continue;
        seen.add(sha);
        searchResult.push(hit);
        sources.push({
          via,
          filename: String(hit.metadata.filename ?? ''),
          codebase: hit.metadata.codebase ?? null,
          fromLine: hit.metadata.fromLine ?? null,
          toLine: hit.metadata.toLine ?? null,
          symbols: hit.metadata.symbols ?? null,
          isSummary: Boolean(hit.metadata.summaryOf),
        });
      }
    }

    return { searchResult, sources };
  }

  /**
   * Finds code chunks whose `symbols` metadata contains one of the given
   * identifiers (exact match on the comma-separated list). At most
   * `perSymbol` chunks per identifier, in file order, so a long function
   * split into several chunks contributes its first parts.
   */
  async findChunksDefiningSymbols(
    identifiers: string[],
    codebase: string | null,
    perSymbol: number = 2,
    maxTotal: number = 6
  ): Promise<DocumentInterface<Record<string, any>>[]> {
    const results: DocumentInterface<Record<string, any>>[] = [];

    for (const id of identifiers) {
      if (results.length >= maxTotal) break;

      // Match the symbol in the JSON `symbols` field. The code-chunk vs summary
      // distinction (summaryOf is null) is done in JS below, not in SQL: an
      // `IS NULL` check on a json_extract expression generates invalid SQL.
      const where: StdClass = {
        'metadata.symbols': { [Op.like]: `%${id}%` },
      };
      if (codebase) {
        where['metadata.codebase'] = codebase;
      }

      const rows: Document[] = await Document.findAll({ where: where as any, limit: 50 });

      const exact = rows
        .filter((row: Document) => !row.metadata?.summaryOf
          && String(row.metadata?.symbols ?? '').split(/,\s*/).includes(id))
        .sort((a: Document, b: Document) =>
          String(a.filename).localeCompare(String(b.filename))
          || Number(a.metadata?.fromLine ?? 0) - Number(b.metadata?.fromLine ?? 0))
        .slice(0, perSymbol);

      for (const row of exact) {
        results.push({
          pageContent: row.content ?? '',
          metadata: { ...(row.metadata ?? {}), sha256: row.sha256, filename: row.filename },
        } as DocumentInterface<Record<string, any>>);
      }
    }

    return results.slice(0, maxTotal);
  }

  async getFinalAnswer(userQuery: string, contextData: string, model: BaseLLM): Promise<string> {

    const promptTemplate = PromptTemplate.fromTemplate(
      PROMPT_USER_QUERY_AND_DATA_CONTEXT
    );

    const chain = promptTemplate.pipe(model);

    return await chain.invoke({ userQuery, contextData });
  }

  /**
   * Builds the "Context" block of the RAG prompt. Each retrieved chunk is
   * paired with its summary and prefixed with a header (file, line range,
   * functions) so the auditor LLM can cite exact locations.
   */
  async getChunksForFinalQuestionAsText(
    searchResult: DocumentInterface<Record<string, any>>[]
  ): Promise<string> {
    const processed: string[] = [];
    const sections: string[] = [];

    for (let i = 0; i < searchResult.length; i++) {
      const meta = searchResult[i].metadata;
      const sha256 = meta.sha256;
      const summaryOf = meta.summaryOf ?? null;

      if (processed.includes(sha256) || (summaryOf && processed.includes(summaryOf))) {
        continue;
      }

      let summary = '';
      let code = '';
      let codeMeta: Record<string, any> = meta;

      if (summaryOf) {
        // the hit is a summary: fetch the code chunk it describes
        summary = searchResult[i].pageContent;
        const doc = await this.getDocumentBySha(summaryOf);
        if (doc) {
          code = doc.content ?? '';
          codeMeta = { ...(doc.metadata as Record<string, any> ?? {}), filename: doc.filename };
          processed.push(doc.sha256);
        }
      } else {
        // the hit is a code chunk: fetch its summary
        code = searchResult[i].pageContent;
        const doc = await this.getDocumentBySummaryOf(sha256);
        if (doc) {
          summary = doc.content ?? '';
          processed.push(doc.sha256);
        }
      }

      processed.push(sha256);

      sections.push([
        this.formatChunkHeader(sections.length + 1, codeMeta),
        summary ? `Summary: ${summary.trim()}` : '',
        code ? '```' + (codeMeta.language ?? 'c') + '\n' + code.trim() + '\n```' : '',
      ].filter(Boolean).join('\n'));
    }

    return sections.join('\n\n');
  }

  private formatChunkHeader(index: number, meta: Record<string, any>): string {
    // filename is relative to source-code/, so it already starts with the code base folder
    const filename = String(meta.filename ?? 'unknown file').replace(/^.*[\\/]source-code[\\/]/, '');
    const lines = meta.fromLine && meta.toLine ? ` (lines ${meta.fromLine}-${meta.toLine})` : '';
    const symbols = meta.symbols ? ` | ${meta.symbols}` : '';
    return `### [${index}] ${filename}${lines}${symbols}`;
  }

  /**
   * @TODO: currently is taking the document from the SQL DB, it should come from the vector store instead
   *
   * @param   {string<Document>}   sha256
   * @return  {Promise<Document | null>}
   */
  async getDocumentBySha(sha256: string): Promise<Document | null> {
    return await Document.findOne({
      where: {
        sha256
      }
    });
  }

  /**
   * @TODO: currently is taking the document from the SQL DB, it should come from the vector store instead
   *
   * @param   {string<Document>}   sha256
   * @return  {Promise<Document | null>}
   */
  async getDocumentBySummaryOf(summaryOfSha256: string): Promise<Document | null> {
    return await Document.findOne({
      where: {
        'metadata.summaryOf': summaryOfSha256
      }
    });
  }

  async refineUserQuery(userQuestion: string, options: RagOptions): Promise<string> {
    let refinedQuestion = userQuestion;

    if (options.refineUserPrompt) {
      const modelStr = options.model || Services.env('LLM_MODEL_REFINE_QUERY');

      if (typeof modelStr !== 'string') {
        throw new Error('The model given to RAG function is not valid.');
      }

      refinedQuestion = await this.refinePrompt(userQuestion, this.llmService.getLlm(modelStr));
      // strip the reasoning block that "thinking" models (e.g. qwen3) emit, and wrapping quotes
      refinedQuestion = stripThinking(refinedQuestion).replace(/^["']|["']$/g, '').trim() || userQuestion;
    }

    return refinedQuestion;
  }

}