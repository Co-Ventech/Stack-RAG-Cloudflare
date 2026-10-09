import { env } from "cloudflare:workers";
import { getClientIp } from "@/lib/clientinfo";
import { checkRateLimit } from "@/lib/ratelimit";

const SETTINGS_RATE_LIMIT = { limit: 6, windowSeconds: 3600 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyInfo = any;

function readOcr(info: AnyInfo): boolean | null {
  const v = info?.indexing_options?.use_ocr;
  return typeof v === "boolean" ? v : null;
}

/** Whether OCR is on for this AI Search instance. OCR turns scanned PDFs and
 * images into searchable text. */
export async function GET() {
  try {
    const info = (await env.AI_SEARCH.info()) as AnyInfo;
    return Response.json({ ok: true, ocr: readOcr(info) });
  } catch (err) {
    console.error("[settings] info() failed", err);
    return Response.json({ ok: false, error: "Couldn't read the AI Search configuration." }, { status: 502 });
  }
}

/**
 * Turns OCR on or off. AI Search re-indexes every document when this changes,
 * which takes a while and is billed as ingestion, so it is rate-limited and
 * the UI asks for confirmation first.
 */
export async function POST(request: Request) {
  const ip = getClientIp(request);
  const rate = await checkRateLimit(env.VINEXT_KV_CACHE, `settings:${ip}`, SETTINGS_RATE_LIMIT);
  if (!rate.allowed) {
    return Response.json({ error: `Too many changes. Try again in ${rate.resetSeconds}s.` }, { status: 429 });
  }

  const body = (await request.json().catch(() => null)) as { ocr?: unknown } | null;
  if (typeof body?.ocr !== "boolean") {
    return Response.json({ error: "Send { \"ocr\": true } or { \"ocr\": false }." }, { status: 400 });
  }

  try {
    const info = (await env.AI_SEARCH.info()) as AnyInfo;
    if (readOcr(info) === body.ocr) {
      return Response.json({ ok: true, ocr: body.ocr, changed: false });
    }
    // Keep the other indexing options (e.g. keyword_tokenizer) exactly as they are.
    const current = info?.indexing_options ?? {};
    await (env.AI_SEARCH as AnyInfo).update({ indexing_options: { ...current, use_ocr: body.ocr } });
    const after = (await env.AI_SEARCH.info()) as AnyInfo;
    return Response.json({ ok: true, ocr: readOcr(after), changed: true });
  } catch (err) {
    console.error("[settings] update failed", err);
    return Response.json({ ok: false, error: "Couldn't change the OCR setting. Please try again." }, { status: 502 });
  }
}
