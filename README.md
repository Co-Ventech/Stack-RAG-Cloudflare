# cf-rag-tool

A small retrieval-augmented generation tool: paste in documents, ask questions, get answers grounded in what you've indexed — with citations back to the source chunk. Built entirely on Cloudflare's own stack, no third-party AI API keys.

Built on [Vinext](https://github.com/cloudflare/vinext) — Cloudflare's experimental Vite plugin that reimplements the Next.js API surface, deployed natively to Cloudflare Workers.

## How it works

1. **Ingest** — paste a title and some text. The text is split into overlapping ~800-character chunks, each embedded with [`bge-base-en-v1.5`](https://developers.cloudflare.com/workers-ai/models/bge-base-en-v1.5/) (768-dim), and stored in a [Vectorize](https://developers.cloudflare.com/vectorize/) index alongside the chunk text and title as metadata.
2. **Ask** — a question is embedded the same way, the 5 nearest chunks are retrieved from Vectorize, and [`gpt-oss-20b`](https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/) is prompted to answer using *only* that context, citing the source chunks. If nothing relevant is retrieved, it says so rather than making something up.

## Features

- Paste-to-index documents, no file upload parsing needed
- Cited answers (source title + chunk index) for every response
- Remove an indexed document (deletes its vectors from Vectorize, not just the KV record)
- Rate limited per IP: 20 document ingests/day, 60 questions/hour

## Stack

- Vinext (App Router, Route Handlers) + TypeScript + Tailwind CSS
- Workers AI (`bge-base-en-v1.5` embeddings, `gpt-oss-20b` generation) via the `AI` binding
- Vectorize for the vector index
- Workers KV for document metadata and rate limiting

## Getting started

```bash
npm install
npm run dev
```

Workers AI and Vectorize bindings always call Cloudflare's real endpoints — even in local dev — so you need to be logged in (`npx wrangler login`).

## Deploying to Cloudflare Workers

1. `npx wrangler login`
2. Create the KV namespaces and the Vectorize index:
   ```bash
   npx wrangler kv namespace create cf_rag_tool_cache
   npx wrangler kv namespace create cf_rag_tool_docs
   npx wrangler vectorize create cf-rag-tool-index --dimensions=768 --metric=cosine
   ```
   Paste the returned KV `id`s into `wrangler.jsonc`.
3. `npm run build && npm run deploy`

## Project structure

```
app/
  page.tsx                   # Ask panel, ingest panel, indexed-documents list
  api/ask/route.ts             # POST — embed question, retrieve context, generate a cited answer
  api/docs/route.ts              # POST — chunk + embed + index a document; GET — list documents
  api/docs/[id]/route.ts           # DELETE — remove a document's vectors and metadata
lib/
  rag.ts                              # Chunking, prompt building, model ids
  docs.ts                               # Document metadata shape and KV key scheme
  ratelimit.ts                            # Fixed-window KV rate limiter
  clientinfo.ts                             # Client IP extraction
wrangler.jsonc                               # Worker config: KV, AI, and Vectorize bindings
```

## Testing notes

`lib/rag.ts` (chunking, prompt construction) and `lib/ratelimit.ts` are covered by the Vitest suite (`npm test`). The full pipeline was also verified live against real Cloudflare infrastructure: ingesting a sample vacation-policy document, confirming it landed in the Vectorize index (`wrangler vectorize info`), asking a question answered correctly from it with the right citation, confirming an unrelated question is correctly declined rather than hallucinated, and confirming delete removes both the Vectorize vectors and the KV record. One thing worth knowing: a freshly-ingested document can take several seconds before Vectorize indexing catches up and it becomes queryable — a query issued immediately after ingest may briefly return no matches.
