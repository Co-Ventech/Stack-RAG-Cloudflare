# stacks: ask your documents

Upload documents, then ask questions about them in any language. Answers come only from your files and cite their sources, with the matching passage on request.

Built on Cloudflare: AI Search (retrieval and answers), R2 (file storage), KV (rate limits) and Workers AI, using the Vinext framework (Next.js-style on Cloudflare Workers).

## Run it

You need Node 22+ and a Cloudflare account.

```bash
npm install
npx wrangler login
npm run dev          # http://127.0.0.1:3000
```

`wrangler.jsonc` already points at this account's resources: the KV namespace, the R2 bucket `cf-rag-tool-docs` and the AI Search instance `cf-rag-tool`. For a different account, create your own and replace those values.

The app talks to the real Cloudflare services even when run locally (`remote: true`), so usage is billed to your account.

## What you can do

- **Chat with one document:** click a file's name in the left panel. Tick several to ask across them.
- **Follow-up questions:** each file or selection keeps its own conversation, saved in your browser.
- **Evidence:** every answer lists its sources with a relevance bar. "Show passage" shows the matching text, and the file icon opens the original.
- **Handy extras:** Stop and Try again, Copy answer, Regenerate, Export as Markdown, and a filter box for long lists.
- **Scanned files (OCR) switch:** off by default. It only matters for scanned PDFs. Changing it re-indexes everything.

## Adding documents

- **Types and size:** PDF, Word, ODT, text, Markdown and images. Up to 10 MB for text (and PDFs with OCR on), 4 MB for everything else, which are Cloudflare AI Search's own limits.
- **Indexing time:** a new file takes about 1 to 2 minutes to become searchable. The status card shows progress.
- **Locally:** uploads and **Sync now** start indexing for you through your logged-in wrangler. This helper only exists while `npm run dev` is running.
- **Deployed copy:** needs a `CF_API_TOKEN` secret (AI Search edit and run access) to start indexing on demand. Without it, files are picked up on AI Search's own schedule, about every 15 minutes.
- Limits per visitor: 20 uploads a day and 60 questions an hour.

## Good to know

- **Summaries are approximate:** each answer is written from about 20 small passages, so "summarize this document" for a long file can miss parts. Specific questions work much better.
- **Images are described, not transcribed:** text inside a picture, especially Urdu, may be wrong or missing.
- **Cloudflare AI Search is in beta:** an answer can occasionally time out. Use Try again.

## Tests

```bash
npm test             # 83 tests
```

## Where things are

- `app/page.tsx`: the page
- `app/api/`: ask, docs, sync and settings routes
- `lib/`: file rules, indexing helpers, rate limiting, right-to-left text detection
- `README.original.md`: the original, longer README
