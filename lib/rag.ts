export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export const CHAT_MODEL = "@cf/openai/gpt-oss-20b";

export const MAX_DOC_CHARS = 200_000;
export const CHUNK_MAX_CHARS = 800;
export const CHUNK_OVERLAP_CHARS = 120;
export const TOP_K = 5;

/** Splits text into overlapping, whitespace-safe chunks. Overlap keeps a
 * sentence that straddles a chunk boundary retrievable from either side,
 * at the cost of embedding a little redundant text. */
export function chunkText(
  text: string,
  maxChars = CHUNK_MAX_CHARS,
  overlapChars = CHUNK_OVERLAP_CHARS,
): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + maxChars, clean.length);
    if (end < clean.length) {
      const lastSpace = clean.lastIndexOf(" ", end);
      if (lastSpace > start) end = lastSpace;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }
  return chunks;
}

export interface SourceChunk {
  title: string;
  chunkIndex: number;
  text: string;
  score?: number;
}

const RAG_SYSTEM_PROMPT =
  "You are a helpful assistant that answers questions using ONLY the provided context. " +
  'If the context does not contain the answer, say "I don\'t have enough information in the ' +
  'ingested documents to answer that." Keep answers concise. Do not make anything up.';

export function buildRagMessages(question: string, context: SourceChunk[]) {
  const contextBlock = context
    .map((c, i) => `[${i + 1}] (from "${c.title}")\n${c.text}`)
    .join("\n\n");

  return [
    { role: "system", content: RAG_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Context:\n${contextBlock}\n\nQuestion: ${question}`,
    },
  ];
}

export function docVectorId(docId: string, chunkIndex: number): string {
  return `${docId}:${chunkIndex}`;
}
