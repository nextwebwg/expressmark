import { expect, it } from "vitest";
import { parse, stringify } from "../src/index.js";
import { renderHtml } from "../src/render.js";

it("preserves layout identity, logical alignment, floating and RTL content through Markdown", () => {
  const source = ':::: layout [مثال] {#example align=center float=end dir=rtl lang=ar}\n::: layout {align=start}\nمرحبًا بالعالم\n:::\n\n> שלום עולם\n::::';
  const document = parse(source);
  expect(document.body[0]).toMatchObject({ type: "container", subType: "layout", id: "example", attributes: { align: "center", float: "end", dir: "rtl", lang: "ar" } });
  expect(parse(stringify(document))).toEqual(document);
});

it("renders layout with logical CSS, preserving child transformers and the input AST", () => {
  const document = parse('::: layout {align=center float=start}\n# مرحبًا\n:::');
  const before = JSON.stringify(document);
  const html = renderHtml(document, { transformers: { heading: (_node, context) => `<h2>${context.renderChildren()}</h2>` } });
  expect(html).toContain('<div data-align="center" data-float="start" data-type="layout"');
  expect(html).toContain("text-align:center");
  expect(html).toContain("float:inline-start");
  expect(html).toContain("<h2>مرحبًا</h2>");
  expect(JSON.stringify(document)).toBe(before);
});

it("preserves unsupported layout values as data and diagnoses their rendering fallback", () => {
  const document = parse('::: layout {align=left float=true}\nKeep me.\n:::');
  expect(parse(stringify(document))).toEqual(document);
  const warnings: string[] = [];
  const html = renderHtml(document, { onDiagnostic: diagnostic => warnings.push(diagnostic.code) });
  expect(html).toContain('data-align="left"');
  expect(html).toContain("text-align:start");
  expect(html).not.toContain("float:");
  expect(warnings).toEqual(["unsupported-layout-attribute", "unsupported-layout-attribute"]);
});

it("imports native layout wrappers as editable containers and filters unsafe layout CSS", () => {
  const document = parse('<div data-type="layout" data-align="end" data-float="start" dir="rtl"><p>שלום</p></div>');
  expect(document.body[0]).toMatchObject({ type: "container", subType: "layout", attributes: { align: "end", float: "start", dir: "rtl" }, body: [{ type: "paragraph", value: "שלום" }] });
  const html = renderHtml(parse('::: layout {align=center}\nHello\n:::'), { transformers: {
    "container:layout": () => '<div style="display:flow-root;float:inline-end;margin-inline-start:auto;position:fixed;float:expression(bad);background-image:url(javascript:bad)">Safe</div>',
  } });
  expect(html).toContain("display:flow-root");
  expect(html).toContain("float:inline-end");
  expect(html).not.toMatch(/fixed|expression|javascript/);
});
