// Structural tests compare document data; authored spellings in `source` have their own tests.
export function semantic<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, item: unknown) => key === "source" ? undefined : item)) as T;
}
