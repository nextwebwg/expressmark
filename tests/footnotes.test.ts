import { describe, expect, it } from "vitest";
import { ConversionError, parse, stringify, type Diagnostic, type Document, type Node } from "../src/index.js";
import { renderHtml } from "../src/render.js";

const reference = (label: string): Node => ({type:"footnoteReference",label});
const note = (label: string, ...body: Node[]): Node => ({type:"footnoteDefinition",label,body});
const paragraph = (...children: Node[]): Node => children.every(child => child.type === "text") ? {type:"paragraph",value:children.map(child => child.value).join("")} : {type:"paragraph",children};
const text = (value: string): Node => ({type:"text",value});

// Each source is canonical, so parsing and writing it must return the same bytes.
interface Case { name: string; source: string; body: Node[]; diagnostics?: string[] }
const cases: Case[] = [
  {name:"references and definitions",source:"Tables[^tables] and tasks[^1].\n\n[^tables]: GFM tables.\n\n[^1]: Checkboxes.\n",
    body:[paragraph(text("Tables"),reference("tables"),text(" and tasks"),reference("1"),text(".")),note("tables",paragraph(text("GFM tables."))),note("1",paragraph(text("Checkboxes.")))]},
  {name:"definitions stay mid-document where they were written",source:"[^b]: Second.\n\nA[^a] and b[^b].\n\n[^a]: First.\n\n## Next\n\nMore.\n",
    body:[note("b",paragraph(text("Second."))),paragraph(text("A"),reference("a"),text(" and b"),reference("b"),text(".")),note("a",paragraph(text("First."))),{type:"heading",level:2,value:"Next"},paragraph(text("More."))]},
  {name:"indented continuation holds several blocks",source:"Log[^log].\n\n[^log]: Every step.\n\n    ```sh\n    pnpm build\n    ```\n\n    - Kept\n    - Rotated\n",
    body:[paragraph(text("Log"),reference("log"),text(".")),note("log",paragraph(text("Every step.")),{type:"code",language:"sh",value:"pnpm build"},{type:"list",ordered:false,tight:true,children:[{type:"listItem",body:[paragraph(text("Kept"))]},{type:"listItem",body:[paragraph(text("Rotated"))]}]})]},
  {name:"repeated references share one note",source:"One[^n], two[^n].\n\n[^n]: Shared.\n",
    body:[paragraph(text("One"),reference("n"),text(", two"),reference("n"),text(".")),note("n",paragraph(text("Shared.")))]},
  {name:"an undefined reference stays text",source:"No note[^missing] here.\n",body:[paragraph(text("No note[^missing] here."))],diagnostics:["undefined-footnote"]},
  {name:"an unused definition is kept",source:"[^unused]: Spare.\n",body:[note("unused",paragraph(text("Spare.")))],diagnostics:["unused-footnote"]},
  {name:"duplicate definitions are kept in place",source:"See[^d].\n\n[^d]: First.\n\n[^d]: Second *one*.\n",
    body:[paragraph(text("See"),reference("d"),text(".")),note("d",paragraph(text("First."))),note("d",paragraph(text("Second "),{type:"emphasis",value:"one"},text(".")))],diagnostics:["duplicate-footnote"]},
  {name:"labels match case-sensitively",source:"A[^Note].\n\n[^note]: Lower.\n",body:[paragraph(text("A[^Note].")),note("note",paragraph(text("Lower.")))],diagnostics:["undefined-footnote","unused-footnote"]},
  {name:"a label outside the identifier grammar is not a footnote",source:"A[^two words].\n",body:[paragraph(text("A[^two words]."))]},
  {name:"a definition inside a container stays there, and titles can refer to it",source:"::: note [See[^c]]\nBody.\n\n[^c]: Inside.\n:::\n",
    body:[{type:"container",subType:"note",title:{type:"title",children:[text("See"),reference("c")]},body:[paragraph(text("Body.")),note("c",paragraph(text("Inside.")))]}]},
  {name:"a definition starting with code, and an empty definition",source:"C[^c] E[^e]\n\n[^c]: ```js\n    x\n    ```\n\n[^e]:\n",
    body:[paragraph(text("C"),reference("c"),text(" E"),reference("e")),note("c",{type:"code",language:"js",value:"x"}),note("e")]},
];

