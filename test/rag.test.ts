import { describe, expect, it } from "vitest";
import { chunkText, buildRagMessages, docVectorId } from "../lib/rag";

describe("chunkText", () => {
  it("returns an empty array for blank input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n  ")).toEqual([]);
  });

  it("returns a single chunk for short text", () => {
    const text = "This is a short document.";
    expect(chunkText(text)).toEqual([text]);
  });

  it("splits long text into multiple chunks without cutting words", () => {
    const word = "lorem ";
    const text = word.repeat(400).trim(); // ~2400 chars
    const chunks = chunkText(text, 800, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.startsWith(" ")).toBe(false);
      expect(chunk.endsWith(" ")).toBe(false);
    }
  });

  it("produces overlapping chunks so no content is silently dropped", () => {
    const text = Array.from({ length: 50 }, (_, i) => `sentence-${i}`).join(" ");
    const chunks = chunkText(text, 100, 20);
    const rejoined = chunks.join(" ");
    for (let i = 0; i < 50; i++) {
      expect(rejoined).toContain(`sentence-${i}`);
    }
  });

  it("always makes forward progress and terminates, even with near-total overlap", () => {
    // maxChars - overlapChars = 1, so this is the worst case: one char of
    // progress per chunk. Still must terminate rather than loop forever.
    const text = "a".repeat(5000);
    const chunks = chunkText(text, 100, 99);
    expect(chunks.length).toBe(4901);
  });

  it("produces a reasonable number of chunks at realistic overlap ratios", () => {
    const text = "lorem ".repeat(2000).trim(); // ~12000 chars
    const chunks = chunkText(text); // defaults: 800 max, 120 overlap
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThan(30);
  });
});

describe("buildRagMessages", () => {
  it("includes the question and cites each context chunk's title", () => {
    const messages = buildRagMessages("What is the refund policy?", [
      { title: "Terms of Service", chunkIndex: 2, text: "Refunds are available within 30 days." },
      { title: "FAQ", chunkIndex: 0, text: "Contact support for help." },
    ]);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("What is the refund policy?");
    expect(messages[1].content).toContain("Terms of Service");
    expect(messages[1].content).toContain("Refunds are available within 30 days.");
    expect(messages[1].content).toContain("FAQ");
  });
});

describe("docVectorId", () => {
  it("combines the doc id and chunk index deterministically", () => {
    expect(docVectorId("abc-123", 0)).toBe("abc-123:0");
    expect(docVectorId("abc-123", 7)).toBe("abc-123:7");
  });
});
