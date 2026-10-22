import { describe, expect, it } from "vitest";
import { parse, stringify, type Diagnostic, type Document, type Node } from "../src/index.js";
import { semantic } from "./semantic.js";

// Original implementation fixtures organized by https://github.github.com/gfm/.
// Assert our document AST, not GFM's HTML: Expressmark does not render HTML and
// applies Expressive Markdown's extensions and safe-HTML policy over that base.
interface Case { name: string; source: string; body: Node[] }
const paragraph = (value: string): Node => ({type:"paragraph",value});
const text = (value: string): Node => ({type:"text",value});
const item = (value: string): Node => ({type:"listItem",body:[paragraph(value)]});
const cell = (value: string, header = false): Node => ({type:"tableCell",value,...(header ? {header:true}:{})});
const row = (...children: Node[]): Node => ({type:"tableRow",children});

function cases(section: string, examples: Case[]): void {
  describe(section, () => {
    it.each(examples)("$name", ({source,body}) => {
      const diagnostics: Diagnostic[] = [];
      const expected: Document = {type:"document",version:1,body};
      const document = parse(source,{onDiagnostic:diagnostic=>diagnostics.push(diagnostic)});
      expect(semantic(document)).toEqual(expected);
      const output = stringify(document,{onDiagnostic:diagnostic=>diagnostics.push(diagnostic)});
      expect(parse(output,{onDiagnostic:diagnostic=>diagnostics.push(diagnostic)})).toEqual(document);
      expect(stringify(parse(output))).toBe(output);
      expect(diagnostics).toEqual([]);
    });
  });
}

cases("GFM 4: leaf blocks", [
  {name:"ATX headings accept closing markers",source:"### Release notes ###",body:[{type:"heading",level:3,value:"Release notes"}]},
  {name:"ATX headings require whitespace after the marker",source:"###Release",body:[paragraph("###Release")]},
  {name:"ATX headings stop at level six",source:"####### Release",body:[paragraph("####### Release")]},
  {name:"setext equals heading",source:"Release notes\n=====",body:[{type:"heading",level:1,value:"Release notes"}]},
  {name:"setext dash heading takes precedence over a thematic break",source:"Release notes\n-----",body:[{type:"heading",level:2,value:"Release notes"}]},
  ...["* * *","_ _ _","- - -"].map(source=>({name:`thematic break ${source}`,source,body:[{type:"horizontalRule"}]})),
  {name:"indented code retains literal Markdown and blank lines",source:"    **literal**\n\n    <span>code</span>",body:[{type:"code",value:"**literal**\n\n<span>code</span>"}]},
  {name:"tab indentation opens a code block",source:"\t:chip[Literal]",body:[{type:"code",value:":chip[Literal]"}]},
  {name:"backtick fence retains language and literal extension syntax",source:"```js\n:chip[Literal]\n<script>code</script>\n```",body:[{type:"code",language:"js",value:":chip[Literal]\n<script>code</script>"}]},
  {name:"tilde fence can contain shorter backtick fences",source:"~~~txt\n```\n~~~",body:[{type:"code",language:"txt",value:"```"}]},
  {name:"a shorter fence does not close a code block",source:"````\none\n```\ntwo\n````",body:[{type:"code",value:"one\n```\ntwo"}]},
  {name:"an unclosed code fence extends to end of input",source:"```\nunfinished",body:[{type:"code",value:"unfinished"}]},
  {name:"blank lines separate paragraphs",source:"First paragraph.\n\n\nSecond paragraph.",body:[paragraph("First paragraph."),paragraph("Second paragraph.")]},
  {name:"CRLF and CR normalize to soft breaks",source:"First\r\nsecond\rthird",body:[{type:"paragraph",children:[text("First"),{type:"softBreak"},text("second"),{type:"softBreak"},text("third")]}]},
]);