describe("footnote conformance", () => {
  it.each(cases)("$name", ({source,body,diagnostics = []}) => {
    const seen: Diagnostic[] = [];
    const expected: Document = {type:"document",version:1,body};
    const document = parse(source,{onDiagnostic:diagnostic => seen.push(diagnostic)});
    expect(document).toEqual(expected);
    expect(seen.map(diagnostic => diagnostic.code)).toEqual(diagnostics);
    expect(stringify(document)).toBe(source);
  });
  it("normalizes a definition's spelling without moving it", () => {
    const source = "Intro[^a].\n\n[^a]:   Lazy\ncontinuation.\n\n## Next\n";
    expect(stringify(parse(source))).toBe("Intro[^a].\n\n[^a]: Lazy\n    continuation.\n\n## Next\n");
  });
  it("reads an interrupting definition and keeps it after that paragraph", () => {
    expect(parse("Para\n[^a]: Note.\n\nRef[^a]").body).toEqual([paragraph(text("Para")),note("a",paragraph(text("Note."))),paragraph(text("Ref"),reference("a"))]);
  });
});

describe("footnote writing", () => {
  it("escapes literal text that would refer to a defined note, and only that", () => {
    const document: Document = {type:"document",version:1,body:[paragraph(text("Literal [^a] and [^b]."),reference("a")),note("a",paragraph(text("A.")))]};
    expect(stringify(document)).toBe("Literal \\[^a] and [^b].[^a]\n\n[^a]: A.\n");
    expect(parse(stringify(document))).toEqual(document);
  });
  it("writes an undefined reference and reports that it reads back as text", () => {
    const seen: string[] = [];
    expect(stringify({type:"document",version:1,body:[paragraph(reference("gone"))]},{onDiagnostic:d => seen.push(d.code)})).toBe("[^gone]\n");
    expect(seen).toEqual(["undefined-footnote"]);
  });
  it.each<[string, Document]>([
    ["a definition in inline content",{type:"document",version:1,body:[paragraph(note("a"))]}],
    ["an invalid label",{type:"document",version:1,body:[paragraph(reference("two words"))]}],
    ["a reference ID",{type:"document",version:1,body:[paragraph({...reference("a"),id:"x"}),note("a")]}],
  ])("rejects %s", (_name, document) => {
    expect(() => stringify(document)).toThrow(ConversionError);
  });
});

describe("footnote HTML", () => {
  it("collects notes at the end, numbered by first reference, with every back-link", () => {
    const html = renderHtml(parse("[^report]: Coverage.\n\nBuild[^build], again[^build], report[^report].\n\n[^build]: Tests.\n\n[^build]: Ignored duplicate.\n\n[^spare]: Unused."));
    expect(html).toBe('<p>Build<sup><a href="#fn:build" id="fnref:build" data-footnote-ref>1</a></sup>, again<sup><a href="#fn:build" id="fnref:build:2" data-footnote-ref>1</a></sup>, report<sup><a href="#fn:report" id="fnref:report" data-footnote-ref>2</a></sup>.</p>'
      + '<section data-footnotes aria-label="Footnotes"><ol>'
      + '<li id="fn:build"><p>Tests. <a href="#fnref:build" data-footnote-backref aria-label="Back to reference 1">↩</a> <a href="#fnref:build:2" data-footnote-backref aria-label="Back to reference 1-2">↩<sup>2</sup></a></p></li>'
      + '<li id="fn:report"><p>Coverage. <a href="#fnref:report" data-footnote-backref aria-label="Back to reference 2">↩</a></p></li>'
      + "</ol></section>");
  });
  it("numbers a note referred to by a note after the text's own references", () => {
    const html = renderHtml(parse("A[^x]\n\n[^x]: X cites [^z].\n\nB[^y]\n\n[^y]: Y.\n\n[^z]: Z."));
    expect([...html.matchAll(/<li id="fn:(\w)"/g)].map(match => match[1])).toEqual(["x","y","z"]);
  });
  it("adds a paragraph for back-links after non-paragraph content", () => {
    expect(renderHtml(parse("C[^c].\n\n[^c]: ```js\n    x\n    ```"))).toContain('<li id="fn:c"><pre><code class="language-js">x</code></pre><p><a href="#fnref:c" data-footnote-backref aria-label="Back to reference 1">↩</a></p></li>');
  });
  it("renders an unresolved reference as its text and omits an empty notes section", () => {
    expect(renderHtml(parse("A[^missing].\n\n[^spare]: Unused."))).toBe("<p>A[^missing].</p>");
    expect(renderHtml({type:"document",version:1,body:[paragraph(reference("gone"))]})).toBe("<p>[^gone]</p>");
  });
});
