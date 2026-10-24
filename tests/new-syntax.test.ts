import { describe, expect, it } from "vitest";
import { parse, stringify, type Diagnostic, type Node } from "../src/index.js";
import { renderHtml } from "../src/render.js";
import { fresh, semantic } from "./semantic.js";

const first = (source: string): Node => semantic(parse(source).body[0]!);
// A paragraph of plain text holds it as a value; read it as one text node.
const inlines = (source: string): Node[] => { const node = semantic(parse(source).body[0]!); return node.children ?? [{type:"text",value:node.value!}]; };

// Every new spelling writes back byte for byte.
const spellings: [string, string][] = [
  ["generic container with shorthand attributes","::: {.render #intro title=\"x\"}\nBody.\n:::\n"],
  ["generic container with a title","::: [Summary]\nBody.\n:::\n"],
  ["bare generic container","::: \nBody.\n:::\n".replace("::: \n",":::\n")],
  ["generic container nested in a longer fence","::::\n:::\nInner.\n:::\n::::\n"],
  ["malformed header","::: note [unclosed\nBody.\n:::\n"],
  ["class shorthand on a heading","## Install {.wide #install}\n"],
  ["class shorthand on a link","[Docs](/docs){.external}\n"],
  ["bracketed span with a class","A [word]{.kw} here.\n"],
  ["bracketed span with class, id and value","A [word]{.kw #w key=\"v\"} here.\n"],
  ["bracketed span holding formatting","A [*bold* text]{.note} here.\n"],
  ["bracketed span with an empty list","A [word]{} here.\n"],
];

describe("new syntax round trips", () => {
  it.each(spellings)("%s", (_name, source) => {
    const document = parse(source);
    expect(stringify(document)).toBe(source);
    expect(parse(stringify(document))).toEqual(document);
  });
});

describe("colon fences", () => {
  it("open a generic container for a typeless header, never a paragraph", () => {
    expect(first("::: {.render title=\"x\"}\nBody.\n:::")).toEqual({type:"container",attributes:{class:"render",title:"x"},body:[{type:"paragraph",value:"Body."}]});
    expect(first(":::\nBody.\n:::")).toEqual({type:"container",body:[{type:"paragraph",value:"Body."}]});
    expect(first("Text\n::: {.x}\nBody.\n:::").type).toBe("paragraph");
    expect(parse("Text\n::: {.x}\nBody.\n:::").body[1]?.type).toBe("container");
  });
  it("keep an unreadable header as written, with a diagnostic", () => {
    const seen: Diagnostic[] = [];
    const document = parse("::: note [unclosed\nBody.\n:::", {onDiagnostic:d => seen.push(d)});
    expect(document.body[0]).toEqual({type:"container",subType:"note",source:{rest:" [unclosed"},body:[{type:"paragraph",value:"Body."}]});
    expect(seen.map(d => d.code)).toEqual(["invalid-container-header"]);
  });
  it("render a generic container as a plain div with its attributes", () => {
    expect(renderHtml(parse("::: {#summary class=\"wide\"} [Summary]\nBody.\n:::"))).toBe('<div class="wide" id="summary"><header>Summary</header><p>Body.</p></div>');
  });
  it("keep a stray bare fence as one node that renders nothing and swallows nothing", () => {
    const seen: string[] = [];
    const source = "::: note\nA\n:::\n:::\n\nAfter.\n\n::: tip\nC\n:::\n";
    const document = parse(source,{onDiagnostic:d => seen.push(d.code)});
    expect(semantic(document.body).map(node => node.type)).toEqual(["container","strayFence","paragraph","container"]);
    expect(seen).toEqual(["stray-fence"]);
    expect(stringify(document)).toBe(source);
    expect(stringify(fresh(document))).toBe("::: note\nA\n:::\n\n:::\n\nAfter.\n\n::: tip\nC\n:::\n");
    expect(parse(stringify(document))).toEqual(document);
    expect(renderHtml(document)).toBe('<section data-type="note"><p>A</p></section><p>After.</p><section data-type="tip"><p>C</p></section>');
  });
  it("run an unclosed typed container to the end of its enclosing block", () => {
    const seen: string[] = [];
    expect(semantic(parse("::: note\nA\n\nB",{onDiagnostic:d => seen.push(d.code)}).body)).toEqual([{type:"container",subType:"note",body:[{type:"paragraph",value:"A"},{type:"paragraph",value:"B"}]}]);
    expect(seen).toEqual(["unclosed-container"]);
    expect(semantic(parse(":::: outer\n::: inner\nA\n::::\n\nAfter").body)).toEqual([{type:"container",subType:"outer",body:[{type:"container",subType:"inner",body:[{type:"paragraph",value:"A"}]}]},{type:"paragraph",value:"After"}]);
  });
  it("strips a fence's indentation before interpreting compatible indented code", () => {
    expect(semantic(parse("  ::: note\n      four after stripping\n  :::", {syntax:"compatible"}).body[0]!.body)).toEqual([{type:"code",value:"four after stripping"}]);
    expect(semantic(parse("  ::: note\n     three after stripping\n  :::", {syntax:"compatible"}).body[0]!.body)).toEqual([{type:"paragraph",value:"three after stripping"}]);
  });
});