cases("GFM 4.10: tables", [
  {name:"table headers and data cells",source:"| Planet | Moon |\n| --- | --- |\n| Earth | Luna |",body:[{type:"table",children:[row(cell("Planet",true),cell("Moon",true)),row(cell("Earth"),cell("Luna"))]}]},
  {name:"outer pipes are optional",source:"Planet | Moon\n--- | ---\nEarth | Luna",body:[{type:"table",children:[row(cell("Planet",true),cell("Moon",true)),row(cell("Earth"),cell("Luna"))]}]},
  {name:"logical start center end and default column alignment",source:"| A | B | C | D |\n| :--- | :---: | ---: | --- |\n| a | b | c | d |",body:[{type:"table",align:["start","center","end",null],children:[row(cell("A",true),cell("B",true),cell("C",true),cell("D",true)),row(cell("a"),cell("b"),cell("c"),cell("d"))]}]},
  {name:"short body rows pad and long rows truncate",source:"A | B\n--- | ---\none\ntwo | three | discarded",body:[{type:"table",children:[row(cell("A",true),cell("B",true)),row(cell("one"),cell("")),row(cell("two"),cell("three"))]}]},
  {name:"header-only table",source:"A | B\n--- | ---",body:[{type:"table",children:[row(cell("A",true),cell("B",true))]}]},
  {name:"inline formatting and escaped pipes stay inside cells",source:"| Label | Value |\n| --- | --- |\n| **bold** | `a\\|b` |",body:[{type:"table",children:[row(cell("Label",true),cell("Value",true)),row({type:"tableCell",children:[{type:"strong",value:"bold"}]},{type:"tableCell",children:[{type:"inlineCode",value:"a|b"}]})]}]},
  {name:"a block quote terminates a table",source:"A | B\n--- | ---\na | b\n> After",body:[{type:"table",children:[row(cell("A",true),cell("B",true)),row(cell("a"),cell("b"))]},{type:"blockquote",body:[paragraph("After")]}]},
  {name:"mismatched header and delimiter widths stay ordinary text",source:"A | B\n--- | --- | ---",body:[{type:"paragraph",children:[text("A | B"),{type:"softBreak"},text("--- | --- | ---")]}]},
]);

cases("GFM 5: container blocks and task lists", [
  {name:"lazy block quote continuation",source:"> First\ncontinued",body:[{type:"blockquote",body:[{type:"paragraph",children:[text("First"),{type:"softBreak"},text("continued")]}]}]},
  {name:"nested block quotes",source:"> > Nested",body:[{type:"blockquote",body:[{type:"blockquote",body:[paragraph("Nested")]}]}]},
  {name:"tight unordered list",source:"- Alpha\n- Beta",body:[{type:"list",ordered:false,tight:true,children:[item("Alpha"),item("Beta")]}]},
  {name:"loose unordered list",source:"- Alpha\n\n- Beta",body:[{type:"list",ordered:false,tight:false,children:[item("Alpha"),item("Beta")]}]},
  {name:"ordered list start and parenthesis delimiter",source:"7) Alpha\n8) Beta",body:[{type:"list",ordered:true,start:7,tight:true,children:[item("Alpha"),item("Beta")]}]},
  {name:"nested lists retain item boundaries",source:"- Outer\n  - Inner\n- Next",body:[{type:"list",ordered:false,tight:true,children:[{type:"listItem",body:[paragraph("Outer"),{type:"list",ordered:false,tight:true,children:[item("Inner")]}]},item("Next")]}]},
  {name:"a loose inner list does not loosen the outer list",source:"- Outer\n  - Inner one\n\n  - Inner two\n- Next",body:[{type:"list",ordered:false,tight:true,children:[{type:"listItem",body:[paragraph("Outer"),{type:"list",ordered:false,tight:false,children:[item("Inner one"),item("Inner two")]}]},item("Next")]}]},
  {name:"nested ordered lists retain item boundaries",source:"- Outer\n  1. Inner\n- Next",body:[{type:"list",ordered:false,tight:true,children:[{type:"listItem",body:[paragraph("Outer"),{type:"list",ordered:true,tight:true,children:[item("Inner")]}]},item("Next")]}]},
  {name:"unordered task list accepts lower and upper case checks",source:"- [ ] Pending\n- [x] Complete\n- [X] Verified",body:[{type:"list",ordered:false,tight:true,children:[{...item("Pending"),checked:false},{...item("Complete"),checked:true},{...item("Verified"),checked:true}]}]},
  {name:"ordered task list",source:"1. [x] Complete\n2. [ ] Pending",body:[{type:"list",ordered:true,tight:true,children:[{...item("Complete"),checked:true},{...item("Pending"),checked:false}]}]},
  {name:"task marker is special only in a list item",source:"[x] Ordinary paragraph",body:[paragraph("[x] Ordinary paragraph")]},
  {name:"invalid and escaped task markers remain literal",source:"- [y] Other\n- [x]No space\n- \\[x] Escaped",body:[{type:"list",ordered:false,tight:true,children:[item("[y] Other"),item("[x]No space"),item("[x] Escaped")]}]},
]);

