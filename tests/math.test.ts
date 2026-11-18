import { describe, expect, it } from "vitest";
import { ConversionError, parse, stringify, type Document, type Node } from "../src/index.js";
import { renderHtml } from "../src/render.js";
import { parseCompatible } from "./compatible.js";
import { fresh, semantic } from "./semantic.js";

const text = (value: string): Node => ({type:"text",value});
const math = (value: string): Node => ({type:"inlineMath",value});
const paragraph = (...children: Node[]): Node => children.every(child => child.type === "text") ? {type:"paragraph",value:children.map(child => child.value).join("")} : {type:"paragraph",children};
const doc = (...body: Node[]): Document => ({type:"document",version:1,body});

// Each source is canonical, so parsing and writing it must return the same bytes.
const cases: { name: string; source: string; body: Node[] }[] = [
  {name:"inline math between single dollars",source:"The energy is $E = mc^2$.\n",body:[paragraph(text("The energy is "),math("E = mc^2"),text("."))]},
  {name:"spacing keeps prices text",source:"$5 and $10\n",body:[paragraph(text("$5 and $10"))]},
  {name:"a digit after the closer keeps prices text",source:"$5–$10 and $x$5\n",body:[paragraph(text("$5–$10 and $x$5"))]},
  {name:"two dollars inside a paragraph are text",source:"cost$$x$$ here\n",body:[paragraph(text("cost$$x$$ here"))]},
  {name:"an escaped dollar is text and does not open",source:"\\$x$ stays\n",body:[paragraph(text("$x$ stays"))]},
  {name:"an escaped dollar inside math is notation",source:"$a\\$b$\n",body:[paragraph(math("a\\$b"))]},
  {name:"a code span holds dollars literally",source:"`$x$` and $`y`$\n",body:[paragraph({type:"inlineCode",value:"$x$"},text(" and "),math("`y`"))]},
  {name:"display math between dollar lines",source:"$$\nx = \\frac{-b}{2a}\n$$\n",body:[{type:"math",value:"x = \\frac{-b}{2a}"}]},
  {name:"display math on one line",source:"$$y^2$$\n",body:[{type:"math",value:"y^2",source:{form:"line"}}]},
  {name:"a math fence with an ID",source:"```math {#euler}\ne^{i\\pi} + 1 = 0\n```\n",body:[{type:"math",value:"e^{i\\pi} + 1 = 0",id:"euler",source:{fence:"```"}}]},
  {name:"display math inside a quote",source:"> $$\n> a\n> $$\n",body:[{type:"blockquote",body:[{type:"math",value:"a"}]}]},
  {name:"an unclosed display opener is text",source:"$$\nopen\n",body:[paragraph(text("$$"),{type:"softBreak"},text("open"))]},
];

describe("math conformance", () => {
  it.each(cases)("$name", ({source,body}) => {
    const document = parse(source);
    expect(document).toEqual(doc(...body));
    expect(stringify(document)).toBe(source);
  });
  it("reads a line ending in inline math as a space", () => {
    expect(parse("$a\nb$").body).toEqual([paragraph(math("a b"))]);
  });
  it("lets display math interrupt a paragraph", () => {
    expect(parse("Text\n$$\na\n$$").body).toEqual([paragraph(text("Text")),{type:"math",value:"a"}]);
  });
  it("keeps a container fence inside display math literal", () => {
    expect(parse("::: note\n$$\n:::\n$$\n:::").body).toEqual([{type:"container",subType:"note",body:[{type:"math",value:":::"}]}]);
  });
  it("reads math in compatible syntax", () => {
    expect(parseCompatible("$x$").body).toEqual([paragraph(math("x"))]);
  });
});

describe("math writing", () => {
  it.each<[string, Node[], string]>([
    ["literal text that would pair",[paragraph(text("$x$ is text"))],"\\$x$ is text\n"],
    ["prices that cannot pair",[paragraph(text("$5 and $10"))],"$5 and $10\n"],
    ["a dollar before inline math",[paragraph(text("cost$"),math("x"))],"cost\\$$x$\n"],
    ["a dollar after inline math",[paragraph(math("x"),text("$"))],"$x$\\$\n"],
    ["a digit after inline math",[paragraph(math("x"),text("1 more"))],"$x$&#49; more\n"],
    ["a possible opener before another node",[paragraph(text("a $b "),{type:"emphasis",value:"c"},text(" d$"))],"a \\$b *c* d\\$\n"],
    ["a literal display opener",[paragraph(text("$$y$$"))],"\\$$y$$\n"],
    ["display math without a recorded form",[{type:"math",value:"a"}],"$$\na\n$$\n"],
    ["display math holding a $$ line",[{type:"math",value:"a\n$$\nb"}],"```math\na\n$$\nb\n```\n"],
    ["captioned display math",[{type:"math",value:"a",title:"Area"}],"```math {title=\"Area\"}\na\n```\n"],
  ])("writes %s", (_name, body, expected) => {
    const document = doc(...body);
    expect(stringify(document)).toBe(expected);
    expect(semantic(parse(expected))).toEqual(document);
  });
  it("rewrites a parsed document that holds math", () => {
    const source = "A $x$ b.\n\n$$y$$\n";
    expect(stringify(fresh(parse(source)))).toBe(source);
  });
  it.each<[string, Node]>([
    ["empty inline math",paragraph(math(""))],
    ["inline math with outer space",paragraph(math(" x"))],
    ["inline math holding a closer",paragraph(math("a$ b"))],
    ["inline math holding a line ending",paragraph(math("a\nb"))],
    ["adjacent inline math",paragraph(math("a"),math("b"))],
    ["inline math with an ID",paragraph({...math("a"),id:"x"})],
  ])("rejects %s", (_name, node) => {
    expect(() => stringify(doc(node))).toThrow(ConversionError);
  });
});

describe("math HTML", () => {
  it("renders the notation as escaped code", () => {
    expect(renderHtml(parse("A $x<y$.\n\n$$\na & b\n$$"))).toBe('<p>A <code class="language-math">x&lt;y</code>.</p><pre><code class="language-math">a &amp; b</code></pre>');
  });
  it("lets a host typeset math with transformers", () => {
    const html = renderHtml(parse("$x$"), {transformers:{inlineMath:node => `<span class="tex">${node.value}</span>`}, trustedHtml:{}});
    expect(html).toBe('<p><span class="tex">x</span></p>');
  });
});
