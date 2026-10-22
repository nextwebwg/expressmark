import { describe, expect, it } from "vitest";
import { parse, stringify, type Node } from "../src/index.js";
import { renderHtml } from "../src/render.js";
import { semantic } from "./semantic.js";

const trusted = {trustedHtml:true} as const;
const body = (source: string): Node[] => semantic(parse(source, trusted).body);

// Trusted raw HTML and its fenced content write back byte for byte.
const sources: [string, string][] = [
  ["a one-line element","<template component=\"demo-x\"><p>{greeting}</p></template>\n"],
  ["an element holding blank lines","<template component=\"demo-x\">\n  <p>One</p>\n\n  <p>Two</p>\n</template>\n"],
  ["nested same-name elements","<div>\n<div>\n\n</div>\n</div>\n"],
  ["bare and attributed fenced content","<spec-entry>\n  :::\n  Plain fenced content\n  :::\n\n  ::: {.cells #intro}\n  Wrapped fenced content\n  :::\n</spec-entry>\n"],
  ["indented fenced content","<spec-entry name=\"&lt;defs&gt;\">\n  <header>raw</header>\n  :::\n  Contains `<prop>` entries.\n  :::\n</spec-entry>\n"],
  ["a container inside fenced content","<section>\n::::\n::: tip\nInside.\n:::\n::::\n</section>\n"],
  ["a typed fence stays raw","<section>\n::: tip\nRaw text.\n:::\n</section>\n"],
  ["script content holding tags","<div>\n<script>const html = \"</div>\";</script>\n</div>\n"],
];

describe("raw HTML elements", () => {
  it.each(sources)("%s", (_name, source) => {
    const document = parse(source, trusted);
    expect(stringify(document, trusted)).toBe(source);
    expect(parse(stringify(document, trusted), trusted)).toEqual(document);
  });
  it("hold fenced content as raw segments and fencedContent nodes", () => {
    expect(body("<spec-entry>\n  :::\n  Text\n  :::\n</spec-entry>")).toEqual([{type:"html",display:"block",body:[
      {type:"html",display:"block",value:"<spec-entry>"},
      {type:"fencedContent",body:[{type:"paragraph",value:"Text"}]},
      {type:"html",display:"block",value:"</spec-entry>"},
    ]}]);
  });
  it("render bare fenced content with no wrapper and attributed fenced content in a div", () => {
    const html = renderHtml(parse("<spec-entry>\n  :::\n  Plain\n  :::\n\n  ::: {.cells #intro}\n  Wrapped\n  :::\n</spec-entry>", trusted), {trustedHtml:{tags:["spec-entry"]}});
    expect(html).toContain("<spec-entry>");
    expect(html).toMatch(/<spec-entry>\s*<p>Plain<\/p>/);
    expect(html).toContain('<div class="cells" id="intro"><p>Wrapped</p></div>');
    expect(html).not.toContain(":::");
  });
  it("number footnotes referenced inside fenced content", () => {
    expect(renderHtml(parse("<div>\n:::\nNote[^a]\n:::\n</div>\n\n[^a]: A.", trusted))).toContain('<li id="fn:a">');
  });
  it("filter raw HTML in the safe profile while fenced content still renders", () => {
    const source = "<div class=\"x\" onclick=\"steal()\">\n:::\n**Bold**\n:::\n</div>";
    expect(renderHtml(parse(source))).toBe('<div class="x">\n<p><strong>Bold</strong></p>\n</div>');
  });
  it("turn fenced content into Markdown when filtering removes its element", () => {
    expect(semantic(parse("<demo-x>\n:::\nPlain\n:::\n\n::: {.cells}\nWrapped\n:::\n</demo-x>").body)).toEqual([
      {type:"paragraph",value:"Plain"},
      {type:"container",attributes:{class:"cells"},body:[{type:"paragraph",value:"Wrapped"}]},
    ]);
  });
});

