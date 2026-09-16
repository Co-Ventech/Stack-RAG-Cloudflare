// Automatic indexing helpers.
//
// Cloudflare AI Search re-syncs from its R2 source on its own schedule
// (`sync_interval`, minimum 900s per the REST/binding `update()` call —
// confirmed empirically: 900 and 1800 are accepted, 899 and 1000 are
// rejected with "Invalid input", so the instance only accepts multiples of
// 900 seconds). Two independent mechanisms make new uploads searchable
// sooner than waiting for that scheduled sync:
//
// 1. `ensureFastSyncInterval` — lowers the instance's own scheduled sync to
//    the fastest allowed interval (15 minutes) using `env.AI_SEARCH.update()`
//    directly. This is a *Workers binding* call, not a REST call, so it
//    needs **no API token** — confirmed by calling it with no CF_API_TOKEN
//    secret configured at all. This is the zero-configuration backstop:
//    even a fresh deploy with no secrets set gets 15-minute auto-indexing.
//
// 2. `triggerIndexingJob` — calls the AI Search REST API directly
//    (`POST .../ai-search/namespaces/default/instances/{instance}/jobs`)
//    right after an upload, so the new document is searchable within
//    seconds instead of minutes. This needs an account-scoped API token
//    (`CF_API_TOKEN` secret) because the Workers binding's `jobs.create()`
//    throws at runtime ("The RPC receiver does not implement the method
//    \"create\"" — confirmed directly, not assumed) even though it's in the
//    binding's TypeScript types. Without the secret this degrades
//    gracefully: `triggerIndexingJob` returns `{ ok: false, reason:
//    "no-token" }` instead of throwing, and the app falls back to
//    mechanism (1) above plus the manual CLI command.
//
// The jobs endpoint is undocumented in public REST API docs at the time of
// writing; its exact path was recovered from `wrangler`'s own bundled
// source (`baseInstanceUrl`/`baseJobUrl` in `wrangler-dist/cli.js`) and
// confirmed working with a live `curl` call before being wired into this
// file — see the project's session notes. Cloudflare also documents a hard
// rate limit of one indexing job per 30 seconds; the debounce window below
// is set comfortably above that floor.

export const AISEARCH_MIN_JOB_INTERVAL_SECONDS = 30; // Cloudflare's documented hard floor
export const JOB_DEBOUNCE_WINDOW_SECONDS = 60; // coalesces upload bursts; stays safely above the 30s floor
export const FAST_SYNC_INTERVAL_SECONDS = 900; // 15 minutes — the fastest sync_interval AI Search accepts
export const SYNC_INTERVAL_ENSURE_TTL_SECONDS = 86400; // re-check the instance's sync_interval at most once/day

const AISEARCH_API_ROOT = "https://api.cloudflare.com/client/v4";
const DEFAULT_NAMESPACE = "default"; // AI Search's own default namespace (matches wrangler's DEFAULT_NAMESPACE)

/** REST URL for creating/listing indexing jobs on an instance. */
export function jobsApiUrl(accountId: string, instanceName: string): string {
  return `${AISEARCH_API_ROOT}/accounts/${accountId}/ai-search/namespaces/${DEFAULT_NAMESPACE}/instances/${instanceName}/jobs`;
}

/** KV key used to debounce/coalesce indexing-job triggers for one instance. */
export function jobDebounceKvKey(instanceName: string): string {
  return `aisearch:job-debounce:${instanceName}`;
}

/** KV key used to gate how often we re-check/lower the instance's own sync_interval. */
export function syncIntervalEnsuredKvKey(instanceName: string): string {
  return `aisearch:sync-interval-ensured:${instanceName}`;
}

/** KV key used to track R2 keys deleted from the bucket but not yet
 * confirmed removed from AI Search's vector index (see "pending removals"
 * below). */
export function pendingRemovalsKvKey(instanceName: string): string {
  return `aisearch:pending-removals:${instanceName}`;
}

export interface AiSearchActivityStats {
  queued?: number;
  running?: number;
}

/** True when AI Search already has a job queued or running, so kicking off
 * another one would be redundant (and risks the 30s rate limit if it lands
 * too close to the in-flight job's start). */
