import { describe, expect, it } from "vitest";
import { ConversionError, parse, stringify, type Diagnostic, type Document, type Node } from "../src/index.js";
import { renderHtml } from "../src/render.js";

const reference = (label: string): Node => ({type:"footnoteReference",label});
const note = (label: string, ...body: Node[]): Node => ({type:"footnoteDefinition",label,body});
const paragraph = (...children: Node[]): Node => children.every(child => child.type === "text") ? {type:"paragraph",value:children.map(child => child.value).join("")} : {type:"paragraph",children};
const text = (value: string): Node => ({type:"text",value});

// Conformance compares content; provenance is checked separately below.
const semantic = (document: Document): Document => document.footnotes ? {...document,footnotes:document.footnotes.map(({position:_position,source:_source,...note}) => note)} : document;

interface Case { name: string; source: string; body: Node[]; footnotes?: Node[]; canonical: string; diagnostics?: string[] }
const cases: Case[] = [
  {name:"references and definitions",source:"Tables[^tables] and tasks[^1].\n\n[^tables]: GFM tables.\n\n[^1]: Checkboxes.",
    body:[paragraph(text("Tables"),reference("tables"),text(" and tasks"),reference("1"),text("."))],
    footnotes:[note("tables",paragraph(text("GFM tables."))),note("1",paragraph(text("Checkboxes.")))],
    canonical:"Tables[^tables] and tasks[^1].\n\n[^tables]: GFM tables.\n\n[^1]: Checkboxes.\n"},
  {name:"definitions move to the end in first-reference order",source:"[^b]: Second.\n\n[^a]: First.\n\nA[^a] and b[^b].",
    body:[paragraph(text("A"),reference("a"),text(" and b"),reference("b"),text("."))],
    footnotes:[note("a",paragraph(text("First."))),note("b",paragraph(text("Second.")))],
    canonical:"A[^a] and b[^b].\n\n[^a]: First.\n\n[^b]: Second.\n"},
  {name:"indented continuation holds several blocks",source:"Log[^log].\n\n[^log]: Every step.\n\n    ```sh\n    pnpm build\n    ```\n\n    - Kept\n    - Rotated",
    body:[paragraph(text("Log"),reference("log"),text("."))],
    footnotes:[note("log",paragraph(text("Every step.")),{type:"code",language:"sh",value:"pnpm build"},{type:"list",ordered:false,tight:true,children:[{type:"listItem",body:[paragraph(text("Kept"))]},{type:"listItem",body:[paragraph(text("Rotated"))]}]})],
    canonical:"Log[^log].\n\n[^log]: Every step.\n\n    ```sh\n    pnpm build\n    ```\n\n    - Kept\n    - Rotated\n"},
  {name:"repeated references share one note",source:"One[^n], two[^n].\n\n[^n]: Shared.",
    body:[paragraph(text("One"),reference("n"),text(", two"),reference("n"),text("."))],footnotes:[note("n",paragraph(text("Shared.")))],
    canonical:"One[^n], two[^n].\n\n[^n]: Shared.\n"},
  {name:"a note's reference joins the list after the body's",source:"A[^x] B[^y]\n\n[^y]: Y cites [^z].\n\n[^z]: Z.\n\n[^x]: X.",
    body:[paragraph(text("A"),reference("x"),text(" B"),reference("y"))],
    footnotes:[note("x",paragraph(text("X."))),note("y",paragraph(text("Y cites "),reference("z"),text("."))),note("z",paragraph(text("Z.")))],
    canonical:"A[^x] B[^y]\n\n[^x]: X.\n\n[^y]: Y cites [^z].\n\n[^z]: Z.\n"},
  {name:"an undefined reference stays text",source:"No note[^missing] here.",body:[paragraph(text("No note[^missing] here."))],
    canonical:"No note[^missing] here.\n",diagnostics:["undefined-footnote"]},
  {name:"an unused definition stays after referenced notes",source:"[^unused]: Spare.\n\nUsed[^u].\n\n[^u]: Note.",
    body:[paragraph(text("Used"),reference("u"),text("."))],footnotes:[note("u",paragraph(text("Note."))),note("unused",paragraph(text("Spare.")))],
    canonical:"Used[^u].\n\n[^u]: Note.\n\n[^unused]: Spare.\n",diagnostics:["unused-footnote"]},
  {name:"the first duplicate definition wins; later ones stay text in place",source:"See[^d].\n\n[^d]: First.\n\n[^d]: Second *one*.",
    body:[paragraph(text("See"),reference("d"),text(".")),paragraph(text("[^d]: Second "),{type:"emphasis",value:"one"},text("."))],footnotes:[note("d",paragraph(text("First.")))],
    canonical:"See[^d].\n\n\\[^d]: Second *one*.\n\n[^d]: First.\n",diagnostics:["duplicate-footnote"]},
  {name:"labels match case-sensitively",source:"A[^Note].\n\n[^note]: Lower.",body:[paragraph(text("A[^Note]."))],footnotes:[note("note",paragraph(text("Lower.")))],
    canonical:"A[^Note].\n\n[^note]: Lower.\n",diagnostics:["undefined-footnote","unused-footnote"]},
  {name:"a label outside the identifier grammar is not a footnote",source:"A[^two words].",body:[paragraph(text("A[^two words]."))],canonical:"A[^two words].\n"},
  {name:"definitions inside containers belong to the document",source:"::: note [See[^c]]\nBody.\n\n[^c]: Inside.\n:::",
    body:[{type:"container",subType:"note",title:{type:"title",children:[text("See"),reference("c")]},body:[paragraph(text("Body."))]}],footnotes:[note("c",paragraph(text("Inside.")))],
    canonical:"::: note [See[^c]]\nBody.\n:::\n\n[^c]: Inside.\n"},
  {name:"a definition starting with code and an empty definition",source:"C[^c] E[^e]\n\n[^c]: ```js\n    x\n    ```\n\n[^e]:",
    body:[paragraph(text("C"),reference("c"),text(" E"),reference("e"))],footnotes:[note("c",{type:"code",language:"js",value:"x"}),note("e")],
    canonical:"C[^c] E[^e]\n\n[^c]: ```js\n    x\n    ```\n\n[^e]:\n"},
];

