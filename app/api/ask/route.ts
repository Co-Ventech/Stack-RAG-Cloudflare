import { env } from "cloudflare:workers";
import { getClientIp } from "@/lib/clientinfo";
import { checkRateLimit } from "@/lib/ratelimit";
import { CHAT_MODEL, buildFilenameFilter, validateFilenames, dedupeSources } from "@/lib/docs";

const ASK_RATE_LIMIT = { limit: 60, windowSeconds: 3600 };

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
    | { question?: string; filenames?: unknown }
    | null;
  const question = body?.question?.trim();
  if (!question) {
    return Response.json({ error: "A question is required." }, { status: 400 });
  }

  // Fetched unconditionally (not just when scoping was requested): also
  // needed below to flag citations for documents that were deleted from R2
  // but haven't dropped out of the index yet (see lib/aisearch.ts "Pending
  // removals" and Bug 2 in the project notes) — an answer can still cite a
  // no-longer-present file, and that must be visible, not silently hidden.
  const existingKeys = (await env.DOCS_BUCKET.list()).objects.map((o) => o.key);

  // Optional scoping to specific document(s) — "chat with this book only".
  // Never trust the request's filenames directly: only ones that actually
  // exist in the bucket are allowed through to the AI Search filter.
  const requestedFilenames = Array.isArray(body?.filenames)
    ? body.filenames.filter((f): f is string => typeof f === "string")
    : [];
  const scopedTo = requestedFilenames.length > 0 ? validateFilenames(requestedFilenames, existingKeys) : [];
  const filters = buildFilenameFilter(scopedTo);

  const result = await env.AI_SEARCH.chatCompletions({
    messages: [
      {
        role: "system",
        content:
          "Answer in the same language the question was asked in, regardless of what " +
          "language the source documents are in. Prefer short prose and simple lists over " +
          "large tables unless a table is clearly the clearest way to present the answer. " +
          "Answer only using the retrieved context provided to you. Never invent or guess " +
          "citations, hadith, verse numbers, or references that are not literally present in " +
          "the retrieved context, even if they sound plausible. If the retrieved context does " +
          "not contain the answer, say so plainly instead of fabricating one.",
      },
      { role: "user", content: question },
    ],
    model: CHAT_MODEL,
    ai_search_options: {
      retrieval: { max_num_results: 20, ...(filters ? { filters } : {}) },
    },
  });

  const answer = result.choices?.[0]?.message?.content?.trim() || "I couldn't generate an answer.";
  const chunks = (result.chunks ?? []) as AiSearchChunk[];

  // One chip per unique file (dedupeSources), not one per retrieved chunk —
  // with max_num_results: 20 the same file can match 5-6+ chunks. `removed`
  // flags a citation whose file no longer exists in R2 (deleted, index
  // hasn't caught up yet) so the UI can say so instead of hiding it.
  const existing = new Set(existingKeys);
  const sources = dedupeSources(chunks.map((c) => ({ key: c.item?.key ?? "unknown", score: c.score }))).map(
    (s) => ({ ...s, removed: !existing.has(s.key) }),
  );

  return Response.json({
    answer,
    sources,
    scopedTo,
  });
}
