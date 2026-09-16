import { env } from "cloudflare:workers";
import { getClientIp } from "@/lib/clientinfo";
import { checkRateLimit } from "@/lib/ratelimit";
import { EMBEDDING_MODEL, CHAT_MODEL, TOP_K, buildRagMessages, type SourceChunk } from "@/lib/rag";

const ASK_RATE_LIMIT = { limit: 60, windowSeconds: 3600 };

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const rate = await checkRateLimit(env.VINEXT_KV_CACHE, `ask:${ip}`, ASK_RATE_LIMIT);
  if (!rate.allowed) {
    return Response.json(
      { error: `Rate limit exceeded. Try again in ${rate.resetSeconds}s.` },
      { status: 429 },
    );
  }

  const body = (await request.json().catch(() => null)) as { question?: string } | null;
  const question = body?.question?.trim();
  if (!question) {
    return Response.json({ error: "A question is required." }, { status: 400 });
  }

  const embedded = (await env.AI.run(EMBEDDING_MODEL, { text: [question] })) as { data: number[][] };
  const queryVector = embedded.data[0];

  const results = await env.VECTORIZE.query(queryVector, { topK: TOP_K, returnMetadata: "all" });

  if (results.matches.length === 0) {
    return Response.json({
      answer: "No documents have been ingested yet — add one first, then ask again.",
      sources: [],
    });
  }

  const context: SourceChunk[] = results.matches.map((m) => ({
    title: String(m.metadata?.title ?? "untitled"),
    chunkIndex: Number(m.metadata?.chunkIndex ?? 0),
    text: String(m.metadata?.text ?? ""),
    score: m.score,
  }));

  const chatResponse = (await env.AI.run(CHAT_MODEL, {
    messages: buildRagMessages(question, context),
    max_tokens: 400,
  })) as { response?: string; result?: { response?: string }; choices?: { message?: { content?: string } }[] };

  const answer =
    (
      chatResponse.response ??
      chatResponse.result?.response ??
      chatResponse.choices?.[0]?.message?.content ??
      ""
    ).trim() || "Sorry, I couldn't generate an answer from the ingested documents.";

  return Response.json({
    answer,
    sources: context.map((c) => ({ title: c.title, chunkIndex: c.chunkIndex, score: c.score })),
  });
}
