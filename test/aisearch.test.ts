import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  jobsApiUrl,
  jobDebounceKvKey,
  syncIntervalEnsuredKvKey,
  pendingRemovalsKvKey,
  hasActiveJob,
  triggerIndexingJob,
  ensureFastSyncInterval,
  addPendingRemoval,
  prunePendingRemovals,
  recordPendingRemoval,
  getPendingRemovals,
  FAST_SYNC_INTERVAL_SECONDS,
  JOB_DEBOUNCE_WINDOW_SECONDS,
  AISEARCH_MIN_JOB_INTERVAL_SECONDS,
} from "../lib/aisearch";
import { createMockKV } from "./mockKV";

describe("jobsApiUrl", () => {
  it("builds the REST URL for the default namespace", () => {
    expect(jobsApiUrl("acct123", "cf-rag-tool")).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct123/ai-search/namespaces/default/instances/cf-rag-tool/jobs",
    );
  });
});

describe("jobDebounceKvKey / syncIntervalEnsuredKvKey", () => {
  it("are namespaced per instance so different instances don't collide", () => {
    expect(jobDebounceKvKey("a")).not.toBe(jobDebounceKvKey("b"));
    expect(syncIntervalEnsuredKvKey("a")).not.toBe(syncIntervalEnsuredKvKey("b"));
    expect(jobDebounceKvKey("a")).not.toBe(syncIntervalEnsuredKvKey("a"));
  });
});

describe("hasActiveJob", () => {
  it("is false for null/undefined stats", () => {
    expect(hasActiveJob(null)).toBe(false);
    expect(hasActiveJob(undefined)).toBe(false);
  });

  it("is false when nothing is queued or running", () => {
    expect(hasActiveJob({ queued: 0, running: 0 })).toBe(false);
    expect(hasActiveJob({})).toBe(false);
  });

  it("is true when something is queued or running", () => {
    expect(hasActiveJob({ queued: 1, running: 0 })).toBe(true);
    expect(hasActiveJob({ queued: 0, running: 1 })).toBe(true);
  });
});

describe("triggerIndexingJob", () => {
  const baseEnv = () => ({
    CF_API_TOKEN: "token-abc",
    CF_ACCOUNT_ID: "acct123",
    AI_SEARCH_INSTANCE_NAME: "cf-rag-tool",
    VINEXT_KV_CACHE: createMockKV(),
    AI_SEARCH: { stats: vi.fn().mockResolvedValue({ queued: 0, running: 0 }) },
  });

  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("degrades gracefully with no token configured — no crash, no fetch call", async () => {
    const env = baseEnv();
    env.CF_API_TOKEN = undefined as unknown as string;
    const result = await triggerIndexingJob(env);
    expect(result).toEqual({ ok: false, reason: "no-token" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("degrades gracefully with a placeholder account id (unconfigured template)", async () => {
    const env = baseEnv();
    env.CF_ACCOUNT_ID = "<YOUR_CF_ACCOUNT_ID>";
    const result = await triggerIndexingJob(env);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-token");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls the jobs endpoint and reports success", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ result: { id: "job-1" } }), { status: 200 }),
    );
    const env = baseEnv();
    const result = await triggerIndexingJob(env);
    expect(result).toEqual({ ok: true, jobId: "job-1" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct123/ai-search/namespaces/default/instances/cf-rag-tool/jobs",
    );
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer token-abc" });
  });

  it("debounces a second call within the debounce window — coalesces upload bursts", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ result: { id: "job-1" } }), { status: 200 }),
    );
    const env = baseEnv();
    const first = await triggerIndexingJob(env);
    const second = await triggerIndexingJob(env);
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "debounced" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("skips creating a job when one is already queued or running", async () => {
    const env = baseEnv();
    env.AI_SEARCH.stats.mockResolvedValue({ queued: 1, running: 0 });
    const result = await triggerIndexingJob(env);
    expect(result).toEqual({ ok: false, reason: "already-active" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces a 429 from the API as rate-limited rather than a generic error", async () => {
    fetchSpy.mockResolvedValue(new Response("", { status: 429 }));
    const env = baseEnv();
    const result = await triggerIndexingJob(env);
    expect(result).toEqual({ ok: false, reason: "rate-limited" });
  });

  it("never throws on a network failure — returns a structured error instead", async () => {
    fetchSpy.mockRejectedValue(new Error("network down"));
    const env = baseEnv();
    const result = await triggerIndexingJob(env);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("error");
    expect(result.detail).toContain("network down");
  });

  it("debounce window is comfortably above AI Search's documented 30s job rate limit", () => {
    expect(JOB_DEBOUNCE_WINDOW_SECONDS).toBeGreaterThanOrEqual(AISEARCH_MIN_JOB_INTERVAL_SECONDS);
  });
});