export function hasActiveJob(stats: AiSearchActivityStats | null | undefined): boolean {
  return !!stats && ((stats.queued ?? 0) > 0 || (stats.running ?? 0) > 0);
}

export interface TriggerIndexingResult {
  ok: boolean;
  reason?: "no-token" | "debounced" | "already-active" | "rate-limited" | "error";
  detail?: string;
  jobId?: string;
}

interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

interface AiSearchStatsLike {
  stats(): Promise<AiSearchActivityStats>;
}

interface EnvForTrigger {
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  AI_SEARCH_INSTANCE_NAME?: string;
  VINEXT_KV_CACHE: KVLike;
  AI_SEARCH: AiSearchStatsLike;
}

/**
 * Best-effort trigger for an AI Search indexing job via the REST API.
 * Never throws — every failure mode (missing token, debounced, a job
 * already running, a network/API error) comes back as a structured
 * `{ ok: false, reason }` instead of an exception, so callers can safely
 * fire this without blocking or breaking the request that triggered it.
 */
export async function triggerIndexingJob(env: EnvForTrigger): Promise<TriggerIndexingResult> {
  const token = env.CF_API_TOKEN;
  const accountId = env.CF_ACCOUNT_ID;
  const instance = env.AI_SEARCH_INSTANCE_NAME;

  if (!token || !accountId || !instance || accountId.startsWith("<")) {
    return { ok: false, reason: "no-token" };
  }

  const debounceKey = jobDebounceKvKey(instance);
  const debounced = await env.VINEXT_KV_CACHE.get(debounceKey);
  if (debounced) {
    return { ok: false, reason: "debounced" };
  }
  // Claim the debounce window up front (before the network round-trip) so
  // that a burst of near-simultaneous callers coalesces into a single job.
  await env.VINEXT_KV_CACHE.put(debounceKey, String(Date.now()), {
    expirationTtl: JOB_DEBOUNCE_WINDOW_SECONDS,
  });

  try {
    const stats = await env.AI_SEARCH.stats().catch(() => null);
    if (hasActiveJob(stats)) {
      return { ok: false, reason: "already-active" };
    }

    const res = await fetch(jobsApiUrl(accountId, instance), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });

    if (res.status === 429) {
      return { ok: false, reason: "rate-limited" };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, reason: "error", detail: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    }

    const data = (await res.json().catch(() => null)) as { result?: { id?: string } } | null;
    return { ok: true, jobId: data?.result?.id };
  } catch (err) {
    return { ok: false, reason: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}

interface AiSearchConfigLike {
  info(): Promise<{ sync_interval?: number }>;
  update(config: { sync_interval?: number }): Promise<unknown>;
}

interface EnvForSyncInterval {
  VINEXT_KV_CACHE: KVLike;
  AI_SEARCH_INSTANCE_NAME?: string;
  AI_SEARCH: AiSearchConfigLike;
}

/**
 * Zero-configuration backstop: lowers the instance's own scheduled sync
 * interval to the fastest value AI Search allows (15 minutes), using the
 * Workers binding's `update()` method directly — no API token required.
 * KV-gated to run at most once a day so it doesn't hammer the config
 * endpoint on every request. Best-effort: swallows every error, since this
 * must never break the request path that calls it.
 */
export async function ensureFastSyncInterval(env: EnvForSyncInterval): Promise<void> {
  const instance = env.AI_SEARCH_INSTANCE_NAME ?? "default";
  const key = syncIntervalEnsuredKvKey(instance);
  try {
    const already = await env.VINEXT_KV_CACHE.get(key);
    if (already) return;
    await env.VINEXT_KV_CACHE.put(key, "1", { expirationTtl: SYNC_INTERVAL_ENSURE_TTL_SECONDS });

    const info = await env.AI_SEARCH.info();
    if (typeof info.sync_interval === "number" && info.sync_interval <= FAST_SYNC_INTERVAL_SECONDS) {
      return;
    }
    await env.AI_SEARCH.update({ sync_interval: FAST_SYNC_INTERVAL_SECONDS });
  } catch {
    // Best-effort only — never break the caller's request.
  }
}

// --- Pending removals ("the index and the R2 bucket disagree") ---
//
// Deleting an R2 object doesn't remove its vectors from AI Search's index
// until the next sync — confirmed empirically: R2 held only one file while
// the index still reported six files' worth of vectors. Left alone, the UI
// keeps listing only R2 objects (via GET /api/docs), so a deleted
// document's vectors silently keep answering questions with no visible
// trace of where they came from. This tracks deletions in KV as
// "pending removal" until a sync that started after the deletion has
// finished, so the UI can say so honestly instead of hiding the mismatch.

export const PENDING_REMOVALS_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days — well past any plausible sync delay
const PENDING_REMOVALS_MAX_ENTRIES = 50; // cap so a delete-spree can't grow this unboundedly

export interface PendingRemoval {
  key: string;
  /** ms since epoch when the R2 object was deleted. */
  deletedAt: number;
}

/** Adds (or refreshes) one pending-removal entry, deduped by key, newest
 * first, capped at PENDING_REMOVALS_MAX_ENTRIES. Pure function — no I/O. */
export function addPendingRemoval(list: PendingRemoval[], key: string, deletedAt: number): PendingRemoval[] {
  const withoutKey = list.filter((entry) => entry.key !== key);
  return [{ key, deletedAt }, ...withoutKey].slice(0, PENDING_REMOVALS_MAX_ENTRIES);
}

/**
 * Drops any pending-removal entry that predates the index's last completed
 * activity — i.e. a sync has run since that document was deleted, so its
 * vectors are presumed gone. `lastActivity` is `undefined`/invalid when
 * AI Search hasn't reported any activity yet, in which case nothing is
 * pruned (we have no evidence a sync ever ran). Pure function — no I/O.
 */
export function prunePendingRemovals(list: PendingRemoval[], lastActivity: string | undefined): PendingRemoval[] {
  if (!lastActivity) return list;
  const lastActivityMs = Date.parse(lastActivity);
  if (Number.isNaN(lastActivityMs)) return list;
  return list.filter((entry) => entry.deletedAt > lastActivityMs);
}

interface EnvForPendingRemovals {
  VINEXT_KV_CACHE: KVLike;
  AI_SEARCH_INSTANCE_NAME?: string;
}

async function readPendingRemovals(env: EnvForPendingRemovals): Promise<PendingRemoval[]> {
  const instance = env.AI_SEARCH_INSTANCE_NAME ?? "default";
  try {
    const raw = await env.VINEXT_KV_CACHE.get(pendingRemovalsKvKey(instance));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingRemoval[]) : [];
  } catch {
    return [];
  }
}

