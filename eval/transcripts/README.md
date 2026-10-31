# Transcripts

Real runs of `npm run ask`, kept as evidence. Every answer was checked by hand against the Nginx
source and the 1.30.1 fixes. **Do not quote these answers as correct** — see the verdicts.

| File | Question | Retrieval | Answer |
|---|---|---|---|
| 2026-10-20T20-21-46-923Z.md | CVE-2026-42945 copy vs length pass | correct | partly right |
| 2026-10-20T20-30-27-720Z.md | request-body read bounds check | correct | wrong (false positive) |
| 2026-10-20T20-36-00-860Z.md | charset UTF-8 split across buffers | correct | wrong (invented evidence; missed the real over-read) |

Setup: answers by qwen2.5-coder:3b, summaries by qwen2.5-coder:1.5b, k=5, laptop with 8 GB RAM.
Details and the correct answers: main README, "Answer quality: three reviewed transcripts".
