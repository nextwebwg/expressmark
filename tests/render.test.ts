import { describe, expect, it } from "vitest";
import { parse, type Document, type Node } from "../src/index.js";
import { renderHtml } from "../src/render.js";
const document = (...body: Node[]): Document => ({ type: "document", version: 1, body });

describe("HTML transformers", () => {
  it("renders Markdown with escaped text, formatting, lists, code and links", () => {
    const source = '# Hello\n\nA **bold** [link](https://example.com) & `code`.\n\n- First\n- Second\n\n```js\na < b\n```';
    expect(renderHtml(parse(source))).toBe('<h1>Hello</h1><p>A <strong>bold</strong> <a href="https://example.com">link</a> &amp; <code>code</code>.</p><ul><li><p>First</p></li><li><p>Second</p></li></ul><pre><code class="language-js">a &lt; b</code></pre>');
  });
  it("retains child overrides when wrapping a node's default renderer", () => {
    expect(renderHtml(parse("# Hello *world*"), { transformers: {
      heading: (_node, context) => `<section class="hero">${context.renderDefault()}</section>`,
      emphasis: (_node, context) => `<mark>${context.renderChildren()}</mark>`,
    } })).toBe('<section class="hero"><h1>Hello <mark>world</mark></h1></section>');
  });
  it("selects subtype, type, then wildcard; undefined delegates and empty output omits", () => {
    const input = document({ type: "container", subType: "warning", body: [{ type: "paragraph", value: "Careful" }] }, { type: "paragraph", value: "Keep" }, { type: "horizontalRule" });
    expect(renderHtml(input, { transformers: {
      "container:warning": (_node, context) => `<aside>${context.renderChildren()}</aside>`,
      container: () => "wrong", paragraph: () => undefined, horizontalRule: () => "",
      "*": (_node, context) => context.renderDefault(),
    } })).toBe("<aside><p>Careful</p></aside><p>Keep</p>");
  });
  it("passes data to transformers and escapes authored text", () => {
    expect(renderHtml(document({ type: "leaf", subType: "badge", attributes: { label: '<img src=x onerror=alert(1)>' } }), { transformers: {
      "leaf:badge": (node, context) => `<span>${context.escape(String(node.attributes?.label))}</span>`,
    } })).toBe('<span>&lt;img src=x onerror=alert(1)&gt;</span>');
  });
  it("preserves text identities and authored custom attributes as inert data", () => {
    expect(renderHtml(document({ type: "paragraph", children: [
      { type: "text", id: "label", attributes: { tone: "green" }, value: "Ready" },
    ] }))).toBe('<p><span data-tone="green" id="label">Ready</span></p>');
  });
  it("filters HTML, attributes and URLs from built-in and custom output", () => {
    const warnings: string[] = [];
    expect(renderHtml(document({ type: "paragraph", value: "text" }), {
      onDiagnostic: diagnostic => warnings.push(diagnostic.code),
      transformers: { paragraph: () => '<script>bad()</script><p onclick="bad()"><a href="javascript:bad()">safe</a></p>' },
    })).toBe("<p><a>safe</a></p>");
    expect(warnings).toContain("html-filtered");
    expect(renderHtml(document({ type: "link", url: "javascript:bad()", value: "label" }))).toBe("<a>label</a>");
  });
  it("renders rich containers, tables, tasks and titles without changing the AST", () => {
    const input: Document = { ...document(
      { type: "container", subType: "details", title: { type: "title", value: "More" }, body: [{ type: "paragraph", value: "Body" }], attributes: { open: true } },
      { type: "table", title: { type: "title", value: "Data" }, children: [{ type: "tableRow", children: [{ type: "tableCell", header: true, colSpan: 2, value: "Cell" }] }] },
      { type: "list", children: [{ type: "listItem", checked: true, body: [{ type: "paragraph", value: "Done" }] }] },
    ), title: { type: "title", value: "Title" } };
    const before = JSON.stringify(input);
    expect(renderHtml(input)).toBe('<h1>Title</h1><details open><summary>More</summary><p>Body</p></details><table><caption>Data</caption><tr><th colspan="2">Cell</th></tr></table><ul><li>☑ <p>Done</p></li></ul>');
    expect(JSON.stringify(input)).toBe(before);
  });
  it("rejects cycles and unsupported nodes unless a transformer handles them", () => {
    const cyclic: Node = { type: "group", display: "block", children: [] }; cyclic.children!.push(cyclic);
    expect(() => renderHtml(document(cyclic))).toThrow(/cyclic/);
    expect(() => renderHtml(document({ type: "widget" }))).toThrow(/widget/);
    expect(renderHtml(document({ type: "widget" }), { transformers: { widget: () => "<p>Widget</p>" } })).toBe("<p>Widget</p>");
    expect(() => renderHtml({ ...document(), version: 2 } as unknown as Document)).toThrow(/version/);
    expect(() => renderHtml(document({ type: "paragraph", value: "text" }), { transformers: { paragraph: (node, context) => context.render(node) } })).toThrow(/cyclic/);
  });
  it("ignores inherited transformer entries and propagates callback errors", () => {
    expect(() => renderHtml(document({ type: "constructor" }))).toThrow(/constructor/);
    const failure = new Error("renderer failed");
    expect(() => renderHtml(parse("text"), { transformers: { paragraph: () => { throw failure; } } })).toThrow(failure);
  });
});