async function writePendingRemovals(env: EnvForPendingRemovals, list: PendingRemoval[]): Promise<void> {
  const instance = env.AI_SEARCH_INSTANCE_NAME ?? "default";
  try {
    await env.VINEXT_KV_CACHE.put(pendingRemovalsKvKey(instance), JSON.stringify(list), {
      expirationTtl: PENDING_REMOVALS_TTL_SECONDS,
    });
  } catch {
    // Best-effort only.
  }
}

/** Call right after deleting `key` from R2 — records it as pending removal
 * from the index. Never throws. */
export async function recordPendingRemoval(env: EnvForPendingRemovals, key: string): Promise<void> {
  try {
    const list = await readPendingRemovals(env);
    await writePendingRemovals(env, addPendingRemoval(list, key, Date.now()));
  } catch {
    // Best-effort only — never break the delete request.
  }
}

/** Returns the filenames still pending removal from the index, pruning any
 * entries a completed sync has already caught up to (based on
 * `stats.last_activity`) and persisting the pruned list. Never throws —
 * returns `[]` on any failure so this can never break GET /api/docs. */
export async function getPendingRemovals(
  env: EnvForPendingRemovals,
  lastActivity: string | undefined,
): Promise<string[]> {
  try {
    const list = await readPendingRemovals(env);
    const pruned = prunePendingRemovals(list, lastActivity);
    if (pruned.length !== list.length) {
      await writePendingRemovals(env, pruned);
    }
    return pruned.map((entry) => entry.key);
  } catch {
    return [];
  }
}
