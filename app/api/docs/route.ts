import { env } from "cloudflare:workers";
import { getClientIp } from "@/lib/clientinfo";
import { checkRateLimit } from "@/lib/ratelimit";
import { EMBEDDING_MODEL, MAX_DOC_CHARS, chunkText, docVectorId } from "@/lib/rag";
import { docKey, type DocMeta } from "@/lib/docs";

const INGEST_RATE_LIMIT = { limit: 20, windowSeconds: 86400 };
const EMBED_BATCH_SIZE = 50;

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const rate = await checkRateLimit(env.DOCS_KV, `ingest:${ip}`, INGEST_RATE_LIMIT);
  if (!rate.allowed) {
    return Response.json(
      { error: `Rate limit exceeded. Try again in ${rate.resetSeconds}s.` },
      { status: 429 },
    );
  }

  const body = (await request.json().catch(() => null)) as { title?: string; text?: string } | null;
  const title = body?.title?.trim();
  const text = body?.text?.trim();

  if (!title || !text) {
    return Response.json({ error: "Both a title and document text are required." }, { status: 400 });
  }
  if (text.length > MAX_DOC_CHARS) {
    return Response.json({ error: `Document is too large (max ${MAX_DOC_CHARS} characters).` }, { status: 413 });
  }

  const chunks = chunkText(text);
  if (chunks.length === 0) {
    return Response.json({ error: "Couldn't extract any text to index." }, { status: 400 });
  }

  const docId = crypto.randomUUID();
  const vectors: { id: string; values: number[]; metadata: Record<string, string | number> }[] = [];

  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const embedded = (await env.AI.run(EMBEDDING_MODEL, { text: batch })) as { data: number[][] };
    embedded.data.forEach((values, j) => {
      const chunkIndex = i + j;
      vectors.push({
        id: docVectorId(docId, chunkIndex),
        values,
        metadata: { docId, title, chunkIndex, text: batch[j] },
      });
    });
  }

  await env.VECTORIZE.upsert(vectors);

  const meta: DocMeta = {
    id: docId,
    title,
    createdAt: new Date().toISOString(),
    chunkCount: chunks.length,
    vectorIds: vectors.map((v) => v.id),
  };
  await env.DOCS_KV.put(docKey(docId), JSON.stringify(meta));

  return Response.json({ id: docId, title, chunkCount: chunks.length });
}

export async function GET() {
  const list = await env.DOCS_KV.list({ prefix: "doc:" });
  const docs = await Promise.all(
    list.keys.map(async (k) => {
      const raw = await env.DOCS_KV.get(k.name);
      return raw ? (JSON.parse(raw) as DocMeta) : null;
    }),
  );
  const sorted = docs
    .filter((d): d is DocMeta => d !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ id, title, createdAt, chunkCount }) => ({ id, title, createdAt, chunkCount }));

  return Response.json({ docs: sorted });
}
