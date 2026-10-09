import { env } from "cloudflare:workers";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { triggerIndexingJob, ensureFastSyncInterval, recordPendingRemoval } from "@/lib/aisearch";
import { contentTypeForKey } from "@/lib/docs";

function decodeKey(key: string): string | null {
  try {
    return decodeURIComponent(key);
  } catch {
    return null;
  }
}

/**
 * Opens a stored document. Content type is decided from the file extension,
 * never from whatever the uploader claimed, and the response is sandboxed so
 * an uploaded file can never run script in this app's origin.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const decoded = decodeKey(key);
  if (decoded === null) {
    return Response.json({ error: "Invalid document name." }, { status: 400 });
  }

  const object = await env.DOCS_BUCKET.get(decoded);
  if (!object) {
    return Response.json({ error: "Document not found." }, { status: 404 });
  }

  const { type, inline } = contentTypeForKey(decoded);
  const headers = new Headers();
  headers.set("content-type", type);
  headers.set(
    "content-disposition",
    `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(decoded)}`,
  );
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "sandbox");
  headers.set("cache-control", "private, max-age=60");
  return new Response(object.body, { headers });
}

/**
 * Deleting an R2 object does not remove its vectors from AI Search's index
 * until the next sync (confirmed empirically — see lib/aisearch.ts). So a
 * delete here does two things beyond the R2 delete itself: (1) best-effort
 * trigger an indexing job (same debounced mechanism as uploads) so the
 * index converges quickly, and (2) record the key as "pending removal" in
 * KV so GET /api/docs can tell the UI the truth about the mismatch instead
 * of silently going quiet about it.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const decoded = decodeKey(key);
  if (decoded === null) {
    return Response.json({ error: "Invalid document name." }, { status: 400 });
  }
  await env.DOCS_BUCKET.delete(decoded);

  // Recorded synchronously (a single fast KV write) so a GET /api/docs
  // immediately after this response reliably sees the pending removal —
  // unlike the indexing-job trigger below, which involves a network round
  // trip and is fine to finish after the response.
  await recordPendingRemoval(env, decoded).catch(() => undefined);

  const ctx = getRequestExecutionContext();
  const background = Promise.all([
    triggerIndexingJob(env).catch(() => undefined),
    ensureFastSyncInterval(env).catch(() => undefined),
  ]);
  if (ctx) {
    ctx.waitUntil(background);
  } else {
    await background;
  }

  return Response.json({ ok: true });
}
