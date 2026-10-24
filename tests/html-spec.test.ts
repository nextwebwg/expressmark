import { parseCompatible as parse, stringifyCompatible as stringify } from "./compatible.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderHtml } from "../src/render.js";
import { sanitizeHtml, type HtmlAllowlist } from "../src/html.js";

// CommonMark's and GFM's HTML-block and raw-HTML examples. Raw HTML is read
// in the trusted profile, which keeps it, so block boundaries are visible.
// Output filtering is the renderer's: each example's tags are allowed, and the
// expected HTML passes through the same filter before comparison.
interface Example { example: number; section: string; markdown: string; html: string }
const { sources } = JSON.parse(readFileSync(new URL("./fixtures/html-spec-examples.json", import.meta.url), "utf8")) as { sources: Record<string, { examples: Example[] }> };
// GFM 0.29 predates CommonMark 0.31's comment rules, the base of Expressive
// Markdown; its tag filter escapes tags on output, a renderer decision. In
// Expressive Markdown `/>` closes every element, so `<a/><b2/>` is two
// elements, and a stray end tag such as example 148's `</p>` is ignored.
const selfClosing = "`/>` closes every element", stray = "a stray end tag is ignored";
const superseded: Record<string, Record<number, string>> = { commonmark: { 148: stray, 614: selfClosing, 615: selfClosing }, gfm: { 118: stray, 637: selfClosing, 638: selfClosing, 649: "CommonMark 0.31 comments", 650: "CommonMark 0.31 comments", 657: "GFM tag filter on output" } };
const allowlist = (text: string): HtmlAllowlist => {
  const tags = new Set<string>(), attributes = new Set<string>();
  for (const match of text.matchAll(/<\/?([A-Za-z][A-Za-z0-9-]*)([^>]*)>/g)) {
    tags.add(match[1]!.toLowerCase());
    for (const name of match[2]!.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*(?==|\s|\/|$)/g)) if (!/^on/i.test(name[1]!)) attributes.add(name[1]!.toLowerCase());
  }
  return { tags: [...tags], attributes: { "*": [...attributes] } };
};
const normalize = (html: string) => html.replace(/\s+/g, " ").replace(/\s*(<[^>]+>)\s*/g, "$1").trim();

for (const [name, { examples }] of Object.entries(sources)) describe(`${name} HTML examples`, () => {
  it.each(examples.filter(example => !superseded[name]?.[example.example]))("example $example ($section)", ({ markdown, html }) => {
    const allow = allowlist(markdown + html);
    expect(normalize(renderHtml(parse(markdown, { trustedHtml: true }), { trustedHtml: allow }))).toBe(normalize(sanitizeHtml(html, {}, allow)));
  });
});

describe("an element's tags in separate HTML blocks", () => {
  const sources = [
    "<div class=\"entry\">\n\n::: tip Heads up\nSome **bold** text.\n:::\n\n</div>\n",
    "<details>\n<summary>Release notes</summary>\n\nThis paragraph is **Markdown**.\n\n</details>\n",
  ];
  it.each(sources)("keeps both tags as authored in the safe profile: %j", source => {
    const document = parse(source);
    expect(document.body[0]).toMatchObject({type:"html",display:"block"});
    expect(document.body.at(-1)).toMatchObject({type:"html",display:"block"});
    expect(stringify(document)).toBe(source);
  });
  it.each(sources)("keeps both tags as authored in the trusted profile: %j", source => {
    expect(stringify(parse(source, {trustedHtml:true}), {trustedHtml:true})).toBe(source);
  });
  it("nests the container inside the div when rendering", () => {
    expect(renderHtml(parse(sources[0]!))).toBe('<div class="entry"><section data-type="tip"><header>Heads up</header><p>Some <strong>bold</strong> text.</p></section></div>');
  });
  it("nests the Markdown inside the details when rendering", () => {
    expect(renderHtml(parse(sources[1]!))).toBe("<details>\n<summary>Release notes</summary><p>This paragraph is <strong>Markdown</strong>.</p></details>");
  });
});
