import { expect } from "vitest";

// A parsed document records its source text and block ranges for exact
// writing. Structural assertions compare documents without that record; the
// round-trip tests check it through `stringify`.
const recorded = ["text", "blocks", "head", "trusted"];
function withoutText(value: unknown): unknown {
  if (!value || typeof value !== "object" || (value as { type?: unknown }).type !== "document") return value;
  const document = { ...(value as Record<string, unknown>) };
  const source = document.source && typeof document.source === "object" ? { ...(document.source as Record<string, unknown>) } : undefined;
  if (source) {
    for (const key of recorded) delete source[key];
    if (Object.keys(source).length) document.source = source; else delete document.source;
  }
  return document;
}
expect.addEqualityTesters([
  function documentsWithoutText(a: unknown, b: unknown, testers) {
    const isDocument = (value: unknown) => Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "document" && (value as { source?: { text?: unknown } }).source?.text !== undefined);
    if (!isDocument(a) && !isDocument(b)) return undefined;
    return this.equals(withoutText(a), withoutText(b), testers);
  },
]);