describe("class shorthand", () => {
  it("accumulates classes, and an assigned class replaces them", () => {
    expect(first("## A {.one .two}").attributes).toEqual({class:"one two"});
    const seen: string[] = [];
    expect(semantic(parse("## A {.one class=two .three}",{onDiagnostic:d => seen.push(d.code)}).body[0]!.attributes)).toEqual({class:"two three"});
    expect(seen).toEqual(["duplicate-attribute"]);
    expect(inlines("[Docs](/d){.one}{.two}")[0]?.attributes).toEqual({class:"one two"});
  });
  it("never turns a class into a container type", () => {
    expect(first("::: {.warning}\nBody.\n:::")).toEqual({type:"container",attributes:{class:"warning"},body:[{type:"paragraph",value:"Body."}]});
  });
  it("writes the preferred .class and #id spellings for new content", () => {
    const write = (attributes: Record<string,string>, id?: string) => stringify({type:"document",version:1,body:[{type:"heading",level:2,...(id === undefined ? {} : {id}),attributes,value:"A"}]});
    expect(write({class:"wide"},"a")).toBe("## A {.wide #a}\n");
    expect(write({class:"one two",lang:"en"})).toBe('## A {.one .two lang="en"}\n');
    expect(write({class:"a&b"})).toBe('## A {class="a&b"}\n');
    for (const source of ['## A {.wide #a}','## A {#a class="wide"}','## A {id="a" class="one two"}']) expect(stringify(parse(source))).toBe(source);
  });
});

// Each construct that shares the new forms' characters keeps its reading.
describe("conflicts with existing syntax", () => {
  it("inline types and leaf directives keep their types", () => {
    expect(inlines(":kw[word]{.x}")).toEqual([{type:"inline",subType:"kw",value:"word",attributes:{class:"x"}}]);
    expect(first("::break[Here]{.x}")).toEqual({type:"leaf",subType:"break",title:{type:"title",value:"Here"},attributes:{class:"x"}});
    expect(inlines(":mention[Ada]{#a}")).toEqual([{type:"text",value:":mention[Ada]{#a}"}]);
  });
  it("mentions keep their brackets, and a mention shape that does not form stays text", () => {
    expect(inlines("@[Ada]#ada{.x}")).toEqual([{type:"inline",subType:"mention",value:"Ada",ref:"ada",attributes:{class:"x"}}]);
    expect(inlines("a@[Ada]{.x}")).toEqual([{type:"text",value:"a@[Ada]{.x}"}]);
  });
  it("links and resolving references keep the bracket; the list attaches to them", () => {
    expect(inlines("[w](/u){.x}")).toEqual([{type:"link",url:"/u",value:"w",attributes:{class:"x"}}]);
    expect(semantic(parse("[w]{.x}\n\n[w]: /u").body[0]!.children)).toEqual([{type:"linkReference",label:"w",referenceType:"shortcut",value:"w",attributes:{class:"x"}}]);
    expect(inlines("![a](/i.png){.x}")).toEqual([{type:"image",url:"/i.png",alt:"a",attributes:{class:"x"}}]);
    expect(inlines("![a]{.x}")).toEqual([{type:"text",value:"![a]{.x}"}]);
  });
  it("an unresolved reference bracket with a list is a span", () => {
    expect(inlines("[w]{.x}")).toEqual([{type:"inline",value:"w",attributes:{class:"x"}}]);
  });
  it("footnotes and task markers keep their readings", () => {
    expect(inlines("A[^n]{.x}\n\n[^n]: Note.")).toEqual([{type:"text",value:"A"},{type:"footnoteReference",label:"n"},{type:"text",value:"{.x}"}]);
    expect(inlines("A[^n]{.x}")).toEqual([{type:"text",value:"A[^n]{.x}"}]);
    expect(first("- [x] Done")).toMatchObject({children:[{checked:true}]});
    expect(first("- [x]{.a} Done").children?.[0]).toEqual({type:"listItem",body:[{type:"paragraph",children:[{type:"inline",value:"x",attributes:{class:"a"}},{type:"text",value:" Done"}]}]});
  });
  it("chips and the TOC placeholder keep their types", () => {
    expect(inlines(":chip[Ready]{.x tone=green}")).toEqual([{type:"inline",subType:"chip",value:"Ready",attributes:{class:"x",tone:"green"}}]);
    expect(first("::: toc [On this page] {.x}\n:::")).toEqual({type:"container",subType:"toc",title:{type:"title",value:"On this page"},attributes:{class:"x"},body:[]});
  });
  it("code spans and escaped brackets stay literal", () => {
    expect(inlines("`[a]{.x}`")).toEqual([{type:"inlineCode",value:"[a]{.x}"}]);
    expect(inlines("\\[a]{.x}")).toEqual([{type:"text",value:"[a]{.x}"}]);
    expect(stringify({type:"document",version:1,body:[{type:"paragraph",value:"[a]{.x}"}]})).toBe("\\[a]{.x}\n");
  });
  it("headings take a final whitespace-separated list; an adjacent one belongs to a span", () => {
    expect(first("## Title {.x}")).toEqual({type:"heading",level:2,value:"Title",attributes:{class:"x"}});
    expect(first("## [a]{.x} {#h}")).toEqual({type:"heading",level:2,id:"h",children:[{type:"inline",value:"a",attributes:{class:"x"}}]});
  });
  it("the existing {#id} keeps its meaning", () => {
    expect(first("## A {#a}")).toEqual({type:"heading",level:2,id:"a",value:"A"});
  });
  it("alerts need a space after the marker; a container list after the type is attributes", () => {
    expect(first("> [!note]{.x}")).toEqual({type:"blockquote",body:[{type:"paragraph",children:[{type:"inline",value:"!note",attributes:{class:"x"}}]}]});
    expect(first("> [!note] {.x}")).toMatchObject({type:"container",subType:"note",spelling:"alert",title:{type:"title",value:"{.x}"}});
    expect(first("::: tip {.x}\n:::")).toEqual({type:"container",subType:"tip",attributes:{class:"x"},body:[]});
  });
  it("a container title keeps inner braces; a final valid list is attributes", () => {
    expect(first("::: note Use {name} here\n:::")).toMatchObject({title:{type:"title",value:"Use {name} here"}});
    expect(first("::: note Title {.x}\n:::")).toMatchObject({title:{type:"title",value:"Title"},attributes:{class:"x"}});
    expect(first("::: note Title \\{.x}\n:::")).toMatchObject({title:{type:"title",value:"Title {.x}"}});
  });
  it("line blocks and table cells read spans like other inline content", () => {
    expect(first("| [a]{.x}\n| next")).toEqual({type:"lineBlock",children:[{type:"inline",value:"a",attributes:{class:"x"}},{type:"break"},{type:"text",value:"next"}]});
    expect(first("| A |\n| --- |\n| [a]{.x} |").children?.[1]?.children?.[0]).toEqual({type:"tableCell",children:[{type:"inline",value:"a",attributes:{class:"x"}}]});
  });
  it("CommonMark definitions, unresolved brackets and braces without a valid list stay as they were", () => {
    expect(first("[w]: /u")).toEqual({type:"definition",label:"w",url:"/u"});
    expect(inlines("[w] and {.5} and [w] {.x}")).toEqual([{type:"text",value:"[w] and {.5} and [w] {.x}"}]);
  });
});

