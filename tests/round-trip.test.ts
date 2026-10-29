import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, stringify, type Syntax } from "../src/index.js";

// `stringify` of an unedited parse writes the source back byte for byte, in
// both syntaxes; edited blocks are written fresh and the rest stay as authored.
const exact = (source: string, syntax: Syntax = "compatible", trustedHtml = true) =>
  expect(stringify(parse(source, { syntax, trustedHtml }), { syntax, trustedHtml })).toBe(source);

describe("exact round trips", () => {
  it.each(["compatible", "standard"] as const)("writes an unedited %s document back byte for byte", syntax => {
    for (const source of [
      "# Title\n\n\n\nText  with  spaces.   \n\n* a\n*   b\n\n\n",
      "---\ntitle:   Spaced\n---\n\n\nBody",
      "﻿First\r\n\r\n- a\r\n- b\r\n",
      "   \n\n",
      "",
      "Para\n<div>\n  **x**\n</div>\n\n\n> q\n> q",
      "| a |b|\n|--|:-:|\n| 1 | 2 |\n\n[x]:   /u   'T'\n",
    ]) exact(source, syntax);
  });
  // Every CommonMark 0.31.2 and GFM 0.29 example, as the specifications publish them.
  const { sources } = JSON.parse(readFileSync(new URL("./fixtures/spec-examples.json", import.meta.url), "utf8")) as { sources: Record<string, { examples: string[] }> };
  it.each(Object.entries(sources))("writes every %s example back byte for byte", (_name, { examples }) => {
    for (const markdown of examples) for (const syntax of ["compatible", "standard"] as const) exact(markdown, syntax);
  });
  it("keeps the unedited blocks and their spacing when one block changes", () => {
    const document = parse("# Title\n\n\n*  one\n*  two\n\n\nLast  line.");
    document.body[0] = { type: "heading", level: 1, value: "Renamed" };
    expect(stringify(document)).toBe("# Renamed\n\n*  one\n*  two\n\n\nLast  line.");
  });
  it.each(["compatible", "standard"] as const)("rewrites only the edited item of a %s list", syntax => {
    const source = "Intro\n\n*   first  item\n*   second *item*\n\n    more\n*   third\n";
    const document = parse(source, { syntax });
    document.body[1]!.children![1]!.body![0]!.children![1] = { type: "strong", value: "item" };
    expect(stringify(document, { syntax })).toBe("Intro\n\n*   first  item\n* second **item**\n\n  more\n*   third\n");
    const added = parse(source, { syntax });
    added.body[1]!.children!.push({ type: "listItem", body: [{ type: "paragraph", value: "fourth" }] });
    // A blank line inside an item loosens a `compatible` list, so its items stand apart.
    expect(stringify(added, { syntax })).toBe(`${source}${syntax === "compatible" ? "\n" : ""}* fourth\n`);
  });
  it.each(["compatible", "standard"] as const)("rewrites only the edited cell of a %s pipe table", syntax => {
    const document = parse("|  Name | Value  |\n|:------|------:|\n|  alpha | 1 |\n| beta   |  2 |\n", { syntax });
    document.body[0]!.children![2]!.children![1]!.value = "a|b";
    expect(stringify(document, { syntax })).toBe("|  Name | Value  |\n|:------|------:|\n|  alpha | 1 |\n| beta   |  a\\|b |\n");
  });
  it("keeps the source's spacing around inserted and removed blocks", () => {
    const document = parse("A\n\n\n\nB\n\nC");
    document.body.splice(1, 1);
    expect(stringify(document)).toBe("A\n\nC");
    const inserted = parse("A\n\n\n\nB");
    inserted.body.splice(1, 0, { type: "paragraph", value: "New" });
    expect(stringify(inserted)).toBe("A\n\nNew\n\nB");
  });
  it("ends an edited document as its source ended", () => {
    for (const ending of ["", "\n", "\n\n"]) {
      const document = parse(`A\n\n::: note\nB\n:::${ending}`);
      document.body[1]!.body![0]!.value = "C";
      expect(stringify(document)).toBe(`A\n\n::: note\nC\n:::${ending}`);
    }
  });
  it("writes fresh blocks with the document's own line endings", () => {
    const document = parse("A\r\n\r\nB\r\n");
    document.body[1] = { type: "paragraph", value: "C" };
    expect(stringify(document)).toBe("A\r\n\r\nC\r\n");
  });
  it("writes a serialized document back exactly", () => {
    const source = "*  a\n\n\n_b_  ";
    expect(stringify(JSON.parse(JSON.stringify(parse(source))))).toBe(source);
  });
  it("never replays HTML the safe profile filters", () => {
    const source = "Text\n\n<div onclick=\"steal()\">x</div>\n\n\nAfter";
    const written = stringify(parse(source));
    expect(written).not.toContain("steal");
    expect(written.startsWith("Text\n\n")).toBe(true);
    expect(written.endsWith("\n\n\nAfter")).toBe(true);
    expect(stringify(parse(source, { trustedHtml: true }))).not.toContain("steal");
  });
  it("writes preferred forms in place of the source with preferredForms", () => {
    expect(stringify(parse("*  _a_"), { preferredForms: true })).toBe("- *a*\n");
  });
});
