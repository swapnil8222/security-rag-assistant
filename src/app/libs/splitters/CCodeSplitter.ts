import { Document } from "@langchain/core/documents";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

/**
 * A structure-aware splitter for C / C++ source files (.c, .h, .cpp, .hpp).
 *
 * LangChain's generic `RecursiveCharacterTextSplitter.fromLanguage('cpp')` splits
 * on keywords such as "\nvoid " or "\nint ". That works poorly on real-world C
 * code bases like Nginx, where the return type sits on its own line:
 *
 *     static ngx_int_t
 *     ngx_http_read_client_request_body(ngx_http_request_t *r, ...)
 *     {
 *
 * so functions get cut in half, and a function's signature ends up in a
 * different chunk from the bounds check that matters.
 *
 * This splitter instead:
 *   1. Lexes the file (aware of comments, string/char literals and preprocessor
 *      lines) and tracks brace depth to find *top-level declaration boundaries*:
 *      the end of a function body, a struct/union/enum/typedef, a prototype, a
 *      global variable, or a preprocessor directive.
 *   2. Treats each top-level declaration (plus the comment block directly above
 *      it) as an atomic unit and greedily packs whole units into chunks of at
 *      most `chunkSize` characters. Functions and structs are never split when
 *      they fit.
 *   3. Only when a single unit is larger than `chunkSize` (very long functions)
 *      does it fall back to a C-aware recursive split that prefers statement
 *      boundaries, and each sub-chunk is prefixed with the enclosing function's
 *      signature so the LLM always knows which function it is looking at.
 *
 * Output documents carry `metadata.loc.lines.{from,to}` (same shape as
 * LangChain's splitters) plus `symbols` (comma-separated function/type names).
 */

export interface CCodeSplitterOptions {
  chunkSize?: number;
  chunkOverlap?: number;
}

interface CodeUnit {
  text: string;
  fromLine: number; // 1-based, inclusive
  toLine: number;   // 1-based, inclusive
  symbols: string[];
  signature: string | null;
}

/** Separators used only for oversize units (e.g. a 600-line function). */
const C_FALLBACK_SEPARATORS = [
  "\n\n",                 // blank lines between logical blocks
  "\n    /* ",            // block comments at function-body level (Nginx: 4-space indent)
  "\n    if (",
  "\n    for (",
  "\n    while (",
  "\n    switch (",
  "\n    case ",
  "\n    return ",
  "\n        if (",
  "\n        for (",
  "\n        while (",
  ";\n",                  // end of any statement
  "\n",
  " ",
  "",
];

const NON_FUNCTION_KEYWORDS = new Set([
  "if", "for", "while", "switch", "return", "sizeof", "defined", "do", "else",
]);

export default class CCodeSplitter {
  private readonly chunkSize: number;
  private readonly chunkOverlap: number;

  constructor(options: CCodeSplitterOptions = {}) {
    this.chunkSize = options.chunkSize ?? 3000;
    this.chunkOverlap = options.chunkOverlap ?? 200;

    if (this.chunkOverlap >= this.chunkSize) {
      throw new Error("CCodeSplitter: chunkOverlap must be smaller than chunkSize");
    }
  }

  /** Same call signature as LangChain's TextSplitter.createDocuments(). */
  async createDocuments(
    texts: string[],
    metadatas: Record<string, unknown>[] = []
  ): Promise<Document[]> {
    const docs: Document[] = [];

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      const baseMeta = metadatas[i] ?? {};
      for (const chunk of await this.splitSource(text)) {
        docs.push(new Document({
          pageContent: chunk.text,
          metadata: {
            ...baseMeta,
            symbols: chunk.symbols.join(", "),
            loc: { lines: { from: chunk.fromLine, to: chunk.toLine } },
          },
        }));
      }
    }

