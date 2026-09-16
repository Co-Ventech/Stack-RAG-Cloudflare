import { describe, expect, it } from "vitest";
import { isRtl } from "../lib/rtl";

describe("isRtl", () => {
  it("detects Arabic-script text (covers Urdu, Persian, Pashto)", () => {
    // Urdu
    expect(isRtl("یہ ایک جملہ ہے")).toBe(true);
    // Arabic
    expect(isRtl("هذا نص عربي للاختبار")).toBe(true);
  });

  it("detects Hebrew text", () => {
    expect(isRtl("זהו משפט בעברית לבדיקה")).toBe(true);
  });

  it("does not flag Latin-script text", () => {
    expect(isRtl("This is a plain English sentence for testing.")).toBe(false);
  });

  it("does not flag CJK text", () => {
    expect(isRtl("这是一个用于测试的中文句子")).toBe(false);
  });

  it("treats short strings as non-RTL regardless of script", () => {
    expect(isRtl("ا")).toBe(false);
  });

  it("resolves mixed Latin/Arabic-script strings by majority", () => {
    // Mostly Urdu with a couple of Latin words mixed in.
    const mostlyUrdu = "یہ ایک test جملہ ہے اور کچھ";
    expect(isRtl(mostlyUrdu)).toBe(true);

    // Mostly English with one Arabic-script word mixed in.
    const mostlyEnglish =
      "This is mostly an English sentence with just one لفظ word mixed in for good measure.";
    expect(isRtl(mostlyEnglish)).toBe(false);
  });
});
