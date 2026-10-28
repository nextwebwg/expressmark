import { describe, expect, it } from "vitest";
import { parse, stringify, type Diagnostic, type Syntax } from "../src/index.js";

// Each lint rule warns at the lines of the block holding the spelling, names
// the preferred form, and `preferredForms` writes that form.
function warnings(markdown: string, syntax: Syntax = "compatible", lint: boolean | Record<string, boolean> = true): Diagnostic[] {
  const seen: Diagnostic[] = [];
  parse(markdown, { syntax, lint, onDiagnostic: diagnostic => seen.push(diagnostic) });
  return seen;
}
const preferred = (markdown: string, syntax: Syntax = "compatible") => stringify(parse(markdown, { syntax }), { syntax, preferredForms: true });

describe("lint rules", () => {
  it.each([
    ["prefer-colon-callout", "> [!note] Heads up\n> Body", "::: note [Heads up]\nBody\n:::\n"],
    ["prefer-bracketed-title", "::: warning Before you upgrade\nText\n:::", "::: warning [Before you upgrade]\nText\n:::\n"],
    ["prefer-fenced-code", "    const x = 1;", "```\nconst x = 1;\n```\n"],
    ["prefer-shortest-fence", "~~~ js\ncode\n~~~", "```js\ncode\n```\n"],
    ["prefer-shortest-code-span", "Use ``x`` here.", "Use `x` here.\n"],
    ["prefer-atx-heading", "Title\n===", "# Title\n"],
    ["prefer-open-atx-heading", "## Title ##", "## Title\n"],
    ["prefer-backslash-break", "one  \ntwo", "one\\\ntwo\n"],
    ["prefer-star-emphasis", "_a_ and __b__", "*a* and **b**\n"],
    ["prefer-dash-bullet", "* a\n* b", "- a\n- b\n"],
    ["prefer-dot-delimiter", "1) a\n2) b", "1. a\n2. b\n"],
    ["prefer-incrementing-numbers", "1. a\n1. b", "1. a\n2. b\n"],
    ["prefer-lowercase-task", "- [X] done", "- [x] done\n"],
    ["prefer-dash-break", "***", "---\n"],
    ["prefer-link-syntax", "<https://example.com>", "[https://example.com](https://example.com)\n"],
    ["prefer-canonical-target", "[a]( /u )", "[a](/u)\n"],
    ["prefer-canonical-definition", "[a]\n\n[a]:   /u", "[a]\n\n[a]: /u\n"],
    ["prefer-named-table", "| A | B |\n| --- | --- |\n| 1 | 2 |", "::: table\n\n- A: 1\n  B: 2\n\n:::\n"],
    ["prefer-bracketed-mention", "Thanks @ada", "Thanks @[ada]\n"],
    ["prefer-canonical-line-block", "|   one\n|   two", "| one\n| two\n"],
  ])("%s", (code, source, written) => {
    const found = warnings(source).filter(diagnostic => diagnostic.code === code);
    expect(found).toHaveLength(found.length || 1);
    expect(found[0]).toMatchObject({ code, severity: "warning", position: { start: { column: 1 } } });
    expect(found[0]?.preferred).toBeTruthy();
    expect(preferred(source)).toBe(written);
  });
  it("reports the lines after frontmatter as the source's lines", () => {
    expect(warnings("---\ntitle: T\n---\n\n* a")[0]?.position).toEqual({ start: { line: 5, column: 1 }, end: { line: 5, column: 4 } });
  });
  it("reports the containing block's lines for an inline spelling", () => {
    expect(warnings("Text\n\nSome _a_\nmore")[0]).toMatchObject({ code: "prefer-star-emphasis", position: { start: { line: 3 }, end: { line: 4 } } });
  });
  it("names no warning for preferred forms, longhand attributes or a typeless container", () => {
    for (const source of ["# Title", "- a\n- b", "*a* **b**", "```js\ncode\n```", "::: note [Title]\nBody\n:::", '## A {class="wide" id="a"}', "## A {.wide #a}", "::: {.render}\nBody\n:::"]) expect(warnings(source)).toEqual([]);
  });
  it("keeps the bullet that separates a list from the list before it", () => {
    expect(warnings("- a\n\n* b").map(diagnostic => diagnostic.code)).toEqual([]);
    expect(preferred("- a\n\n* b")).toBe("- a\n\n* b\n");
  });
  it("turns single rules off by name", () => {
    expect(warnings("* _a_", "compatible", { "prefer-dash-bullet": false }).map(diagnostic => diagnostic.code)).toEqual(["prefer-star-emphasis"]);
  });
  it("warns about mixed indentation in compatible syntax as a lint rule", () => {
    expect(warnings("- a\n\t- b\n    - c").map(diagnostic => diagnostic.code)).toContain("mixed-indentation");
    expect(warnings("- a\n\t- b\n    - c", "compatible", false)).toEqual([]);
  });
  it("flags an item bullet that differs from its list's in standard syntax", () => {
    expect(warnings("- a\n* b", "standard").map(diagnostic => diagnostic.code)).toEqual(["prefer-list-bullet"]);
    expect(preferred("- a\n* b", "standard")).toBe("- a\n- b\n");
  });
  it("flags \\| inside a table code span in compatible syntax", () => {
    const table = "| Command | Use |\n| --- | --- |\n| `a \\| b` | either |";
    const pipes = (source: string, syntax: Syntax = "compatible") => warnings(source, syntax).filter(diagnostic => diagnostic.code === "table-code-pipe");
    expect(pipes(table)).toEqual([expect.objectContaining({ code: "table-code-pipe", position: { start: { line: 1, column: 1 }, end: { line: 3, column: 22 } } })]);
    expect(pipes(table, "standard")).toEqual([]);
    expect(pipes("| a | b |\n| --- | --- |\n| x \\| y | z |")).toEqual([]);
  });
  it("writes authored spellings back without preferredForms", () => {
    expect(stringify(parse("* _a_"))).toBe("* _a_");
  });
});
