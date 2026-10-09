import { defineConfig, type Plugin } from "vite";
import { execFile } from "node:child_process";
import path from "node:path";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { kvDataAdapter } from "@vinext/cloudflare/cache/kv-data-adapter";
import { cdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";

// Dev-only: lets the page start an AI Search indexing job from this machine.
//
// The Worker can't create jobs itself (Cloudflare doesn't expose that through
// the binding; it needs an API token). But when the app runs locally, wrangler
// is already logged in, so this runs the same command you would type:
//   wrangler ai-search jobs create <instance>
// Nothing is stored, no token is needed, and it only exists while `vinext dev`
// is running (apply: "serve") — a deployed copy has no such endpoint.
const SYNC_INSTANCE = "cf-rag-tool"; // must match ai_search[0].instance_name in wrangler.jsonc
let syncRunning = false;

function localSyncPlugin(): Plugin {
  return {
    name: "local-ai-search-sync",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__local/sync", (req, res) => {
        const send = (status: number, body: Record<string, unknown>) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        };
        const remote = req.socket.remoteAddress ?? "";
        const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
        // Fixed command, no user input reaches it. The custom header means
        // another website in your browser can't trigger it with a plain POST.
        if (req.method !== "POST" || !isLoopback || req.headers["x-requested-with"] !== "stacks") {
          return send(403, { ok: false, reason: "forbidden" });
        }
        if (syncRunning) return send(200, { ok: false, reason: "busy" });
        syncRunning = true;

        const wranglerJs = path.join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");
        execFile(
          process.execPath,
          [wranglerJs, "ai-search", "jobs", "create", SYNC_INSTANCE],
          { timeout: 90_000, env: { ...process.env, CI: "1", NO_COLOR: "1" } },
          (error, stdout, stderr) => {
            syncRunning = false;
            const out = `${stdout}\n${stderr}`;
            if (/Successfully created indexing job/i.test(out)) return send(200, { ok: true });
            if (/sync_in_cooldown|cooldown/i.test(out)) return send(200, { ok: false, reason: "cooldown" });
            if (/not logged in|authenticat|login/i.test(out)) return send(200, { ok: false, reason: "not-logged-in" });
            console.error("[local-sync] failed", error?.message, out.slice(0, 400));
            return send(200, { ok: false, reason: "error" });
          },
        );
      });
    },
  };
}

export default defineConfig({
  // Editing docs must never reload the page (it cut off a live call once).
  server: { watch: { ignored: ["**/*.md"] } },
  plugins: [
    localSyncPlugin(),
    vinext({
      cache: { data: kvDataAdapter(), cdn: cdnAdapter() },
      images: { optimizer: imagesOptimizer() },
    }),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
