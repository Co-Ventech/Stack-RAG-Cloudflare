export const CHAT_MODEL = "@cf/openai/gpt-oss-20b";
// Cloudflare AI Search's own per-file limits (it silently skips anything larger,
// so the app must refuse it up front instead of accepting it and never
// indexing it): 10 MiB for plain text and for PDFs when OCR is on; 4 MiB for
// PDFs without OCR and for every other converted format (Word, ODT, images).
export const MIB = 1024 * 1024;
export const MAX_FILE_BYTES = 10 * MIB; // the largest any file can be
export const MAX_CONVERTED_BYTES = 4 * MIB;
export const MAX_PASTE_CHARS = 200_000;
export const MAX_QUESTION_CHARS = 2_000;

// Extensions AI Search can index from an R2 source: plain text/markdown
// directly, PDFs natively, and .docx/.odt via its own text conversion.
export const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "heic", "heif"];
export const ALLOWED_EXTENSIONS = ["txt", "md", "pdf", "docx", "odt", ...IMAGE_EXTENSIONS];

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

export function isAllowedExtension(filename: string): boolean {
  return ALLOWED_EXTENSIONS.includes(extensionOf(filename));
}

export function isImageFile(filename: string): boolean {
  return IMAGE_EXTENSIONS.includes(extensionOf(filename));
}

/** The largest size AI Search will index for this kind of file. A PDF may be
 * 10 MiB only when OCR is enabled; plain text is 10 MiB either way; Word,
 * ODT and images are 4 MiB. */
export function maxBytesFor(filename: string, ocrEnabled: boolean): number {
  const ext = extensionOf(filename);
  if (ext === "txt" || ext === "md") return MAX_FILE_BYTES;
  if (ext === "pdf") return ocrEnabled ? MAX_FILE_BYTES : MAX_CONVERTED_BYTES;
  return MAX_CONVERTED_BYTES;
}

export function formatMiB(bytes: number): string {
  return `${Math.round((bytes / MIB) * 10) / 10} MB`;
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
  /** The retrieved passage text, when the search returned it. */
  text?: string;
}

export interface DedupedSource {
  key: string;
  score?: number;
  count: number;
  /** Best-scoring passage for this file (trimmed), shown as evidence. */
  excerpt?: string;
}

export const MAX_EXCERPT_CHARS = 420;

function toExcerpt(text: string | undefined): string | undefined {
  const t = text?.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > MAX_EXCERPT_CHARS ? `${t.slice(0, MAX_EXCERPT_CHARS).trimEnd()}…` : t;
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
      byKey.set(s.key, { key: s.key, score: s.score, count: 1, excerpt: toExcerpt(s.text) });
      continue;
    }
    existing.count += 1;
    if (s.score !== undefined && (existing.score === undefined || s.score > existing.score)) {
      existing.score = s.score;
      // The excerpt follows the best-scoring chunk.
      existing.excerpt = toExcerpt(s.text) ?? existing.excerpt;
    } else if (existing.excerpt === undefined) {
      existing.excerpt = toExcerpt(s.text);
    }
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.score === undefined && b.score === undefined) return 0;
    if (a.score === undefined) return 1;
    if (b.score === undefined) return -1;
    return b.score - a.score;
  });
}

// --- Full bucket listing ---
//
// R2's list() returns at most 1000 objects per call. Using a single call
// silently drops everything past the first page — which would hide
// documents from the library and make citations to them look "removed".
// This follows the cursor until the listing is complete (bounded so a
// misbehaving bucket can never loop forever).

export interface ListedObject {
  key: string;
  size: number;
  uploaded: Date;
}

export interface BucketListPage {
  objects: ListedObject[];
  truncated: boolean;
  cursor?: string;
}

export interface ListableBucket {
  list(options?: { cursor?: string; limit?: number }): Promise<BucketListPage>;
}

export const MAX_LIST_PAGES = 20;

export async function listAllObjects(bucket: ListableBucket): Promise<ListedObject[]> {
  const all: ListedObject[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await bucket.list(cursor ? { cursor } : undefined);
    all.push(...result.objects);
    if (!result.truncated || !result.cursor) break;
    cursor = result.cursor;
  }
  return all;
}

// --- Conversation history ("follow-up questions") ---

export const MAX_HISTORY_MESSAGES = 12;
export const MAX_HISTORY_MESSAGE_CHARS = 4_000;

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/** Validates the earlier turns sent by the client. Anything malformed is
 * dropped, each message is capped, and only the most recent
 * MAX_HISTORY_MESSAGES are kept — the request body is never trusted as-is. */
export function sanitizeHistory(raw: unknown): HistoryMessage[] {
  if (!Array.isArray(raw)) return [];
  const clean: HistoryMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { role, content } = item as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string") continue;
    const text = content.trim().slice(0, MAX_HISTORY_MESSAGE_CHARS);
    if (!text) continue;
    clean.push({ role, content: text });
  }
  return clean.slice(-MAX_HISTORY_MESSAGES);
}

// --- Search error classification ---

function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name} ${err.message}`;
  return String(err ?? "");
}

/** True when AI Search (or the remote proxy in front of it) timed out. */
export function isSearchTimeout(err: unknown): boolean {
  return /time[d ]?-?out|timed out/i.test(errorText(err));
}

/** True for transient failures worth one quick retry (a timeout is excluded
 * on purpose by the caller: a retry would double an already long wait). */
export function isRetryableSearchError(err: unknown): boolean {
  return /\b(5\d\d|temporar|unavailable|overload|rate.?limit|try again|connection|ECONNRESET|fetch failed)\b/i.test(
    errorText(err),
  );
}

// --- Serving stored documents safely ---

/** Content type is chosen from the extension — never from the uploader's
 * claimed type — so an uploaded file can't be served as HTML. Only plain
 * text and PDF open inline; everything else downloads. */
export function contentTypeForKey(key: string): { type: string; inline: boolean } {
  switch (extensionOf(key)) {
    case "txt":
    case "md":
      return { type: "text/plain; charset=utf-8", inline: true };
    case "pdf":
      return { type: "application/pdf", inline: true };
    case "docx":
      return {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        inline: false,
      };
    case "odt":
      return { type: "application/vnd.oasis.opendocument.text", inline: false };
    case "jpg":
    case "jpeg":
      return { type: "image/jpeg", inline: true };
    case "png":
      return { type: "image/png", inline: true };
    case "webp":
      return { type: "image/webp", inline: true };
    case "gif":
      return { type: "image/gif", inline: true };
    case "bmp":
      return { type: "image/bmp", inline: true };
    default:
      return { type: "application/octet-stream", inline: false };
  }
}
