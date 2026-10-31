export type StdClass = Record<PropertyKey, unknown>;

export interface OperationResult {
  success: boolean,
  message: string | null,
  name: string,
  error: unknown
}

export interface RunnerResult {
  success: boolean,
  message: string | null,
  results: OperationResult[]
}

export type VectorStoreEntry = {
  id: string,
  metadata: Record<string, string | number | boolean> | null,
  document: string | null
}

export type RagOptions = {
  refineUserPrompt: boolean,
  similaritySearchResults: number,
  model: null | string,
  /** Restrict retrieval to one indexed code base, e.g. "nginx-1.30.0". */
  codebase?: null | string,
  /** Also fetch chunks that define C identifiers named in the question (default true). */
  symbolLookup?: boolean,
}

export type RetrievedSource = {
  via: 'symbol' | 'vector',
  filename: string,
  codebase: string | null,
  fromLine: number | null,
  toLine: number | null,
  symbols: string | null,
  isSummary: boolean,
}