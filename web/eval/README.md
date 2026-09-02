# eval/

Two plain ts-node scripts that exercise the real ingestion pipeline. No test framework.

```
npm run eval:extraction                          # all fixtures
npm run eval:extraction -- vendor-services       # one fixture (substring match)
npm run eval:injection
npm run eval:extraction -- --selftest             # scoring math check, no API calls, no key needed
```

## Requires live API keys

There is no offline/mock mode — that is the point. Both scripts call OpenRouter with the models
in `src/lib/config/models.ts`.

- **`OPENROUTER_API_KEY` — required.** Missing → the script prints a one-line message and exits 1,
  no stack trace.
- `OPENAI_API_KEY` — not needed. Embeddings and Neo4j writes are outside what these scripts test.

Keys are read from `web/.env.local` (same as `scripts/init_neo4j.ts`) or the shell environment.

## Files

| Path | What |
|---|---|
| `dataset/*.md` | 5 short enterprise fixtures: contract, earnings summary, meeting minutes, architecture doc, HR policy |
| `dataset/*.expected.json` | Hand labels: class, entities, key relationships, Q/A pairs (each doc has one deliberately unanswerable question) |
| `pipeline.ts` | Adapter over the real pipeline — see the debt note at the top |
| `extraction-eval.ts` | Classification accuracy + entity P/R/F1 + relation recall |
| `injection-tests.ts` | 8 adversarial docs; hard-asserts closed-enum classification, warns on instruction-looking graph text |
| `util.ts` | Fuzzy matching, P/R/F1, report writer, injection sniffer |
| `results/` | Timestamped JSON reports, one per run — diff these across template/prompt changes |

## Scoring notes

- Entity matching is fuzzy (case/punctuation-insensitive, containment allowed). Exact string
  match is too strict for LLM output.
- **Entity precision is a lower bound.** The gold list is "entities that MUST appear", not an
  exhaustive list, so a legitimately-extracted extra entity is counted as a false positive.
  Recall and F1-trend across runs are the numbers to watch.
- Relations are scored on **recall only**, for the same reason. Reversed-direction matches are
  counted separately (`reversedDirection`) because direction errors are a distinct failure mode.
- The `qa` labels in the fixtures are for a future retrieval eval; `extraction-eval.ts` does not
  read them yet.

## Known debt

`classifyDocument`, `extractChunk` and `chunkText` are module-private in
`src/lib/inngest/functions.ts`, and that module opens Inngest/Supabase/Neo4j clients at import
time. `pipeline.ts` therefore holds a verbatim copy of the two prompt-building functions while
importing everything that *is* exported (templates, models, retry). Export those three functions
(or move them to a side-effect-free module) and `pipeline.ts` shrinks to an import.
