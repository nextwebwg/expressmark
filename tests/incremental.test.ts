import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, parseDoc, type Syntax } from "../src/index.js";

// An edit's document is the document `parse` reads from the edited text.
const { sources } = JSON.parse(readFileSync(new URL("./fixtures/spec-examples.json", import.meta.url), "utf8")) as { sources: Record<string, { examples: string[] }> };
const inserts = ["x", "\n", "\n\n", "> ", "- ", "1. ", "```\n", "# ", "|", "[a]: /u\n", "[^n]: note\n", "    ", "\t", "*", "---\n", ":::\n", "<div>", "</div>", "===\n", ": ", "\n: ", "Term\n: d\n", ""];
// A definition list continues past blank lines into a later term, so its edits reach beyond its own lines.
const definitionLists = [
  "Term\n: A\n\nNext\n: B\n: C\n\nPara\n\nX\n: Y\n",
  "# H\n\nT\n: a\n  b\n\n  c\n\nP\nQ\n\n- T\n  : d\n\n> T\n> : d\n",
  "Term\n: Description\ncontinued\n\nA\n\n: b\n\nC\n: d\n\n\n\nE\n: f\n",
  "::: note\nT\n: d\n:::\n\nT2\n: d2\n",
];

describe("parseDoc", () => {
  it.each(["compatible", "standard"] as const)("reads every %s edit as parse reads the edited text", (syntax: Syntax) => {
    let seed = 3;
    const random = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
    for (const examples of [...Object.values(sources).map(source => source.examples), definitionLists]) for (const example of examples) {
      let doc = parseDoc(example, { syntax });
      for (let step = 0; step < 3; step++) {
        const from = random(doc.text.length + 1), to = from + (random(4) === 0 ? random(Math.min(20, doc.text.length - from) + 1) : 0);
        const text = doc.text.slice(0, from) + inserts[random(inserts.length)]! + doc.text.slice(to);
        let expected: unknown;
        try { expected = parse(text, { syntax }); } catch (error) { expected = error; }
        if (expected instanceof Error) { expect(() => doc.edit(from, to, text.slice(from, text.length - doc.text.length + to))).toThrow(expected.message); break; }
        doc = doc.edit(from, to, text.slice(from, text.length - doc.text.length + to));
        expect(doc.text).toBe(text);
        expect(doc.document).toEqual(expected);
      }
    }
  });
  it("reuses the blocks an edit leaves alone", () => {
    const doc = parseDoc("# Title\n\nFirst paragraph.\n\n- a\n- b\n\nLast paragraph.\n");
    const edited = doc.edit(doc.text.indexOf("First") + 5, doc.text.indexOf("First") + 5, "!");
    expect(edited.document.body[1]).toEqual({ type: "paragraph", value: "First! paragraph." });
    expect(edited.document.body[0]).toBe(doc.document.body[0]);
    expect(edited.document.body[2]).toBe(doc.document.body[2]);
    expect(edited.document.body[3]).toBe(doc.document.body[3]);
    expect(edited.document).toEqual(parse(edited.text));
  });
  it("re-reads every block when an edit changes a definition", () => {
    const source = "[a] and [b]\n\nMiddle.\n\n[a]: /one\n";
    const doc = parseDoc(source).edit(source.length, source.length, "[b]: /two\n");
    expect(doc.document).toEqual(parse(`${source}[b]: /two\n`));
    expect(doc.document.body[0]!.children).toHaveLength(3);
  });
  it.each(["compatible", "standard"] as const)("joins a %s definition list to the term after it, past blank lines", syntax => {
    // The re-read block becomes a term, so the list before it takes it in.
    const before = "T\n: a\n\nP\nQ\n";
    const joined = parseDoc(before, { syntax }).edit(before.indexOf("Q"), before.indexOf("Q") + 1, ": q");
    expect(joined.document).toEqual(parse("T\n: a\n\nP\n: q\n", { syntax }));
    expect(joined.document.body).toHaveLength(1);
    // A list starting after the edit, where a block started before, continues the re-read list.
    const apart = "T\n: a\n\nP\n\nU\n: u\n";
    const merged = parseDoc(apart, { syntax }).edit(apart.indexOf("P"), apart.indexOf("P") + 1, "V\n: v");
    expect(merged.document).toEqual(parse("T\n: a\n\nV\n: v\n\nU\n: u\n", { syntax }));
    expect(merged.document.body).toHaveLength(1);
  });
  it("refuses a range outside the text", () => {
    const doc = parseDoc("text");
    expect(() => doc.edit(2, 1, "")).toThrow(RangeError);
    expect(() => doc.edit(0, 5, "")).toThrow(RangeError);
  });
});
