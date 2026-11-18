import { createHash } from 'crypto';
import { EXT_TO_LANG } from '../settings.js';

/**
 * Calculates the SHA-256 hash of a string asynchronously.
 *
 * @param {string} inputString The string to hash.
 * @returns {string} A promise that resolves with the SHA-256 hash as a hexadecimal string.
 */
export function calculateSHA256(inputString: string): string {
  const hash = createHash('sha256');
  hash.update(inputString);
  return hash.digest('hex');
}

/**
 * Removes the <think>...</think> block that reasoning models (e.g. qwen3,
 * deepseek-r1) prepend to their output.
 */
export function stripThinking(text: string): string {
  return String(text ?? '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
}

/**
 * Name of the code base a file belongs to: the first folder under the scanned
 * root. With `source-code/nginx-1.30.0/src/http/x.c` this is `nginx-1.30.0`.
 * It lets several versions of the same project live in one index and be
 * queried separately (vulnerable vs. patched).
 */
export function codebaseFromPath(scanRoot: string, filePath: string): string {
  const rel = filePath.slice(scanRoot.length).replace(/^[\\/]+/, '');
  const parts = rel.split(/[\\/]/);
  return parts.length > 1 ? parts[0] : 'default';
}

/**
 * Pulls C-style identifiers out of a question (e.g. `ngx_http_script_copy_capture_code`,
 * `rb->buf` gives nothing, `is_args` is kept). Only names with an underscore
 * are kept, so ordinary English words are ignored.
 */
export function extractCIdentifiers(text: string): string[] {
  const ids = String(text).match(/\b[A-Za-z_][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g) ?? [];
  return [...new Set(ids)].filter((id) => id.length >= 5);
}

/** Escapes the SQL LIKE wildcards (`%`, `_`) and the escape character itself. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * LIKE patterns that match `id` as a whole entry of a comma-separated
 * `symbols` list ("a, b, c"): the only entry, the first, the last, or one in
 * the middle. A plain `%id%` would also match longer names that contain `id`
 * (e.g. `ngx_http_script_code` inside `ngx_http_script_code_foo`), and `_`
 * would act as a one-character wildcard.
 */
export function symbolLikePatterns(id: string): string[] {
  const e = escapeLike(id);
  return [e, `${e},%`, `%, ${e}`, `%, ${e},%`];
}

/** True if `id` is one of the entries in a comma-separated symbols list. */
export function symbolsInclude(symbols: unknown, id: string): boolean {
  return String(symbols ?? '').split(/,\s*/).includes(id);
}

export function extToLang(ext: string): string | null {
  return EXT_TO_LANG[ext.replace(/^\./, '').toLowerCase()] ?? null;
}

export function isACodingLanguage(lang: string): boolean {
  return [
    'html',
    'c',
    'cpp',
    'go',
    'java',
    'javascript',
    'php',
    'proto',
    'python',
    'rst',
    'ruby',
    'rust',
    'scala',
    'swift',
    'latex',
    'sol'
  ].includes(lang);
}

export function errorWithCause(message: string, error: any): Error {
  return new Error(message, {
    cause: {
      message: error.message,
      stack: error.stack,
      ...(error.cause && { cause: String(error.cause) }),
    }
  });
}

export type Verdict = 'YES' | 'NO' | 'UNKNOWN' | 'NONE';

/**
 * Reads the "VERDICT: YES|NO|UNKNOWN" line the comprehension prompts ask for.
 * Takes the first one (the prompt asks for it on the first line), tolerating
 * markdown such as **VERDICT:** NO. Returns NONE when the model gave none.
 */
export function parseVerdict(answer: string): Verdict {
  const m = String(answer ?? '').match(/VERDICT\W{0,4}\s*(YES|NO|UNKNOWN)\b/i);
  return m ? (m[1].toUpperCase() as Verdict) : 'NONE';
}

/**
 * Characters of retrieved context that fit in the model's window. The window
 * (LLM_NUM_CTX tokens) must also hold the auditor prompt and question
 * (about 1,200 tokens) and the answer (LLM_NUM_PREDICT tokens). C code
 * tokenizes densely, so 3 characters per token is used as a safe estimate.
 * CONTEXT_MAX_CHARS overrides the computed value.
 */
export function contextCharBudget(
  numCtx: number = Number(process.env.LLM_NUM_CTX) || 8192,
  numPredict: number = Number(process.env.LLM_NUM_PREDICT) || 512,
  override: number = Number(process.env.CONTEXT_MAX_CHARS) || 0
): number {
  if (override > 0) return override;
  const promptTokens = 1200;
  const charsPerToken = 3;
  return Math.max(2000, (numCtx - numPredict - promptTokens) * charsPerToken);
}

export type ContextBlock = { text: string; kept: number; dropped: number; chars: number };

/**
 * Keeps sections, in the order given (best-ranked first), while the joined
 * text stays within maxChars. The first section is always kept so the best
 * hit is never lost.
 */
export function packSections(sections: string[], maxChars: number, separator: string = '\n\n'): ContextBlock {
  const kept: string[] = [];
  let chars = 0;
  for (const s of sections) {
    const add = s.length + (kept.length ? separator.length : 0);
    if (kept.length && chars + add > maxChars) break;
    kept.push(s);
    chars += add;
  }
  return { text: kept.join(separator), kept: kept.length, dropped: sections.length - kept.length, chars };
}
