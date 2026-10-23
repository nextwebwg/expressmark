import { describe, expect, it } from "vitest";
import { parse, stringify, type ConversionOptions, type Syntax } from "../src/index.js";
import { renderHtml } from "../src/render.js";
import type { HtmlAllowlist } from "../src/html.js";

// Each `modern` case is an example in the Expressive Markdown spec; each
// `compatible` case is an example in docs/syntax.md, where expressmark follows
// CommonMark 0.31.2 and GFM.
const allow: HtmlAllowlist = { tags: ["x-embed", "x-a", "kbd", "select", "option", "script", "textarea", "template", "style"], attributes: { "*": ["video", "src", "type", "href", "align"] } };
const normalize = (html: string) => html.replace(/>\s+</g, "><").trim();
function render(markdown: string, syntax: Syntax = "modern", options: ConversionOptions = {}): string {
  return normalize(renderHtml(parse(markdown, { syntax, trustedHtml: true, ...options }), { trustedHtml: allow }));
}
function codes(markdown: string, syntax: Syntax = "modern", options: ConversionOptions = {}): string[] {
  const seen: string[] = [];
  parse(markdown, { syntax, trustedHtml: true, ...options, onDiagnostic: diagnostic => seen.push(diagnostic.code) });
  return seen;
}
// `stringify` writes each document back as authored.
function roundTrips(markdown: string, syntax: Syntax = "modern"): void {
  expect(stringify(parse(markdown, { syntax, trustedHtml: true }), { syntax, trustedHtml: true })).toBe(`${markdown}\n`);
}

describe("syntax selection", () => {
  it("reads compatible syntax by default and modern syntax when asked", () => {
    expect(parse("Title\n---").body[0]?.type).toBe("heading");
    expect(parse("Title\n---", { syntax: "modern" }).body.map(node => node.type)).toEqual(["paragraph", "horizontalRule"]);
  });
  it("lets frontmatter choose the syntax, over the host's default", () => {
    const document = parse("---\nmarkdownSyntax: modern\n---\nTitle\n---");
    expect(document.syntax).toBe("modern");
    expect(document.metadata).toBeUndefined();
    expect(parse("---\nmarkdownSyntax: compatible\n---\nTitle\n---", { syntax: "modern" }).body[0]?.type).toBe("heading");
  });
  it("records the syntax and writes the key when it differs from the host's default", () => {
    const document = parse("Text", { syntax: "modern" });
    expect(document.syntax).toBe("modern");
    expect(stringify(document)).toBe("---\nmarkdownSyntax: modern\n---\n\nText\n");
    expect(stringify(document, { syntax: "modern" })).toBe("Text\n");
  });
  it("keeps an unknown syntax value as metadata, with a diagnostic", () => {
    expect(codes("---\nmarkdownSyntax: strict\n---\nText", "compatible")).toContain("invalid-syntax");
    expect(parse("---\nmarkdownSyntax: strict\n---\nText").metadata).toEqual({ markdownSyntax: "strict" });
  });
});

