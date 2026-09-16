import { env } from "cloudflare:workers";
import { getClientIp } from "@/lib/clientinfo";
import { checkRateLimit } from "@/lib/ratelimit";
import { triggerIndexingJob, ensureFastSyncInterval } from "@/lib/aisearch";

const SYNC_RATE_LIMIT = { limit: 10, windowSeconds: 3600 };

/**
 * Reports live indexing status (queued/running/completed/error counts plus
 * vector count) so the UI can show real progress.
 */
export async function GET() {
  try {
    const stats = await env.AI_SEARCH.stats();
    return Response.json({ ok: true, stats });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to fetch stats." },
      { status: 502 },
    );
  }
}

/**
 * Manual "sync now" — lets the user force an indexing pass without the
 * CLI. Needs an account-scoped API token (`CF_API_TOKEN` secret — the
 * Workers binding's `jobs.create()` throws at runtime, confirmed directly,
 * even though it's in the binding's TypeScript types) since AI Search's
 * job-creation endpoint isn't exposed through the binding. Without that
 * secret this degrades gracefully: it still lowers the instance's own
 * scheduled sync interval to the fastest allowed value (no token needed
 * for that part), and reports that a manual trigger isn't available rather
 * than a 500.
 */
export async function POST(request: Request) {
  const ip = getClientIp(request);
  const rate = await checkRateLimit(env.VINEXT_KV_CACHE, `sync:${ip}`, SYNC_RATE_LIMIT);
  if (!rate.allowed) {
    return Response.json(
      { error: `Rate limit exceeded. Try again in ${rate.resetSeconds}s.` },
      { status: 429 },
    );
  }

  await ensureFastSyncInterval(env).catch(() => undefined);
  const result = await triggerIndexingJob(env);
  return Response.json(result);
}
