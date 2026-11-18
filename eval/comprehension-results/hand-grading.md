# Hand grading of the comprehension runs

The script scores only the `VERDICT:` line. A verdict counts as **understood** here only if
the justification under it is also correct: it points to the right code and the right
mechanism. Every answer whose automatic verdict matched the expected one was read in full
(`*.md` transcripts in this folder). All other answers were wrong at the verdict level already.

Model `qwen2.5-coder:7b` answering, `qwen2.5-coder:1.5b` chunk summaries,
`snowflake-arctic-embed2:568m` embeddings, k = 8, temperature 0.1, 3 runs per question,
T4 GPU (Google Colab), 2026-11-18.

| Run | Window | Context |
|---|---|---|
| `2026-11-18T13-50-14-946Z` | `LLM_NUM_CTX=8192` | Not limited. Prompts of ~8.7k–10.6k tokens were silently cut from the start by Ollama, which is where the best-ranked chunk sits |
| `2026-11-18T14-08-27-292Z` | `LLM_NUM_CTX=16384` | Limited to the window (context budget fix); every answer received all retrieved sections (7/7 or 8/8) |

## Answers with a matching verdict

| Question | Run 1 (8k, truncated) | Run 2 (16k, full context) | Grade |
|---|---|---|---|
| `copy-escapes-captures` (YES) | YES ×3 | YES ×3 | **Understood ×3 in both runs.** Quotes `if ((e->is_args \|\| e->quote) && (quoted_uri \|\| plus_in_uri))` and the `ngx_escape_uri(..., NGX_ESCAPE_ARGS)` call and explains the 1→3 byte expansion. (It quotes the `_len_code` twin; the condition is identical.) |
| `overflow-is-2n` (YES) | YES ×2 | YES ×3 | **Not understood.** Says escaping "doubles" a `+` or adds "one byte" per `+`; claims the length calculation "does not account for escaping". The length code does handle escaping; the real cause, that the length pass runs on a zeroed engine with `is_args = 0`, is never stated. One run-2 answer gets the 2-bytes-per-`+` arithmetic right but still not the cause. One answer invents a `./configure --add-module=../nginx-http-script.c` command. |
| `end-resets-is-args-1.30.1` (YES) | UNKNOWN ×3 | YES ×3 | **Not understood.** All three quote `e->ip += sizeof(...); return;` as the evidence instead of `e->is_args = 0;`. Two of the three then write that there are "no assignments or modifications made to `e->is_args`", which is the argument for NO, directly under `VERDICT: YES`. |

## Totals

| | Closed-book | RAG, run 1 | RAG, run 2 |
|---|---|---|---|
| Verdict matches (automatic) | 0/27 | 5/27 | 9/27 |
| Verdict and reasoning correct (hand-graded) | 0/27 | **3/27** | **3/27** |
| Corrections-log questions, either grade | 0/6 | 0/6 | 0/6 |
| Vulnerable/patched pairs, either grade | 0/3 | 0/3 | 0/3 |

## What this shows

1. **The verdict score overstates comprehension by 3×** in run 2 (9 vs 3). Grading by hand is
   not optional for this kind of evaluation.
2. **Fixing the context made the model *say* the right thing more often, not *understand* more.**
   The context fix is still correct engineering (the evidence was being thrown away), but on
   this model it moved verdicts, not reasoning.
3. **What the model can do:** read a condition that is present in one function and explain it
   (`copy-escapes-captures`, 6/6 across both runs).
   **What it cannot:** conclude from something *absent* (the missing `is_args` reset in 1.30.0:
   UNKNOWN 6/6), connect two functions (the zeroed length engine vs the live copy engine:
   0/6), or locate a fix (0/6). CVE-2026-42945 is exactly an absent line connecting two functions.
4. **Closed-book, the model mostly declines (UNKNOWN), but not always honestly:** it states that
   CVE-2026-42945 is "in HTTP request header handling" and that `ngx_http_script_regex_end_code`
   "is not a standard part of Nginx". Both are false.
5. **Retrieval limits the corrections-log questions.** `capture-in-replacement-required` names no
   function, and retrieval found 0 of the 2 functions it needs in every run; the model repeated
   the original assistant's mistake 6/6 (closed) and 6/6 (RAG).

## Limits of this run

One answer model (7B), one index, 9 questions × 3 runs, one grader (the author). The YES-only
pattern of the correct verdicts means a yes-bias cannot be ruled out; the vulnerable/patched pair
was designed to expose that and was failed in every run.
