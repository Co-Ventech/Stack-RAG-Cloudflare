import { env } from "cloudflare:workers";
import { docKey, type DocMeta } from "@/lib/docs";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const raw = await env.DOCS_KV.get(docKey(id));
  if (!raw) {
    return Response.json({ error: "Document not found." }, { status: 404 });
  }

  const meta = JSON.parse(raw) as DocMeta;
  if (meta.vectorIds.length > 0) {
    await env.VECTORIZE.deleteByIds(meta.vectorIds);
  }
  await env.DOCS_KV.delete(docKey(id));

  return Response.json({ ok: true });
}
