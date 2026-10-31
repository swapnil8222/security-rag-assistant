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