describe("review fixes", () => {
  it("keeps a span inside link text inside the link (M5)", () => {
    expect(inlines("[a [b]{.x}](/u)")).toEqual([{type:"link",url:"/u",children:[{type:"text",value:"a "},{type:"inline",value:"b",attributes:{class:"x"}}]}]);
    expect(inlines("[[w]{.x}](/u)")).toEqual([{type:"link",url:"/u",children:[{type:"inline",value:"w",attributes:{class:"x"}}]}]);
    for (const source of ["[a [b]{.x}](/u)\n","[[w]{.x}](/u)\n"]) expect(stringify(parse(source))).toBe(source);
  });
  it("keeps the type an unreadable header names, with its remainder (minor 2)", () => {
    expect(parse("::: warning [unclosed\nx\n:::").body[0]).toEqual({type:"container",subType:"warning",source:{rest:" [unclosed"},body:[{type:"paragraph",value:"x"}]});
    expect(stringify(parse("::: warning [unclosed\nx\n:::"))).toBe("::: warning [unclosed\nx\n:::");
  });
  it("forms a span after an escaped image or mention marker (minor 3)", () => {
    expect(inlines("\\![w]{.x}")).toEqual([{type:"text",value:"!"},{type:"inline",value:"w",attributes:{class:"x"}}]);
    expect(inlines("\\@[w]{.x}")).toEqual([{type:"text",value:"@"},{type:"inline",value:"w",attributes:{class:"x"}}]);
    for (const source of ["\\![w]{.x}\n","\\@[w]{.x}\n"]) expect(stringify(parse(source))).toBe(source);
  });
  it("keeps unresolved collapsed and full reference forms as text (minor 4)", () => {
    expect(inlines("[w][]{.x} [w][nope]{.x}")).toEqual([{type:"text",value:"[w][]{.x} [w][nope]{.x}"}]);
    expect(semantic(parse(stringify(parse("[w][]{.x} [w][nope]{.x}"))).body)).toEqual([{type:"paragraph",value:"[w][]{.x} [w][nope]{.x}"}]);
  });
  it("leaves no empty text node after a task marker (minor 5)", () => {
    expect(first("- [ ] [w]{.x} task").children?.[0]?.body?.[0]).toEqual({type:"paragraph",children:[{type:"inline",value:"w",attributes:{class:"x"}},{type:"text",value:" task"}]});
  });
  it("keeps content after an unclosed container in a list item (B2)", () => {
    expect(semantic(parse("- item\n  ::: note\n  x\n\n# Heading outside").body).at(-1)).toEqual({type:"heading",level:1,value:"Heading outside"});
    expect(semantic(parse("- item\n  :::\n  x\n\nOutside\n:::").body).map(node => node.type)).toEqual(["list","paragraph","strayFence"]);
  });
});
