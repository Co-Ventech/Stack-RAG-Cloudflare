// Simple fixed-window rate limiter backed by KV. Not perfectly precise (a burst
// can land across a window boundary and briefly exceed the limit), but cheap,
// needs no extra infrastructure, and is plenty for stopping casual abuse.

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetSeconds: number;
}

export async function checkRateLimit(
  kv: KVNamespace,
  identifier: string,
  opts: { limit: number; windowSeconds: number },
): Promise<RateLimitResult> {
  const windowStart = Math.floor(Date.now() / (opts.windowSeconds * 1000));
  const key = `ratelimit:${identifier}:${windowStart}`;

  const current = Number((await kv.get(key)) ?? "0");
  const resetSeconds = opts.windowSeconds - Math.floor((Date.now() / 1000) % opts.windowSeconds);

  if (current >= opts.limit) {
    return { allowed: false, remaining: 0, limit: opts.limit, resetSeconds };
  }

  await kv.put(key, String(current + 1), { expirationTtl: opts.windowSeconds + 60 });
  return { allowed: true, remaining: opts.limit - current - 1, limit: opts.limit, resetSeconds };
}

export interface RateLimitTier {
  label: string;
  limit: number;
  windowSeconds: number;
}

export interface TieredRateLimitResult {
  allowed: boolean;
  failedTier?: string;
  resetSeconds?: number;
}

/** Checks several fixed windows (e.g. hour/day/month) against the same
 * identifier, all of which must pass. Peeks every tier first — only writes
 * the increments if every tier has room, so a request denied by (say) the
 * daily cap doesn't still burn an hourly-window slot. */
export async function checkTieredRateLimit(
  kv: KVNamespace,
  identifier: string,
  tiers: RateLimitTier[],
): Promise<TieredRateLimitResult> {
  const buckets = tiers.map((tier) => {
    const windowStart = Math.floor(Date.now() / (tier.windowSeconds * 1000));
    return { tier, key: `ratelimit:${identifier}:${tier.label}:${windowStart}` };
  });

  const counts = await Promise.all(buckets.map(({ key }) => kv.get(key)));

  for (let i = 0; i < buckets.length; i++) {
    const current = Number(counts[i] ?? "0");
    if (current >= buckets[i].tier.limit) {
      const resetSeconds =
        buckets[i].tier.windowSeconds - Math.floor((Date.now() / 1000) % buckets[i].tier.windowSeconds);
      return { allowed: false, failedTier: buckets[i].tier.label, resetSeconds };
    }
  }

  await Promise.all(
    buckets.map(({ key, tier }, i) => {
      const current = Number(counts[i] ?? "0");
      return kv.put(key, String(current + 1), { expirationTtl: tier.windowSeconds + 60 });
    }),
  );

  return { allowed: true };
}

/** Tiered ceiling for API-key-authenticated shortens — all three must have
 * room. Deliberately tighter than a flat hourly number alone: 10/hour stops
 * a burst, 100/day and 1000/month stop steady abuse that stays under the
 * hourly radar. */
export const API_KEY_RATE_TIERS: RateLimitTier[] = [
  { label: "hour", limit: 10, windowSeconds: 3600 },
  { label: "day", limit: 100, windowSeconds: 86400 },
  { label: "month", limit: 1000, windowSeconds: 2592000 },
];