describe("HTML elements", () => {
  it("reads Markdown inside an element, whatever its line breaks and indentation", () => {
    for (const source of ["<div>Some **bold**</div>", "<div>\nSome **bold**\n</div>", "<div>\n  Some **bold**\n</div>"]) {
      expect(render(source)).toBe("<div>Some <strong>bold</strong></div>");
      roundTrips(source);
    }
  });
  it("gives an element's paragraphs <p> when blank lines separate its blocks", () => {
    expect(render("<div>\n\nA\n\nB\n\n</div>")).toBe("<div><p>A</p><p>B</p></div>");
    expect(render("<div>\nA\n</div>")).toBe("<div>A</div>");
  });
  it("reads an element's content as blocks, whatever the element", () => {
    expect(render("<span># tag</span>")).toBe("<span><h1>tag</h1></span>");
  });
  it("reads an element followed by text on its line as part of a paragraph", () => {
    expect(render("<kbd>Ctrl</kbd>+<kbd>C</kbd> copies **x**")).toBe("<p><kbd>Ctrl</kbd>+<kbd>C</kbd> copies <strong>x</strong></p>");
  });
  it("reads elements separated only by whitespace on a line as blocks", () => {
    expect(render("<details><summary>Notes</summary><div>\n\nBody\n</div></details>")).toBe("<details><summary>Notes</summary><div><p>Body</p></div></details>");
  });
  it("lets an element interrupt a paragraph when it runs past its line or its start tag ends the line", () => {
    expect(render('Text\n<a href="/x">link</a>')).toBe('<p>Text\n<a href="/x">link</a></p>');
    expect(render("Text\n<div>\nBlock\n</div>")).toBe("<p>Text</p><div>Block</div>");
    expect(render("Text\n<br>\nmore")).toBe("<p>Text\n<br />\nmore</p>");
  });
  it("keeps raw text in script, style, textarea, title, pre and comments", () => {
    expect(render("<pre>\n**raw**\n\ntext\n</pre>")).toBe("<pre>\n**raw**\n\ntext\n</pre>");
    expect(render("<textarea>\n**raw**\n</textarea>")).toBe("<textarea>\n**raw**\n</textarea>");
    expect(render("<!-- **not bold** -->\nAfter")).toBe("<p>After</p>");
    roundTrips("<pre>\n**raw**\n\ntext\n</pre>");
  });
  it("ends an unclosed element with its enclosing block, with a diagnostic", () => {
    expect(render("- <div>\n  open\n\nAfter")).toBe("<ul><li><div>open</div></li></ul><p>After</p>");
    expect(codes("- <div>\n  open\n\nAfter")).toContain("unclosed-html-element");
  });
  it("reads the element nodes in both HTML profiles", () => {
    for (const trustedHtml of [true, false]) expect(parse("<div>A</div>", { syntax: "modern", trustedHtml }).body[0]).toMatchObject({ type: "htmlElement", tag: "div", open: "<div>", close: "</div>" });
    expect(parse("Press <kbd>Ctrl</kbd>", { syntax: "modern", trustedHtml: true }).body[0]?.children?.[1]).toMatchObject({ type: "htmlElement", display: "inline", tag: "kbd", value: "Ctrl" });
  });
});

describe("element boundaries", () => {
  it("ends an unclosed element at its first blank line, at the top level too", () => {
    expect(render("<div>\nopen\n\nAfter")).toBe("<div>open</div><p>After</p>");
    expect(render('<a href="x"><img src="y">\n\n# Next')).toBe('<a href="x"><img src="y" /></a><h1>Next</h1>');
    expect(codes("<div>\nopen\n\nAfter")).toEqual(["unclosed-html-element"]);
    expect(render("<div>\n```\na\n\nb\n```\nmore\n\nAfter")).toBe("<div><pre><code>a\n\nb</code></pre>\nmore</div><p>After</p>");
  });
  it("never counts tags inside code spans or fences when finding an element's end", () => {
    expect(render("<details>\nUse `</details>` to close.\n</details>\nAfter")).toBe("<details>Use <code>&lt;/details&gt;</code> to close.</details><p>After</p>");
    expect(render("<details>\n\n```html\n</details>\n```\n\n</details>\nAfter")).toBe('<details><pre><code class="language-html">&lt;/details&gt;</code></pre></details><p>After</p>');
    expect(render("<div>\n~~~\n</div>\n~~~\n</div>\nAfter")).toBe("<div><pre><code>&lt;/div&gt;</code></pre></div><p>After</p>");
    expect(render("<div>a `` ` `` b</div>")).toBe("<div>a <code>`</code> b</div>");
  });
  it("keeps raw-text elements raw inside a paragraph", () => {
    const document = parse("Run <script>if (a **b** c) `x` </script> now", { syntax: "modern", trustedHtml: true });
    expect(document.body[0]?.children?.[1]).toEqual({ type: "htmlElement", display: "inline", tag: "script", open: "<script>", close: "</script>", value: "if (a **b** c) `x` " });
    expect(render("Use <textarea>*not em*</textarea>.")).toBe("<p>Use <textarea>*not em*</textarea>.</p>");
    expect(render("a <style>p { x: 1 }")).toBe("<p>a <style>p { x: 1 }</style></p>");
    expect(codes("a <style>p { x: 1 }")).toEqual(["unclosed-html-element"]);
    for (const source of ["Run <script>if (a **b** c) `x` </script> now", "Use <textarea>*not em*</textarea>."]) roundTrips(source);
  });
});

