import { describe, expect, it } from "vitest";
import { ConversionError, parse, stringify, type Diagnostic, type Document, type Node, type Syntax } from "../src/index.js";
import { renderHtml } from "../src/render.js";
import { fresh, semantic } from "./semantic.js";

// Definition lists as the Expressive Markdown specification states them:
// https://nextwebwg.org/expressive-markdown/parsing#definition-lists
const term = (value: string): Node => ({type:"definitionTerm",value});
const paragraph = (value: string): Node => ({type:"paragraph",value});
const description = (...body: Node[]): Node => ({type:"definitionDescription",body});
const list = (...children: Node[]): Node => ({type:"definitionList",children});
const lines = (...values: string[]): Node => ({type:"paragraph",children:values.flatMap((value,index)=>[...(index ? [{type:"softBreak"}]:[]),{type:"text",value}])});
const read = (source: string, syntax: Syntax = "standard") => {
  const codes: string[] = [];
  const document = parse(source,{syntax,onDiagnostic:diagnostic => codes.push(diagnostic.code)});
  return {body:semantic(document.body),codes,document};
};

describe("where a definition starts", () => {
  // Every row of the specification's source → reading table.
  const rows: [string, string, Node[]][] = [
    ["a term line and a marker line","Term\n: Description",[list(term("Term"),description(paragraph("Description")))]],
    ["a marker without a following space","Term\n:Description",[lines("Term",":Description")]],
    ["an inline directive","Term\n:kw[must] apply",[{type:"paragraph",children:[{type:"text",value:"Term"},{type:"softBreak"},{type:"inline",subType:"kw",value:"must"},{type:"text",value:" apply"}]}]],
    ["a leaf directive","Term\n::page-break",[paragraph("Term"),{type:"leaf",subType:"page-break"}]],
    ["a colon fence","Term\n:::",[paragraph("Term"),{type:"strayFence",value:":::"}]],
    ["an escaped colon","Term\n\\: Description",[lines("Term",": Description")]],
    ["a tilde","Term\n~ Description",[lines("Term","~ Description")]],
    ["a later paragraph line","First line\nTerm\n: Description",[lines("First line","Term",": Description")]],
    ["a blank line before the marker","Term\n\n: Description",[paragraph("Term"),paragraph(": Description")]],
    ["a heading","## Term\n: Description",[{type:"heading",level:2,value:"Term"},paragraph(": Description")]],
    ["an unindented line after a list item","- Term\n: Description",[{type:"list",ordered:false,tight:true,children:[{type:"listItem",body:[paragraph("Term")]}]},paragraph(": Description")]],
    ["a marker indented under a list item","- Term\n  : Description",[{type:"list",ordered:false,tight:true,children:[{type:"listItem",body:[list(term("Term"),description(paragraph("Description")))]}]}]],
    ["a quote","> Term\n> : Description",[{type:"blockquote",body:[list(term("Term"),description(paragraph("Description")))]}]],
    ["an alert","> [!note] Term\n> : Description",[{type:"container",subType:"note",spelling:"alert",title:{type:"title",value:"Term"},body:[paragraph(": Description")]}]],
    ["a container header","::: note [Term]\n: Description\n:::",[{type:"container",subType:"note",title:{type:"title",value:"Term"},body:[paragraph(": Description")]}]],
    ["a line block","| Term\n: Description",[{type:"lineBlock",value:"Term"},paragraph(": Description")]],
    ["a marker indented under a description","Term\n: Description\n  : More",[list(term("Term"),description(list(term("Description"),description(paragraph("More")))))]],
    ["an unindented line after a description","Term\n: Description\ncontinued",[list(term("Term"),description(paragraph("Description"))),paragraph("continued")]],
  ];
  it.each(rows)("%s", (_name, source, body) => {
    expect(read(source).body).toEqual(body);
    // `compatible` keeps CommonMark's lazy continuation in a list item; every other row reads the same.
    if(source !== "- Term\n: Description") expect(read(source,"compatible").body).toEqual(body);
    else expect(read(source,"compatible").body).toEqual([{type:"list",ordered:false,tight:true,children:[{type:"listItem",body:[lines("Term",": Description")]}]}]);
  });
  it("reads a definition list in every block context", () => {
    const inner = list(term("T"),description(paragraph("d")));
    expect(read("::: note\nT\n: d\n:::").body).toEqual([{type:"container",subType:"note",body:[inner]}]);
    expect(read("Ref[^n]\n\n[^n]: Note\n\n    T\n    : d").body[1]).toEqual({type:"footnoteDefinition",label:"n",body:[paragraph("Note"),inner]});
    expect(read("::: table\n\n- Name: x\n  Value:\n    T\n    : d\n\n:::").body[0]!.children![1]!.children![1]).toEqual({type:"tableCell",body:[inner]});
  });
});

