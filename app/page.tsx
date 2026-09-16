"use client";

import { useCallback, useEffect, useState } from "react";

interface DocSummary {
  id: string;
  title: string;
  createdAt: string;
  chunkCount: number;
}

interface Source {
  title: string;
  chunkIndex: number;
  score?: number;
}

export default function HomePage() {
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [ingesting, setIngesting] = useState(false);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [ingestNote, setIngestNote] = useState<string | null>(null);

  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [sources, setSources] = useState<Source[]>([]);

  const loadDocs = useCallback(async () => {
    const res = await fetch("/api/docs");
    const data = await res.json();
    setDocs(data.docs ?? []);
  }, []);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  async function handleIngest(e: React.FormEvent) {
    e.preventDefault();
    setIngestError(null);
    setIngestNote(null);
    setIngesting(true);
    try {
      const res = await fetch("/api/docs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, text }),
      });
      const data = await res.json();
      if (!res.ok) {
        setIngestError(data.error ?? "Something went wrong.");
        return;
      }
      setIngestNote(`Indexed "${data.title}" into ${data.chunkCount} chunk${data.chunkCount === 1 ? "" : "s"}.`);
      setTitle("");
      setText("");
      await loadDocs();
    } catch {
      setIngestError("Couldn't reach the server.");
    } finally {
      setIngesting(false);
    }
  }

  async function handleDelete(id: string) {
    setDocs((prev) => prev?.filter((d) => d.id !== id) ?? null);
    await fetch(`/api/docs/${id}`, { method: "DELETE" });
  }

  async function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    setAskError(null);
    setAnswer(null);
    setSources([]);
    setAsking(true);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAskError(data.error ?? "Something went wrong.");
        return;
      }
      setAnswer(data.answer);
      setSources(data.sources ?? []);
    } catch {
      setAskError("Couldn't reach the server.");
    } finally {
      setAsking(false);
    }
  }

  return (
    <main className="relative z-10 mx-auto flex min-h-screen max-w-3xl flex-col gap-14 px-6 py-16">
      <header>
        <p className="chip tracking-[0.2em] text-[var(--accent)] uppercase">workers ai + vectorize</p>
        <h1 className="mt-3 font-[family-name:var(--font-display)] text-4xl font-semibold tracking-tight sm:text-5xl">
          Ask your documents.
        </h1>
        <p className="mt-3 max-w-lg text-sm leading-relaxed text-[var(--ink-dim)]">
          Paste in some text, then ask questions about it. Answers are generated only from what
          you've indexed — with citations back to the source.
        </p>
      </header>

      <section>
        <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold">Ask a question</h2>
        <form onSubmit={handleAsk} className="mt-4 flex flex-col gap-3">
          <textarea
            required
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What does the document say about…?"
            rows={2}
            className="paper resize-none rounded-lg px-4 py-3 text-sm text-[var(--ink)] placeholder:text-[var(--ink-dim)] focus:border-[var(--accent)] focus:outline-none"
          />
          <button
            type="submit"
            disabled={asking}
            className="self-start rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-medium text-[var(--accent-ink)] transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {asking ? "thinking…" : "ask →"}
          </button>
        </form>

        {askError ? <p className="fade-in-up mt-3 text-sm text-[var(--err)]">{askError}</p> : null}

        {answer ? (
          <div className="fade-in-up paper mt-5 rounded-xl p-5">
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{answer}</p>
            {sources.length > 0 ? (
              <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--border)] pt-4">
                {sources.map((s, i) => (
                  <span
                    key={i}
                    className="chip rounded-full border border-[var(--border-strong)] px-2.5 py-1 text-[var(--ink-dim)]"
                  >
                    [{i + 1}] {s.title} · chunk {s.chunkIndex}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section>
        <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold">Add a document</h2>
        <form onSubmit={handleIngest} className="mt-4 flex flex-col gap-3">
          <input
            type="text"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Document title"
            className="paper rounded-lg px-4 py-2.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-dim)] focus:border-[var(--accent)] focus:outline-none"
          />
          <textarea
            required
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste the document's text here…"
            rows={6}
            className="paper resize-y rounded-lg px-4 py-3 font-[family-name:var(--font-mono)] text-sm text-[var(--ink)] placeholder:font-[family-name:var(--font-body)] placeholder:text-[var(--ink-dim)] focus:border-[var(--accent)] focus:outline-none"
          />
          <button
            type="submit"
            disabled={ingesting}
            className="self-start rounded-lg border border-[var(--border-strong)] bg-[var(--paper)] px-5 py-2.5 text-sm font-medium transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
          >
            {ingesting ? "indexing…" : "index document"}
          </button>
        </form>
        {ingestError ? <p className="fade-in-up mt-3 text-sm text-[var(--err)]">{ingestError}</p> : null}
        {ingestNote ? <p className="fade-in-up mt-3 text-sm text-[var(--accent)]">{ingestNote}</p> : null}
      </section>

      <section>
        <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold">Indexed documents</h2>
        <div className="paper mt-4 divide-y divide-[var(--border)] rounded-xl">
          {docs === null ? (
            <p className="px-5 py-6 text-sm text-[var(--ink-dim)]">
              <span className="spin-dot mr-2 inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
              loading…
            </p>
          ) : docs.length === 0 ? (
            <p className="px-5 py-6 text-sm text-[var(--ink-dim)]">No documents yet — add one above.</p>
          ) : (
            docs.map((doc) => (
              <div key={doc.id} className="flex items-center justify-between gap-4 px-5 py-3.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{doc.title}</p>
                  <p className="chip mt-0.5 text-[var(--ink-dim)]">
                    {doc.chunkCount} chunk{doc.chunkCount === 1 ? "" : "s"} · {new Date(doc.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleDelete(doc.id)}
                  className="shrink-0 rounded-full border border-[var(--border-strong)] px-3 py-1.5 text-xs transition-colors hover:border-[var(--err)] hover:text-[var(--err)]"
                >
                  remove
                </button>
              </div>
            ))
          )}
        </div>
      </section>
    </main>
  );
}