describe("footnote conformance", () => {
  it.each(cases)("$name", ({source,body,footnotes,canonical,diagnostics = []}) => {
    const seen: Diagnostic[] = [];
    const expected: Document = {type:"document",version:1,body,...(footnotes ? {footnotes}:{})};
    const document = parse(source,{onDiagnostic:diagnostic => seen.push(diagnostic)});
    expect(semantic(document)).toEqual(expected);
    expect(seen.map(diagnostic => diagnostic.code)).toEqual(diagnostics);
    const output = stringify(document);
    expect(output).toBe(canonical);
    expect(semantic(parse(output))).toEqual(expected);
    expect(stringify(parse(output))).toBe(output);
  });
});

describe("footnote writing", () => {
  it("escapes literal text that would refer to a defined note, and only that", () => {
    const document: Document = {type:"document",version:1,body:[paragraph(text("Literal [^a] and [^b]."),reference("a"))],footnotes:[note("a",paragraph(text("A.")))]};
    expect(stringify(document)).toBe("Literal \\[^a] and [^b].[^a]\n\n[^a]: A.\n");
    expect(semantic(parse(stringify(document)))).toEqual(document);
  });
  it("writes an undefined reference and reports that it reads back as text", () => {
    const seen: string[] = [];
    expect(stringify({type:"document",version:1,body:[paragraph(reference("gone"))]},{onDiagnostic:d => seen.push(d.code)})).toBe("[^gone]\n");
    expect(seen).toEqual(["undefined-footnote"]);
  });
  it.each<[string, Document]>([
    ["a definition in a body",{type:"document",version:1,body:[note("a",paragraph(text("A.")))]}],
    ["a duplicate label",{type:"document",version:1,body:[],footnotes:[note("a"),note("a")]}],
    ["an invalid label",{type:"document",version:1,body:[paragraph(reference("two words"))]}],
    ["a reference ID",{type:"document",version:1,body:[paragraph({...reference("a"),id:"x"})],footnotes:[note("a")]}],
    ["a non-definition note",{type:"document",version:1,body:[],footnotes:[paragraph(text("A."))]}],
  ])("rejects %s", (_name, document) => {
    expect(() => stringify(document)).toThrow(ConversionError);
  });
});

