"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { isRtl } from "@/lib/rtl";

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Markdown table cells need to scroll rather than blow out the card's
// width, so tables get wrapped in an overflow-x:auto container. No raw
// HTML is ever rendered (no rehype-raw) — model output is untrusted text,
// so literal HTML like stray "<br>" tags shows up as visible text instead
// of being executed.
const markdownComponents: Components = {
  table: ({ children }) => (
    <div className="markdown-table-wrap">
      <table>{children}</table>
    </div>
  ),
};

export default function HomePage() {
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [pendingRemovals, setPendingRemovals] = useState<string[]>([]);
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [sources, setSources] = useState<Source[]>([]);

  const [stats, setStats] = useState<IndexStats | null>(null);
  const [statsError, setStatsError] = useState(false);
  const [showSyncHelp, setShowSyncHelp] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  const [selectedDocs, setSelectedDocs] = useState<string[]>([]);
  const [scopedAnswerTo, setScopedAnswerTo] = useState<string[]>([]);

  const loadDocs = useCallback(async () => {
    const res = await fetch("/api/docs");
    const data = await res.json();
    setDocs(data.docs ?? []);
    setPendingRemovals(data.pendingRemovals ?? []);
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch("/api/sync");
      const data = await res.json();
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

  useEffect(() => {
    loadDocs();
    loadStats();
    const id = setInterval(loadStats, 20_000);
    return () => clearInterval(id);
  }, [loadDocs, loadStats]);

  async function uploadFile(file: File) {
    setUploadError(null);
    setUploadNote(null);
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/docs", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        setUploadError(data.error ?? "Something went wrong.");
        return;
      }
      setUploadNote(`Uploaded "${data.key}". Indexing was triggered automatically — it'll be searchable shortly.`);
      await loadDocs();
      loadStats();
    } catch {
      setUploadError("Couldn't reach the server.");
    } finally {
      setUploading(false);
    }
  }

  function handleFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) uploadFile(file);
    e.target.value = "";
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) uploadFile(file);
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
      const data = await res.json();
      if (!res.ok) {
        setUploadError(data.error ?? "Something went wrong.");
        return;
      }
      setUploadNote(`Saved "${data.key}". Indexing was triggered automatically — it'll be searchable shortly.`);
      setTitle("");
      setText("");
      await loadDocs();
      loadStats();
    } catch {
      setUploadError("Couldn't reach the server.");
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(key: string) {
    setDocs((prev) => prev?.filter((d) => d.key !== key) ?? null);
    setSelectedDocs((prev) => prev.filter((k) => k !== key));
    await fetch(`/api/docs/${encodeURIComponent(key)}`, { method: "DELETE" });
    // Removing the R2 object doesn't remove its vectors from the index
    // until the next sync — reload so the "pending removal" state (and its
    // sync-now nudge) shows up right away instead of only on the next poll.
    await loadDocs();
    loadStats();
  }

  function toggleDocSelected(key: string) {
    setSelectedDocs((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  async function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    setAskError(null);
    setAnswer(null);
    setSources([]);
    setScopedAnswerTo([]);
    setAsking(true);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question, filenames: selectedDocs }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAskError(data.error ?? "Something went wrong.");
        return;
      }
      setAnswer(data.answer);
      setSources(data.sources ?? []);
      setScopedAnswerTo(data.scopedTo ?? []);
    } catch {
      setAskError("Couldn't reach the server.");
    } finally {
      setAsking(false);
    }
  }

  async function handleSyncNow() {
    setSyncing(true);
    setSyncNote(null);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setSyncNote("Indexing job started.");
      } else if (data.reason === "no-token") {
        setSyncNote("No API token configured — showing the CLI command instead.");
        setShowSyncHelp(true);
      } else if (data.reason === "already-active") {
        setSyncNote("An indexing job is already running.");
      } else if (data.reason === "debounced") {
        setSyncNote("A sync was just triggered — try again in a bit.");
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

  const pending = (stats?.queued ?? 0) + (stats?.running ?? 0);
  const answerIsRtl = answer ? isRtl(answer) : false;
  const questionIsRtl = isRtl(question);

  return (
    <main className="relative z-10 mx-auto flex min-h-screen max-w-6xl flex-col gap-10 px-6 py-12 sm:py-16">
      <header className="flex flex-col gap-6 border-b border-[var(--border)] pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--accent)] text-[var(--accent-ink)]"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                <path
                  d="M6 4h9l4 4v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"
                  strokeLinejoin="round"
                />
                <path d="M15 4v4h4" strokeLinejoin="round" />
                <circle cx="10.5" cy="14" r="3" />
                <path d="M12.8 16.3 15 18.5" strokeLinecap="round" />
              </svg>
            </span>
            <p className="chip tracking-[0.2em] text-[var(--accent)] uppercase">cloudflare ai search</p>
          </div>
          <h1 className="mt-4 font-[family-name:var(--font-display)] text-4xl font-semibold tracking-tight sm:text-5xl">
            Ask your documents.
          </h1>
          <p className="mt-3 max-w-lg text-sm leading-relaxed text-[var(--ink-dim)]">
            Drop in PDFs, Word docs, or plain text in any language — Cloudflare AI Search indexes
            them with a multilingual model. Ask in any language and get answers grounded only in
            what you&rsquo;ve uploaded, with citations, replied to in the language you asked in.
          </p>
        </div>
        <IndexStatusCard
          stats={stats}
          error={statsError}
          pending={pending}
          onRefresh={loadStats}
          onSyncNow={handleSyncNow}
          syncing={syncing}
          syncNote={syncNote}
        />
      </header>

      <div className="grid gap-10 lg:grid-cols-[1.6fr_1fr] lg:items-start">
        <section className="flex flex-col gap-10">
          <div>
            <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold">Ask a question</h2>

            <div
              className={`mt-3 flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${
                selectedDocs.length > 0
                  ? "border border-[var(--accent)] bg-[var(--bg-2)]"
                  : "border border-transparent"
              }`}
            >
              <span className="font-medium text-[var(--ink-dim)]">Asking:</span>
              {selectedDocs.length === 0 ? (
                <span className="chip rounded-full border border-[var(--border-strong)] px-2.5 py-1 text-[var(--ink-dim)]">
                  all documents
                </span>
              ) : (
                <>
                  {selectedDocs.map((key) => (
                    <span
                      key={key}
                      dir="auto"
                      className="chip flex max-w-[16rem] items-center gap-1.5 rounded-full border border-[var(--accent)] bg-[var(--paper)] px-2.5 py-1 text-[var(--accent)]"
                    >
                      <span className="truncate">{key}</span>
                      <button
                        type="button"
                        onClick={() => toggleDocSelected(key)}
                        aria-label={`Remove ${key} from scope`}
                        className="shrink-0 hover:opacity-70"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <button
                    type="button"
                    onClick={() => setSelectedDocs([])}
                    className="chip rounded-full border border-[var(--border-strong)] px-2.5 py-1 text-[var(--ink-dim)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                  >
                    reset to all documents
                  </button>
                </>
              )}
            </div>

            <form onSubmit={handleAsk} className="mt-3 flex flex-col gap-3">
              <textarea
                required
                dir="auto"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="What does the document say about…? (ask in any language)"
                rows={2}
                className={`paper resize-none rounded-lg px-4 py-3 text-sm text-[var(--ink)] placeholder:text-[var(--ink-dim)] focus:border-[var(--accent)] focus:outline-none ${
                  selectedDocs.length > 0 ? "border-[var(--accent)]" : ""
                } ${questionIsRtl ? "rtl-text-ui" : ""}`}
              />
              <button
                type="submit"
                disabled={asking}
                className="self-start rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-medium text-[var(--accent-ink)] transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {asking
                  ? "thinking…"
                  : selectedDocs.length > 0
                    ? `ask (${selectedDocs.length} doc${selectedDocs.length === 1 ? "" : "s"} only) →`
                    : "ask →"}
              </button>
            </form>

            {askError ? <p className="fade-in-up mt-3 text-sm text-[var(--err)]">{askError}</p> : null}

            {answer ? (
              <div className="fade-in-up paper mt-5 rounded-xl p-5">
                <div
                  dir="auto"
                  className={`markdown-body ${answerIsRtl ? "rtl-text" : ""}`}
                >
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {answer}
                  </ReactMarkdown>
                </div>
                {sources.length > 0 ? (
                  <div className="mt-4 border-t border-[var(--border)] pt-4">
                    {scopedAnswerTo.length > 0 ? (
                      <p className="chip mb-2 text-[var(--ink-dim)]">
                        Answered using only: {scopedAnswerTo.join(", ")}
                      </p>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      {sources.map((s, i) => {
                        const titleParts = [
                          s.score !== undefined ? `relevance ${s.score.toFixed(2)}` : null,
                          `${s.count} matching excerpt${s.count === 1 ? "" : "s"}`,
                          s.removed
                            ? "This document was removed from the library but the search index hasn't caught up yet."
                            : null,
                        ].filter(Boolean);
                        return (
                          <span
                            key={s.key}
                            dir="auto"
                            className={`chip flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${
                              s.removed
                                ? "border-[var(--err)]/60 text-[var(--err)]"
                                : "border-[var(--border-strong)] text-[var(--ink-dim)]"
                            }`}
                            title={titleParts.join(" · ")}
                          >
                            <span>
                              [{i + 1}] {s.key}
                              {s.count > 1 ? ` · ${s.count} excerpts` : ""}
                            </span>
                            {s.removed ? <span className="font-medium">removed</span> : null}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <div>
            <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold">Add a document</h2>

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setMode("file")}
                className={`chip rounded-full border px-3 py-1.5 transition-colors ${
                  mode === "file"
                    ? "border-[var(--accent)] text-[var(--accent)]"
                    : "border-[var(--border-strong)] text-[var(--ink-dim)]"
                }`}
              >
                upload file
              </button>
              <button
                type="button"
                onClick={() => setMode("paste")}
                className={`chip rounded-full border px-3 py-1.5 transition-colors ${
                  mode === "paste"
                    ? "border-[var(--accent)] text-[var(--accent)]"
                    : "border-[var(--border-strong)] text-[var(--ink-dim)]"
                }`}
              >
                paste text
              </button>
            </div>

            {mode === "file" ? (
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`paper mt-4 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors ${
                  dragOver ? "border-[var(--accent)] bg-[var(--bg-2)]" : "border-[var(--border-strong)]"
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.docx,.odt,.md,.txt"
                  onChange={handleFilePicked}
                  className="hidden"
                />
                <p className="text-sm font-medium">
                  {uploading ? "uploading…" : "Drop a file here, or click to browse"}
                </p>
                <p className="chip text-[var(--ink-dim)]">PDF, DOCX, ODT, Markdown, or plain text — up to 20MB</p>
              </div>
            ) : (
              <form onSubmit={handlePasteSubmit} className="mt-4 flex flex-col gap-3">
                <input
                  type="text"
                  required
                  dir="auto"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Document title"
                  className={`paper rounded-lg px-4 py-2.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-dim)] focus:border-[var(--accent)] focus:outline-none ${
                    isRtl(title) ? "rtl-text-ui" : ""
                  }`}
                />
                <textarea
                  required
                  dir="auto"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Paste the document's text here…"
                  rows={6}
                  className={`paper resize-y rounded-lg px-4 py-3 text-sm text-[var(--ink)] placeholder:font-[family-name:var(--font-body)] placeholder:text-[var(--ink-dim)] focus:border-[var(--accent)] focus:outline-none ${
                    isRtl(text) ? "rtl-text" : "font-[family-name:var(--font-mono)]"
                  }`}
                />
                <button
                  type="submit"
                  disabled={uploading}
                  className="self-start rounded-lg border border-[var(--border-strong)] bg-[var(--paper)] px-5 py-2.5 text-sm font-medium transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
                >
                  {uploading ? "saving…" : "save document"}
                </button>
              </form>
            )}

            {uploadError ? <p className="fade-in-up mt-3 text-sm text-[var(--err)]">{uploadError}</p> : null}
            {uploadNote ? (
              <div className="fade-in-up mt-3 flex flex-wrap items-center gap-2 text-sm text-[var(--accent)]">
                <span>{uploadNote}</span>
                <button
                  type="button"
                  onClick={() => setShowSyncHelp(true)}
                  className="chip rounded-full border border-[var(--accent)] px-2 py-0.5 text-[var(--accent)] hover:opacity-80"
                >
                  how do I sync?
                </button>
              </div>
            ) : null}
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold">Document library</h2>
            {docs && docs.length > 0 ? (
              <p className="chip text-[var(--ink-dim)]">check to scope questions</p>
            ) : null}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-[var(--ink-dim)]">
            What&rsquo;s in R2, not necessarily what&rsquo;s searchable right now — the search
            index can lag behind by a sync or more. See Index status.
          </p>

          {pendingRemovals.length > 0 ? (
            <div className="fade-in-up mt-3 rounded-lg border border-[var(--accent-2)] bg-[var(--bg-2)] px-4 py-3 text-sm">
              <p>
                <span className="font-medium">
                  Index likely out of sync — {pendingRemovals.length} removed document
                  {pendingRemovals.length === 1 ? " may" : "s may"} still be searchable.
                </span>{" "}
                Deleted from the library but not yet confirmed dropped from the search index:{" "}
                <span dir="auto">{pendingRemovals.join(", ")}</span>. Usually clears within a
                sync or two (as often as every 15 minutes), or use &ldquo;sync now&rdquo; above.
                Either way, any citation from a removed document is always flagged
                &ldquo;removed&rdquo; below the answer, live — so nothing is hidden even after
                this notice clears.
              </p>
            </div>
          ) : null}

          <div className="paper mt-4 divide-y divide-[var(--border)] rounded-xl">
            {docs === null ? (
              <p className="px-5 py-6 text-sm text-[var(--ink-dim)]">
                <span className="spin-dot mr-2 inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                loading…
              </p>
            ) : docs.length === 0 ? (
              <p className="px-5 py-6 text-sm text-[var(--ink-dim)]">No documents yet — add one above.</p>
            ) : (
              docs.map((doc) => {
                const checked = selectedDocs.includes(doc.key);
                return (
                  <div
                    key={doc.key}
                    className={`flex items-center justify-between gap-4 px-5 py-3.5 transition-colors ${
                      checked ? "bg-[var(--bg-2)]" : ""
                    }`}
                  >
                    <label className="flex min-w-0 items-center gap-3">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleDocSelected(doc.key)}
                        aria-label={`Scope questions to ${doc.key} only`}
                        className="shrink-0 accent-[var(--accent)]"
                      />
                      <div className="min-w-0">
                        <p dir="auto" className="truncate text-sm font-medium">
                          {doc.key}
                        </p>
                        <p className="chip mt-0.5 text-[var(--ink-dim)]">
                          {formatBytes(doc.size)} · {new Date(doc.uploaded).toLocaleDateString()}
                        </p>
                      </div>
                    </label>
                    <button
                      type="button"
                      onClick={() => handleDelete(doc.key)}
                      className="shrink-0 rounded-full border border-[var(--border-strong)] px-3 py-1.5 text-xs transition-colors hover:border-[var(--err)] hover:text-[var(--err)]"
                    >
                      remove
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>

      {showSyncHelp ? <SyncHelpDialog onClose={() => setShowSyncHelp(false)} /> : null}
    </main>
  );
}

function IndexStatusCard({
  stats,
  error,
  pending,
  onRefresh,
  onSyncNow,
  syncing,
  syncNote,
}: {
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

  return (
    <div className="paper w-full shrink-0 rounded-xl px-5 py-4 sm:w-72">
      <div className="flex items-center justify-between">
        <p className="chip font-medium text-[var(--ink-dim)] uppercase">Index status</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSyncNow}
            disabled={syncing}
            className="chip text-[var(--accent)] hover:opacity-70 disabled:opacity-50"
            aria-label="Sync now"
          >
            {syncing ? "syncing…" : "sync now"}
          </button>
          <button
            type="button"
            onClick={onRefresh}
            className="chip text-[var(--accent)] hover:opacity-70"
            aria-label="Refresh index status"
          >
            refresh
          </button>
        </div>
      </div>

      {syncNote ? <p className="fade-in-up mt-2 text-sm text-[var(--ink-dim)]">{syncNote}</p> : null}

      {error ? (
        <p className="mt-2 text-sm text-[var(--ink-dim)]">Couldn&rsquo;t reach AI Search.</p>
      ) : !stats ? (
        <p className="mt-2 text-sm text-[var(--ink-dim)]">checking…</p>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <span
            className={`status-dot h-2 w-2 rounded-full ${
              hasErrors ? "bg-[var(--err)]" : pending > 0 ? "bg-[var(--accent-2)]" : "bg-[var(--accent)]"
            }`}
          />
          <p className="text-sm">
            {hasErrors
              ? `${stats.error} indexing error${stats.error === 1 ? "" : "s"}`
              : pending > 0
                ? `indexing… ${pending} pending`
                : "up to date"}
          </p>
        </div>
      )}

      {stats ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-[var(--border)] pt-3">
          <dt className="chip text-[var(--ink-dim)]">completed</dt>
          <dd className="text-right text-sm">{stats.completed ?? 0}</dd>
          <dt className="chip text-[var(--ink-dim)]">vectors</dt>
          <dd className="text-right text-sm">{vectors ?? "—"}</dd>
        </dl>
      ) : null}
    </div>
  );
}

function SyncHelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-20 flex items-center justify-center bg-[var(--ink)]/30 px-6 backdrop-blur-[2px]"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="fade-in-up paper w-full max-w-md rounded-xl p-6"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-help-title"
      >
        <h3 id="sync-help-title" className="font-[family-name:var(--font-display)] text-lg font-semibold">
          Newly-added documents aren&rsquo;t searchable instantly
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-[var(--ink-dim)]">
          This app tries to index new uploads automatically. If an API token is configured
          (<code className="chip mx-1 rounded bg-[var(--bg-2)] px-1 py-0.5">CF_API_TOKEN</code>),
          uploads and &ldquo;sync now&rdquo; trigger an indexing job right away. Without one, AI
          Search still re-syncs on its own schedule (as often as every 15 minutes). To force it
          immediately yourself, run this from a machine with
          <code className="chip mx-1 rounded bg-[var(--bg-2)] px-1 py-0.5">wrangler</code>
          authenticated:
        </p>
        <pre className="chip mt-3 overflow-x-auto rounded-lg bg-[var(--bg-2)] p-3 leading-relaxed">
          npx wrangler ai-search jobs create cf-rag-tool
        </pre>
        <p className="mt-2 text-sm leading-relaxed text-[var(--ink-dim)]">
          Then watch progress with
          <code className="chip mx-1 rounded bg-[var(--bg-2)] px-1 py-0.5">
            npx wrangler ai-search stats cf-rag-tool
          </code>
          — or just glance at the Index status panel on this page, which polls the same numbers.
        </p>
        <button
          type="button"
          onClick={onClose}
          className="mt-4 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:opacity-90"
        >
          got it
        </button>
      </div>
    </div>
  );
}
