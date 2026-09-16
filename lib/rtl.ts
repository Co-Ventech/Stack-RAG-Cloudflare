// General right-to-left script detection.
//
// This app is language-universal (the embedding model, bge-m3, supports
// 100+ languages with cross-lingual retrieval), but the UI still needs to
// pick a text *direction* and font stack for whatever script a document,
// question, or answer happens to be in. Most scripts are left-to-right and
// are handled fine by the browser's default; the ones that need explicit
// RTL handling are Arabic (which also covers Urdu, Persian, Pashto, Sindhi,
// etc. — they all share the Arabic Unicode block plus its presentation-form
// extensions), Hebrew, Thaana (Dhivehi/Maldivian), and Syriac.
//
// Ranges are written as \u{...} code point escapes (rather than pasting the
// literal characters) so this file stays byte-identical no matter what
// editor, shell, or terminal encoding touches it:
const RTL_SCRIPT = new RegExp(
  "[" +
    "\\u0590-\\u05FF" + // Hebrew
    "\\u0600-\\u06FF" + // Arabic (covers Urdu, Persian, Pashto, Sindhi, Kurdish…)
    "\\u0700-\\u074F" + // Syriac
    "\\u0750-\\u077F" + // Arabic Supplement
    "\\u0780-\\u07BF" + // Thaana (Dhivehi)
    "\\u08A0-\\u08FF" + // Arabic Extended-A
    "\\uFB1D-\\uFB4F" + // Hebrew Presentation Forms
    "\\uFB50-\\uFDFF" + // Arabic Presentation Forms-A
    "\\uFE70-\\uFEFF" + // Arabic Presentation Forms-B
    "]",
  "gu",
);

/**
 * Returns true if a string is majority-RTL-script, so the caller can apply
 * an RTL-appropriate font stack. Direction itself is left to the browser's
 * own `dir="auto"` resolution (applied per element in the UI), which
 * already handles mixed-script paragraphs correctly on its own — this
 * helper is only for font selection, not for setting `dir` explicitly.
 */
export function isRtl(s: string): boolean {
  const letters = s.match(/[\p{L}]/gu) ?? [];
  if (letters.length < 3) return false;
  const rtl = s.match(RTL_SCRIPT) ?? [];
  return rtl.length / letters.length > 0.3;
}
