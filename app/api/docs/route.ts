import { env } from "cloudflare:workers";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { getClientIp } from "@/lib/clientinfo";
import { checkRateLimit } from "@/lib/ratelimit";
import {
  isAllowedExtension,
  sanitizeFilename,
  titleToKey,
  maxBytesFor,
  formatMiB,
  extensionOf,
  MAX_PASTE_CHARS,
  ALLOWED_EXTENSIONS,
  listAllObjects,
} from "@/lib/docs";
import { triggerIndexingJob, ensureFastSyncInterval, getPendingRemovals } from "@/lib/aisearch";

const INGEST_RATE_LIMIT = { limit: 20, windowSeconds: 86400 };

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const rate = await checkRateLimit(env.VINEXT_KV_CACHE, `ingest:${ip}`, INGEST_RATE_LIMIT);
  if (!rate.allowed) {
    return Response.json(
      { error: `Rate limit exceeded. Try again in ${rate.resetSeconds}s.` },
      { status: 429 },
    );
  }

  const formData = await request.formData().catch(() => null);
  if (!formData) {
    return Response.json({ error: "Expected multipart form data." }, { status: 400 });
  }

  const file = formData.get("file");
  const title = formData.get("title")?.toString().trim();
  const text = formData.get("text")?.toString().trim();

  let key: string;
  let body: ArrayBuffer | string;
  let contentType: string;

  if (file instanceof Blob && file.size > 0) {
    const filename = "name" in file ? (file as File).name : "upload";
    if (!isAllowedExtension(filename)) {
      return Response.json(
        { error: `Unsupported file type. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}` },
        { status: 400 },
      );
    }
    // AI Search skips files over its own limit, so refuse them here instead of
    // storing a file that would never become searchable. A PDF may be larger
    // only when OCR is on, so look that up for PDFs.
    let ocrEnabled = false;
    if (extensionOf(filename) === "pdf") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const info = (await env.AI_SEARCH.info().catch(() => null)) as any;
      ocrEnabled = info?.indexing_options?.use_ocr === true;
    }
    const limit = maxBytesFor(filename, ocrEnabled);
    if (file.size > limit) {
      const hint =
        extensionOf(filename) === "pdf" && !ocrEnabled
          ? " Turn on OCR in the library panel to allow PDFs up to 10 MB."
          : "";
      return Response.json(
        { error: `File is too large (max ${formatMiB(limit)} for this file type).${hint}` },
        { status: 413 },
      );
    }
    key = sanitizeFilename(filename);
    body = await file.arrayBuffer();
    contentType = file.type || "application/octet-stream";
  } else if (title && text) {
    if (text.length > MAX_PASTE_CHARS) {
      return Response.json({ error: `Text is too long (max ${MAX_PASTE_CHARS} characters).` }, { status: 413 });
    }
    key = titleToKey(title);
    body = text;
    contentType = "text/plain; charset=utf-8";
  } else {
    return Response.json({ error: "Provide either a file or a title + text." }, { status: 400 });
  }

  // Avoid clobbering an existing object with the same name.
  const existing = await env.DOCS_BUCKET.head(key);
  if (existing) {
    const dot = key.lastIndexOf(".");
    const stem = dot === -1 ? key : key.slice(0, dot);
    const ext = dot === -1 ? "" : key.slice(dot);
    key = `${stem}-${crypto.randomUUID().slice(0, 8)}${ext}`;
  }

  await env.DOCS_BUCKET.put(key, body, { httpMetadata: { contentType } });

  // Best-effort, non-blocking: try to make the new upload searchable right
  // away (needs CF_API_TOKEN — see lib/aisearch.ts) and make sure the
  // instance's own scheduled sync is as fast as AI Search allows even when
  // it isn't. Neither call can fail this request — both swallow their own
  // errors — so this is scheduled via waitUntil rather than awaited.
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

  return Response.json({ key, status: "uploaded", note: "AI Search will index this shortly." });
}

/**
 * Lists R2 objects — the document *library* — plus, separately, any
 * filenames that were deleted from R2 but aren't yet confirmed removed
 * from AI Search's index (see lib/aisearch.ts "Pending removals"). These
 * are two different things: R2 is the source of truth for what's in the
 * library; AI Search's index (which answers questions) can lag behind it
 * by up to one sync. Returning both lets the UI say so honestly instead of
 * presenting the R2 listing as "what's indexed."
 */
export async function GET() {
  const objects = await listAllObjects(env.DOCS_BUCKET);
  const docs = objects
    .map((obj) => ({ key: obj.key, size: obj.size, uploaded: obj.uploaded.toISOString() }))
    .sort((a, b) => b.uploaded.localeCompare(a.uploaded));

  const stats = await env.AI_SEARCH.stats().catch(() => null);
  const pendingRemovals = await getPendingRemovals(env, stats?.last_activity);

  return Response.json({ docs, pendingRemovals });
}
