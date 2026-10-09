import { env } from "cloudflare:workers";
import { getClientIp } from "@/lib/clientinfo";
import { checkRateLimit } from "@/lib/ratelimit";
import {
  CHAT_MODEL,
  MAX_QUESTION_CHARS,
  buildFilenameFilter,
  validateFilenames,
  dedupeSources,
  listAllObjects,
  sanitizeHistory,
  isRetryableSearchError,
  isSearchTimeout,
} from "@/lib/docs";

const ASK_RATE_LIMIT = { limit: 60, windowSeconds: 3600 };

// A retry only makes sense for a *fast* transient failure. A timeout already
// burned ~30s, and a second attempt would double the wait.
const RETRY_ONLY_IF_FASTER_THAN_MS = 10_000;

const SYSTEM_PROMPT =
  "Answer in the same language the question was asked in, regardless of what " +
  "language the source documents are in. Prefer short prose and simple lists over " +
  "large tables unless a table is clearly the clearest way to present the answer. " +
  "Answer only using the retrieved context provided to you. Never invent or guess " +
  "citations, hadith, verse numbers, or references that are not literally present in " +
  "the retrieved context, even if they sound plausible. If the retrieved context does " +
  "not contain the answer, say so plainly instead of fabricating one.";

interface AiSearchChunk {
  text?: string;
  score?: number;
  item?: { key?: string };
}

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const rate = await checkRateLimit(env.VINEXT_KV_CACHE, `ask:${ip}`, ASK_RATE_LIMIT);
  if (!rate.allowed) {
    return Response.json(
      { error: `Rate limit exceeded. Try again in ${rate.resetSeconds}s.` },
      { status: 429 },
    );
  }

  const body = (await request.json().catch(() => null)) as
    | { question?: string; filenames?: unknown; history?: unknown }
    | null;
  const question = body?.question?.trim();
  if (!question) {
    return Response.json({ error: "A question is required." }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return Response.json(
      { error: `Question is too long (max ${MAX_QUESTION_CHARS} characters).` },
      { status: 413 },
    );
  }

  // Fetched unconditionally (not just when scoping was requested): also
  // needed below to flag citations for documents that were deleted from R2
  // but haven't dropped out of the index yet (see lib/aisearch.ts "Pending
  // removals") — an answer can still cite a no-longer-present file, and that
  // must be visible, not silently hidden.
  const existingKeys = (await listAllObjects(env.DOCS_BUCKET)).map((o) => o.key);

  // Optional scoping to specific document(s) — "chat with this book only".
  // Never trust the request's filenames directly: only ones that actually
  // exist in the bucket are allowed through to the AI Search filter.
  const requestedFilenames = Array.isArray(body?.filenames)
    ? body.filenames.filter((f): f is string => typeof f === "string")
    : [];
  const scopedTo = requestedFilenames.length > 0 ? validateFilenames(requestedFilenames, existingKeys) : [];
  const filters = buildFilenameFilter(scopedTo);

  // Earlier turns of the conversation, so follow-up questions ("and the
  // second one?") make sense. Validated and capped; never trusted as-is.
  const history = sanitizeHistory(body?.history);

  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    ...history,
    { role: "user" as const, content: question },
  ];

  let result: Awaited<ReturnType<typeof env.AI_SEARCH.chatCompletions>> | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const startedAt = Date.now();
    try {
      result = await env.AI_SEARCH.chatCompletions({
        messages,
        model: CHAT_MODEL,
        ai_search_options: {
          retrieval: { max_num_results: 20, ...(filters ? { filters } : {}) },
        },
      });
      break;
    } catch (err) {
      lastError = err;
      console.error(`[ask] AI Search call failed (attempt ${attempt})`, err);
      const fast = Date.now() - startedAt < RETRY_ONLY_IF_FASTER_THAN_MS;
      if (attempt === 2 || !fast || !isRetryableSearchError(err)) break;
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }

  if (!result) {
    if (isSearchTimeout(lastError)) {
      return Response.json(
        {
          error:
            "Cloudflare AI Search took too long to respond (it is still in beta and can be slow at times). Please try again.",
          retryable: true,
        },
        { status: 504 },
      );
    }
    return Response.json(
      { error: "The search service couldn't answer right now. Please try again in a moment.", retryable: true },
      { status: 502 },
    );
  }

  const answer = result.choices?.[0]?.message?.content?.trim() || "I couldn't generate an answer.";
  const chunks = (result.chunks ?? []) as AiSearchChunk[];

  // One entry per unique file (dedupeSources), not one per retrieved chunk —
  // with max_num_results: 20 the same file can match 5-6+ chunks. `removed`
  // flags a citation whose file no longer exists in R2 (deleted, index
  // hasn't caught up yet) so the UI can say so instead of hiding it. Each
  // entry also carries the best-matching passage so the UI can show the
  // actual evidence behind the answer.
  const existing = new Set(existingKeys);
  const sources = dedupeSources(
    chunks.map((c) => ({ key: c.item?.key ?? "unknown", score: c.score, text: c.text })),
  ).map((s) => ({ ...s, removed: !existing.has(s.key) }));

  return Response.json({
    answer,
    sources,
    scopedTo,
  });
}
