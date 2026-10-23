import { describe, expect, it } from "vitest";
import { anchorText, headingAnchors, parse, stringify, type HtmlAllowlist } from "../src/index.js";
import { renderHtml } from "../src/render.js";

const authored = [
  '<template component="demo-card">',
  "  <p>{greeting}</p>",
  "</template>",
  "",
  '<link rel="component" href="./demo-card.html">',
  "",
  "<style>",
  "demo-card { color: light-dark(#111, #eee); }",
  "</style>",
  "",
  'Text <demo-card tone="calm">**bold**</demo-card>.',
  "",
].join("\n");

describe("trusted host HTML", () => {
  it("keeps raw HTML verbatim as opaque nodes and writes it back unchanged", () => {
    const document = parse(authored, {trustedHtml:true});
    expect(document.body.slice(0,3)).toEqual([
      {type:"html",display:"block",value:'<template component="demo-card">\n  <p>{greeting}</p>\n</template>'},
      {type:"html",display:"block",value:'<link rel="component" href="./demo-card.html">'},
      {type:"html",display:"block",value:"<style>\ndemo-card { color: light-dark(#111, #eee); }\n</style>"},
    ]);
    expect(document.body[3]).toEqual({type:"paragraph",children:[{type:"text",value:"Text "},{type:"html",display:"inline",value:'<demo-card tone="calm">'},{type:"strong",value:"bold"},{type:"html",display:"inline",value:"</demo-card>"},{type:"text",value:"."}]});
    expect(stringify(document,{trustedHtml:true})).toBe(authored);
  });
  it("keeps the strict profile by default", () => {
    expect(JSON.stringify(parse(authored).body)).not.toMatch(/template|demo-card|<style|<link/);
    // Disallowed elements are shown as text, as GitHub's tag filter shows them.
    const html = renderHtml(parse(authored,{trustedHtml:true}));
    expect(html).not.toMatch(/<template|<demo-card|<style|<link/);
    expect(html).toContain("&lt;demo-card tone=\"calm\"&gt;<strong>bold</strong>&lt;/demo-card&gt;");
  });
  it("renders allowlisted elements, attributes and style values", () => {
    const allow: HtmlAllowlist = {tags:["demo-card","template","button","input"],attributes:{"demo-card":["tone"],template:["component"],input:["type","checked","disabled"]},styles:{color:[/^light-dark\(#[\da-f]+, #[\da-f]+\)$/i],"--shiki-dark":[/^#[\da-f]{3,8}$/i]}};
    const document = parse('Text <demo-card tone="calm">**bold**</demo-card>.\n\n<button>Copy</button> <input type="checkbox" checked disabled>\n\n<span style="color:light-dark(#111, #eee);--shiki-dark:#abc">x</span>', {trustedHtml:true});
    expect(renderHtml(document,{trustedHtml:allow})).toBe('<p>Text <demo-card tone="calm"><strong>bold</strong></demo-card>.</p><p><button>Copy</button> <input type="checkbox" checked disabled /></p><p><span style="color:light-dark(#111, #eee);--shiki-dark:#abc">x</span></p>');
    expect(renderHtml(parse('<template component="x">\n<p>Inside</p>\n</template>',{trustedHtml:true}),{trustedHtml:allow})).toBe('<template component="x">\n<p>Inside</p>\n</template>');
  });
  it("applies the allowlist to transformer output too", () => {
    expect(renderHtml(parse("Done"),{trustedHtml:{tags:["ui-check"]},transformers:{paragraph:() => '<ui-check onclick="x()">ok</ui-check><blink>no</blink>'}})).toBe("<ui-check>ok</ui-check>no");
  });
});

describe("trusted host HTML cannot be bypassed through attributes", () => {
  const allow: HtmlAllowlist = {tags:["demo-link","button"],attributes:{"demo-link":["href"],button:["type"]}};
  it.each([
    ['<button onclick="steal()" onmouseover="steal()" type="button">Go</button>','<p><button type="button">Go</button></p>'],
    ['<a href="javascript:steal()">x</a>','<p><a>x</a></p>'],
    ['<a href="jav&#97;script:steal()">x</a>','<p><a>x</a></p>'],
    ['<demo-link href="javascript:steal()">x</demo-link>','<p><demo-link>x</demo-link></p>'],
    ['<span style="background:url(https://example.com/track)">x</span>','<p><span>x</span></p>'],
    ['<script>steal()</script>',"&lt;script&gt;steal()&lt;/script&gt;"],
  ])("blocks %s", (html, expected) => {
    expect(renderHtml(parse(html,{trustedHtml:true}),{trustedHtml:allow})).toBe(expected);
  });
  it("rejects wildcard attribute entries that could admit event handlers", () => {
    for (const name of ["*","on*","o*","*click"]) expect(() => renderHtml(parse("x"),{trustedHtml:{attributes:{"*":[name]}}})).toThrow(TypeError);
  });
  it("admits a handler or script scheme only when named exactly", () => {
    const html = '<button onclick="run()">Go</button> <a href="javascript:run()">Run</a>';
    expect(renderHtml(parse(html,{trustedHtml:true}),{trustedHtml:{tags:["button"],attributes:{button:["onclick"]},schemes:["javascript"]}})).toBe('<p><button onclick="run()">Go</button> <a href="javascript:run()">Run</a></p>');
  });
});

describe("heading anchors", () => {
  const document = parse("# Über setup\n\n## Install {#install}\n\n## Install\n\n## Install\n\n### !!!\n\n::: note\n## Über setup\n:::");
  it("follows the recommended algorithm, reserving authored IDs first", () => {
    expect([...headingAnchors(document).values()]).toEqual(["über-setup","install","install-1","install-2","section","über-setup-1"]);
    expect(anchorText("  Hello, *World*  ")).toBe("hello-world");
  });
  it("renders the IDs only when asked", () => {
    expect(renderHtml(parse("## Install\n\n## Install"))).toBe("<h2>Install</h2><h2>Install</h2>");
    expect(renderHtml(parse("## Install\n\n## Install {#mine}\n\n## Install"),{headingIds:true})).toBe('<h2 id="install">Install</h2><h2 id="mine">Install</h2><h2 id="install-1">Install</h2>');
  });
});

describe("text escaping hook", () => {
  const escapeBraces = (html: string) => html.replace(/\{/g, "&#123;");
  it("applies to text runs and code, never to raw HTML or attributes", () => {
    const document = parse('Text {a} `code {b}`\n\n```js\nconst x = {c};\n```\n\n<demo-x data-v="{d}">\n{e}\n</demo-x>\n\nInline <demo-x>{h}</demo-x> is Markdown text.\n\n[link {f}](/p "title {g}")', {trustedHtml:true});
    const html = renderHtml(document,{escapeText:escapeBraces,trustedHtml:{tags:["demo-x"]}});
    expect(html).toBe('<p>Text &#123;a} <code>code &#123;b}</code></p><pre><code class="language-js">const x = &#123;c};</code></pre><demo-x data-v="{d}">\n{e}\n</demo-x><p>Inline <demo-x>&#123;h}</demo-x> is Markdown text.</p><p><a href="/p" title="title {g}">link &#123;f}</a></p>');
  });
  it("cannot be forged by marker characters in authored text", () => {
    expect(renderHtml(parse("a\u0003b\u0002c{"),{escapeText:escapeBraces})).toBe("<p>abc&#123;</p>");
  });
});

describe("document title", () => {
  it("omits the designated title's heading while keeping document.title", () => {
    const document = parse("---\ntitle: Guide\n---\n# Guide\n\nBody.");
    expect(document.title).toEqual({type:"title",value:"Guide"});
    expect(renderHtml(document)).toBe("<h1>Guide</h1><h1>Guide</h1><p>Body.</p>");
    expect(renderHtml(document,{title:false})).toBe("<h1>Guide</h1><p>Body.</p>");
  });
});

describe("Markupress rendering fixes", () => {
  it("renders a tight list's items without paragraphs and a loose list's with them", () => {
    expect(renderHtml(parse("- One\n- Two\n  - Nested"))).toBe("<ul><li>One</li><li>Two<ul><li>Nested</li></ul></li></ul>");
    expect(renderHtml(parse("- One\n\n- Two"))).toBe("<ul><li><p>One</p></li><li><p>Two</p></li></ul>");
    expect(renderHtml(parse("- [x] Done"))).toBe("<ul><li>☑ Done</li></ul>");
  });
  it("keeps empty boolean attributes wherever the profile allows them", () => {
    const allow: HtmlAllowlist = {tags:["input"],attributes:{"*":["hidden"],input:["type","checked","disabled"]}};
    expect(renderHtml(parse('<div hidden="">Hidden</div>\n\n<details open=""><summary>S</summary></details>\n\n<input type="checkbox" checked="" disabled="">',{trustedHtml:true}),{trustedHtml:allow}))
      .toBe('<div hidden>Hidden</div><details open><summary>S</summary></details><input type="checkbox" checked disabled />');
  });
  it("reserves no heading anchor for the document's own ID", () => {
    const document = parse("---\nid: install\ntitle: Install\n---\n# Install\n\n## Install");
    expect([...headingAnchors(document).values()]).toEqual(["install","install-1"]);
    expect(renderHtml(document,{headingIds:true,title:false})).toBe('<h1 id="install">Install</h1><h2 id="install-1">Install</h2>');
  });
});
