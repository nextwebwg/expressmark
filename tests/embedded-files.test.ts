import { expect, it } from "vitest";
import { parse, stringify } from "../src/index.js";
import { renderHtml } from "../src/render.js";

const link = (markdown: string) => parse(markdown).body[0]?.children?.[0];

it("reads a title that is one attribute list as the link's or image's attributes", () => {
  expect(link('[button.html](examples/button.html "{embed highlight=2}")\n')).toEqual({
    type: "link", url: "examples/button.html", value: "button.html",
    attributes: { embed: true, highlight: "2" }, source: { attachment: "title", attributes: "{embed highlight=2}" },
  });
  expect(link('![Diagram](d.svg "{width=640}")\n')).toMatchObject({ type: "image", attributes: { width: "640" } });
  expect(link('![Diagram](d.svg "{width=640}")\n')).not.toHaveProperty("title");
  // The same node as an adjacent list, apart from the recorded spelling.
  const { source: _, ...titled } = link('[a](b "{.x #y}")\n')!;
  expect(titled).toEqual(link("[a](b){.x #y}\n"));
  // A partial, malformed or escaped list stays a title.
  for (const [markdown, title] of [['[a](b "{beta} build")', "{beta} build"], ['[a](b "{oops")', "{oops"], ['[a](b "\\{beta}")', "{beta}"], ['[a](b "{x &}")', "{x &}"]])
    expect(link(markdown + "\n")).toMatchObject({ type: "link", title });
  // Padding inside the braces reads the same list.
  expect(link('[a](b "{ embed highlight=2 }")\n')).toMatchObject({ attributes: { embed: true, highlight: "2" } });
  expect(link('[a](b "{ }")\n')).not.toHaveProperty("title");
  expect(parse("## Deploy { #deploy }\n").body[0]).toMatchObject({ type: "heading", id: "deploy" });
  // Reference definitions keep their titles.
  expect(link('[a][r]\n\n[r]: b "{x}"\n')).toMatchObject({ type: "linkReference" });
  expect(parse('[a][r]\n\n[r]: b "{x}"\n').body[1]).toMatchObject({ type: "definition", title: "{x}" });
});

it("writes a title list back as authored, and protects a literal title that would read as one", () => {
  for (const markdown of ['[button.html](examples/button.html "{embed highlight=2}")\n', "[a](b){.x}\n", '[a](b "\\{beta}")\n', "![d](d.svg 'x'){width=640}\n", '[a](<my file.html> "{embed}")\n'])
    expect(stringify(parse(markdown))).toBe(markdown);
  const document = parse('[a](b "{embed}")\n');
  document.body[0]!.children![0]!.attributes = { embed: "example" };
  expect(stringify(document)).toBe("[a](b '{embed=\"example\"}')\n");
  expect(stringify({ type: "document", version: 1, body: [{ type: "paragraph", children: [{ type: "link", url: "b", title: "{beta}", value: "a" }] }] })).toBe('[a](b "\\{beta}")\n');
});

it("renders an embed link as a link and reports that renderHtml cannot read files", () => {
  const codes = (markdown: string, transformers = {}) => {
    const found: string[] = [];
    const html = renderHtml(parse(markdown), { transformers, onDiagnostic: diagnostic => found.push(diagnostic.code) });
    return { html, found };
  };
  const embed = codes('[button.html](examples/button.html "{embed}")\n');
  expect(embed.html).toContain('href="examples/button.html">button.html</a>');
  expect(embed.found).toContain("unsupported-presentation");
  // A renderer that reads files embeds through a paragraph transformer, and reports nothing.
  expect(codes('[b](b.html "{embed}")\n', { paragraph: () => "<pre></pre>" }).found).not.toContain("unsupported-presentation");
  expect(codes('See [b](b.html "{embed}").\n').found).not.toContain("unsupported-presentation");
});
