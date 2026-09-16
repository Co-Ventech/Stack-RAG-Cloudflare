export const CHAT_MODEL = "@cf/openai/gpt-oss-20b";
export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB
export const MAX_PASTE_CHARS = 200_000;

// Extensions AI Search can index from an R2 source: plain text/markdown
// directly, PDFs natively, and .docx/.odt via its own text conversion.
export const ALLOWED_EXTENSIONS = ["txt", "md", "pdf", "docx", "odt"];

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

export function isAllowedExtension(filename: string): boolean {
  return ALLOWED_EXTENSIONS.includes(extensionOf(filename));
}

/** R2 object keys are flat filenames — strip path separators and anything
 * that isn't safe to round-trip through a URL path segment. */
export function sanitizeFilename(filename: string): string {
  const base = filename.replace(/[\\/]/g, "_").trim();
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180);
  return /[a-zA-Z0-9]/.test(cleaned) ? cleaned : "file";
}

/** Makes a pasted-text title collision-safe and gives it a .txt extension
 * so AI Search treats it as plain text. */
export function titleToKey(title: string): string {
  const safe = sanitizeFilename(title) || "note";
  return safe.toLowerCase().endsWith(".txt") ? safe : `${safe}.txt`;
}

// --- Per-document filtering ("chat with a specific document only") ---
//
// AI Search applies metadata filters *before* retrieval — a chunk that
// fails the filter is never scored or returned, so this genuinely scopes
// the answer rather than just re-ranking. The item's R2 key is indexed
// under the metadata field "filename" (confirmed empirically: filtering on
// `{ filename: "<key>" }` returns only chunks whose `item.key` equals that
// value; filtering on `{ key: ... }` — a name that would match the field on
// `AiSearchItemInfo` — errors with "metadata_filter_unknown_field", so
// "filename" is the correct field, not "key").
//
// Known platform limitation: AI Search's metadata filters only match the
// first 64 UTF-8 bytes of an indexed string. Every filename in this app's
// allowed corpus is short enough to fit, but a filename with a long non-
// Latin prefix (each Urdu/Arabic character is 2+ UTF-8 bytes) could exceed
// 64 bytes and silently fail to match past that point — see README.

export type AiSearchFilenameFilter = { filename: string } | { filename: { $in: string[] } };

/**
 * Only pass through filenames that actually exist in the bucket. Never
 * forward requested filenames straight into the AI Search filter — that
 * would let a caller probe for the existence of file names blindly (the
 * filter would just no-op instead of erroring, but there's no reason to
 * trust unvalidated input here either). Preserves the caller's order,
 * dedupes, and silently drops anything not present in `existing`.
 */
export function validateFilenames(requested: string[], existing: string[]): string[] {
  const known = new Set(existing);
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const name of requested) {
    if (known.has(name) && !seen.has(name)) {
      seen.add(name);
      valid.push(name);
    }
  }
  return valid;
}

/** Builds the `ai_search_options.retrieval.filters` value for a set of
 * already-validated filenames. Returns `undefined` for an empty list (no
 * scoping — search everything), `{ filename: "..." }` for a single
 * document (implicit `$eq`), and `{ filename: { $in: [...] } }` for
 * multiple. */
export function buildFilenameFilter(filenames: string[]): AiSearchFilenameFilter | undefined {
  if (filenames.length === 0) return undefined;
  if (filenames.length === 1) return { filename: filenames[0] };
  return { filename: { $in: filenames } };
}

// --- Citation dedup ("one chip per document, not one per chunk") ---
//
// With max_num_results raised to 20 (see lib/aisearch.ts comments and the
// README), a single answer routinely cites the same file 5-6+ times — once
// per matching chunk. Rendering one chip per chunk produced 20 near-
// duplicate chips for a 2-3 document corpus, which is noise, not a
// citation list. This collapses raw per-chunk sources down to one entry per
// unique filename: the best (highest) score seen for that file, and a
// count of how many chunks matched, so "confidence" isn't lost even though
// the chip count is.

export interface RawSource {
  key: string;
  score?: number;
}

export interface DedupedSource {
  key: string;
  score?: number;
  count: number;
}

/**
 * Collapses one chip per retrieved chunk down to one chip per unique
 * filename. Keeps the highest score seen per file and how many chunks
 * matched, and orders the result by best score descending (chunks with no
 * score sort last, in first-seen order among themselves).
 */
export function dedupeSources(sources: RawSource[]): DedupedSource[] {
  const byKey = new Map<string, DedupedSource>();
  for (const s of sources) {
    const existing = byKey.get(s.key);
    if (!existing) {
      byKey.set(s.key, { key: s.key, score: s.score, count: 1 });
      continue;
    }
    existing.count += 1;
    if (s.score !== undefined && (existing.score === undefined || s.score > existing.score)) {
      existing.score = s.score;
    }
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.score === undefined && b.score === undefined) return 0;
    if (a.score === undefined) return 1;
    if (b.score === undefined) return -1;
    return b.score - a.score;
  });
}
