# Cloudflare RAG

A multilingual document Q&A tool. Upload documents in any language, ask questions in any language, and get answers grounded only in what you've indexed — with citations back to the source file. Runs entirely on Cloudflare's own stack, with no third-party AI API keys.

Built on [Vinext](https://github.com/cloudflare/vinext), Cloudflare's Vite plugin that reimplements the Next.js API surface and deploys natively to Cloudflare Workers.

## Features

- Upload PDF, DOCX, ODT, Markdown, or plain text (up to 20 MB) by drag-and-drop, or paste text directly
- Ask in any language and get an answer back in that same language
- Answers cite their source documents, deduplicated to one entry per file
- Scope a question to specific documents instead of the whole corpus
- Automatic indexing with no configuration required
- Markdown-rendered answers with script-aware text direction (LTR/RTL)
- Live index status showing queued, running, and completed indexing jobs
- Per-IP rate limiting: 20 uploads/day, 60 questions/hour

## How it works

This does not hand-roll a chunk/embed/vector-search pipeline. It uses [Cloudflare AI Search](https://developers.cloudflare.com/ai-search/) — Cloudflare's managed RAG product — with an R2 bucket as its data source.

1. **Ingest** — an uploaded file or pasted text is written directly to an R2 bucket via the `DOCS_BUCKET` binding. The application performs no chunking or embedding.
2. **Index** — AI Search watches the bucket and chunks, embeds, and stores each object in its own managed vector index, either on its sync schedule or when triggered on demand.
3. **Ask** — a question is sent to `env.AI_SEARCH.chatCompletions()`, which handles retrieval and generation in one call and returns an answer plus the source chunks used.

## Architecture

| Component | Role |
|---|---|
| Cloudflare AI Search | Managed chunking, embedding, retrieval, and generation |
| R2 | Document storage; the AI Search data source |
| Workers AI | Embedding and generation models |
| Workers KV | Rate limiting, indexing debounce, framework cache |
| Vinext + React + TypeScript + Tailwind CSS v4 | Application and UI |

**Models**

- **Embedding:** `@cf/baai/bge-m3` — supports 100+ languages and is trained so that a query and a passage in *different* languages land close together in the same semantic space. The instance default, `@cf/baai/bge-large-en-v1.5`, is English-only and degrades silently for other languages.
- **Generation:** `@cf/openai/gpt-oss-20b` — with two system instructions: reply in the language the question was asked in, and answer strictly from retrieved context without inventing citations, quotations, or references.

**Retrieval configuration**

- **Reranking: off.** The only reranking model AI Search offers, `@cf/baai/bge-reranker-base`, is trained primarily on English and Chinese. In A/B testing it degraded cross-lingual queries, filtering out chunks that unranked retrieval surfaced correctly.
- **Hybrid search: off.** The keyword half uses a `porter` tokenizer, an English-only stemming algorithm, which sharply reduced recall for non-English text. Pure vector search performed substantially better.
- **`chunk_size: 64`, `chunk_overlap: 30`** — 64 is the platform minimum; smaller chunks improve retrieval precision on dense text.
- **`max_num_results: 20`** — compensates for the small chunk size by retrieving more chunks per query.

## Automatic indexing

Uploads are made searchable automatically, in three layers that each degrade to the next:

| Layer | Setup required | Latency |
|---|---|---|
| Scheduled sync (`sync_interval: 900`) | None | Up to 15 minutes |
| On-upload trigger | `CF_API_TOKEN` secret | Seconds |
| Manual "sync now" button | None (token optional) | On demand |

The 15-minute interval is set through the Workers binding and requires no API token. With `CF_API_TOKEN` configured, uploads and deletions additionally trigger an indexing job immediately. Job creation is debounced through KV and skipped when a job is already running, staying within Cloudflare's rate limit of one sync per 30 seconds.

R2 event notifications into a Queue would give true event-driven indexing, but Vinext's Worker entry point exports only `fetch` and provides no documented way to add a `queue()` handler.

## Chat with a specific document

Selecting documents in the library scopes the next question to only those files, using AI Search metadata filters (`{ filename: "..." }` or `{ filename: { $in: [...] } }`). Filters are applied before retrieval, so unselected documents are never scored — the scope is real, not a re-ranking.

Requested filenames are validated against a live bucket listing before being passed to the filter. Note that AI Search matches only the first 64 UTF-8 bytes of a filename, so very long names — particularly in non-Latin scripts, where each character uses 2+ bytes — may not filter reliably.

## Document library vs. search index

The document library lists objects in R2. That is not always identical to what is currently searchable:

- A newly uploaded document is in the library before it has been indexed.
- A deleted document leaves the library immediately, but its vectors persist until a subsequent sync — sometimes more than one.

Two mechanisms keep this honest rather than silent: deletions are recorded in KV and surfaced as pending removals, and every answer checks its citations against a live bucket listing, flagging any source that no longer exists as **removed** rather than hiding it.

## Getting started

```bash
npm install
npm run dev
```

All bindings are configured `remote: true`, so local development talks to real Cloudflare infrastructure. You must be logged in via `npx wrangler login`, and **usage is billed to your account even in local development**.

## Use your own Cloudflare account

This repo is a template, not a hosted service. Every resource belongs to whoever creates it.

### Prerequisites

- **Node.js 22 or later.** Vinext declares `"engines": { "node": ">=22" }`. Node 20 fails with a `node:fs/promises` / `glob` export error.
- A Cloudflare account, logged in via `npx wrangler login`.
- AI Search is currently an **open-beta** Cloudflare product; its REST and binding surface is still changing. Workers AI and AI Search have free-tier allowances and are billed beyond them — see [current pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).

### 1. Create your resources

```bash
npx wrangler kv namespace create VINEXT_KV_CACHE
npx wrangler r2 bucket create cf-rag-tool-docs
npx wrangler ai-search create cf-rag-tool \
  --type r2 --source cf-rag-tool-docs \
  --chunk-size 64 --chunk-overlap 30 \
  --max-num-results 20 \
  --hybrid-search false --cache false \
  --embedding-model "@cf/baai/bge-m3" \
  --generation-model "@cf/openai/gpt-oss-20b"
```

`--chunk-size` must be between 64 and 512, and `--chunk-overlap` must be 30 or less. Values outside those ranges are rejected, not clamped.

### 2. Edit `wrangler.jsonc`

The committed file ships with placeholders so a missed field fails loudly rather than pointing at someone else's resources.

| Field | Set to |
|---|---|
| `kv_namespaces[0].id` | The `id` printed by `wrangler kv namespace create` |
| `vars.CF_ACCOUNT_ID` | Your [account ID](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/) |
| `r2_buckets[0].bucket_name` | Your bucket name, if different |
| `ai_search[0].instance_name` | Your AI Search instance name, if different |
| `name` | Your Worker's name, if different |

`vars.AI_SEARCH_INSTANCE_NAME` must always match `ai_search[0].instance_name`.

### 3. Optional: instant indexing

Without a token, indexing falls back to the 15-minute scheduled sync. For instant indexing, create a custom API token with **AI Search:Edit** and **AI Search:Run**, then:

```bash
npx wrangler secret put CF_API_TOKEN
```

For local development, put the same value in a `.dev.vars` file (gitignored).

### 4. Run and deploy

```bash
npm run dev
npm run build && npm run deploy
```

## Troubleshooting

- **`invalid_chunk_size`** — `--chunk-size` must be 64–512; `--chunk-overlap` must be ≤30.
- **Uploads succeed but nothing becomes searchable** — check that `r2_buckets[0].remote` is `true`. If not, uploads go to a local R2 emulator that AI Search cannot see. The upload returns HTTP 200, so nothing appears wrong.
- **Binding error on dev or deploy** — `kv_namespaces[0].id` is still a placeholder or points at another account.
- **The dev server appears to hang for ~40 seconds** — it is binding `remote: true` resources against live infrastructure before serving.
- **Uploads aren't instantly searchable** — expected without `CF_API_TOKEN`; worst case is a 15-minute wait.

## Limitations

AI Search's chunker allocates its token budget far more coarsely for Arabic-script text than for Latin-script text — measured at roughly 15× in a controlled comparison of same-length documents. Individual facts are therefore diluted across larger chunks, which measurably weakens fine-grained retrieval. This is a platform characteristic and cannot be corrected from application configuration, as `chunk_size` is already at the platform minimum. The tool remains usable for such corpora, and the grounding instruction prevents fabricated answers when retrieval falls short, but precision is lower than for Latin-script or CJK content.

## Project structure

```
app/
  page.tsx                  # Ask panel, upload/paste panel, document library, index status
  layout.tsx                  # Root layout, fonts, metadata
  globals.css                   # Theme tokens, script-aware fonts, Markdown styling
  api/ask/route.ts                # POST — question (+ optional scope) in, cited answer out
  api/docs/route.ts                 # POST — upload to R2 and trigger indexing; GET — list
  api/docs/[key]/route.ts             # DELETE — remove a document
  api/sync/route.ts                     # GET — index stats; POST — manual sync
lib/
  docs.ts                                 # Extensions, filename sanitizing, filters, citation dedupe
  aisearch.ts                               # Indexing triggers, sync interval, debounce
  ratelimit.ts                                # Fixed-window KV rate limiter
  clientinfo.ts                                 # Client IP extraction
  rtl.ts                                          # Right-to-left script detection
wrangler.jsonc                                    # KV, AI, R2, and AI Search bindings
```

## Testing

`npm test` runs the Vitest suite (61 tests) covering filename validation and sanitizing, metadata filter construction, citation deduplication, pending-removal tracking, indexing debounce and graceful degradation without a token, rate limiting, and RTL script detection.

Retrieval quality was verified end to end against multilingual corpora in English, Chinese, and Urdu, including cross-lingual queries, per-document scoping, and confirmation that the grounding instruction prevents fabricated citations when a fact is not present in the retrieved context.