cases("GFM 6: escapes, entities, code and formatting", [
  {name:"escaped punctuation is literal",source:"\\*literal\\* and \\[brackets\\]",body:[paragraph("*literal* and [brackets]")]},
  {name:"escaped bullet marker stays paragraph text",source:"\\- Literal bullet",body:[paragraph("- Literal bullet")]},
  {name:"escaped ordered marker stays paragraph text",source:"1\\. Literal number",body:[paragraph("1. Literal number")]},
  {name:"escaped parenthesis marker stays paragraph text",source:"2\\) Literal number",body:[paragraph("2) Literal number")]},
  {name:"numbered heading text stays in its heading",source:"## 1. Introduction",body:[{type:"heading",level:2,value:"1. Introduction"}]},
  {name:"named decimal and hex character references decode",source:"&copy; &#169; &#x1F680; &amp;",body:[paragraph("© © 🚀 &")]},
  {name:"entities and Markdown remain literal inside code spans",source:"`&copy; **literal** :chip[Code]`",body:[{type:"paragraph",children:[{type:"inlineCode",value:"&copy; **literal** :chip[Code]"}]}]},
  {name:"code spans support embedded backticks",source:"`` a`b ``",body:[{type:"paragraph",children:[{type:"inlineCode",value:"a`b"}]}]},
  {name:"code span line endings normalize to spaces",source:"`one\ntwo`",body:[{type:"paragraph",children:[{type:"inlineCode",value:"one two"}]}]},
  {name:"an all-space code span keeps its spaces",source:"`   `",body:[{type:"paragraph",children:[{type:"inlineCode",value:"   "}]}]},
  {name:"emphasis and strong emphasis",source:"*soft* and __strong__",body:[{type:"paragraph",children:[{type:"emphasis",value:"soft"},text(" and "),{type:"strong",value:"strong"}]}]},
  {name:"intraword underscores remain literal",source:"release_candidate_name",body:[paragraph("release_candidate_name")]},
  {name:"strikethrough retains inline formatting",source:"~~old *draft*~~",body:[{type:"paragraph",children:[{type:"delete",children:[text("old "),{type:"emphasis",value:"draft"}]}]}]},
  {name:"strikethrough can span a soft break",source:"~~old\ndraft~~",body:[{type:"paragraph",children:[{type:"delete",children:[text("old"),{type:"softBreak"},text("draft")]}]}]},
  {name:"strikethrough does not cross a paragraph boundary",source:"~~old\n\ndraft~~",body:[paragraph("~~old"),paragraph("draft~~")]},
  {name:"two trailing spaces produce a hard break",source:"First  \nsecond",body:[{type:"paragraph",children:[text("First"),{type:"break"},text("second")]}]},
  {name:"a trailing backslash produces a hard break",source:"First\\\nsecond",body:[{type:"paragraph",children:[text("First"),{type:"break"},text("second")]}]},
]);

cases("Expressive precedence over the GFM base", [
  {name:"leading-pipe lines preserve literal list markers",source:"| - Literal bullet\n| 1. Literal number",body:[{type:"lineBlock",children:[text("- Literal bullet"),{type:"break"},text("1. Literal number")]}]},
  {name:"a leading-pipe line without a table delimiter remains a line block",source:"| A | B |",body:[{type:"lineBlock",value:"A | B |"}]},
  {name:"safe inline HTML becomes structured formatting",source:"Read <em>carefully</em>.",body:[{type:"paragraph",children:[text("Read "),{type:"emphasis",value:"carefully"},text(".")]}]},
  {name:"safe block HTML becomes a structured paragraph",source:"<p>Read <strong>carefully</strong>.</p>",body:[{type:"paragraph",children:[text("Read "),{type:"strong",value:"carefully"},text(".")]}]},
]);

