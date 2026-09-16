/** Minimal in-memory KVNamespace mock — enough surface area for this app's
 * get/put/delete/list usage. Not a full KV emulation (no real TTL expiry,
 * no cursor pagination beyond a flat slice), just enough for unit tests. */
export function createMockKV() {
  const store = new Map<string, string>();

  return {
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list({ prefix = "", limit = 1000 }: { prefix?: string; limit?: number } = {}) {
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort()
        .slice(0, limit)
        .map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, string> };
}
