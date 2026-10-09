"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { isRtl } from "@/lib/rtl";
import { ALLOWED_EXTENSIONS, extensionOf, maxBytesFor, formatMiB } from "@/lib/docs";

interface DocSummary {
  key: string;
  size: number;
  uploaded: string;
}

interface Source {
  key: string;
  score?: number;
  count: number;
  removed: boolean;
  excerpt?: string;
}

interface IndexStats {
  queued?: number;
  running?: number;
  completed?: number;
  error?: number;
  skipped?: number;
  outdated?: number;
  last_activity?: string;
  engine?: {
    vectorize?: { vectorsCount?: number; dimensions?: number };
  };
}

interface Exchange {
  id: number;
  question: string;
  status: "loading" | "done" | "error";
  startedAt: number;
  answer?: string;
  sources?: Source[];
  scopedTo?: string[];
  error?: string;
}

type Threads = Record<string, Exchange[]>;

const ALL_DOCS = "all";
const STORAGE_KEY = "stacks-conversations-v1";
const MAX_SAVED_PER_SCOPE = 30;
const HISTORY_EXCHANGES = 6; // earlier Q&A pairs sent along as context
const CLIENT_TIMEOUT_MS = 75_000;

// The headline cycles through languages: the product's whole point is that you
// can ask in one language about documents written in another.
const HEADLINES: { text: string; dir: "ltr" | "rtl"; lang: string }[] = [
  { text: "Ask your documents.", dir: "ltr", lang: "en" },
  { text: "اپنی دستاویزات سے پوچھیں۔", dir: "rtl", lang: "ur" },
  { text: "向你的文档提问。", dir: "ltr", lang: "zh" },
  { text: "Pregunta a tus documentos.", dir: "ltr", lang: "es" },
  { text: "اسأل مستنداتك.", dir: "rtl", lang: "ar" },
  { text: "अपने दस्तावेज़ों से पूछें।", dir: "ltr", lang: "hi" },
  { text: "Interrogez vos documents.", dir: "ltr", lang: "fr" },
  { text: "Belgelerine sor.", dir: "ltr", lang: "tr" },
];

const GENERAL_QUESTIONS = [
  "Summarize the main points",
  "What topics does this cover?",
  "List the key names, dates or numbers mentioned",
];

const DOCUMENT_QUESTIONS = [
  "Give me a short summary of this document",
  "What are the key points?",
  "Which names, dates or numbers matter most?",
  "What questions does this document leave unanswered?",
];

// Response bodies are untrusted: a proxy or crash page can return HTML, and
// the strict DOM typings make res.json() `unknown`. This reads JSON safely
// and yields {} (never throws) so callers can fall back to a clean message.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

// Starts an indexing job through the dev server's local helper (see
// vite.config.ts). Returns "started", "cooldown" (a job ran in the last 30s),
// or "unavailable" (deployed copy, or wrangler not logged in).
// When a run is already in progress (or ran within 30s) a new file isn't part
// of it, so try again a few times instead of making the user press Sync now.
async function startLocalSyncWithRetry(
  onResult: (outcome: "started" | "cooldown" | "busy" | "unavailable") => void,
  attempts = 6,
  delayMs = 40_000,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const outcome = await startLocalSync();
    if (outcome === "started" || outcome === "unavailable") {
      onResult(outcome);
      return;
    }
  }
  onResult("cooldown");
}

async function startLocalSync(): Promise<"started" | "cooldown" | "busy" | "unavailable"> {
  try {
    const res = await fetch("/__local/sync", { method: "POST", headers: { "x-requested-with": "stacks" } });
    if (!res.ok) return "unavailable";
    const data = await readJson(res);
    if (data.ok) return "started";
    if (data.reason === "cooldown") return "cooldown";
    if (data.reason === "busy") return "busy";
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function scopeKeyOf(selected: string[]): string {
  return selected.length === 0 ? ALL_DOCS : [...selected].sort().join("\u0001");
}

function docUrl(key: string): string {
  return `/api/docs/${encodeURIComponent(key)}`;
}

function loadSavedThreads(): Threads {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Threads;
    const out: Threads = {};
    for (const [k, list] of Object.entries(parsed ?? {})) {
      if (!Array.isArray(list)) continue;
      out[k] = list.map((x) =>
        // A question that was still running when the page closed can't finish.
        x.status === "loading" ? { ...x, status: "error", error: "This question was interrupted. Try again." } : x,
      );
    }
    return out;
  } catch {
    return {};
  }
}

function saveThreads(threads: Threads): void {
  try {
    const trimmed: Threads = {};
    for (const [k, list] of Object.entries(threads)) {
      if (list.length > 0) trimmed[k] = list.slice(-MAX_SAVED_PER_SCOPE);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    /* storage full or blocked: conversations just won't persist */
  }
}

function downloadText(filename: string, body: string, type = "text/markdown;charset=utf-8") {
  const blob = new Blob([body], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Markdown table cells need to scroll rather than blow out the card's
// width, so tables get wrapped in an overflow-x:auto container. No raw
// HTML is ever rendered (no rehype-raw) — model output is untrusted text,
// so literal HTML like stray "<br>" tags shows up as visible text instead
// of being executed.
//
// Models often write "<br>" for a line break (especially inside table cells).
// Since raw HTML is never rendered, that used to appear as literal "<br>" text.
// These components turn only that exact token into a real <br /> element that
// we create ourselves, so nothing from the model is ever parsed as HTML.
function withBreaks(children: React.ReactNode): React.ReactNode {
  const nodes = Array.isArray(children) ? children : [children];
  return nodes.map((child, i) => {
    if (typeof child !== "string") return child;
    const parts = child.split(/<br\s*\/?>/gi);
    if (parts.length === 1) return child;
    return parts.map((part, j) => (
      <span key={`${i}-${j}`}>
        {j > 0 ? <br /> : null}
        {part}
      </span>
    ));
  });
}

const markdownComponents: Components = {
  table: ({ children }) => (
    <div className="markdown-table-wrap">
      <table>{children}</table>
    </div>
  ),
  p: ({ children }) => <p>{withBreaks(children)}</p>,
  li: ({ children }) => <li>{withBreaks(children)}</li>,
  td: ({ children }) => <td>{withBreaks(children)}</td>,
  th: ({ children }) => <th>{withBreaks(children)}</th>,
};

function RotatingHeadline() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % HEADLINES.length), 3400);
    return () => clearInterval(id);
  }, []);

  const current = HEADLINES[index];
  return (
    <>
      <h1 className="sr-only">Ask your documents</h1>
      <p key={current.lang} aria-hidden dir={current.dir} lang={current.lang} className="headline headline-swap">
        {current.text}
      </p>
    </>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <>{Math.max(0, Math.floor((now - since) / 1000))}s</>;
}