describe("footnote continuation", () => {
  const source = "Note[^a].\n\n[^a]: First.\n\n  Second.\nOutside";
  it("continues a note on lines indented past its marker in modern syntax", () => {
    expect(render(source)).toContain('<li id="fn:a"><p>First.</p><p>Second.');
    expect(render(source)).toContain("<p>Outside</p>");
  });
  it("continues a note four columns past its marker in compatible syntax", () => {
    expect(render(source, "compatible")).toContain("<p>Second.\nOutside</p>");
  });
});

describe("void elements", () => {
  const voids = ["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"];
  it.each(voids)("reads <%s> and <%s /> the same, at block level and inline", name => {
    for (const syntax of ["modern", "compatible"] as const) {
      const block = (tag: string) => JSON.stringify(parse(tag, { syntax, trustedHtml: true }).body.map(node => node.type));
      expect(block(`<${name}>`)).toBe(block(`<${name} />`));
    }
    const inline = (tag: string) => parse(`a ${tag} b`, { syntax: "modern", trustedHtml: true }).body[0]?.children?.[1];
    expect(inline(`<${name}>`)).toMatchObject({ type: "htmlElement", display: "inline", tag: name });
    expect(inline(`<${name} />`)).toMatchObject({ type: "htmlElement", display: "inline", tag: name });
    expect(inline(`<${name}>`)?.children).toBeUndefined();
  });
  it("writes each void element back as authored", () => {
    for (const source of ['<img src="a.png">', '<img src="a.png" />', "Line<br>break", "Line<br/>break"]) roundTrips(source);
  });
});