describe("ensureFastSyncInterval", () => {
  it("degrades gracefully when the binding call throws — never propagates", async () => {
    const env = {
      VINEXT_KV_CACHE: createMockKV(),
      AI_SEARCH_INSTANCE_NAME: "cf-rag-tool",
      AI_SEARCH: {
        info: vi.fn().mockRejectedValue(new Error("boom")),
        update: vi.fn(),
      },
    };
    await expect(ensureFastSyncInterval(env)).resolves.toBeUndefined();
  });

  it("lowers sync_interval when the current value is slower than the fast target", async () => {
    const update = vi.fn().mockResolvedValue({});
    const env = {
      VINEXT_KV_CACHE: createMockKV(),
      AI_SEARCH_INSTANCE_NAME: "cf-rag-tool",
      AI_SEARCH: {
        info: vi.fn().mockResolvedValue({ sync_interval: 21600 }),
        update,
      },
    };
    await ensureFastSyncInterval(env);
    expect(update).toHaveBeenCalledWith({ sync_interval: FAST_SYNC_INTERVAL_SECONDS });
  });

  it("leaves sync_interval alone when it's already at or below the fast target", async () => {
    const update = vi.fn();
    const env = {
      VINEXT_KV_CACHE: createMockKV(),
      AI_SEARCH_INSTANCE_NAME: "cf-rag-tool",
      AI_SEARCH: {
        info: vi.fn().mockResolvedValue({ sync_interval: FAST_SYNC_INTERVAL_SECONDS }),
        update,
      },
    };
    await ensureFastSyncInterval(env);
    expect(update).not.toHaveBeenCalled();
  });

  it("only checks once per day — a second call within the TTL is a no-op", async () => {
    const info = vi.fn().mockResolvedValue({ sync_interval: 21600 });
    const env = {
      VINEXT_KV_CACHE: createMockKV(),
      AI_SEARCH_INSTANCE_NAME: "cf-rag-tool",
      AI_SEARCH: { info, update: vi.fn().mockResolvedValue({}) },
    };
    await ensureFastSyncInterval(env);
    await ensureFastSyncInterval(env);
    expect(info).toHaveBeenCalledTimes(1);
  });
});

describe("pendingRemovalsKvKey", () => {
  it("is namespaced per instance and distinct from the other KV keys", () => {
    expect(pendingRemovalsKvKey("a")).not.toBe(pendingRemovalsKvKey("b"));
    expect(pendingRemovalsKvKey("cf-rag-tool")).not.toBe(jobDebounceKvKey("cf-rag-tool"));
    expect(pendingRemovalsKvKey("cf-rag-tool")).not.toBe(syncIntervalEnsuredKvKey("cf-rag-tool"));
  });
});

describe("addPendingRemoval", () => {
  it("adds a new entry to the front", () => {
    const result = addPendingRemoval([], "a.txt", 1000);
    expect(result).toEqual([{ key: "a.txt", deletedAt: 1000 }]);
  });

  it("refreshes (dedupes) an existing key instead of duplicating it", () => {
    const list = [{ key: "a.txt", deletedAt: 1000 }];
    const result = addPendingRemoval(list, "a.txt", 2000);
    expect(result).toEqual([{ key: "a.txt", deletedAt: 2000 }]);
  });

  it("caps the list at 50 entries, dropping the oldest", () => {
    let list: { key: string; deletedAt: number }[] = [];
    for (let i = 0; i < 55; i++) {
      list = addPendingRemoval(list, `f${i}.txt`, i);
    }
    expect(list.length).toBe(50);
    expect(list[0].key).toBe("f54.txt");
    expect(list.find((e) => e.key === "f0.txt")).toBeUndefined();
  });
});

describe("prunePendingRemovals", () => {
  const list = [
    { key: "old.txt", deletedAt: 1000 },
    { key: "new.txt", deletedAt: 5000 },
  ];

  it("keeps everything when there's no last_activity yet — no evidence a sync ran", () => {
    expect(prunePendingRemovals(list, undefined)).toEqual(list);
  });

  it("keeps everything when last_activity is unparseable", () => {
    expect(prunePendingRemovals(list, "not-a-date")).toEqual(list);
  });

  it("drops entries deleted before the last completed sync — presumed removed from the index", () => {
    const lastActivity = new Date(3000).toISOString();
    expect(prunePendingRemovals(list, lastActivity)).toEqual([{ key: "new.txt", deletedAt: 5000 }]);
  });

  it("keeps entries deleted after the last completed sync", () => {
    const lastActivity = new Date(0).toISOString();
    expect(prunePendingRemovals(list, lastActivity)).toEqual(list);
  });
});

describe("recordPendingRemoval / getPendingRemovals", () => {
  it("round-trips a recorded deletion back out as a pending removal", async () => {
    const env = { VINEXT_KV_CACHE: createMockKV(), AI_SEARCH_INSTANCE_NAME: "cf-rag-tool" };
    await recordPendingRemoval(env, "deleted.pdf");
    const pending = await getPendingRemovals(env, undefined);
    expect(pending).toEqual(["deleted.pdf"]);
  });

  it("prunes and persists once last_activity shows a sync ran after the deletion", async () => {
    const env = { VINEXT_KV_CACHE: createMockKV(), AI_SEARCH_INSTANCE_NAME: "cf-rag-tool" };
    await recordPendingRemoval(env, "deleted.pdf");
    const future = new Date(Date.now() + 60_000).toISOString();
    const pending = await getPendingRemovals(env, future);
    expect(pending).toEqual([]);
    // Persisted — a second read with no activity info still comes back empty.
    const again = await getPendingRemovals(env, undefined);
    expect(again).toEqual([]);
  });

  it("never throws when KV is unavailable", async () => {
    const brokenKV = {
      get: vi.fn().mockRejectedValue(new Error("kv down")),
      put: vi.fn().mockRejectedValue(new Error("kv down")),
    };
    const env = { VINEXT_KV_CACHE: brokenKV, AI_SEARCH_INSTANCE_NAME: "cf-rag-tool" };
    await expect(recordPendingRemoval(env, "x.txt")).resolves.toBeUndefined();
    await expect(getPendingRemovals(env, undefined)).resolves.toEqual([]);
  });
});
