import { describe, expect, it } from "vitest";
import { parse, stringify, type Node } from "../src/index.js";
import { renderHtml } from "../src/render.js";

const container = (subType: string, title: Node, extra: Partial<Node> = {}): Node => ({type:"container",subType,title,body:[{type:"paragraph",value:"Body."}],...extra});
const plain = (value: string): Node => ({type:"title",value});

// Each source is canonical: both title spellings write back as authored.
const cases: [string, string, Node][] = [
  ["an unbracketed title","::: warning Before you upgrade\nBody.\n:::\n",container("warning",plain("Before you upgrade"),{titleSpelling:"unbracketed"})],
  ["the bracketed title","::: warning [Before you upgrade]\nBody.\n:::\n",container("warning",plain("Before you upgrade"))],
  ["inline Markdown in an unbracketed title","::: figure The *build*\nBody.\n:::\n",container("figure",{type:"title",children:[{type:"text",value:"The "},{type:"emphasis",value:"build"}]},{titleSpelling:"unbracketed"})],
  ["trailing attributes after an unbracketed title","::: details Show the output {open}\nBody.\n:::\n",container("details",plain("Show the output"),{titleSpelling:"unbracketed",attributes:{open:true}})],
  ["brackets and braces inside the text","::: note Use a[0] and {name} here\nBody.\n:::\n",container("note",plain("Use a[0] and {name} here"),{titleSpelling:"unbracketed"})],
  ["a final brace list kept as text","::: note Ends with \\{literal}\nBody.\n:::\n",container("note",plain("Ends with {literal}"),{titleSpelling:"unbracketed"})],
  ["a bare word after tabs is the group title","::: tabs Install\nBody.\n:::\n",container("tabs",plain("Install"),{titleSpelling:"unbracketed"})],
];

describe("container title spellings", () => {
  it.each(cases)("%s", (_name, source, node) => {
    const document = parse(source);
    expect(document.body).toEqual([node]);
    expect(stringify(document)).toBe(source);
  });
  it("trims surrounding whitespace and reads attributes before the title", () => {
    expect(parse("::: note {#n}   Spaced title   {tone=calm}\nBody.\n:::").body).toEqual([container("note",plain("Spaced title"),{id:"n",titleSpelling:"unbracketed",attributes:{tone:"calm"}})]);
  });
  it("keeps a bracketed title followed by words as ordinary text", () => {
    expect(parse("::: note [Title] extra\nBody.\n:::").body[0]?.type).toBe("paragraph");
  });
  it("protects an unbracketed title that starts with a bracket or ends with an attribute-shaped list", () => {
    const document = {type:"document" as const,version:1 as const,body:[container("note",plain("[Draft] notes {x}"),{titleSpelling:"unbracketed"})]};
    expect(stringify(document)).toBe("::: note \\[Draft] notes \\{x}\nBody.\n:::\n");
    expect(parse(stringify(document))).toEqual(document);
  });
  it("renders both spellings alike", () => {
    expect(renderHtml(parse("::: warning Before you upgrade\nBody.\n:::"))).toBe(renderHtml(parse("::: warning [Before you upgrade]\nBody.\n:::")));
  });
});