describe("footnote provenance", () => {
  const source = "Intro[^a].\n\n[^a]: Note A.\n\n    More of A.\n\n## Next\n\nMore[^b].\n\n[^b]: Note B.\n";
  it("records each definition's original range and Markdown", () => {
    const [a, b] = parse(source).footnotes!;
    expect(a).toMatchObject({position:{start:{line:3,column:1,offset:12},end:{line:5,column:15,offset:41}},source:{markdown:"[^a]: Note A.\n\n    More of A.",bodyIndex:1}});
    expect(b?.source).toEqual({markdown:"[^b]: Note B.",bodyIndex:3});
    expect(parse("\uFEFF---\r\ntitle: T\r\n---\r\nA[^a]\r\n\r\n[^a]: N").footnotes?.[0]?.position)
      .toEqual({start:{line:6,column:1,offset:30},end:{line:6,column:8,offset:37}});
  });
  it("writes unedited notes back in place when preserving source, and at the end canonically", () => {
    const document = parse(source);
    expect(stringify(document,{preserveSource:true})).toBe(source);
    expect(stringify(document)).toBe("Intro[^a].\n\n## Next\n\nMore[^b].\n\n[^a]: Note A.\n\n    More of A.\n\n[^b]: Note B.\n");
  });
  it("moves only an edited note to the canonical place", () => {
    const document = parse(source);
    document.footnotes![1]!.body = [{type:"paragraph",value:"Edited B."}];
    expect(stringify(document,{preserveSource:true})).toBe("Intro[^a].\n\n[^a]: Note A.\n\n    More of A.\n\n## Next\n\nMore[^b].\n\n[^b]: Edited B.\n");
    document.body.splice(1);
    expect(stringify(document,{preserveSource:true})).toBe("Intro[^a].\n\n[^a]: Note A.\n\n    More of A.\n\n[^b]: Edited B.\n");
  });
});

describe("footnote HTML", () => {
  it("numbers by first reference and links every reference back", () => {
    const html = renderHtml(parse("Build[^build], again[^build], report[^report].\n\n[^report]: Coverage.\n\n[^build]: Tests.\n\n[^spare]: Unused."));
    expect(html).toBe('<p>Build<sup><a href="#fn:build" id="fnref:build" data-footnote-ref>1</a></sup>, again<sup><a href="#fn:build" id="fnref:build:2" data-footnote-ref>1</a></sup>, report<sup><a href="#fn:report" id="fnref:report" data-footnote-ref>2</a></sup>.</p>'
      + '<section data-footnotes aria-label="Footnotes"><ol>'
      + '<li id="fn:build"><p>Tests. <a href="#fnref:build" data-footnote-backref aria-label="Back to reference 1">↩</a> <a href="#fnref:build:2" data-footnote-backref aria-label="Back to reference 1-2">↩<sup>2</sup></a></p></li>'
      + '<li id="fn:report"><p>Coverage. <a href="#fnref:report" data-footnote-backref aria-label="Back to reference 2">↩</a></p></li>'
      + "</ol></section>");
  });
  it("adds a paragraph for back-links after non-paragraph content", () => {
    expect(renderHtml(parse("C[^c].\n\n[^c]: ```js\n    x\n    ```"))).toContain('<li id="fn:c"><pre><code class="language-js">x</code></pre><p><a href="#fnref:c" data-footnote-backref aria-label="Back to reference 1">↩</a></p></li>');
  });
  it("renders an unresolved reference as its text and omits an empty notes section", () => {
    expect(renderHtml(parse("A[^missing].\n\n[^spare]: Unused."))).toBe("<p>A[^missing].</p>");
    expect(renderHtml({type:"document",version:1,body:[paragraph(reference("gone"))]})).toBe("<p>[^gone]</p>");
  });
});