    return docs;
  }

  /** Splits one source file into chunks (exposed for testing). */
  async splitSource(source: string): Promise<CodeUnit[]> {
    const normalized = source.replace(/\r\n?/g, "\n");
    const units = this.extractTopLevelUnits(normalized);
    return await this.packUnits(units);
  }

  // ---------------------------------------------------------------------------
  // Step 1: find top-level boundaries
  // ---------------------------------------------------------------------------

  private extractTopLevelUnits(src: string): CodeUnit[] {
    const lines = src.split("\n");
    const boundaryAfterLine = new Set<number>(); // 0-based line indexes

    let depth = 0;
    let inBlockComment = false;
    let lastSignificant = "";

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const trimmed = line.trimStart();

      // Preprocessor directive (outside block comments). Braces inside it are ignored.
      if (!inBlockComment && trimmed.startsWith("#")) {
        let end = li;
        while (end < lines.length - 1 && lines[end].trimEnd().endsWith("\\")) {
          end++;
        }
        if (depth === 0) {
          boundaryAfterLine.add(end);
          lastSignificant = "";
        }
        li = end;
        continue;
      }

      // Nginx / K&R style: a '}' in column 0 always closes a top-level body.
      // This resyncs the depth counter when #if/#else branches unbalance braces.
      if (!inBlockComment && depth > 0 && line.startsWith("}")) {
        depth = 1;
      }

      let inString: '"' | "'" | null = null;

      for (let ci = 0; ci < line.length; ci++) {
        const ch = line[ci];
        const next = line[ci + 1];

        if (inBlockComment) {
          if (ch === "*" && next === "/") { inBlockComment = false; ci++; }
          continue;
        }
        if (inString) {
          if (ch === "\\") { ci++; continue; }
          if (ch === inString) inString = null;
          continue;
        }
        if (ch === "/" && next === "*") { inBlockComment = true; ci++; continue; }
        if (ch === "/" && next === "/") break; // line comment
        if (ch === '"' || ch === "'") { inString = ch; lastSignificant = ch; continue; }

        if (ch === "{") depth++;
        else if (ch === "}") depth = Math.max(0, depth - 1);

        if (!/\s/.test(ch)) lastSignificant = ch;
      }

      // A top-level declaration ends on a line whose last significant token is
      // '}' (function body / struct closing on its own) or ';' (prototype,
      // global, "} name_t;").
      if (depth === 0 && !inBlockComment && (lastSignificant === "}" || lastSignificant === ";")) {
        boundaryAfterLine.add(li);
        lastSignificant = "";
      }
    }

    // Materialize units from boundary lines.
    const units: CodeUnit[] = [];
    let start = 0;
    const sortedBoundaries = [...boundaryAfterLine].sort((a, b) => a - b);
    sortedBoundaries.push(lines.length - 1);

    for (const b of sortedBoundaries) {
      if (b < start) continue;
      const text = lines.slice(start, b + 1).join("\n");
      if (text.trim().length) {
        units.push(this.describeUnit(text, start + 1, b + 1));
      } else if (units.length) {
        // blank lines: attach to the previous unit so line numbers stay contiguous
        const prev = units[units.length - 1];
        prev.text += "\n" + text;
        prev.toLine = b + 1;
      }
      start = b + 1;
    }

    return units;
  }

  /** Extracts symbol names and the signature (text before the first body '{'). */
  private describeUnit(text: string, fromLine: number, toLine: number): CodeUnit {
    const code = this.stripComments(text);
    const symbols: string[] = [];
    let signature: string | null = null;

    const braceIdx = code.indexOf("{");
    const head = braceIdx >= 0 ? code.slice(0, braceIdx) : code;

    // struct / union / enum tag names
    for (const m of head.matchAll(/\b(struct|union|enum)\s+([A-Za-z_]\w*)/g)) {
      symbols.push(`${m[1]} ${m[2]}`);
    }

    // typedef names:  "} ngx_foo_t;"  or  "typedef x y_t;"
    const typedefTail = code.match(/}\s*([A-Za-z_]\w*)\s*;\s*$/);
    if (/\btypedef\b/.test(code) && typedefTail) {
      symbols.push(typedefTail[1]);
    } else if (/^\s*typedef\b/m.test(code) && braceIdx < 0) {
      const simple = code.match(/([A-Za-z_]\w*)\s*(\)\s*\(.*\))?\s*;\s*$/s);
      if (simple) symbols.push(simple[1]);
    }

    // function definition: identifier directly before '(' in the head, followed by a body
    if (braceIdx >= 0 && !/\b(struct|union|enum|typedef)\b/.test(head)) {
      const fn = [...head.matchAll(/([A-Za-z_]\w*)\s*\(/g)]
        .map(m => m[1])
        .find(name => !NON_FUNCTION_KEYWORDS.has(name));
      if (fn) {
        symbols.push(fn);
        signature = head.trim().replace(/\s+/g, " ");
      }
    }

    // #define NAME
    for (const m of code.matchAll(/^\s*#\s*define\s+([A-Za-z_]\w*)/gm)) {
      symbols.push(m[1]);
    }

    return { text, fromLine, toLine, symbols: [...new Set(symbols)], signature };
  }

  private stripComments(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");
  }

  // ---------------------------------------------------------------------------
  // Step 2: pack whole units into chunks
  // ---------------------------------------------------------------------------

  /**
   * Nginx (and many C code bases) build strings in two passes: a "length" pass
   * that computes how much memory to allocate, then a "copy" pass that writes
   * into it (e.g. ngx_http_script_copy_capture_len_code / _copy_capture_code).
   * A mismatch between the two is a classic heap overflow, so a pair like that
   * is merged into one atomic unit whenever it fits in a single chunk.
   */
  private mergeLengthCopyPairs(units: CodeUnit[]): CodeUnit[] {
    const out: CodeUnit[] = [];

    for (let i = 0; i < units.length; i++) {
      const a = units[i];
      const b = units[i + 1];
      const lenFn = a.symbols.find(s => /_len(_\w+)?$/.test(s));

      if (b && lenFn) {
        const copyFn = lenFn.replace(/_len(_\w+)?$/, "$1");
        if (b.symbols.includes(copyFn) && a.text.length + 1 + b.text.length <= this.chunkSize) {
          out.push({
            text: a.text + "\n" + b.text,
            fromLine: a.fromLine,
            toLine: b.toLine,
            symbols: [...a.symbols, ...b.symbols],
            signature: a.signature,
          });
          i++;
          continue;
        }
      }
      out.push(a);
    }

    return out;
  }

  private async packUnits(allUnits: CodeUnit[]): Promise<CodeUnit[]> {
    const units = this.mergeLengthCopyPairs(allUnits);
    const chunks: CodeUnit[] = [];
    let current: CodeUnit | null = null;

    const flush = () => {
      if (current && current.text.trim().length) chunks.push(current);
      current = null;
    };

    for (const unit of units) {
      if (unit.text.length > this.chunkSize) {
        flush();
        chunks.push(...await this.splitOversizeUnit(unit));
        continue;
      }

      if (current && (current as CodeUnit).text.length + 1 + unit.text.length > this.chunkSize) {
        flush();
      }

      if (!current) {
        current = { ...unit, symbols: [...unit.symbols] };
      } else {
        const c = current as CodeUnit;
        c.text += "\n" + unit.text;
        c.toLine = unit.toLine;
        c.symbols.push(...unit.symbols);
      }
    }
    flush();

    for (const c of chunks) c.symbols = [...new Set(c.symbols)];
    return chunks;
  }

  // ---------------------------------------------------------------------------
  // Step 3: oversize units (e.g. very long functions)
  // ---------------------------------------------------------------------------

  private async splitOversizeUnit(unit: CodeUnit): Promise<CodeUnit[]> {
    const header = unit.signature
      ? `/* [continued] ${unit.signature} */\n`
      : "";

    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: Math.max(200, this.chunkSize - header.length),
      chunkOverlap: this.chunkOverlap,
      separators: C_FALLBACK_SEPARATORS,
      keepSeparator: true,
    });

    const parts = await splitter.splitText(unit.text);

    const result: CodeUnit[] = [];
    let searchFrom = 0;

    parts.forEach((part, idx) => {
      // Locate the part in the unit to compute accurate line numbers.
      let pos = unit.text.indexOf(part, searchFrom);
      if (pos < 0) pos = unit.text.indexOf(part);
      if (pos < 0) pos = searchFrom;
      searchFrom = pos + 1;

      const linesBefore = unit.text.slice(0, pos).split("\n").length - 1;
      const partLines = part.split("\n").length;

      result.push({
        text: idx === 0 ? part : header + part,
        fromLine: unit.fromLine + linesBefore,
        toLine: unit.fromLine + linesBefore + partLines - 1,
        symbols: [...unit.symbols],
        signature: unit.signature,
      });
    });

    return result;
  }
}