describe("definition lists", () => {
  it("read the specification's glossary, with its AST and HTML", () => {
    const {body,document} = read("Container\n: A block between colon fences, such as a callout.\n\nFence\n: A line of three or more colons around a container.\n: A line of backticks or tildes around code.\n");
    expect(body).toEqual([list(
      term("Container"),description(paragraph("A block between colon fences, such as a callout.")),
      term("Fence"),description(paragraph("A line of three or more colons around a container.")),description(paragraph("A line of backticks or tildes around code.")),
    )]);
    expect(renderHtml(document)).toBe("<dl><dt>Container</dt><dd>A block between colon fences, such as a callout.</dd><dt>Fence</dt><dd>A line of three or more colons around a container.</dd><dd>A line of backticks or tildes around code.</dd></dl>");
  });
  it("read descriptions as list items are read, with blank-line-separated blocks loose", () => {
    const {body,document} = read("Fence\n: A line of colons around a container.\n\n  Nested containers use a longer outer fence.\n");
    expect(body).toEqual([list(term("Fence"),{...description(paragraph("A line of colons around a container."),paragraph("Nested containers use a longer outer fence.")),tight:false})]);
    expect(renderHtml(document)).toBe("<dl><dt>Fence</dt><dd><p>A line of colons around a container.</p><p>Nested containers use a longer outer fence.</p></dd></dl>");
  });
  it("continue across blank lines and continuation lines, as the parsing example shows", () => {
    const {body,document} = read("Term\n: First description,\n  continued.\n: Second description.\n\nNext term\n: Its description.\n");
    expect(body).toEqual([list(term("Term"),description(lines("First description,","continued.")),description(paragraph("Second description.")),term("Next term"),description(paragraph("Its description.")))]);
    expect(renderHtml(document)).toBe("<dl><dt>Term</dt><dd>First description,\ncontinued.</dd><dd>Second description.</dd><dt>Next term</dt><dd>Its description.</dd></dl>");
  });
  it("give `:` alone an empty description, and read other spellings by their indentation", () => {
    const {body,document} = read("Term\n:\n:   Spaced\n    by four\n:\tTabbed\n\n\n\nNext\n  : Indented\nAfter\n: x");
    expect(body).toEqual([list(term("Term"),description(),description(lines("Spaced","by four")),description(paragraph("Tabbed")),term("Next"),description(paragraph("Indented")),term("After"),description(paragraph("x")))]);
    expect(renderHtml(document)).toBe("<dl><dt>Term</dt><dd></dd><dd>Spaced\nby four</dd><dd>Tabbed</dd><dt>Next</dt><dd>Indented</dd><dt>After</dt><dd>x</dd></dl>");
  });
  it("loosen neither a list item nor a description with the blank lines between their groups", () => {
    const groups = list(term("A"),description(paragraph("a")),term("B"),description(paragraph("b")));
    for(const syntax of ["standard","compatible"] as const) {
      expect(read("- A\n  : a\n\n  B\n  : b",syntax).body).toEqual([{type:"list",ordered:false,tight:true,children:[{type:"listItem",body:[groups]}]}]);
      expect(read("T\n: A\n  : a\n\n  B\n  : b",syntax).body).toEqual([list(term("T"),description(groups))]);
    }
  });
  it("hold any blocks in a description, and inline Markdown in a term", () => {
    expect(read("`code` *term*\n: ```js\n  x\n  ```\n  - a\n  - b").body).toEqual([list(
      {type:"definitionTerm",children:[{type:"inlineCode",value:"code"},{type:"text",value:" "},{type:"emphasis",value:"term"}]},
      description({type:"code",language:"js",value:"x"},{type:"list",ordered:false,tight:true,children:[{type:"listItem",body:[paragraph("a")]},{type:"listItem",body:[paragraph("b")]}]}),
    )]);
  });
});

