import { expect, it } from "vitest";
import { parse, stringify } from "../src/index.js";
import { renderHtml } from "../src/render.js";

const codes = (markdown: string, transformers = {}) => {
  const found: string[] = [];
  renderHtml(parse(markdown), { transformers, onDiagnostic: diagnostic => found.push(diagnostic.code) });
  return found;
};

it("keeps code from a file and live examples as authored, and reports that renderHtml cannot read files", () => {
  const fence = '```html {title="button.html" & src="examples/button.html" & highlight=2}\n```\n';
  const example = '::example[Button tones]{src="examples/button.html"}\n';
  expect(parse(fence).body[0]).toMatchObject({ type: "code", language: "html", title: "button.html", attributes: { src: "examples/button.html", highlight: "2" }, value: "" });
  expect(parse(example).body[0]).toMatchObject({ type: "leaf", subType: "example", attributes: { src: "examples/button.html" } });
  expect(stringify(parse(fence))).toBe(fence);
  expect(stringify(parse(example))).toBe(example);
  expect(codes(fence)).toContain("unsupported-presentation");
  expect(codes(example)).toContain("unsupported-presentation");
  // A renderer that reads files supplies its own transformers, and reports nothing.
  expect(codes(fence + "\n" + example, { code: () => "<pre></pre>", "leaf:example": () => "<figure></figure>" })).not.toContain("unsupported-presentation");
  expect(codes("```ts\nx\n```\n")).not.toContain("unsupported-presentation");
});