cases("GFM 6: links, images and autolinks", [
  {name:"inline link with a title and formatted label",source:'[Read **this**](https://example.com/guide "Guide")',body:[{type:"paragraph",children:[{type:"link",url:"https://example.com/guide",title:"Guide",children:[text("Read "),{type:"strong",value:"this"}]}]}]},
  {name:"balanced parentheses in a link destination",source:"[API](https://example.com/api(v2))",body:[{type:"paragraph",children:[{type:"link",url:"https://example.com/api(v2)",value:"API"}]}]},
  {name:"full reference link keeps its label and a later definition stays in place",source:'[Guide][DOC]\n\n[doc]: /guide "Read me"',body:[{type:"paragraph",children:[{type:"linkReference",label:"DOC",referenceType:"full",value:"Guide"}]},{type:"definition",label:"doc",url:"/guide",title:"Read me"}]},
  {name:"collapsed and shortcut references",source:"[Guide][] and [Guide]\n\n[Guide]: /guide",body:[{type:"paragraph",children:[{type:"linkReference",label:"Guide",referenceType:"collapsed",value:"Guide"},text(" and "),{type:"linkReference",label:"Guide",referenceType:"shortcut",value:"Guide"}]},{type:"definition",label:"Guide",url:"/guide"}]},
  {name:"duplicate reference definitions are both kept",source:"[Guide]\n\n[Guide]: /first\n[Guide]: /second",body:[{type:"paragraph",children:[{type:"linkReference",label:"Guide",referenceType:"shortcut",value:"Guide"}]},{type:"definition",label:"Guide",url:"/first"},{type:"definition",label:"Guide",url:"/second"}]},
  {name:"unresolved references remain literal",source:"[Missing][unknown]",body:[paragraph("[Missing][unknown]")]},
  {name:"image alt text and title",source:'![Moon map](moon.png "Lunar atlas")',body:[{type:"paragraph",children:[{type:"image",url:"moon.png",alt:"Moon map",title:"Lunar atlas"}]}]},
  {name:"angle URL autolink",source:"<https://example.com/guide>",body:[{type:"paragraph",children:[{type:"link",url:"https://example.com/guide",value:"https://example.com/guide"}]}]},
  {name:"angle email autolink takes precedence over mentions",source:"<editor@example.com>",body:[{type:"paragraph",children:[{type:"link",url:"mailto:editor@example.com",value:"editor@example.com"}]}]},
  {name:"bare URL excludes terminal punctuation",source:"See https://example.com/guide.",body:[{type:"paragraph",children:[text("See "),{type:"link",url:"https://example.com/guide",value:"https://example.com/guide"},text(".")]}]},
  {name:"www autolink supplies the HTTP scheme",source:"www.example.com",body:[{type:"paragraph",children:[{type:"link",url:"http://www.example.com",value:"www.example.com"}]}]},
  {name:"www autolink retains paths and excludes terminal punctuation",source:"See www.example.com/guide.",body:[{type:"paragraph",children:[text("See "),{type:"link",url:"http://www.example.com/guide",value:"www.example.com/guide"},text(".")]}]},
  {name:"bare domains without www stay literal",source:"example.com",body:[paragraph("example.com")]},
  {name:"www code stays literal",source:"`www.example.com`",body:[{type:"paragraph",children:[{type:"inlineCode",value:"www.example.com"}]}]},
  {name:"bare email autolink takes precedence over mentions",source:"editor@example.com",body:[{type:"paragraph",children:[{type:"link",url:"mailto:editor@example.com",value:"editor@example.com"}]}]},
  {name:"autolinks balance parentheses and exclude the surrounding closer",source:"(https://example.com/api(v2))",body:[{type:"paragraph",children:[text("("),{type:"link",url:"https://example.com/api(v2)",value:"https://example.com/api(v2)"},text(")")]}]},
  {name:"code spans suppress automatic links",source:"`https://example.com editor@example.com`",body:[{type:"paragraph",children:[{type:"inlineCode",value:"https://example.com editor@example.com"}]}]},
]);