describe("writing definition lists", () => {
  // Each source writes back byte for byte, in both syntaxes.
  const spellings = [
    "Term\n: Description\n",
    "Term\n: First\n  continued.\n: Second\n\nNext\n: Its description.\n",
    "Term\n:\n",
    "Fence\n: One.\n\n  Two.\n",
    "Term\n:   Pandoc style\n    continuation\n",
    "A\n: a\nB\n: b\n\n\nC\n  : c\n:\td\n",
    "> Quote\n> : d\n",
    "- Item\n  : d\n- Next\n  : e\n",
    "Outer\n: Inner\n  : nested\n",
    "Outer\n: A\n  : a\n\n  B\n  : b\n",
  ];
  it.each(spellings)("writes %j back exactly", source => {
    for(const syntax of ["standard","compatible"] as const) {
      const document = parse(source,{syntax});
      expect(stringify(document,{syntax})).toBe(source);
      expect(stringify(fresh(document),{syntax})).toBe(source);
      expect(parse(stringify(fresh(document),{syntax}),{syntax})).toEqual(document);
    }
  });
  it("records only spellings other than the preferred form, and writes the preferred form for new content", () => {
    expect(parse(spellings[1]!).body[0]!.source).toBeUndefined();
    expect(parse("Term\n:   x\n").body[0]!.source).toEqual({markdown:"Term\n:   x"});
    const document: Document = {type:"document",version:1,body:[
      list(term("Term"),description(lines("First","continued.")),description(),term("Next"),{...description(paragraph("One."),paragraph("Two.")),tight:false}),
    ]};
    const written = stringify(document);
    expect(written).toBe("Term\n: First\n  continued.\n:\n\nNext\n: One.\n\n  Two.\n");
    expect(semantic(parse(written))).toEqual(document);
    expect(stringify(parse("Term\n:   x\n    y\n\n\nNext\n  : z"),{preferredForms:true})).toBe("Term\n: x\n  y\n\nNext\n: z\n");
  });
  it("keeps a recorded spelling while it reads as the list, and writes an edited list in the preferred form", () => {
    const document = parse("# Title\n\nTerm\n:   x\n");
    document.body[0] = {type:"heading",level:1,value:"Renamed"};
    expect(stringify(document)).toBe("# Renamed\n\nTerm\n:   x\n");
    document.body[1]!.children![0] = term("Edited");
    expect(stringify(document)).toBe("# Renamed\n\nEdited\n: x\n");
  });
  it("protects a colon that would start a marker line, and a term that would start another block", () => {
    const document: Document = {type:"document",version:1,body:[
      lines("Term",": not a description"),
      list(term("# Heading"),description(),term(": colon"),description(paragraph("x"))),
      paragraph(": after the list"),
      lines("Later","line",": stays"),
    ]};
    const written = stringify(document);
    expect(written).toBe("Term\n\\: not a description\n\n\\# Heading\n:\n\n\\: colon\n: x\n\n\\: after the list\n\nLater\nline\n: stays\n");
    expect(semantic(parse(written))).toEqual(document);
  });
  it.each<[string, Node[]]>([
    ["an empty list",[list()]],
    ["a list starting with a description",[list(description(),term("T"),description())]],
    ["a list ending with a term",[list(term("T"),description(),term("U"))]],
    ["two terms above one description",[list(term("T"),term("U"),description())]],
    ["an ID on a list",[{...list(term("T"),description()),id:"glossary"}]],
    ["attributes on a term",[list({...term("T"),attributes:{class:"x"}},description())]],
    ["a term holding a break",[list({type:"definitionTerm",children:[{type:"text",value:"a"},{type:"softBreak"},{type:"text",value:"b"}]},description())]],
    ["adjacent lists",[list(term("T"),description()),list(term("U"),description())]],
  ])("reports %s as an unsupported conversion", (_name, body) => {
    expect(() => stringify({type:"document",version:1,body})).toThrow(ConversionError);
  });
});

describe("definition list diagnostics", () => {
  it.each([
    ["a later paragraph line starting with :","First\nTerm\n: Description"],
    ["a later paragraph line starting with ~","Term\n~ Description"],
    ["a later paragraph line holding only :","Term\nmore\n:"],
    ["a : paragraph after a one-line paragraph and a blank line","Term\n\n: Description"],
    ["a ~ paragraph after a one-line paragraph and a blank line","Term\n\n~ Description"],
  ])("warn about %s", (_name, source) => {
    for(const syntax of ["standard","compatible"] as const) expect(read(source,syntax).codes).toEqual(["unattached-definition-marker"]);
  });
  it.each([
    ["a definition list","Term\n: Description"],
    ["an escaped marker","Term\n\\: Description"],
    ["a : paragraph after a two-line paragraph","One\nTwo\n\n: Three"],
    ["a colon without a following space","Term\n:Description"],
  ])("stay quiet for %s", (_name, source) => {
    expect(read(source).codes).toEqual([]);
  });
  it("warn about mixed tabs and spaces in a description's indentation", () => {
    const seen: Diagnostic[] = [];
    parse("Term\n  : one\n\ttwo",{onDiagnostic:diagnostic => seen.push(diagnostic)});
    expect(seen.map(diagnostic => diagnostic.code)).toEqual(["mixed-indentation"]);
  });
});
