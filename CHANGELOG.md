# Changelog

All changes made in this fork, compared with the upstream project
[danielefavi/ai-codebase-assistant](https://github.com/danielefavi/ai-codebase-assistant).
The changes adapt a general-purpose codebase assistant to auditing C code (Nginx) for
memory-safety bugs, with CVE-2026-42945 as the case study, as part of M.Tech project research.

Newest first.

---

## Round 2: review, fixes, evaluation (2026-10-08)

### Fixed: pipeline bugs (inherited from upstream)

| Problem | Effect | Fix | File |
|---|---|---|---|
| A file split into chunks was **also** summarized and embedded as a whole file | A whole C file overflows the LLM context window; a whole-file hit dumped an entire file into the RAG prompt | The file record is marked `isSplit: true`; summarize and embed skip it, so only its chunks are processed | `ChunkContentOperation.ts`, `SummarizeContentOperation.ts`, `StoreInVectorDbOperation.ts` |
| Document hash covered only the content, while the `sha256` column is unique | Identical files or chunks in two places (e.g. two Nginx versions) failed to index | File and chunk hashes now include the file path | `MasterOperation.ts`, `ChunkContentOperation.ts` |
| A file that fit in one chunk got no line or symbol metadata | Its answers could not cite lines or function names | The single chunk's `fromLine`, `toLine`, `symbols` are copied onto the file record | `ChunkContentOperation.ts` |
| `splitNum` was off by one | Wrong chunk numbering | Fixed | `ChunkContentOperation.ts` |
| Non-scalar or empty metadata was sent to Chroma | Chroma rejects such values | Only string / number / boolean values are stored | `StoreInVectorDbOperation.ts` |
| `record.save()` was not awaited after embedding | Vector-store id could be lost | Awaited | `StoreInVectorDbOperation.ts` |
| `errorWithCause()` ignored its message argument | Misleading error text | Uses the given message | `helpers.ts` |
| `<think>` blocks from reasoning models stayed in text summaries and final answers | Noise in the index and answers | Stripped everywhere through one `stripThinking()` helper | `helpers.ts`, `AiAgent.ts`, `SummarizeContentOperation.ts` |

### Changed: chunker

- Long functions (bigger than `CHUNK_SIZE_C`) are now split **between whole lines**, preferring blank lines, then closing braces, then statement ends. Previously LangChain's character splitter was used here; it could start a chunk with the `;` of the previous statement. Every chunk's text now matches its reported line range exactly.
- `CCodeSplitter` no longer depends on LangChain. (`CCodeSplitter.ts`)

### Added: features

- **Code base labels.** The first folder under `source-code/` (e.g. `nginx-1.30.0`) is stored as `codebase` on every record. The RAG API takes an optional `codebase` filter, so the vulnerable and patched releases can be compared in one index. (`MasterOperation.ts`, `AiAgent.ts`, `AgentController.ts`, `types.ts`)
- **Hybrid retrieval.** C identifiers in a question (e.g. `ngx_http_script_copy_capture_code`) are looked up exactly in chunk metadata and placed before the vector-search results. Can be turned off with `symbolLookup: false`. (`AiAgent.ts`, `helpers.ts`)
- **`sources` in the RAG response**: file, lines, functions and whether each hit came from the name lookup or the vector search. (`AiAgent.ts`)

### Added: tests, evaluation, scripts

- `npm test`: 6 unit tests for `CCodeSplitter` (`test/CCodeSplitter.test.ts`).
- `npm run chunk-stats`: offline benchmark of `CCodeSplitter` vs LangChain's C++ splitter (`src/scripts/chunk-stats.ts`). On Nginx 1.30.0: 99.9% vs 75.1% of functions kept whole (the LangChain figure is from a re-implementation; re-run it with the real package).
- `npm run eval`: retrieval hit rate and recall on a labelled question set, vector-only vs hybrid (`src/scripts/eval-retrieval.ts`, `eval/questions.json`, 11 questions).
- `npm run ask`: one question from the command line, saved as a Markdown transcript (`src/scripts/ask.ts`).

### Docs

- README rewritten. Removed: a made-up example session, a made-up description of the upstream fix, a wrong affected-version range, and a file count (411) given without its Nginx version. 411 is correct for release-1.31.6; the vulnerable release-1.30.0 has 395, and both were later measured. Added: the CVE root cause checked against upstream commit `524977e7`, measured chunking results, evaluation instructions, a list of fork changes, limitations and next steps.
- `package.json`: project name, description, license (GPL-3.0, same as upstream) and new scripts.
- `.env.example`: note on code base labels.

---

## Round 1: adaptation to C/C++ security auditing (before 2026-10-08)

### Added

- **`CCodeSplitter`**: structure-aware chunker for C/C++. Tracks brace depth (ignoring comments, strings and preprocessor lines), keeps whole functions and structs together, keeps Nginx `*_len_code` / `*_code` pairs in one chunk, and records line numbers and function/type names. (`src/app/libs/splitters/CCodeSplitter.ts`)
- C/C++ files (`.c .h .cc .cpp .cxx .hpp .hh .hxx`) are routed to it, with configurable `CHUNK_SIZE_C` / `CHUNK_OVERLAP_C`. (`ChunkContentOperation.ts`)
- `.h` mapped to C instead of C++, `c` added as a coding language. (`settings.ts`, `helpers.ts`)
- Configurable Ollama context window (`LLM_NUM_CTX`) and temperature (`LLM_TEMPERATURE`). (`OllamaLlmService.ts`, `bootstrap.ts`)
- `SCAN_EXTENSIONS` setting; default scan is `c,h`. (`scan-docs.ts`)

### Changed: prompts (`settings.ts`)

- **Summary prompt**: written for a memory-safety audit (allocations, size arithmetic, copies, bounds checks, attacker-controlled input).
- **Query-rewriting prompt**: examples in C / Nginx vocabulary.
- **Answer prompt**: "Senior C/C++ Security Auditor" with ranked priorities, file:line citations, confirmed vs potential findings, CWE, and verification steps.

### Changed: context builder (`AiAgent.ts`)

- Each retrieved chunk is shown with a `file (lines X-Y) | functions` header, its summary and its code.

### Fixed (upstream bugs)

- Query rewriting threw away the rewritten query and used the original question (`userQuestion` used instead of `refinedQuestion`).
- `Services.env()` compared `typeof` with `undefined` instead of `'undefined'`, so defaults were never used.
- The `scan-docs` npm script pointed at a missing file; `load-docs` added.
- Summary hashes could collide when two chunks got the same summary text.
- The summary context used a misspelled key (`filemane`), so the file name was never passed.

### Config

- Default collection `nginx-audit`; MariaDB port 3307 to match `docker-compose.yml`.