// Each construct sharing raw HTML's characters keeps a defined reading.
describe("conflicts with existing syntax", () => {
  it("a tag opening a sentence stays inline", () => {
    expect(body('<a href="/x">link</a> is great')).toEqual([{type:"paragraph",children:[{type:"html",display:"inline",value:'<a href="/x">'},{type:"text",value:"link"},{type:"html",display:"inline",value:"</a>"},{type:"text",value:" is great"}]}]);
  });
  it("an element alone on its line is raw HTML", () => {
    expect(body("<b>Note:</b>\nMore text.")).toEqual([{type:"html",display:"block",value:"<b>Note:</b>"},{type:"paragraph",value:"More text."}]);
    expect(semantic(parse("<s>old <em>draft</em></s>").body)).toEqual([{type:"paragraph",children:[{type:"delete",children:[{type:"text",value:"old "},{type:"emphasis",value:"draft"}]}]}]);
  });
  it("an element does not interrupt a paragraph", () => {
    expect(body("Text\n<div>x</div>")).toEqual([{type:"paragraph",children:[{type:"text",value:"Text"},{type:"softBreak"},{type:"html",display:"inline",value:"<div>"},{type:"text",value:"x"},{type:"html",display:"inline",value:"</div>"}]}]);
  });
  it("Markdown after a blank line inside an element stays raw HTML", () => {
    expect(body("<details>\n<summary>More</summary>\n\n**Raw**\n\n</details>")).toEqual([{type:"html",display:"block",value:"<details>\n<summary>More</summary>\n\n**Raw**\n\n</details>"}]);
  });
  it("an unclosed element keeps its content to the end of its block, with a diagnostic", () => {
    const seen: string[] = [];
    expect(semantic(parse("<div>\nA\n\nB", {trustedHtml:true,onDiagnostic:d => seen.push(d.code)}).body)).toEqual([{type:"html",display:"block",value:"<div>\nA\n\nB"}]);
    expect(seen).toEqual(["unclosed-html-element"]);
    expect(semantic(parse("> <div>\n> A\n\nAfter", trusted).body)).toEqual([{type:"blockquote",body:[{type:"html",display:"block",value:"<div>\nA"}]},{type:"paragraph",value:"After"}]);
  });
  it("void and self-closing elements end at their tag", () => {
    expect(body("<img src=\"a.png\">\n\n<demo-x/>")).toEqual([{type:"html",display:"block",value:"<img src=\"a.png\">"},{type:"html",display:"block",value:"<demo-x/>"}]);
    expect(body("<br> text")[0]?.type).toBe("paragraph");
  });
  it("comments, declarations and stray end tags keep CommonMark's handling", () => {
    expect(body("<!-- note -->\n\n</div>\n\nText")).toEqual([{type:"html",display:"block",value:"<!-- note -->"},{type:"html",display:"block",value:"</div>"},{type:"paragraph",value:"Text"}]);
  });
  it("a fence inside raw text elements still encloses fenced content", () => {
    expect(body("<pre>\n:::\n**x**\n:::\n</pre>")[0]!.body?.[1]?.type).toBe("fencedContent");
    expect(body("<pre>\n&#58;::\n</pre>")).toEqual([{type:"html",display:"block",value:"<pre>\n&#58;::\n</pre>"}]);
  });
  it("code keeps HTML literal, and indented lines are code", () => {
    expect(body("```html\n<div>\n```")[0]?.type).toBe("code");
    expect(body("    <div>\n    </div>")[0]?.type).toBe("code");
  });
  it("a container's closing fence ignores fences inside an element", () => {
    expect(body("::: note\n<div>\n:::\nIn\n:::\n</div>\n:::")[0]).toMatchObject({type:"container",subType:"note",body:[{type:"html",body:[{type:"html"},{type:"fencedContent"},{type:"html"}]}]});
  });
  it("elements in list items and quotes read the same way", () => {
    expect(body("- <div>\n\n  x\n  </div>")[0]?.children?.[0]?.body?.[0]).toEqual({type:"html",display:"block",value:"<div>\n\nx\n</div>"});
  });
  it("fenced content nested in an inner element closes at its own fence", () => {
    const outer = body("<a-x>\n:::\n<b-x>\n:::\ninner\n:::\n</b-x>\n:::\n</a-x>")[0]!;
    expect(outer.body?.map(node => node.type)).toEqual(["html","fencedContent","html"]);
    expect(outer.body?.[1]?.body?.[0]).toMatchObject({type:"html",body:[{type:"html"},{type:"fencedContent"},{type:"html"}]});
  });
});