export default function HomePage() {
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [pendingRemovals, setPendingRemovals] = useState<string[]>([]);
  const [docFilter, setDocFilter] = useState("");
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const [question, setQuestion] = useState("");
  const [threads, setThreads] = useState<Threads>({});
  const [threadsLoaded, setThreadsLoaded] = useState(false);
  const nextId = useRef(1);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const controllers = useRef(new Map<number, { controller: AbortController; stoppedByUser: boolean }>());
  const [openPassages, setOpenPassages] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const [stats, setStats] = useState<IndexStats | null>(null);
  const [statsError, setStatsError] = useState(false);
  const [showSyncHelp, setShowSyncHelp] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  const [selectedDocs, setSelectedDocs] = useState<string[]>([]);
  const [libraryError, setLibraryError] = useState<string | null>(null);

  const [ocr, setOcr] = useState<boolean | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrNote, setOcrNote] = useState<string | null>(null);

  const scopeKey = scopeKeyOf(selectedDocs);
  const thread = threads[scopeKey] ?? [];

  // ---------- data loading ----------

  const loadDocs = useCallback(async () => {
    try {
      const res = await fetch("/api/docs");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await readJson(res);
      setDocs(data.docs ?? []);
      setPendingRemovals(data.pendingRemovals ?? []);
      setLibraryError(null);
    } catch {
      // Keep whatever list we already had; only flag the failure.
      setLibraryError("Couldn't load the document library.");
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch("/api/sync");
      const data = await readJson(res);
      if (data.ok) {
        setStats(data.stats);
        setStatsError(false);
      } else {
        setStatsError(true);
      }
    } catch {
      setStatsError(true);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      const data = await readJson(res);
      if (data.ok) setOcr(typeof data.ocr === "boolean" ? data.ocr : null);
    } catch {
      /* the switch just stays unavailable */
    }
  }, []);

  useEffect(() => {
    loadDocs();
    loadStats();
    loadSettings();
    const id = setInterval(loadStats, 20_000);
    return () => clearInterval(id);
  }, [loadDocs, loadStats, loadSettings]);

  // Conversations survive a refresh. Loaded after mount (not during render) so
  // the server-rendered HTML and the first client render always match.
  useEffect(() => {
    const saved = loadSavedThreads();
    setThreads(saved);
    const maxId = Math.max(0, ...Object.values(saved).flat().map((x) => x.id));
    nextId.current = maxId + 1;
    setThreadsLoaded(true);
  }, []);

  useEffect(() => {
    if (threadsLoaded) saveThreads(threads);
  }, [threads, threadsLoaded]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [thread.length, thread[thread.length - 1]?.status]);

  // Drop selections for documents that no longer exist.
  useEffect(() => {
    if (!docs) return;
    const known = new Set(docs.map((d) => d.key));
    setSelectedDocs((prev) => (prev.every((k) => known.has(k)) ? prev : prev.filter((k) => known.has(k))));
  }, [docs]);

  // ---------- uploads ----------

  // Uploads one or several files in order. A multi-file drop used to keep
  // only the first file and silently ignore the rest.
  async function uploadFiles(files: File[]) {
    if (files.length === 0 || uploading) return;
    setUploadError(null);
    setUploadNote(null);
    setUploading(true);
    const saved: string[] = [];
    const failed: string[] = [];
    try {
      for (const file of files) {
        // Check the type and size here too, so a doomed upload fails instantly
        // instead of after sending megabytes. (The server checks again.)
        if (!ALLOWED_EXTENSIONS.includes(extensionOf(file.name))) {
          failed.push(`${file.name}: this file type isn't supported`);
          continue;
        }
        const limit = maxBytesFor(file.name, ocr === true);
        if (file.size > limit) {
          failed.push(
            `${file.name}: too large (max ${formatMiB(limit)} for this file type${
              extensionOf(file.name) === "pdf" && ocr !== true ? "; turn on OCR to allow PDFs up to 10 MB" : ""
            })`,
          );
          continue;
        }
        try {
          const formData = new FormData();
          formData.append("file", file);
          const res = await fetch("/api/docs", { method: "POST", body: formData });
          const data = await readJson(res);
          if (!res.ok) {
            failed.push(`${file.name}: ${data.error ?? `upload failed (HTTP ${res.status})`}`);
            if (res.status === 429) break; // rate-limited — the rest would fail too
            continue;
          }
          saved.push(data.key);
        } catch {
          failed.push(`${file.name}: couldn't reach the server`);
        }
      }
      if (saved.length > 0) {
        const what = saved.length === 1 ? `"${saved[0]}"` : `${saved.length} documents`;
        await loadDocs();
        const outcome = await startLocalSync();
        setUploadNote(
          outcome === "started"
            ? `Added ${what}. Indexing started, which usually takes a minute or two.`
            : outcome === "cooldown" || outcome === "busy"
              ? `Added ${what}. An indexing run is already going, so this one will start automatically as soon as it can.`
              : `Added ${what}. It becomes searchable after the next index run.`,
        );
        loadStats();
        if (outcome === "cooldown" || outcome === "busy") {
          void startLocalSyncWithRetry((o) => {
            setUploadNote(
              o === "started"
                ? `Indexing of ${what} has started, which usually takes a minute or two.`
                : `Couldn't start indexing ${what} automatically. Press Sync now to try again.`,
            );
            loadStats();
          });
        }
      }
      if (failed.length > 0) setUploadError(failed.join(" · "));
    } finally {
      setUploading(false);
    }
  }

  function handleFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    void uploadFiles(files);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    void uploadFiles(Array.from(e.dataTransfer.files ?? []));
  }

  async function handlePasteSubmit(e: React.FormEvent) {
    e.preventDefault();
    setUploadError(null);
    setUploadNote(null);
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("title", title);
      formData.append("text", text);
      const res = await fetch("/api/docs", { method: "POST", body: formData });
      const data = await readJson(res);
      if (!res.ok) {
        setUploadError(data.error ?? `Something went wrong (HTTP ${res.status}).`);
        return;
      }
      setTitle("");
      setText("");
      await loadDocs();
      const outcome = await startLocalSync();
      setUploadNote(
        outcome === "started"
          ? `Saved "${data.key}". Indexing started, which usually takes a minute or two.`
          : outcome === "cooldown" || outcome === "busy"
            ? `Saved "${data.key}". An indexing run is already going, so this one will start automatically as soon as it can.`
            : `Saved "${data.key}". It becomes searchable after the next index run.`,
      );
      loadStats();
      if (outcome === "cooldown" || outcome === "busy") {
        void startLocalSyncWithRetry((o) => {
          setUploadNote(
            o === "started"
              ? `Indexing of "${data.key}" has started, which usually takes a minute or two.`
              : `Couldn't start indexing "${data.key}" automatically. Press Sync now to try again.`,
          );
          loadStats();
        });
      }
    } catch {
      setUploadError("Couldn't reach the server.");
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(key: string) {
    if (!window.confirm(`Remove "${key}" from the library? This can't be undone.`)) return;
    const previousDocs = docs;
    const previousSelection = selectedDocs;
    setDocs((prev) => prev?.filter((d) => d.key !== key) ?? null);
    setSelectedDocs((prev) => prev.filter((k) => k !== key));
    try {
      const res = await fetch(docUrl(key), { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      // Put the row back instead of letting it silently reappear later.
      setDocs(previousDocs);
      setSelectedDocs(previousSelection);
      setLibraryError(`Couldn't remove "${key}". Please try again.`);
      return;
    }
    // Removing the R2 object doesn't remove its vectors from the index
    // until the next sync — reload so the "pending removal" state (and its
    // sync-now nudge) shows up right away instead of only on the next poll.
    await loadDocs();
    loadStats();
  }

  async function toggleOcr(next: boolean) {
    if (ocrBusy) return;
    const ok = window.confirm(
      next
        ? "Turn on OCR?\n\nThis reads text from scanned PDFs and images. AI Search will re-index every document, which takes a few minutes and is billed as ingestion. Answers may be slower or incomplete until it finishes."
        : "Turn off OCR?\n\nScanned PDFs and images will stop being read as text. AI Search will re-index every document.",
    );
    if (!ok) return;
    setOcrBusy(true);
    setOcrNote(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ocr: next }),
      });
      const data = await readJson(res);
      if (!res.ok || !data.ok) {
        setOcrNote(data.error ?? `Couldn't change OCR (HTTP ${res.status}).`);
        return;
      }
      setOcr(data.ocr);
      setOcrNote(
        data.changed
          ? "OCR is now " + (data.ocr ? "on" : "off") + ". AI Search is re-indexing your documents."
          : "OCR was already " + (data.ocr ? "on" : "off") + ".",
      );
      loadStats();
    } catch {
      setOcrNote("Couldn't reach the server.");
    } finally {
      setOcrBusy(false);
    }
  }

  // ---------- scope ----------

  function toggleDocSelected(key: string) {
    setSelectedDocs((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  function chatWithDoc(key: string) {
    setSelectedDocs([key]);
    setQuestion("");
    setTimeout(() => composerRef.current?.focus(), 0);
  }

  // ---------- asking ----------

  const updateExchange = useCallback((scope: string, id: number, patch: Partial<Exchange>) => {
    setThreads((prev) => ({
      ...prev,
      [scope]: (prev[scope] ?? []).map((x) => (x.id === id ? { ...x, ...patch } : x)),
    }));
  }, []);

  // Runs one question for the given scope. `replaceId` re-runs an existing
  // exchange (retry / regenerate) instead of adding a new one.
  async function runQuestion(q: string, scope: string, files: string[], replaceId?: number) {
    const existing = threads[scope] ?? [];
    const upTo = replaceId === undefined ? existing : existing.slice(0, existing.findIndex((x) => x.id === replaceId));
    const history = upTo
      .filter((x) => x.status === "done" && x.answer)
      .slice(-HISTORY_EXCHANGES)
      .flatMap((x) => [
        { role: "user" as const, content: x.question },
        { role: "assistant" as const, content: x.answer as string },
      ]);

    const id = replaceId ?? nextId.current++;
    const fresh: Exchange = { id, question: q, status: "loading", startedAt: Date.now() };
    setThreads((prev) => {
      const list = prev[scope] ?? [];
      return {
        ...prev,
        [scope]: replaceId === undefined ? [...list, fresh] : list.map((x) => (x.id === id ? fresh : x)),
      };
    });

    const entry = { controller: new AbortController(), stoppedByUser: false };
    controllers.current.set(id, entry);
    const timer = setTimeout(() => entry.controller.abort(), CLIENT_TIMEOUT_MS);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q, filenames: files, history }),
        signal: entry.controller.signal,
      });
      const data = await readJson(res);
      if (!res.ok) {
        updateExchange(scope, id, {
          status: "error",
          error: data.error ?? `Something went wrong (HTTP ${res.status}).`,
        });
        return;
      }
      updateExchange(scope, id, {
        status: "done",
        answer: data.answer,
        sources: data.sources ?? [],
        scopedTo: data.scopedTo ?? [],
        error: undefined,
      });
    } catch {
      updateExchange(scope, id, {
        status: "error",
        error: entry.stoppedByUser
          ? "Stopped."
          : entry.controller.signal.aborted
            ? "This is taking too long. Cloudflare AI Search may be slow right now. Try again."
            : "Couldn't reach the server.",
      });
    } finally {
      clearTimeout(timer);
      controllers.current.delete(id);
    }
  }

  function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || asking) return;
    setQuestion("");
    void runQuestion(q, scopeKey, selectedDocs);
  }

  function stopExchange(id: number) {
    const entry = controllers.current.get(id);
    if (entry) {
      entry.stoppedByUser = true;
      entry.controller.abort();
    }
  }

  function retryExchange(x: Exchange) {
    void runQuestion(x.question, scopeKey, selectedDocs, x.id);
  }

  async function copyAnswer(x: Exchange) {
    try {
      await navigator.clipboard.writeText(x.answer ?? "");
      setCopiedId(x.id);
      setTimeout(() => setCopiedId((cur) => (cur === x.id ? null : cur)), 1600);
    } catch {
      /* clipboard unavailable (insecure context or denied) */
    }
  }

  function clearConversation() {
    if (thread.length > 0 && !window.confirm("Clear this conversation?")) return;
    setThreads((prev) => ({ ...prev, [scopeKey]: [] }));
  }

  function exportConversation() {
    const scopeName = selectedDocs.length === 0 ? "all documents" : selectedDocs.join(", ");
    const lines = [`# Conversation about ${scopeName}`, ""];
    for (const x of thread) {
      lines.push(`## ${x.question}`, "");
      if (x.status === "done") {
        lines.push(x.answer ?? "", "");
        if (x.sources && x.sources.length > 0) {
          lines.push("Sources:", ...x.sources.map((s, i) => `${i + 1}. ${s.key}${s.removed ? " (removed)" : ""}`), "");
        }
      } else if (x.status === "error") {
        lines.push(`(No answer: ${x.error ?? "failed"})`, "");
      }
    }
    downloadText(`stacks-conversation-${new Date().toISOString().slice(0, 10)}.md`, lines.join("\n"));
  }

  // ---------- indexing ----------

  async function handleSyncNow() {
    setSyncing(true);
    setSyncNote(null);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await readJson(res);
      if (data.ok) {
        setSyncNote("Indexing job started.");
      } else if (data.reason === "no-token") {
        const outcome = await startLocalSync();
        if (outcome === "started") {
          setSyncNote("Indexing started. It usually takes a minute or two.");
        } else if (outcome === "cooldown" || outcome === "busy") {
          setSyncNote("An indexing run just happened or is still going. Try again in about 30 seconds.");
        } else {
          setSyncNote("Instant indexing needs an API token. Until then new files are picked up on the 15-minute schedule.");
          setShowSyncHelp(true);
        }
      } else if (data.reason === "already-active") {
        setSyncNote("An indexing job is already running.");
      } else if (data.reason === "debounced") {
        setSyncNote("A sync was just triggered — try again in a bit.");
      } else if (data.reason === "rate-limited") {
        setSyncNote("Cloudflare allows one sync every 30 seconds — try again shortly.");
      } else if (data.reason === "error") {
        setSyncNote(data.detail ? `Sync failed: ${data.detail}` : "Sync failed. Please try again.");
      } else if (data.error) {
        setSyncNote(data.error);
      } else {
        setSyncNote("Couldn't start a sync right now.");
      }
      loadStats();
    } catch {
      setSyncNote("Couldn't reach the server.");
    } finally {
      setSyncing(false);
    }
  }

  // ---------- derived ----------

  const pending = (stats?.queued ?? 0) + (stats?.running ?? 0);
  const asking = thread.some((x) => x.status === "loading");
  const questionIsRtl = isRtl(question);
  const hasDocs = !!docs && docs.length > 0;
  const scoped = selectedDocs.length > 0;
  const singleDoc = selectedDocs.length === 1 ? selectedDocs[0] : null;
  const scopeLabel = singleDoc ?? (scoped ? `${selectedDocs.length} documents` : "all documents");

  const visibleDocs = useMemo(() => {
    if (!docs) return null;
    const f = docFilter.trim().toLowerCase();
    return f ? docs.filter((d) => d.key.toLowerCase().includes(f)) : docs;
  }, [docs, docFilter]);

  const exampleQuestions = scoped ? DOCUMENT_QUESTIONS : GENERAL_QUESTIONS;

  return (
    <div className="shell">
      {/* ---------- Library rail ---------- */}
      <aside className="rail" aria-label="Document library">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 4h9l4 4v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" strokeLinejoin="round" />
              <path d="M8.5 13h7M8.5 17h4" strokeLinecap="round" />
            </svg>
          </span>
          <span className="brand-name">stacks</span>
        </div>

        <IndexStatusCard
          docCount={docs ? docs.length : null}
          stats={stats}
          error={statsError}
          pending={pending}
          onRefresh={loadStats}
          onSyncNow={handleSyncNow}
          syncing={syncing}
          syncNote={syncNote}
        />

        <section aria-labelledby="library-heading">
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="library-heading" className="rail-heading">
              Your documents
            </h2>
            {hasDocs ? (
              <span className="flex gap-3">
                <button type="button" className="rail-link" onClick={() => setSelectedDocs(docs!.map((d) => d.key))}>
                  Select all
                </button>
                <button
                  type="button"
                  className="rail-link"
                  onClick={() => setSelectedDocs([])}
                  disabled={!scoped}
                >
                  Clear
                </button>
              </span>
            ) : null}
          </div>
          <p className="rail-note mt-1">
            Click a name to chat with just that file, or tick several to ask across them.
          </p>

          {docs && docs.length > 4 ? (
            <input
              type="search"
              className="field mt-3"
              placeholder="Filter documents"
              aria-label="Filter documents"
              value={docFilter}
              onChange={(e) => setDocFilter(e.target.value)}
            />
          ) : null}

          {libraryError ? (
            <div role="alert" className="rail-error">
              <span>{libraryError}</span>
              <button type="button" className="rail-link" onClick={() => void loadDocs()}>
                Retry
              </button>
            </div>
          ) : null}

          {pendingRemovals.length > 0 ? (
            <div className="rail-notice">
              <strong>
                {pendingRemovals.length} removed document{pendingRemovals.length === 1 ? " may" : "s may"} still be
                searchable.
              </strong>{" "}
              <span dir="auto">{pendingRemovals.join(", ")}</span> will drop out after the next sync. Answers that cite
              them are marked &ldquo;removed&rdquo;.
            </div>
          ) : null}

          {visibleDocs === null ? (
            <p className="rail-note mt-3">{libraryError ? "Library unavailable." : "Loading…"}</p>
          ) : docs && docs.length === 0 ? (
            <p className="rail-note mt-3">No documents yet. Add one below to start asking questions.</p>
          ) : visibleDocs.length === 0 ? (
            <p className="rail-note mt-3">No document matches &ldquo;{docFilter}&rdquo;.</p>
          ) : (
            <ul className="doc-list">
              {visibleDocs.map((doc) => {
                const checked = selectedDocs.includes(doc.key);
                return (
                  <li key={doc.key} className="doc-row" data-on={checked}>
                    <input
                      type="checkbox"
                      className="doc-check"
                      checked={checked}
                      onChange={() => toggleDocSelected(doc.key)}
                      aria-label={`Include ${doc.key} in questions`}
                    />
                    <button
                      type="button"
                      className="doc-main"
                      onClick={() => chatWithDoc(doc.key)}
                      title={`Chat with ${doc.key}`}
                    >
                      <span dir="auto" className="doc-name">
                        {doc.key}
                      </span>
                      <span className="doc-meta">
                        {formatBytes(doc.size)} &middot; {new Date(doc.uploaded).toLocaleDateString()}
                      </span>
                    </button>
                    <a
                      className="icon-btn"
                      href={docUrl(doc.key)}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open ${doc.key}`}
                      title="Open file"
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </a>
                    <button
                      type="button"
                      className="icon-btn danger"
                      onClick={() => handleDelete(doc.key)}
                      aria-label={`Remove ${doc.key}`}
                      title="Remove"
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-labelledby="add-heading">
          <h2 id="add-heading" className="rail-heading">
            Add a document
          </h2>
          <div className="seg" role="group" aria-label="How to add a document">
            <button type="button" aria-pressed={mode === "file"} onClick={() => setMode("file")}>
              Upload file
            </button>
            <button type="button" aria-pressed={mode === "paste"} onClick={() => setMode("paste")}>
              Paste text
            </button>
          </div>

          {mode === "file" ? (
            <div
              className="dropzone"
              data-over={dragOver}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              role="button"
              tabIndex={0}
              aria-label="Upload documents: drop files here or press Enter to browse"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.odt,.md,.txt,.jpg,.jpeg,.png,.webp,.gif,.bmp,.tif,.tiff,.heic,.heif"
                multiple
                onChange={handleFilePicked}
                className="hidden"
              />
              <p className="text-sm font-medium">{uploading ? "Uploading…" : "Drop files here, or click to browse"}</p>
              <p className="rail-note mt-1">
                PDF, Word, text, Markdown or images. Up to 10 MB for text{ocr ? " and PDFs" : ""}, 4 MB for the rest.
              </p>
            </div>
          ) : (
            <form onSubmit={handlePasteSubmit} className="mt-3 flex flex-col gap-2">
              <input
                type="text"
                required
                dir="auto"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Document title"
                className={`field ${isRtl(title) ? "rtl-text-ui" : ""}`}
              />
              <textarea
                required
                dir="auto"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Paste the text here"
                rows={6}
                className={`field resize-y ${isRtl(text) ? "rtl-text-ui" : ""}`}
              />
              <button type="submit" disabled={uploading} className="btn-marker self-start">
                {uploading ? "Saving…" : "Save document"}
              </button>
            </form>
          )}

          {uploadError ? (
            <p role="alert" className="rail-error">
              {uploadError}
            </p>
          ) : null}
          {uploadNote ? (
            <p className="rail-note mt-3">
              {uploadNote}{" "}
              <button type="button" className="rail-link" onClick={() => setShowSyncHelp(true)}>
                How do I index it now?
              </button>
            </p>
          ) : null}
        </section>

        <section aria-labelledby="ocr-heading">
          <h2 id="ocr-heading" className="rail-heading">
            Scanned files
          </h2>
          <label className="switch-row">
            <input
              type="checkbox"
              className="switch"
              role="switch"
              checked={ocr === true}
              disabled={ocr === null || ocrBusy}
              onChange={(e) => void toggleOcr(e.target.checked)}
            />
            <span>
              Read text from scanned PDFs and images (OCR)
              <span className="rail-note" style={{ display: "block" }}>
                {ocr === null
                  ? "Checking…"
                  : ocr
                    ? "On. Scanned pages and pictures become searchable. PDFs can be up to 10 MB."
                    : "Off. Scanned pages and pictures with text won't be searchable. Turning it on re-indexes everything."}
              </span>
            </span>
          </label>
          {ocrNote ? <p className="rail-note mt-2">{ocrNote}</p> : null}
        </section>
      </aside>

      {/* ---------- Desk ---------- */}
      <main className="desk">
        <div className="desk-inner">
          {scoped ? (
            <div className="scope-bar">
              <div className="min-w-0">
                <p className="scope-bar-title">
                  Chatting with <strong dir="auto">{scopeLabel}</strong>
                </p>
                <p className="scope-bar-note">
                  {singleDoc
                    ? "Answers come only from this file."
                    : `Answers come only from these ${selectedDocs.length} files.`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {singleDoc ? (
                  <a className="btn-quiet" href={docUrl(singleDoc)} target="_blank" rel="noreferrer">
                    Open file
                  </a>
                ) : null}
                <button type="button" className="btn-quiet" onClick={() => setSelectedDocs([])}>
                  Ask all documents
                </button>
              </div>
            </div>
          ) : null}

          {thread.length === 0 ? (
            <div className="pt-4 sm:pt-8">
              {scoped ? (
                <>
                  <h1 dir="auto" className="headline" style={{ minHeight: 0 }}>
                    {singleDoc ? `Chat with ${singleDoc}` : `Chat with ${selectedDocs.length} documents`}
                  </h1>
                  <p className="lede">
                    Ask anything about {singleDoc ? "this file" : "these files"}. Follow-up questions remember the
                    conversation.
                  </p>
                </>
              ) : (
                <>
                  <RotatingHeadline />
                  <p className="lede">
                    Ask in any language about documents written in any language. Answers come only from what
                    you&rsquo;ve added, with the source files cited, and arrive in the language you asked in.
                  </p>
                </>
              )}
              {hasDocs ? (
                <div className="chip-row" role="group" aria-label="Example questions">
                  {exampleQuestions.map((q) => (
                    <button
                      key={q}
                      type="button"
                      className="ghost-chip"
                      onClick={() => {
                        setQuestion(q);
                        composerRef.current?.focus();
                      }}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="lede mt-4">Add a document from the library panel to get started.</p>
              )}
            </div>
          ) : (
            <div className="thread" aria-live="polite">
              {thread.map((x, index) => (
                <article key={x.id}>
                  <h2 dir="auto" className={`question ${isRtl(x.question) ? "rtl-text-ui" : ""}`}>
                    {x.question}
                  </h2>

                  {x.status === "loading" ? (
                    <div className="sheet loading-sheet">
                      <p className="dots" role="status" aria-label="Searching your documents">
                        <span />
                        <span />
                        <span />
                      </p>
                      <p className="doc-meta" style={{ color: "var(--ink-dim)" }}>
                        Searching {scoped ? scopeLabel : "your documents"} (<Elapsed since={x.startedAt} />)
                      </p>
                      <button type="button" className="btn-quiet" onClick={() => stopExchange(x.id)}>
                        Stop
                      </button>
                    </div>
                  ) : null}

                  {x.status === "error" ? (
                    <div className="error-box" role="alert">
                      <p>{x.error}</p>
                      <button type="button" className="btn-outline-ink" onClick={() => retryExchange(x)}>
                        Try again
                      </button>
                    </div>
                  ) : null}

                  {x.status === "done" ? (
                    <>
                      {x.scopedTo && x.scopedTo.length > 0 ? (
                        <p className="scope-note" dir="auto">
                          Answered using only: {x.scopedTo.join(", ")}
                        </p>
                      ) : null}
                      <div className="sheet">
                        <div dir="auto" className={`markdown-body ${x.answer && isRtl(x.answer) ? "rtl-text" : ""}`}>
                          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                            {x.answer ?? ""}
                          </ReactMarkdown>
                        </div>

                        {x.sources && x.sources.length > 0 ? (
                          <div className="sources">
                            <h3>Sources</h3>
                            {x.sources.map((s, i) => {
                              const open = !!openPassages[`${x.id}:${s.key}`];
                              const pct = s.score !== undefined ? Math.round(Math.min(1, Math.max(0, s.score)) * 100) : null;
                              return (
                                <div
                                  key={s.key}
                                  className="source-row"
                                  data-removed={s.removed}
                                  title={
                                    s.removed
                                      ? "This document was removed from the library but the search index hasn't caught up yet."
                                      : undefined
                                  }
                                >
                                  <span className="source-num">{i + 1}</span>
                                  <div className="min-w-0">
                                    <p dir="auto" className="doc-name" style={{ color: "var(--ink)" }}>
                                      {s.removed ? (
                                        <>
                                          {s.key} <span style={{ color: "var(--err)" }}>(removed)</span>
                                        </>
                                      ) : (
                                        <a className="src-link" href={docUrl(s.key)} target="_blank" rel="noreferrer">
                                          {s.key}
                                        </a>
                                      )}
                                    </p>
                                    {pct !== null ? (
                                      <div className="meter" role="img" aria-label={`Relevance ${pct} percent`}>
                                        <span style={{ width: `${pct}%` }} />
                                      </div>
                                    ) : null}
                                  </div>
                                  <span className="doc-meta" style={{ color: "var(--ink-dim)" }}>
                                    {s.count} excerpt{s.count === 1 ? "" : "s"}
                                  </span>
                                  {s.excerpt ? (
                                    <div className="source-extra">
                                      <button
                                        type="button"
                                        className="btn-quiet"
                                        aria-expanded={open}
                                        onClick={() =>
                                          setOpenPassages((prev) => ({ ...prev, [`${x.id}:${s.key}`]: !open }))
                                        }
                                      >
                                        {open ? "Hide passage" : "Show passage"}
                                      </button>
                                      {open ? (
                                        <blockquote dir="auto" className="passage">
                                          {s.excerpt}
                                        </blockquote>
                                      ) : null}
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="no-sources" role="note">
                            No passages from your files were found for this question, so this answer isn&rsquo;t based on
                            them. If you just added the file, it may still be indexing. Check the status card on the left
                            and ask again when it says the index is up to date.
                          </p>
                        )}
                      </div>

                      <div className="answer-actions">
                        <button type="button" className="btn-quiet" onClick={() => void copyAnswer(x)}>
                          {copiedId === x.id ? "Copied" : "Copy answer"}
                        </button>
                        {index === thread.length - 1 ? (
                          <button type="button" className="btn-quiet" onClick={() => retryExchange(x)} disabled={asking}>
                            Regenerate
                          </button>
                        ) : null}
                      </div>
                    </>
                  ) : null}
                </article>
              ))}
              <div ref={bottomRef} />
            </div>
          )}

          <div className="flex-1" />

          <div className="composer-wrap">
            <form onSubmit={handleAsk} className="composer">
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <span className="rail-note" style={{ color: "var(--ink-dim)" }}>
                  Asking
                </span>
                {selectedDocs.length === 0 ? (
                  <span className="text-sm font-medium">all documents</span>
                ) : (
                  <>
                    {selectedDocs.map((key) => (
                      <span key={key} dir="auto" className="marker-chip">
                        <span className="truncate">{key}</span>
                        <button
                          type="button"
                          onClick={() => toggleDocSelected(key)}
                          aria-label={`Stop limiting questions to ${key}`}
                        >
                          &times;
                        </button>
                      </span>
                    ))}
                    <button type="button" className="btn-quiet" onClick={() => setSelectedDocs([])}>
                      Ask all documents
                    </button>
                  </>
                )}
              </div>
              <div className="flex items-end gap-3">
                <textarea
                  ref={composerRef}
                  dir="auto"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder={
                    singleDoc
                      ? `Ask about ${singleDoc}`
                      : scoped
                        ? "Ask about the selected documents"
                        : "Ask anything about your documents, in any language"
                  }
                  rows={2}
                  aria-label="Your question"
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                      e.preventDefault();
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                  className={questionIsRtl ? "rtl-text-ui" : ""}
                />
                <button type="submit" disabled={asking || !question.trim() || !hasDocs} className="btn-primary">
                  {asking ? "Searching…" : "Ask"}
                </button>
              </div>
            </form>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
              <p className="rail-note" style={{ color: "var(--ink-dim)" }}>
                Ctrl + Enter to send{!hasDocs && docs !== null ? " · add a document first" : ""}
              </p>
              {thread.length > 0 ? (
                <span className="flex gap-4">
                  <button type="button" className="btn-quiet" onClick={exportConversation}>
                    Export as Markdown
                  </button>
                  <button type="button" className="btn-quiet" onClick={clearConversation}>
                    Clear conversation
                  </button>
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </main>

      {showSyncHelp ? <SyncHelpDialog onClose={() => setShowSyncHelp(false)} /> : null}
    </div>
  );
}

function IndexStatusCard({
  docCount,
  stats,
  error,
  pending,
  onRefresh,
  onSyncNow,
  syncing,
  syncNote,
}: {
  docCount: number | null;
  stats: IndexStats | null;
  error: boolean;
  pending: number;
  onRefresh: () => void;
  onSyncNow: () => void;
  syncing: boolean;
  syncNote: string | null;
}) {
  const vectors = stats?.engine?.vectorize?.vectorsCount;
  const hasErrors = (stats?.error ?? 0) > 0;
  // Files that are in the library but that the index hasn't processed yet.
  // Before this, the card said "up to date" while a just-uploaded file was
  // still waiting, which is why it looked like nothing was happening.
  const handled = (stats?.completed ?? 0) + (stats?.skipped ?? 0) + (stats?.error ?? 0);
  const waiting = docCount === null || !stats ? 0 : Math.max(0, docCount - handled);
  const dot = hasErrors ? "#ff8a7a" : pending > 0 || waiting > 0 ? "#ffd166" : "var(--marker)";

  return (
    <div className="status-card" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {error || !stats ? null : <span className="status-dot" style={{ background: dot }} />}
          <p className="text-sm font-medium">
            {error
              ? "Can't reach AI Search"
              : !stats
                ? "Checking the index…"
                : hasErrors
                  ? `${stats.error} indexing error${stats.error === 1 ? "" : "s"}`
                  : pending > 0
                    ? `Indexing, ${pending} pending`
                    : waiting > 0
                      ? `${waiting} file${waiting === 1 ? "" : "s"} not indexed yet`
                      : "Index is up to date"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button type="button" className="rail-link" onClick={onSyncNow} disabled={syncing}>
            {syncing ? "Syncing…" : "Sync now"}
          </button>
          <button type="button" className="rail-link" onClick={onRefresh}>
            Refresh
          </button>
        </div>
      </div>

      {syncNote ? <p className="rail-note mt-2">{syncNote}</p> : null}

      {stats ? (
        <p className="rail-note mt-2">
          {stats.completed ?? 0} indexed file{(stats.completed ?? 0) === 1 ? "" : "s"}
          {vectors !== undefined ? ` · ${vectors.toLocaleString()} searchable passages` : ""}
        </p>
      ) : null}
    </div>
  );
}

function SyncHelpDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="scrim" onClick={onClose} role="presentation">
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-help-title"
      >
        <h3 id="sync-help-title" className="font-[family-name:var(--font-display)] text-lg font-bold">
          New documents aren&rsquo;t searchable right away
        </h3>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--ink-dim)" }}>
          AI Search re-reads your documents on its own schedule, as often as every 15 minutes, so a new file can take
          that long to appear in answers. To index immediately, either run this command from a machine where{" "}
          <code>wrangler</code> is logged in:
        </p>
        <pre className="mt-3">npx wrangler ai-search jobs create cf-rag-tool</pre>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--ink-dim)" }}>
          or set an API token (<code>CF_API_TOKEN</code> with AI Search edit and run access) so uploads and
          &ldquo;Sync now&rdquo; start the job for you. Watch progress with <code>npx wrangler ai-search stats cf-rag-tool</code>{" "}
          or the status card in the library panel.
        </p>
        <button type="button" onClick={onClose} className="btn-primary mt-4">
          Got it
        </button>
      </div>
    </div>
  );
}
