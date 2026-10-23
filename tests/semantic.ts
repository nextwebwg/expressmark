// Structural tests compare document data; authored spellings in `source` have their own tests.
/** A copy of a parsed document without its recorded source text, so writing it uses canonical forms. */
export function fresh<T extends { source?: Record<string, unknown> }>(document: T): T {
  const copy = { ...document, source: { ...document.source } };
  for (const key of ["text", "blocks", "head", "trusted"]) delete copy.source[key];
  if (!Object.keys(copy.source).length) delete (copy as { source?: unknown }).source;
  return copy;
}
export function semantic<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, item: unknown) => key === "source" ? undefined : item)) as T;
}