describe("implied end tags", () => {
  it("closes list items, cells, rows, paragraphs and options where HTML does", () => {
    expect(render("<ul><li>a<li>b</ul>")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(render("<ul>\n<li>a\n<li>b\n</ul>")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(render("<table>\n<tr><td>a<td>b\n<tr><td>c\n</table>")).toBe("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>");
    expect(render("<p>one\n<p>two")).toBe("<p>one</p><p>two</p>");
    expect(render("Pick <select><option>a<option>b</select> now")).toBe("<p>Pick <select><option>a</option><option>b</option></select> now</p>");
  });
  it("closes an open heading at the next heading's start tag", () => {
    expect(render("<h1>One<h2>Two</h2>")).toBe("<h1>One</h1><h2>Two</h2>");
  });
  it("writes the elements back as authored", () => {
    for (const source of ["<ul><li>a<li>b</ul>", "<table>\n<tr><td>a<td>b\n<tr><td>c\n</table>"]) roundTrips(source);
  });
});

describe("self-closing elements", () => {
  it("closes every element written with />, in both syntaxes", () => {
    for (const syntax of ["modern", "compatible"] as const) {
      expect(render('<x-embed video="1" />', syntax)).toBe('<x-embed video="1"></x-embed>');
      expect(render('<script src="app.js" />', syntax)).toBe('<script src="app.js"></script>');
    }
    expect(render("<textarea />")).toBe("<textarea></textarea>");
    expect(render("<template />")).toBe("<template></template>");
  });
  it("closes a self-closing element inside others and inside table cells", () => {
    expect(render("<div><x-a /><p>b</p></div>")).toBe("<div><x-a></x-a><p>b</p></div>");
    expect(render("<table><tr><td><x-a /></td></tr></table>")).toBe("<table><tr><td><x-a></x-a></td></tr></table>");
  });
  it("reads the self-closing flag as HTML's tokenizer does", () => {
    const source = "<a href=https://www.infoq.com/articles/Transition-RDBMS-NoSQL/>Source</a>";
    for (const syntax of ["modern", "compatible"] as const) expect(render(source, syntax)).toContain('<a href="https://www.infoq.com/articles/Transition-RDBMS-NoSQL/">Source</a>');
  });
  it("writes the authored /> back", () => {
    for (const source of ['<x-embed video="1" />', "<div><x-a /><p>b</p></div>"]) roundTrips(source);
    expect(stringify(parse('<x-embed video="1" />', { trustedHtml: true }), { trustedHtml: true })).toBe('<x-embed video="1" />\n');
  });
});

describe("stray end tags", () => {
  it("ignores an end tag that closes nothing, with a diagnostic", () => {
    expect(render("a </span> b")).toBe("<p>a  b</p>");
    expect(render("</div>\n\nText")).toBe("<p>Text</p>");
    expect(render("a </p> b")).toBe("<p>a  b</p>");
    expect(render("a </img> b")).toBe("<p>a  b</p>");
    expect(codes("a </span> b")).toEqual(["stray-end-tag"]);
    expect(codes("</div>\n\nText", "compatible")).toEqual(["stray-end-tag"]);
    roundTrips("a </span> b");
  });
  it("reads </br> as <br>, with a lint warning, in both syntaxes", () => {
    const excalidraw = '<h2 align="center">\n  An open source virtual hand-drawn style whiteboard. </br>\n  Collaborative and end-to-end encrypted. </br>\n<br />\n</h2>';
    expect(render(excalidraw)).toBe('<h2 align="center">An open source virtual hand-drawn style whiteboard. <br />\nCollaborative and end-to-end encrypted. <br /><br /></h2>');
    expect(render(excalidraw, "compatible")).toContain("whiteboard. <br />");
    expect(codes("line one</br>\nline two", "modern", { lint: true })).toEqual(["br-end-tag"]);
    expect(codes("line one</br>\nline two", "compatible", { lint: true })).toEqual(["br-end-tag"]);
    expect(codes("line one</br>\nline two")).toEqual([]);
    roundTrips(excalidraw);
  });
});

describe("the safe profile", () => {
  it("shows a disallowed element as text, with a diagnostic", () => {
    const seen: string[] = [];
    expect(normalize(renderHtml(parse('<input type="checkbox">', { syntax: "modern", onDiagnostic: diagnostic => seen.push(diagnostic.code) })))).toBe('&lt;input type="checkbox"&gt;');
    expect(seen).toContain("html-element-escaped");
    seen.length = 0;
    expect(normalize(renderHtml(parse('<input type="checkbox">', { syntax: "modern", trustedHtml: true }), { onDiagnostic: diagnostic => seen.push(diagnostic.code) }))).toBe('&lt;input type="checkbox"&gt;');
    expect(seen).toContain("html-element-escaped");
    expect(normalize(renderHtml(parse('<input type="checkbox">', { trustedHtml: true })))).toBe('&lt;input type="checkbox"&gt;');
    expect(normalize(renderHtml(parse("Run <script>x()</script> now", { syntax: "modern", trustedHtml: true })))).toBe("<p>Run &lt;script&gt;x()&lt;/script&gt; now</p>");
  });
});

describe("indented code", () => {
  it("reads indentation as no code in modern syntax", () => {
    expect(render("    const x = 1;")).toBe("<p>const x = 1;</p>");
    expect(render("    # Title")).toBe("<h1>Title</h1>");
    expect(render("- item\n\n      more")).toBe("<ul><li><p>item</p><p>more</p></li></ul>");
  });
  it("reads indented code in compatible syntax", () => {
    expect(render("    const x = 1;", "compatible")).toBe("<pre><code>const x = 1;</code></pre>");
  });
});

describe("headings", () => {
  it("reads --- under a paragraph as a thematic break and === as text in modern syntax", () => {
    expect(render("Title\n---")).toBe("<p>Title</p><hr />");
    expect(render("Title\n===")).toBe("<p>Title\n===</p>");
  });
  it("reads setext headings in compatible syntax", () => {
    expect(render("Title\n---", "compatible")).toBe("<h2>Title</h2>");
  });
});

describe("hard breaks", () => {
  it("ignores trailing spaces and breaks at a backslash in modern syntax", () => {
    expect(render("one  \ntwo")).toBe("<p>one\ntwo</p>");
    expect(render("one\\\ntwo")).toBe("<p>one<br />two</p>");
  });
  it("breaks at trailing spaces in compatible syntax", () => {
    expect(render("one  \ntwo", "compatible")).toBe("<p>one<br />two</p>");
  });
});

describe("code spans in table cells", () => {
  const table = "| Expression | Reads |\n| --- | --- |\n| `a || b` | or |";
  it("keeps a code span's pipes in its cell in modern syntax", () => {
    expect(render(table)).toBe("<table><tr><th>Expression</th><th>Reads</th></tr><tr><td><code>a || b</code></td><td>or</td></tr></table>");
    expect(render("| a | b |\n| --- | --- |\n| x \\| y | z |")).toContain("<td>x | y</td>");
    roundTrips(table);
  });
  it("splits cells at a code span's pipes in compatible syntax", () => {
    expect(render(table, "compatible")).toContain("<td>`a</td>");
  });
});

describe("lazy continuation", () => {
  it("ends a quote or list at a line without its marker or indentation in modern syntax", () => {
    expect(render("> quoted\nnot quoted")).toBe("<blockquote><p>quoted</p></blockquote><p>not quoted</p>");
    expect(render("- item\nnot item")).toBe("<ul><li>item</li></ul><p>not item</p>");
  });
  it("continues the paragraph in compatible syntax", () => {
    expect(render("> quoted\nnot quoted", "compatible")).toBe("<blockquote><p>quoted\nnot quoted</p></blockquote>");
  });
});

describe("list markers", () => {
  it("continues a list when the bullet or delimiter changes in modern syntax", () => {
    expect(render("- a\n* b\n+ c")).toBe("<ul><li>a</li><li>b</li><li>c</li></ul>");
    expect(render("1. a\n2) b")).toBe("<ol><li>a</li><li>b</li></ol>");
    roundTrips("- a\n* b\n+ c");
  });
  it("starts a new list in compatible syntax", () => {
    expect(render("- a\n* b", "compatible")).toBe("<ul><li>a</li></ul><ul><li>b</li></ul>");
  });
});

describe("link targets", () => {
  it("reads spaces in a target that ends at its balancing parenthesis in modern syntax", () => {
    expect(render("[a](my file.md)")).toBe('<p><a href="my%20file.md">a</a></p>');
    expect(render('[a](my file.md "Title")')).toBe('<p><a href="my%20file.md" title="Title">a</a></p>');
    expect(render("[a](notes (draft).md) and [b](c.md)")).toBe('<p><a href="notes%20(draft).md">a</a> and <a href="c.md">b</a></p>');
    expect(render("![Chart](my chart.png)")).toBe('<p><img src="my%20chart.png" alt="Chart" /></p>');
    roundTrips("[a](my file.md)");
  });
  it("reads no link in compatible syntax", () => {
    expect(render("[a](my file.md)", "compatible")).toBe("<p>[a](my file.md)</p>");
  });
});

describe("list nesting", () => {
  it("nests a line indented past its item's marker in modern syntax", () => {
    expect(render("- a\n - b")).toBe("<ul><li>a<ul><li>b</li></ul></li></ul>");
    expect(render("- a\n\t- b")).toBe("<ul><li>a<ul><li>b</li></ul></li></ul>");
    expect(render("- a\n  - b\n- c")).toBe("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>");
  });
  it("reads CommonMark's content column in compatible syntax", () => {
    expect(render("- a\n - b", "compatible")).toBe("<ul><li>a</li><li>b</li></ul>");
  });
  it("warns when tabs and spaces mix in a list's indentation", () => {
    expect(codes("- a\n\t- b\n    - c")).toContain("mixed-indentation");
  });
});

describe("blank lines in lists", () => {
  it("splits a list at a blank line between items in modern syntax", () => {
    expect(render("- a\n- b\n\n- c")).toBe("<ul><li>a</li><li>b</li></ul><ul><li>c</li></ul>");
    expect(render("- a\n\n  more\n- b")).toBe("<ul><li><p>a</p><p>more</p></li><li>b</li></ul>");
    expect(render("1. a\n2. b\n\n3. c")).toBe('<ol><li>a</li><li>b</li></ol><ol start="3"><li>c</li></ol>');
    for (const source of ["- a\n- b\n\n- c", "- a\n\n  more\n- b"]) roundTrips(source);
  });
  it("makes the whole list loose in compatible syntax", () => {
    expect(render("- a\n- b\n\n- c", "compatible")).toBe("<ul><li><p>a</p></li><li><p>b</p></li><li><p>c</p></li></ul>");
  });
});

describe("list tables", () => {
  it("keeps rows separated by blank lines in one table in both syntaxes", () => {
    for (const syntax of ["modern", "compatible"] as const) expect(render("::: table\n- Name: Ada\n  Role: Math\n\n- Name: Alan\n  Role: Logic\n:::", syntax)).toBe("<table><tr><th>Name</th><th>Role</th></tr><tr><td>Ada</td><td>Math</td></tr><tr><td>Alan</td><td>Logic</td></tr></table>");
  });
});

describe("duplicate link definitions", () => {
  const source = "[x]\n\n[x]: /one\n[x]: /two";
  it("uses the last definition in modern syntax and the first in compatible syntax", () => {
    expect(render(source)).toBe('<p><a href="/two">x</a></p>');
    expect(render(source, "compatible")).toBe('<p><a href="/one">x</a></p>');
  });
  it("reports the duplicate label in both syntaxes", () => {
    expect(codes(source)).toEqual(["duplicate-definition"]);
    expect(codes(source, "compatible")).toEqual(["duplicate-definition"]);
  });
});

// The spec's examples, verbatim, in `modern` syntax.
describe("spec examples", () => {
  it.each([
    ['<div class="entry">\nSome **bold** text.\n</div>', '<div class="entry">Some <strong>bold</strong> text.</div>'],
    ["<details><summary>Notes</summary><div>\n\nBody\n\n</div></details>", "<details><summary>Notes</summary><div><p>Body</p></div></details>"],
    ['Text\n<a href="/x">link</a>\n\nText\n<div>\nBlock\n</div>', '<p>Text\n<a href="/x">link</a></p><p>Text</p><div>Block</div>'],
    ["<ul><li>a<li>b</ul>\n\n<table>\n<tr><td>a<td>b\n<tr><td>c\n</table>", "<ul><li>a</li><li>b</li></ul><table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>"],
    ["a </span> b\n\nline one</br>\nline two", "<p>a  b</p><p>line one<br />\nline two</p>"],
    ['<a href=/docs/>Docs</a>', '<a href="/docs/">Docs</a>'],
    ["    const x = 1;\n\n    # Title", "<p>const x = 1;</p><h1>Title</h1>"],
    ["Title\n---\n\nTitle\n===", "<p>Title</p><hr /><p>Title\n===</p>"],
    ["one  \ntwo\n\none\\\ntwo", "<p>one\ntwo</p><p>one<br />two</p>"],
    ["| Expression | Reads |\n| --- | --- |\n| `a || b` | or |\n| x \\| y | either |", "<table><tr><th>Expression</th><th>Reads</th></tr><tr><td><code>a || b</code></td><td>or</td></tr><tr><td>x | y</td><td>either</td></tr></table>"],
    ["> quoted\nnot quoted\n\n- item\nnot item", "<blockquote><p>quoted</p></blockquote><p>not quoted</p><ul><li>item</li></ul><p>not item</p>"],
    ["- a\n* b\n+ c\n\n1. one\n2) two", "<ul><li>a</li><li>b</li><li>c</li></ul><ol><li>one</li><li>two</li></ol>"],
    ["- a\n - b\n- c", "<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>"],
    ["- a\n- b\n\n- c\n\n- a\n\n  more\n- b\n\n1. one\n2. two\n\n3. three", '<ul><li>a</li><li>b</li></ul><ul><li>c</li></ul><ul><li><p>a</p><p>more</p></li><li>b</li></ul><ol><li>one</li><li>two</li></ol><ol start="3"><li>three</li></ol>'],
    ['[Notes](my notes.md)\n[Draft](notes (draft).md "Draft") and [Next](next.md)\n![Chart](my chart.png)', '<p><a href="my%20notes.md">Notes</a><a href="notes%20(draft).md" title="Draft">Draft</a> and <a href="next.md">Next</a><img src="my%20chart.png" alt="Chart" /></p>'],
    ["[x]\n\n[x]: /one\n[x]: /two", '<p><a href="/two">x</a></p>'],
  ])("%s", (source, html) => expect(render(source)).toBe(html));
  it("reads <u> and <mark> as element nodes", () => {
    expect(parse("<u>Underlined</u> and <mark>highlighted</mark> text.", { syntax: "modern" }).body[0]).toEqual({ type: "paragraph", children: [
      { type: "htmlElement", display: "inline", tag: "u", open: "<u>", close: "</u>", value: "Underlined" },
      { type: "text", value: " and " },
      { type: "htmlElement", display: "inline", tag: "mark", open: "<mark>", close: "</mark>", value: "highlighted" },
      { type: "text", value: " text." },
    ] });
  });
});
