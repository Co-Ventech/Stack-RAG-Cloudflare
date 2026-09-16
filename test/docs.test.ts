import { describe, expect, it } from "vitest";
import {
  extensionOf,
  isAllowedExtension,
  sanitizeFilename,
  titleToKey,
  validateFilenames,
  buildFilenameFilter,
  dedupeSources,
} from "../lib/docs";

describe("extensionOf", () => {
  it("returns the lowercase extension", () => {
    expect(extensionOf("report.PDF")).toBe("pdf");
    expect(extensionOf("notes.md")).toBe("md");
  });

  it("returns an empty string for no extension", () => {
    expect(extensionOf("README")).toBe("");
  });
});

describe("isAllowedExtension", () => {
  it("accepts the supported document types", () => {
    expect(isAllowedExtension("a.pdf")).toBe(true);
    expect(isAllowedExtension("a.docx")).toBe(true);
    expect(isAllowedExtension("a.odt")).toBe(true);
    expect(isAllowedExtension("a.md")).toBe(true);
    expect(isAllowedExtension("a.txt")).toBe(true);
  });

  it("rejects unsupported types", () => {
    expect(isAllowedExtension("a.exe")).toBe(false);
    expect(isAllowedExtension("a.zip")).toBe(false);
    expect(isAllowedExtension("a")).toBe(false);
  });
});

describe("sanitizeFilename", () => {
  it("strips path separators", () => {
    expect(sanitizeFilename("../../etc/passwd")).not.toContain("/");
    expect(sanitizeFilename("C:\\Users\\me\\doc.txt")).not.toContain("\\");
  });

  it("replaces unsafe characters", () => {
    expect(sanitizeFilename("my report (final)!.pdf")).toBe("my_report__final__.pdf");
  });

  it("falls back to a default name for empty input", () => {
    expect(sanitizeFilename("///")).toBe("file");
  });
});

describe("titleToKey", () => {
  it("adds a .txt extension", () => {
    expect(titleToKey("Vacation Policy")).toBe("Vacation_Policy.txt");
  });

  it("doesn't double up an existing .txt extension", () => {
    expect(titleToKey("notes.txt")).toBe("notes.txt");
  });
});

describe("validateFilenames", () => {
  const existing = ["en-test.txt", "guide.pdf", "notes.md"];

  it("keeps only filenames that exist in the bucket", () => {
    expect(validateFilenames(["en-test.txt", "not-real.txt"], existing)).toEqual(["en-test.txt"]);
  });

  it("never trusts arbitrary user input straight through", () => {
    expect(validateFilenames(["../../etc/passwd", "'; DROP TABLE"], existing)).toEqual([]);
  });

  it("dedupes while preserving first-seen order", () => {
    expect(validateFilenames(["guide.pdf", "en-test.txt", "guide.pdf"], existing)).toEqual([
      "guide.pdf",
      "en-test.txt",
    ]);
  });

  it("returns an empty list for an empty request (search everything)", () => {
    expect(validateFilenames([], existing)).toEqual([]);
  });
});

describe("buildFilenameFilter", () => {
  it("returns undefined for no filenames — search everything, unscoped", () => {
    expect(buildFilenameFilter([])).toBeUndefined();
  });

  it("returns an implicit $eq filter for a single filename", () => {
    expect(buildFilenameFilter(["en-test.txt"])).toEqual({ filename: "en-test.txt" });
  });

  it("returns a $in filter for multiple filenames", () => {
    expect(buildFilenameFilter(["a.txt", "b.txt"])).toEqual({
      filename: { $in: ["a.txt", "b.txt"] },
    });
  });
});

describe("dedupeSources", () => {
  it("collapses repeated chunks from the same file into one entry", () => {
    const sources = [
      { key: "cServerGuide.pdf", score: 0.7 },
      { key: "1968-full.txt", score: 0.65 },
      { key: "cServerGuide.pdf", score: 0.9 },
      { key: "cServerGuide.pdf", score: 0.6 },
    ];
    expect(dedupeSources(sources)).toEqual([
      { key: "cServerGuide.pdf", score: 0.9, count: 3 },
      { key: "1968-full.txt", score: 0.65, count: 1 },
    ]);
  });

  it("orders by best score descending", () => {
    const sources = [
      { key: "a.txt", score: 0.3 },
      { key: "b.txt", score: 0.9 },
      { key: "c.txt", score: 0.6 },
    ];
    expect(dedupeSources(sources).map((s) => s.key)).toEqual(["b.txt", "c.txt", "a.txt"]);
  });

  it("puts entries with no score after every scored entry", () => {
    const sources = [
      { key: "no-score.txt" },
      { key: "scored.txt", score: 0.1 },
    ];
    expect(dedupeSources(sources).map((s) => s.key)).toEqual(["scored.txt", "no-score.txt"]);
  });

  it("returns an empty list for an empty input", () => {
    expect(dedupeSources([])).toEqual([]);
  });

  it("handles a single unscored chunk", () => {
    expect(dedupeSources([{ key: "only.txt" }])).toEqual([{ key: "only.txt", score: undefined, count: 1 }]);
  });
});
