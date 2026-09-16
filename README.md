# cf-rag-tool

A small, multilingual document Q&A tool: upload documents (files or pasted text) in any language, ask questions in any language, get answers grounded in what you've indexed — with citations back to the source file. Built entirely on Cloudflare's own stack, no third-party AI API keys.

Built on [Vinext](https://github.com/cloudflare/vinext) — Cloudflare's experimental Vite plugin that reimplements the Next.js API surface, deployed natively to Cloudflare Workers.

## How it works

This does **not** hand-roll a chunk/embed/Vectorize pipeline. It uses [Cloudflare AI Search](https://developers.cloudflare.com/ai-search/) (formerly AutoRAG) — Cloudflare's managed RAG product — configured with an R2 bucket as its data source:

1. **Ingest** — a document (file upload or pasted text) is written straight to an R2 bucket (`cf-rag-tool-docs`) via the `DOCS_BUCKET` binding. Nothing is chunked or embedded by this app's code.
2. **Index** — AI Search watches the bucket and, on its own sync schedule (as fast as every 15 minutes, or triggered automatically right after an upload / on demand via "sync now" — see "Automatic indexing" below), chunks each object, embeds the chunks, and stores them in its own managed vector index. This is entirely outside the Worker; the app has no chunking/embedding code.
3. **Ask** — a question is sent to `env.AI_SEARCH.chatCompletions(...)`, optionally scoped to one or more specific documents (see "Chat with a specific document" below). AI Search does the retrieval (vector search — see "Hybrid search" below for why keyword search is off) and generation in one call, returning an answer plus the source chunks it used, which the UI shows as citation chips.

## Why AI Search instead of raw Vectorize

An earlier version of this app rolled its own chunking + Workers AI embeddings + Vectorize pipeline. That's gone. AI Search does the same job as a managed product: it owns chunking, embedding, the vector index, hybrid search, and even the generation call, all behind two bindings (`AI_SEARCH`, plus the `DOCS_BUCKET`/`AI` bindings it needs). Less code to maintain, and it comes with hybrid search and reranking built in.

The tradeoff: the Workers binding doesn't expose AI Search's admin operations at runtime the way its TypeScript types suggest — `env.AI_SEARCH.jobs.create()` throws `The RPC receiver does not implement the method "create"` (confirmed directly). Triggering an indexing job on demand therefore needs the AI Search **REST API**, which needs an account-scoped API token this Worker doesn't hold by default. See "Automatic indexing" below for how this app now works around that with layered, gracefully-degrading fallbacks instead of just punting to the CLI.

## Multilingual and cross-lingual by design

The whole point of this tool is that it doesn't care what language your documents — or your questions — are in.

- **Embedding: [`@cf/baai/bge-m3`](https://developers.cloudflare.com/workers-ai/models/bge-m3/)** — chosen specifically for multilingual and cross-lingual retrieval. It supports 100+ languages and is explicitly trained so that a query and a passage in *different* languages still land close together in the same semantic space. The instance originally defaulted to `@cf/baai/bge-large-en-v1.5`, which is English-only and would silently degrade to poor embeddings for anything else. Switching embedding models changes vector dimensionality, so this required a full re-index (`npx wrangler ai-search jobs create cf-rag-tool`) — updating the instance in place does not retroactively re-embed existing content.
- **Generation: [`@cf/openai/gpt-oss-20b`](https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/)** — kept as-is after verifying empirically that it produces fluent, accurate prose in whatever language the retrieved context is in, and switches language cleanly to match the question. The `/api/ask` route also sends a short system message asking the model to reply in the same language the question was asked in (see "Testing notes" for why, and evidence that it works), plus a strict grounding/anti-fabrication instruction (see next bullet).
- **Anti-fabrication system prompt.** This corpus is religious/scholarly source material, so an invented citation is a real harm, not a cosmetic bug. It was reproduced directly: asked (in Urdu) "اللہ سے ڈرنے والے کا مصداق" (who is meant by "the one who fears Allah"), the model — with no grounding instruction and a genuine retrieval gap for that exact passage — answered fluently and confidently with **invented** references: a fabricated hadith wording (`مَن يَتَّقِ الله يجعل له مخرجا`), attributions to البخاری and ابن ماجه that don't appear anywhere in the source books, and a made-up Quran citation ("4:56"). The true source (`الاعلیٰ : 10`) was never cited. The `/api/ask` system message now explicitly instructs the model to answer only from retrieved context and never invent citations, hadith, or verse numbers, and to say plainly when the context doesn't contain the answer. Re-tested after the change: the same question now either quotes a real passage verbatim and admits what it doesn't have ("تاہم، کسی بھی دستاویز میں 'عنقریب' کی وضاحت نہیں کی گئی" — "however, no document explains 'soon'") or declines outright, with the fabricated البخاری/ابن ماجه citations gone in every re-test. Two other spot-check questions with known ground truth were also answered correctly with accurate quotes, confirming the instruction fixed fabrication without making the tool useless. This is set as a per-request message (authoritative for this app, since `/api/ask` always sends it) rather than relying solely on the instance-level `system_prompt_ai_search` field — that field is dashboard/API-only to set (no `wrangler ai-search update` flag for it) and wouldn't cover this app's own message anyway; it would only add defense-in-depth for other consumers of the same instance (dashboard playground, MCP endpoint), which is out of scope for this change.
- **Reranking: off.** AI Search only offers one reranking model, `@cf/baai/bge-reranker-base`, which is trained primarily on English/Chinese (it is *not* the multilingual `bge-reranker-v2-m3`). Turning it on was A/B tested against a fixed question set: for same-language questions it made little difference, but it **broke cross-lingual questions outright** — `chatCompletions` returned "no documents found" for queries where the retrieval-only `search` call still showed a relevant chunk sitting at score ~0.55–0.60. The reranker was evidently scoring cross-lingual query/chunk pairs low enough to filter them out entirely. Reranking is left disabled; the `reranking_model` field on the instance is still set to `@cf/baai/bge-reranker-base` (that's just which model would be used *if* reranking were re-enabled — it has no effect while `reranking: false`).
- **Hybrid search: off.** It defaults on (vector + keyword, RRF fusion), but the instance's keyword search uses `indexing_options.keyword_tokenizer: "porter"` — the Porter stemmer is an **English-only** algorithm, so the keyword half tokenizes Urdu (and most non-English text) badly. Measured directly: the query `اللہ سے ڈرنے والے کا مصداق` returned **1 result** with hybrid search on, and **20 results** with it off, same everything else. The bad keyword leg was poisoning RRF fusion and collapsing recall. `wrangler ai-search update` has no flag for `keyword_tokenizer`, and it isn't in the create/update schema either — it appears to be dashboard-only (or fixed) in the current beta, so there's no way from this repo to make hybrid search safe for non-English corpora; it's left off instead.
- **Chunking: `chunk_size: 64` (the API's minimum), `chunk_overlap: 30`** — **`chunk_size` is measured in tokens, not characters** (confirmed against Cloudflare's docs); an earlier version of this README described it as "512 chars", which was wrong. Worse: for this Urdu/Arabic-script corpus, AI Search's chunker treats a given token budget as covering **roughly 15× more text than it does for English**, confirmed with a controlled test — two 6,000-character test files (one English, one Urdu), same `chunk_size`, uploaded and indexed side by side: the English file produced **45 chunks**, the Urdu file produced **3**. That means even at the platform's smallest allowed `chunk_size` (64 — anything below 64 is rejected with `Too small: expected number to be >=64`), Urdu chunks come out far coarser than intended, diluting individual facts inside much larger blocks of unrelated surrounding text and hurting exact-passage retrieval. This is a genuine AI Search platform limitation for Urdu/Arabic-script content, not something fixable via config from this app — see "Indexing coverage: known platform limitation" under Testing notes.
- **`max_num_results`: 20** (raised from the default of 6) — mitigates the chunk-dilution problem above: since Urdu chunks are unavoidably coarse, more of them have to be retrieved for the generation step to have a chance of seeing the right passage.
- **Score threshold: 0.4** — left at the default. Spot-checked against actual score distributions seen during testing (correct-answer chunks scored well above this at reasonable retrieval counts); 0.4 doesn't appear to be silently cutting off good matches at this corpus size.
- **Response caching: off** (`cache: false`). AI Search's similarity cache reuses answers for queries it judges "close enough" to a prior one. On a corpus like this — dense, thematically repetitive religious/scholarly text where many distinct questions are semantically close — that risks serving a cached answer to the *wrong* question. Given this app's anti-fabrication goal (see below), a wrong-but-confident cached answer is worse than the small latency cost of always computing fresh.

## Features

- Upload a file (PDF, DOCX, ODT, Markdown, plain text; up to 20MB) via drag-and-drop or click-to-browse, or paste text directly with a title
- Ask in any language and get an answer back in that same language, with the UI auto-detecting each script (Latin, right-to-left scripts like Arabic/Hebrew, CJK, etc.) to apply sensible direction and fonts
- Answers are rendered as formatted Markdown (headings, bold, lists, and GFM tables), since the generation model routinely replies with structured prose — wide tables scroll inside their own container instead of breaking the page
- **Deduped citations** — with `max_num_results: 20`, one answer routinely matches the same file 5-6+ times; citations are collapsed to one chip per unique document (best score, plus a "· N excerpts" count), ordered by best score descending, instead of one chip per raw chunk (see "Citations" below)
- Remove an indexed document (deletes the R2 object; see "Document library vs. search index" below for what happens next — it isn't instant)
- **Scope a question to specific document(s)** — check one or more files in the "Document library" panel to chat with just those, with an unmistakable highlighted "Asking: …" indicator, a scope-aware ask button label, and one-click reset to search everything (see "Chat with a specific document" below)
- **Automatic indexing** — uploads trigger indexing on their own; no CLI step required for the app to work (see "Automatic indexing" below for what needs a one-time token setup vs. what works out of the box)
- A live **Index status** panel (top right) showing queued/running/completed/error counts and vector count, polled from AI Search's own stats — not a fake progress bar, plus a **sync now** button to force a re-index on demand
- Rate limited per IP: 20 document ingests/day, 60 questions/hour, 10 manual syncs/hour

## Automatic indexing

New uploads land in R2 immediately, but AI Search only picks them up when it runs an indexing job. Originally that meant running `npx wrangler ai-search jobs create cf-rag-tool` by hand after every upload — that's gone. This app now layers three mechanisms, each falling back to the next:

1. **Fast scheduled sync — zero configuration, always on.** AI Search re-syncs from its R2 source on its own schedule (`sync_interval`, 6 hours by default). `lib/aisearch.ts`'s `ensureFastSyncInterval()` calls `env.AI_SEARCH.update({ sync_interval: 900 })` — the Workers **binding**, not the REST API — right after an upload (KV-gated to check at most once/day so it doesn't hammer the config endpoint). This needs **no API token at all**: it was confirmed working end-to-end with `CF_API_TOKEN` completely unset. `900` (15 minutes) is the fastest value AI Search's `update()` actually accepts — confirmed empirically by sweeping values against the live instance and re-reading them back: `899` and `1000` are rejected (`Invalid input`), `900` and `1800` are accepted and persist. This is stricter than Cloudflare's own [sync interval docs](https://developers.cloudflare.com/ai-search/configuration/indexing/syncing/), which describe only six fixed values down to a 1-hour minimum (`3600`/`7200`/`14400`/`21600`/`43200`/`86400`) — the real API accepts any multiple of 900 seconds, at least at the time of testing. Since this needs no secret, **every deployment of this app gets 15-minute automatic indexing with zero setup**, even one where nobody ever runs `wrangler secret put`.
2. **Instant trigger on upload — needs one API token.** Right after a successful upload, `lib/aisearch.ts`'s `triggerIndexingJob()` calls the AI Search REST API directly:
   ```
   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai-search/namespaces/default/instances/{instance}/jobs
   ```
   This endpoint isn't in Cloudflare's public REST API reference at the time of writing; its path was recovered from `wrangler`'s own bundled source (`baseInstanceUrl`/`baseJobUrl` in `node_modules/wrangler/wrangler-dist/cli.js` — the same code `wrangler ai-search jobs create` calls) and confirmed with a live `curl` call before being wired into the app. It needs an account-scoped API token — see "Setting up automatic indexing" below. **Without that token configured, this step degrades gracefully**: `triggerIndexingJob()` returns `{ ok: false, reason: "no-token" }` instead of throwing, the upload still succeeds, and the app falls back to mechanism (1). This was tested directly with `CF_API_TOKEN` unset — no crash, no 500, just a clean no-op.
3. **Manual "sync now" button — same code path, on demand.** The Index status panel has a **sync now** button (`POST /api/sync`) that calls the same `triggerIndexingJob()`/`ensureFastSyncInterval()` pair, rate-limited per IP (10/hour, `lib/ratelimit.ts`). It behaves identically with or without a token: with one, it starts a job immediately; without one, it still tightens `sync_interval` and reports `no-token` instead of erroring, and the UI points at the CLI command as a last resort.

**Debounce.** Ten uploads in a row must not spawn ten indexing jobs, and AI Search rate-limits job creation to roughly one per 30 seconds. `triggerIndexingJob()` claims a KV key (`aisearch:job-debounce:{instance}`, 60-second TTL — comfortably above the 30s floor) *before* making the network call, so a burst of near-simultaneous callers coalesces into a single job; it also checks `env.AI_SEARCH.stats()` first and skips creating a job if one is already `queued`/`running`. See `test/aisearch.test.ts` for this covered as pure/mocked logic (debounce coalescing, the already-active skip, the no-token and placeholder-account-id degradation paths, a 429 mapped to `"rate-limited"` instead of a generic error, and the sync-interval idempotency check).

**What's still manual:** nothing, for a deployment with the token configured — indexing is fully automatic (seconds, via mechanism 2). Without the token, the worst case is a 15-minute wait for the next scheduled sync (mechanism 1), or the CLI command / dashboard "sync now" for anyone who wants it sooner.

### R2 Event Notifications → Queue: evaluated, not implemented

The event-driven alternative — R2 dispatches an `object-create` notification to a Cloudflare Queue (`npx wrangler r2 bucket notification create cf-rag-tool-docs --event-type object-create --queue <queue-name>`, plus a `queues.consumers` binding and a `queue()` handler) — would give indexing within seconds with no polling and no request-time REST call. It was evaluated but not implemented: this app's Worker entry point is `vinext/server/fetch-handler`, which re-exports only a `fetch` handler from vinext's own virtual entry module (confirmed by reading `node_modules/vinext/dist/server/fetch-handler.js`) — there's no documented vinext hook to additionally export a `queue()` handler on the same Worker without forking the framework's entry point. Given mechanisms (1) and (2) above already deliver indexing within 15 minutes with zero setup and within seconds with one secret, that framework fork wasn't judged worth it for this app. Anyone who does want it: the commands above are the right starting point, and the consumer would just need to call the same `triggerIndexingJob` logic (or the plain REST endpoint) on each queued message.

### Setting up automatic indexing (optional — for instant, not 15-minute, indexing)

Without this, the app still works (see mechanism 1 above). With it, uploads are searchable within seconds instead of up to 15 minutes.

1. In the Cloudflare dashboard, go to **My Profile → API Tokens** (`https://dash.cloudflare.com/profile/api-tokens`).
2. **Create Token → Create Custom Token**.
3. Name it something like `cf-rag-tool indexing`.
4. Under **Permissions**, add two: **Account → AI Search:Edit** and **Account → AI Search:Run** (this is the exact pairing Cloudflare's own AI Search REST API docs specify for any AI Search REST call).
5. Scope it to your account (or the specific account running this instance) and create it. Copy the token value — it's shown once.
6. Set the two plain (non-secret) values in `wrangler.jsonc`'s `vars` block: `CF_ACCOUNT_ID` (your Cloudflare account ID) and `AI_SEARCH_INSTANCE_NAME` (must match `ai_search[0].instance_name`).
7. Store the token itself as a secret, **not** in `wrangler.jsonc`:
   ```bash
   npx wrangler secret put CF_API_TOKEN
   ```
   For local dev, put the same value in a `.dev.vars` file (`CF_API_TOKEN=...`) — it's gitignored, so it never gets committed.

That's it — no code changes. The next upload (or the "sync now" button) will use the token automatically.

Progress can always be watched with:

```bash
npx wrangler ai-search stats cf-rag-tool --json
```

— which is the same data source the in-app Index status panel polls.

## Chat with a specific document

Sometimes you want an answer grounded in exactly one book, not whatever else happens to be indexed. AI Search supports metadata filters applied **before** retrieval — a chunk that fails the filter is never scored or returned, so this genuinely scopes the search rather than just re-ranking afterward.

**UI**: check one or more documents in the "Document library" panel to scope the next question to just those files. The checked row is highlighted, the active scope shows above the ask box in a highlighted box ("Asking: en-test.txt ×") that stays visible through the "thinking…" state, the ask button itself relabels to "ask (1 doc only) →", and the answer repeats the scope actually applied ("Answered using only: en-test.txt") so scoping stays unmistakable end to end. One-click "reset to all documents" clears it. Leaving everything unchecked searches the whole corpus, as before.

**API**: `POST /api/ask` accepts an optional `filenames: string[]` alongside `question`. The route (`app/api/ask/route.ts`) never trusts these directly — `validateFilenames()` (`lib/docs.ts`) intersects them against a live `DOCS_BUCKET.list()`, silently dropping anything that isn't actually an indexed document (see `test/docs.test.ts` — a path-traversal-shaped or SQL-injection-shaped filename list comes back empty, not passed through). `buildFilenameFilter()` then turns the validated list into the `ai_search_options.retrieval.filters` shape: `{ filename: "<key>" }` (implicit `$eq`) for one document, `{ filename: { $in: [...] } }` for several, or no `filters` key at all (search everything) when nothing was requested or nothing validated. The response's `scopedTo` field echoes back exactly what was actually applied, so the UI's "Asking: …" chip reflects reality rather than the raw request.

The metadata field is `filename` — confirmed empirically, since it's not obvious from the item schema (`AiSearchItemInfo` names the field `key`, and filtering on `{ key: ... }` actually errors with `metadata_filter_unknown_field`; `{ filename: ... }` is the one that works and correctly restricts `item.key` in the results to the requested file).

**Verified evidence that it actually scopes** (via the live `/api/ask` endpoint, not a mock): the fact "a one-time home office stipend of 850 US dollars" exists only in `en-test.txt`, not in `cServerGuide.pdf` (an unrelated tech manual, also indexed).

| Scope | Question | Answer |
|---|---|---|
| none (whole corpus) | "What is the one-time home office stipend amount for a new employee, in US dollars?" | "The one-time home office stipend for a new employee is **$850**." (cited `en-test.txt` among others) |
| `cServerGuide.pdf` (wrong book) | same question | "I'm sorry, but the provided document does not contain any information about a one-time home office stipend." — honest miss, **no leakage** from `en-test.txt` even though it's sitting right there in the same index |
| `en-test.txt` (right book) | same question | "850 US dollars." — correct, sourced only from `en-test.txt` |

The anti-fabrication system prompt (see below) and the filter compose correctly: scoped to the wrong book, the model doesn't invent an answer from the filtered-out context — it says the document doesn't contain it, exactly like the "genuine retrieval gap" behavior documented below for the Urdu corpus.

**Known limitation — 64-byte filter matching.** AI Search's metadata filters only match the first 64 UTF-8 bytes of an indexed string. Every filename in this app's shipped corpus is well under that (ASCII filenames are 1 byte/character), but it's a real trap for non-Latin filenames: each Urdu/Arabic character is 2+ UTF-8 bytes, so a descriptive Urdu title could exceed 64 bytes well before the human-readable part of the name does, and the filter would then fail to match past that point. Keep filenames short, or put distinguishing text in the first 64 bytes, if you're filtering on non-Latin filenames.

## Citations

`max_num_results: 20` (see above) means a single answer routinely retrieves the same file 5-6+ times as separate chunks. Rendering one chip per chunk produced citation lists like `[1] guide.pdf … [6] guide.pdf … [11] book.txt … [20] guide.pdf` — real, reproduced behavior with this app's corpus, not a hypothetical — which is noise, not a usable citation list.

`dedupeSources()` (`lib/docs.ts`) collapses that server-side, before the response ever reaches the client: one entry per unique filename, keeping the **highest** score seen for that file and a count of how many chunks matched, sorted by best score descending (unscored entries sort last). The UI renders one chip per file — `[1] guide.pdf · 6 excerpts` — with the score and excerpt count in the hover tooltip. See `test/docs.test.ts` for the dedup/ordering/edge-case coverage.

## Document library vs. search index

**The bug this fixes**: `GET /api/docs` lists R2 objects. Deleting an R2 object does **not** remove its vectors from AI Search's index until the index's next sync — confirmed empirically (not assumed): with `cServerGuide.pdf` as the only object in R2, the index still reported **1052 vectors across 6 files**, and a broad question came back citing five files that weren't listed anywhere in the UI. Worse, re-tested live during this fix: even an explicitly triggered indexing job that reports `completed` doesn't necessarily purge a deleted file's vectors within that same job — in one live test it took **two** completed jobs before a deleted file's chunks stopped being retrieved. A user has no way to know any of this from the old UI, which presented the R2 listing as if it were "what's indexed."

This is fixed with three complementary changes rather than one, because no single one is sufficient on its own:

1. **Trigger indexing on delete, not just on upload.** `DELETE /api/docs/[key]` now calls the same debounced `triggerIndexingJob()` / `ensureFastSyncInterval()` pair upload already used (`lib/aisearch.ts`), so the index starts converging immediately instead of waiting for the next scheduled sync. Degrades the same way as upload: without `CF_API_TOKEN` it still tightens `sync_interval` to 15 minutes and no-ops the REST call rather than erroring.
2. **Tell the truth about the lag, honestly hedged.** Every delete records the key in KV as a "pending removal" (`recordPendingRemoval`, `lib/aisearch.ts`), and `GET /api/docs` returns it as `pendingRemovals: string[]` alongside the R2 listing. It's pruned once `AI_SEARCH.stats().last_activity` shows a sync completed *after* the deletion — but per the finding above, that's a **best-effort heuristic**, not a guarantee the vectors are actually gone (a completed job doesn't always mean an immediate purge). The UI's banner is worded accordingly ("likely out of sync … may still be searchable"), and says explicitly that the per-citation flag below (next point) is the thing that's actually authoritative, not this banner.
3. **Never silently serve a citation from a deleted document.** `POST /api/ask` checks every citation's filename against a *live* `DOCS_BUCKET.list()` on every request (not the KV heuristic) and returns `removed: true` on any source no longer present in R2. This is the real backstop: it stayed accurate in testing throughout the two-job gap where the pending-removal banner had already cleared but the stale citation was still being served. The UI renders these with a visibly different (red-tinted) "removed" badge and a tooltip explaining why, rather than hiding them or presenting them as normal citations.

The **"Document library" heading** (renamed from "Indexed documents") and a subtitle under it now say explicitly that this list reflects R2, not necessarily what's currently searchable — closing the honesty gap the old heading implied.

`prunePendingRemovals()` / `addPendingRemoval()` in `lib/aisearch.ts` are pure and unit-tested (`test/aisearch.test.ts`) for the KV round-trip, the pruning-by-`last_activity` logic, and graceful degradation when KV is unavailable.

## Stack

- Vinext (App Router, Route Handlers) + TypeScript + Tailwind CSS v4
- Cloudflare AI Search (`AI_SEARCH` binding) — managed retrieval + generation
- R2 (`DOCS_BUCKET` binding) — the AI Search data source; also the source of truth for the document list shown in the UI
- Workers AI (`AI` binding) — required by AI Search itself
- Workers KV (`VINEXT_KV_CACHE`) — rate limiting, the debounce/sync-interval-ensured markers for automatic indexing, and Vinext's own cache
- `react-markdown` + `remark-gfm` — renders the model's Markdown answers (including GFM tables) client-side; raw HTML is never rendered (no `rehype-raw`), so stray HTML in model output shows up as inert text rather than executing

## Getting started

```bash
npm install
npm run dev
```

All bindings (`AI`, `DOCS_BUCKET`, `AI_SEARCH`) are configured `remote: true` in `wrangler.jsonc`, so local dev talks to real Cloudflare infrastructure — you need to be logged in (`npx wrangler login`).

> **Cost warning**: because those bindings are `remote: true`, running `npm run dev` locally does **not** use a free local emulator for `AI`/`DOCS_BUCKET`/`AI_SEARCH` — every question runs real Workers AI inference and every indexing job processes real R2 data against your actual Cloudflare account, and both are billed accordingly. There's no separate "safe" local mode; budget for that before leaving `npm run dev` running.

## Use your own Cloudflare account

This repo is a template, not a hosted service — every resource (KV namespace, R2 bucket, AI Search instance) belongs to whoever creates it. To run it on your own account instead of the original author's:

### Prerequisites

- **Node.js 22 or later.** Vinext's `package.json` declares `"engines": { "node": ">=22" }`. Node 20 fails at build/dev time with a `node:fs/promises` / `glob` export error — this isn't optional.
- A Cloudflare account, logged in via `npx wrangler login`.
- **AI Search is currently an open-beta Cloudflare product** (`wrangler`'s own CLI labels every `ai-search` subcommand `[open beta]`) — expect its REST/binding surface to still be moving. Workers AI and AI Search both have free-tier allowances but are billed beyond them; check [Cloudflare's current pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) for your account rather than assuming a fixed number here, since it changes.

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

These exact flags were found by trial and error (see "Multilingual and cross-lingual by design" and "Indexing coverage" below for why) — keep them unless you have a specific reason to change them. Two hard limits worth knowing up front: `--chunk-size` has a **minimum of 64** and a **maximum of 512**; `--chunk-overlap` has a **maximum of 30**. Values outside those ranges are rejected by the API, not silently clamped.

### 2. Edit `wrangler.jsonc`

Four fields are specific to *your* account and must be changed — the committed file ships with obviously-broken placeholders so a missed field fails loudly instead of silently pointing at the original author's resources:

| Field | Before (this repo) | After (yours) |
|---|---|---|
| `kv_namespaces[0].id` | `"<YOUR_KV_NAMESPACE_ID>"` | the `id` printed by `wrangler kv namespace create` above |
| `r2_buckets[0].bucket_name` | `"cf-rag-tool-docs"` | your bucket name, if you used a different one |
| `ai_search[0].instance_name` | `"cf-rag-tool"` | your AI Search instance name, if different |
| `vars.CF_ACCOUNT_ID` | `"<YOUR_CF_ACCOUNT_ID>"` | your account ID ([find it here](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/)) |
| `name` | `"cf-rag-tool"` | your Worker's name, if you want a different one |

`vars.AI_SEARCH_INSTANCE_NAME` must always match `ai_search[0].instance_name` — they're used for two different things (the Workers binding vs. this app's own REST calls in `lib/aisearch.ts`) but must name the same instance.

Example — before:
```jsonc
"kv_namespaces": [{ "binding": "VINEXT_KV_CACHE", "id": "<YOUR_KV_NAMESPACE_ID>" }],
```
after:
```jsonc
"kv_namespaces": [{ "binding": "VINEXT_KV_CACHE", "id": "83c4915444a245599d83d93b1322d3ea" }],
```

### 3. (Optional) Set up the `CF_API_TOKEN` secret

This app works without it — see "Automatic indexing" above for what degrades gracefully (uploads still work; indexing falls back to a 15-minute scheduled sync instead of an instant trigger). To get instant indexing, follow "Setting up automatic indexing" above: create a custom API token with **AI Search:Edit** + **AI Search:Run**, then `npx wrangler secret put CF_API_TOKEN` (and a `.dev.vars` file with the same value for local dev — gitignored, never committed).

### 4. Run it

```bash
npm run dev      # local dev — talks to your real Cloudflare account, see cost warning above
npm run build && npm run deploy
```

### Troubleshooting

- **`invalid_chunk_size`** — `--chunk-size` must be between 64 and 512.
- **Chunk-overlap rejected** — `--chunk-overlap` must be 30 or less.
- **Uploads succeed but nothing is ever searchable** — check that `r2_buckets[0].remote` is `true` in `wrangler.jsonc`. If it's missing or `false`, uploads go to a local R2 *emulator* that AI Search (a real Cloudflare-side product) can never see. This one cost real debugging time — the upload API call succeeds and returns 200, so nothing *looks* wrong.
- **Wrong/missing KV namespace id** — a deploy or `wrangler dev` fails with a binding error if `kv_namespaces[0].id` is still the placeholder or points at a namespace in a different account. Re-run `npx wrangler kv namespace create VINEXT_KV_CACHE` and paste the real id in.
- **The dev server "hangs" for ~40 seconds** — it isn't hung. `vinext dev` takes roughly that long to bind all the `remote: true` bindings against live Cloudflare infrastructure before it starts serving.
- **Uploads aren't instantly searchable** — expected without `CF_API_TOKEN` configured; see "Automatic indexing" above. Worst case is a 15-minute wait, not never.

### Not suitable for

If your corpus is dense Arabic-script or Urdu source material, read "Indexing coverage: known platform limitation" further down before investing time — AI Search's chunker under-counts tokens for that script family by roughly 15×, which measurably hurts fine-grained retrieval and isn't fixable from this app's config. It's still usable (the anti-fabrication prompt keeps it from making things up), just coarser than the same setup gets for Latin-script text.

## Project structure

```
app/
  page.tsx                   # Ask panel, upload/paste panel, indexed-documents list, index status
  layout.tsx                   # Root layout, fonts, metadata
  globals.css                    # Theme tokens, RTL/script-aware font stack, Markdown answer styling
  api/ask/route.ts                 # POST — question (+ optional filenames) in, AI Search chatCompletions, cited answer out
  api/docs/route.ts                  # POST — upload file or paste text to R2 (+ trigger auto-indexing); GET — list documents
  api/docs/[key]/route.ts              # DELETE — remove a document from R2
  api/sync/route.ts                      # GET — live AI Search stats; POST — manual "sync now"
lib/
  docs.ts                                  # Allowed extensions, filename sanitizing, model id constant, filename-filter helpers
  aisearch.ts                                # Automatic indexing: REST job trigger, sync_interval backstop, debounce
  ratelimit.ts                                 # Fixed-window KV rate limiter
  clientinfo.ts                                  # Client IP extraction
  rtl.ts                                           # Script-agnostic right-to-left text detection
wrangler.jsonc                                     # Worker config: KV, AI, R2, and AI Search bindings + vars
```

## Testing notes

`lib/docs.ts`, `lib/aisearch.ts`, `lib/ratelimit.ts`, and `lib/rtl.ts` are covered by the Vitest suite (`npm test`, 45 tests). The rest was verified live against real Cloudflare infrastructure — no mocks. This tool is corpus-agnostic; the testing below uses two example corpora deliberately chosen to stress different scripts and languages: an Urdu textbook corpus (right-to-left, Arabic script) and a small English/Chinese policy corpus (Latin and CJK scripts) uploaded through the app's own upload flow. The per-document filtering evidence (a live A/B test against these same corpora) is in "Chat with a specific document" above.

### Urdu example corpus (Arabic script, RTL)

**Setup**: switched the AI Search instance's embedding model from `bge-large-en-v1.5` to `bge-m3`, uploaded four real OCR'd Urdu textbooks (AIOU Quran & Tafsir course codes 1967, 1968 full, 1968 short, 1969 — ~2.1MB / ~1.07M characters total text) directly to R2, ran `ai-search jobs create`, and confirmed via `ai-search stats` that all 4 files completed indexing with 0 errors. At `chunk_size: 512` this produced only **527 vectors**, against a naive expectation of ~2,000+ chunks for that much text — see "Indexing coverage: known platform limitation" below for the investigation. After tuning `chunk_size` down to 64 (the platform minimum), the same 4 files produce **~780 vectors**.

**Cross-verification** — read the source `.txt` files directly to find specific, checkable facts, then asked the app about them:

| Question (paraphrased) | Expected answer (from source) | App's answer | Correct? |
|---|---|---|---|
| UR: Which tafsirs cover Surah Al-Fatiha in course 1968 unit 1? | Tafsir Sanai, Tafsir Mazhari, Anwar-ul-Bayan fi Kashf Asrar al-Quran | All three named correctly, cited `1968-full` / `1968-short` | Yes |
| UR: What is course 1967 about and how many units? | Verbal/idiomatic Urdu translation of Para 30, 9 units | Correct topic and unit count, cited `1967_20260725.txt` | Yes |
| UR: Which verse and tafsirs for course 1968 unit 2? | Surah Al-Baqarah ayah 173; Ma'arif-ul-Quran (Kandhlvi), Tafheem-ul-Quran, Zia-ul-Quran | All correct | Yes |
| EN: What is course 1969 about, how many units? | Comparative study of selected verses in light of tafsir literature (2), 9 units | Correct | Yes (cross-lingual) |
| UR: Who is the author of book code 1969? | Dr. Zafar Iqbal | Correct, quoted the exact line | Yes |
| EN: Which tafsirs cover Surah Al-A'la in course 1969? | Ruh-ul-Quran, Anwar-ul-Bayan, Tibyan-ul-Quran (unit 2) | "Documents don't contain a list of specific tafsirs" — **did not find the answer** | No |

5 of 6 were correct with accurate citations. The one failure (Surah Al-A'la tafsirs) was investigated directly: retrieval for that specific question — **in both English and Urdu phrasing** — kept surfacing the 1969 book's title-page chunk instead of its table-of-contents chunk that actually lists the unit-by-unit tafsir names. A more literal query (closely matching the source wording) *does* retrieve the right chunk at score 0.91, so the content is indexed correctly — the miss is a retrieval-ranking issue with paraphrased/question-form queries against a document whose title page and short-edition sibling repeat a lot of similar boilerplate text. This is a real, observed limitation, not a hypothetical one — chunking or query-rewrite tuning could likely improve it further, but that wasn't pursued given the time budget.

**`max_num_results` verified to matter**: the question "سورۃ فاتحہ کے دوسرے نام کیا ہیں؟" ("What are the other names of Surah Fatiha?") returned *"no specific names are given in the documents"* at `max_num_results: 6`, but at `20` correctly returned **فاتحۃ الکتاب** and **ام القرآن** with a direct quote from the source. Re-run after the generalization work in this repo (script detection, Markdown rendering, the same-language system message) still returns the same correct answer, right-aligned in the Arabic-script font stack — confirming the Urdu path wasn't regressed. (It still misses سبع مثانی / سورۃ الکنز / سورۃ شفاء.) Values well above 20 are accepted by the API if you want to trade latency for recall.

**Cross-lingual retrieval**: confirmed to work for broad/general questions (course topic, unit count, author) asked in English about Urdu source material — 4 of 5 English questions above were answered correctly and cited the right Urdu file. It gets less reliable for very specific, narrowly-worded questions (see the Al-A'la failure, which also failed in Urdu, so this isn't purely a cross-lingual weakness).

### English/Chinese example corpus (Latin + CJK scripts)

To verify the app genuinely works beyond Arabic-script text, two short synthetic documents (a company storage-rental policy, one in English and one in Chinese, describing the same facts) were uploaded through the app's own upload UI/API, followed by `ai-search jobs create`; `ai-search stats --json` confirmed both completed indexing with 0 errors alongside the existing Urdu corpus.

| Question | Expected answer | App's answer | Correct? |
|---|---|---|---|
| EN: "What is the swap fee for changing a storage unit size at Wheekeep?" | 150 SAR | "The swap fee ... is **150 SAR**." Cited both the English and Chinese source files. | Yes |
| ZH: "更换仓储单元规格需要支付多少费用？" (same question, in Chinese) | 150 SAR | "更换仓储单元规格需要支付一次性 150 沙特里亚尔。" — answered in Chinese, cited both files, correct fact. | Yes |

Both answers were also confirmed visually in the browser: the Chinese question and answer render left-to-right in the system CJK font fallback (no RTL styling misapplied), and the same-language system message correctly produced a Chinese answer to a Chinese question. These two test documents were removed after verification — they aren't part of the shipped corpus.

**Markdown rendering**: a real query ("Tell me more about and what's in the book 1969") reproduced a response containing a GFM pipe table and bold text; confirmed in the browser that it renders as an actual HTML table with visible borders (scrolling inside its own container, not breaking page layout) rather than literal `|`/`**` syntax. The model also emits literal `<br>` tags inside table cells sometimes; these render as inert visible text (`<br>`) rather than being interpreted as HTML, since `react-markdown` doesn't render raw HTML unless `rehype-raw` is added (it isn't).

**Reranking A/B test**: see "Multilingual and cross-lingual by design" above — `bge-reranker-base` broke cross-lingual retrieval outright and was left off.

**Same-language generation nudge**: `/api/ask` sends a system message asking the model to answer in the question's language. Verified directly: the Chinese question above got a Chinese answer (with correctly-used Chinese numerals/currency phrasing), and the Urdu re-test above still answers in Urdu. This is a cheap, low-risk addition — a single system message — not a deep change to the retrieval or generation pipeline.

**Response caching**: AI Search can cache query responses (`cache_threshold: "close_enough"`, TTL configurable via `cache_ttl`). This was hit directly during testing — an early broken response (reranker on) stayed cached and kept being returned even after reranking was turned back off, until cache was temporarily disabled to get a clean re-test. Caching is now left **off** in this instance's config (see "Multilingual and cross-lingual by design" above) rather than just disabled for testing — a "close enough" cache hit risks answering a different-but-similar question with a stale, wrong answer, which is a bad tradeoff for a corpus where fabricated-sounding wrong answers are the exact failure mode this app is trying to avoid.

### Indexing coverage: known platform limitation (Urdu/Arabic-script chunking)

A user reported that the app confidently invented hadith citations (fake `البخاری`/`ابن ماجه` attributions, a made-up hadith wording, and a wrong Quran citation) when asked "اللہ سے ڈرنے والے کا مصداق" ("who is meant by the one who fears Allah"), even though the correct answer — citing **الاعلیٰ : 10** — exists verbatim in `1969_20260725.txt`. Investigating why retrieval missed it uncovered two separate, compounding problems:

1. **`chunk_size` is measured in tokens, not characters**, and it was set to 512 under the (reasonable-looking, but wrong) assumption that it meant characters. At `chunk_size: 512` the 4-book corpus (~1.07M characters) produced only **527 vectors**, against a back-of-envelope expectation of ~2,000+ chunks. `npx wrangler ai-search jobs logs` showed every job completing cleanly (`completed: 4, error: 0, skipped: 0`) — the shortfall was never surfaced as an error.
2. **AI Search's chunker under-counts tokens for Urdu/Arabic script by roughly 15×**, even after fixing (1). This was confirmed directly, not inferred: two synthetic test files of **identical length (6,000 characters)** — one in English, one in Urdu — were uploaded and indexed with the exact same `chunk_size`. The English file produced **45 chunks**; the Urdu file produced **3**. That means a chunk boundary that spans ~130 characters of English spans roughly **2,000 characters** of Urdu at the same nominal `chunk_size`. Since `wrangler ai-search update --chunk-size` refuses anything below 64 (`Too small: expected number to be >=64`), there is no config value low enough to bring Urdu chunk size down to what a Latin-script corpus gets "for free" at the default.

The practical effect: for this corpus, even the smallest chunks AI Search will produce are large enough that a single-sentence fact (like the "الاعلیٰ : 10" passage) sits diluted inside a chunk containing several unrelated surrounding sentences, dragging its cosine similarity to specific queries down into the same 0.5–0.65 band as loosely-related chunks. In targeted testing — restricting search to the exact source file and querying with the **verbatim source sentence itself** (score threshold 0, up to 50 results) — the chunk containing that specific sentence never appeared in results at any `chunk_size` tried (512, 128, 64). Splitting the source file into four smaller files (~130KB each) was also tried, on the hypothesis that there might be a hard per-file chunk cap; it did **not** fix retrievability, which rules that hypothesis out and confirms the root cause is the token-counting/chunking behavior itself, not a per-file limit.

**What was changed**: `chunk_size` lowered from 512 to **64** (platform minimum). This is a real, measured improvement — vector count rose from 527 to **~780**, and general-purpose retrieval quality improved (see the Al-A'la and Surah Fatiha tests above, both re-verified after this change) — but it does not fully close the gap for narrowly-specific facts in this Urdu corpus, because the 15× token-counting disparity persists at any allowed `chunk_size`. No further config lever exists in `wrangler ai-search update`/`create` to push Urdu chunks smaller.

**This is a genuine Cloudflare AI Search platform limitation for Arabic-script content**, not a bug in this app's code, and not fixable by file-splitting, hybrid-search settings, or cache settings. Anyone indexing dense Arabic-script or Urdu source material with AI Search should expect coarser effective chunking (and correspondingly worse fine-grained retrieval) than the same `chunk_size` gives for Latin-script text, with no current workaround short of Cloudflare fixing the chunker's token counting for these scripts. Given this can't be fully fixed at the retrieval layer, the anti-fabrication system prompt (see above) is the load-bearing mitigation: when the specific fact isn't well-isolated in any retrieved chunk, the app now says so instead of inventing one.

**Known limitations**:
- **Urdu/Arabic-script chunking gap** — see above. Specific, narrowly-phrased facts in the Urdu corpus are not 100% retrievable even after tuning `chunk_size` to its platform minimum; the app is expected to (and, per testing, does) decline rather than fabricate in these cases.
- OCR noise is visible in the Urdu test corpus's source text (garbled headers, stray line-numbers-as-content, repeated boilerplate across sibling editions). This didn't visibly corrupt any tested factual answers, but it's real and could bite on other queries against similarly noisy source material.
- Indexing is now automatic (see "Automatic indexing" above), but instant triggering still needs a one-time `CF_API_TOKEN` setup; without it, the worst case is a 15-minute wait for the scheduled sync rather than a manual CLI step.
- The Al-A'la-style retrieval miss above means specific, narrowly-phrased questions aren't 100% reliable even when the answer is indexed correctly, in any language.
- `indexing_options.keyword_tokenizer` (currently `"porter"`, English-only) has no `wrangler` flag to change — this is why hybrid search is left off rather than fixed; see "Multilingual and cross-lingual by design" above.
- Script/direction detection (`lib/rtl.ts`) explicitly covers Arabic, Hebrew, Thaana, and Syriac; other scripts (CJK, Devanagari, Cyrillic, etc.) are left-to-right by default, which matches their natural direction, but they don't get a dedicated web font — they render via the reader's system font stack (see the comment in `app/globals.css` for the tradeoff).
