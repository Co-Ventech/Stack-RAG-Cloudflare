import { describe, expect, it } from "vitest";
import { checkRateLimit, checkTieredRateLimit } from "../lib/ratelimit";
import { createMockKV } from "./mockKV";

describe("checkRateLimit", () => {
  it("allows requests up to the limit, then denies", async () => {
    const kv = createMockKV();
    const opts = { limit: 3, windowSeconds: 3600 };

    const r1 = await checkRateLimit(kv, "ip-1", opts);
    const r2 = await checkRateLimit(kv, "ip-1", opts);
    const r3 = await checkRateLimit(kv, "ip-1", opts);
    const r4 = await checkRateLimit(kv, "ip-1", opts);

    expect([r1.allowed, r2.allowed, r3.allowed, r4.allowed]).toEqual([true, true, true, false]);
    expect(r4.remaining).toBe(0);
  });

  it("tracks separate identifiers independently", async () => {
    const kv = createMockKV();
    const opts = { limit: 1, windowSeconds: 3600 };

    const a = await checkRateLimit(kv, "ip-a", opts);
    const b = await checkRateLimit(kv, "ip-b", opts);

    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
  });

  it("reports decreasing remaining count", async () => {
    const kv = createMockKV();
    const opts = { limit: 5, windowSeconds: 3600 };

    const r1 = await checkRateLimit(kv, "ip-1", opts);
    const r2 = await checkRateLimit(kv, "ip-1", opts);

    expect(r1.remaining).toBe(4);
    expect(r2.remaining).toBe(3);
  });
});

describe("checkTieredRateLimit", () => {
  it("allows requests while every tier has room", async () => {
    const kv = createMockKV();
    const tiers = [
      { label: "hour", limit: 2, windowSeconds: 3600 },
      { label: "day", limit: 10, windowSeconds: 86400 },
    ];

    expect((await checkTieredRateLimit(kv, "key-1", tiers)).allowed).toBe(true);
    expect((await checkTieredRateLimit(kv, "key-1", tiers)).allowed).toBe(true);
  });

  it("denies once the tightest tier is exhausted, naming that tier", async () => {
    const kv = createMockKV();
    const tiers = [
      { label: "hour", limit: 2, windowSeconds: 3600 },
      { label: "day", limit: 10, windowSeconds: 86400 },
    ];

    await checkTieredRateLimit(kv, "key-1", tiers);
    await checkTieredRateLimit(kv, "key-1", tiers);
    const third = await checkTieredRateLimit(kv, "key-1", tiers);

    expect(third.allowed).toBe(false);
    expect(third.failedTier).toBe("hour");
  });

  it("does not consume any tier's budget on a denied request", async () => {
    const kv = createMockKV();
    const tiers = [
      { label: "hour", limit: 1, windowSeconds: 3600 },
      { label: "day", limit: 10, windowSeconds: 86400 },
    ];

    await checkTieredRateLimit(kv, "key-1", tiers); // consumes the hourly slot
    await checkTieredRateLimit(kv, "key-1", tiers); // denied by hour tier

    // day bucket should only have been incremented once, not twice
    const dayKeys = [...kv._store.keys()].filter((k) => k.includes(":day:"));
    expect(dayKeys).toHaveLength(1);
    expect(kv._store.get(dayKeys[0])).toBe("1");
  });
});
