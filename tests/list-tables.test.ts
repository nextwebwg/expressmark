import { describe, expect, it } from "vitest";
import { parse, stringify, type Diagnostic, type Document, type Node } from "../src/index.js";
import { semantic } from "./semantic.js";

const p = (value: string): Node => ({type:"paragraph",value});
const cell = (value: string, header = false): Node => ({type:"tableCell",value,...(header ? {header:true}:{})});
const row = (...children: Node[]): Node => ({type:"tableRow",children});
const table = (...children: Node[]): Node => ({type:"table",children});
const source = (body: string, settings = ""): string => `::: table${settings ? ` ${settings}`:""}\n\n${body}\n\n:::`;

function check(markdown: string, expected: Node[]): Document {
  const diagnostics: Diagnostic[]=[];
  const document=parse(markdown,{onDiagnostic:diagnostic=>diagnostics.push(diagnostic)});
  expect(semantic(document)).toEqual({type:"document",version:1,body:expected});
  const output=stringify(document,{onDiagnostic:diagnostic=>diagnostics.push(diagnostic)});
  expect(parse(output,{onDiagnostic:diagnostic=>diagnostics.push(diagnostic)})).toEqual(document);
  expect(diagnostics).toEqual([]);
  return document;
}

describe("named list tables",()=> {
  it("creates headers and assigns reordered fields by exact name",()=> {
    check(source('- Task: Install\n  Instructions: Run setup.\n\n- Instructions: Check version.\n  Task: Verify'),[
      table(row(cell("Task",true),cell("Instructions",true)),row(cell("Install"),cell("Run setup.")),row(cell("Verify"),cell("Check version."))),
    ]);
  });
  it("appends new columns and fills omitted fields without shifting old columns",()=> {
    check(source('- Name: Alpha\n  Notes: First\n\n- Status: Ready\n  Name: Beta\n\n- Notes:'),[
      table(row(cell("Name",true),cell("Notes",true),cell("Status",true)),row(cell("Alpha"),cell("First"),cell("")),row(cell("Beta"),cell(""),cell("Ready")),row(cell(""),cell(""),cell(""))),
    ]);
  });
  it("retains case-sensitive, Unicode and punctuation-bearing column names",()=> {
    check(source('- Name: A\n  name: B\n  Café: C\n  Café: D\n  A\\: B: E'),[
      table(row(cell("Name",true),cell("name",true),cell("Café",true),cell("Café",true),cell("A: B",true)),row(cell("A"),cell("B"),cell("C"),cell("D"),cell("E"))),
    ]);
  });
  it("parses values as Markdown instead of YAML scalars",()=> {
    check(source('- Enabled: false\n  Count: 42\n  Label: **Ready**'),[
      table(row(cell("Enabled",true),cell("Count",true),cell("Label",true)),row(cell("false"),cell("42"),{type:"tableCell",children:[{type:"strong",value:"Ready"}]})),
    ]);
  });
  it("accepts positional records after named columns and pads them",()=> {
    check(source('- A: one\n  B: two\n\n- - three\n\n- B: four\n  C: five'),[
      table(row(cell("A",true),cell("B",true),cell("C",true)),row(cell("one"),cell("two"),cell("")),row(cell("three"),cell(""),cell("")),row(cell(""),cell("four"),cell("five"))),
    ]);
  });
  it("retains lists, paragraphs, quotes, line blocks and code inside fields",()=> {
    check(source('- Topic: Example\n  Body:\n    First paragraph.\n\n    - One\n    - Two\n\n    > Quoted\n\n    | First line\n    | Second line\n\n    ```md\n    Field: code text\n    ```'),[
      table(row(cell("Topic",true),cell("Body",true)),row(cell("Example"),{type:"tableCell",body:[p("First paragraph."),{type:"list",ordered:false,tight:true,children:[{type:"listItem",body:[p("One")]},{type:"listItem",body:[p("Two")]}]},{type:"blockquote",body:[p("Quoted")]},{type:"lineBlock",children:[{type:"text",value:"First line"},{type:"break"},{type:"text",value:"Second line"}]},{type:"code",language:"md",value:"Field: code text"}]})),
    ]);
  });
  it("treats named caret values as content rather than merges",()=> {
    check(source('- A: ^\n  B: \\>'),[table(row(cell("A",true),cell("B",true)),row(cell("^"),cell(">")))]);
  });
  it("accepts redundant header and negated transpose flags",()=> {
    check(source('- Name: Alpha','{header !transpose}'),[table(row(cell("Name",true)),row(cell("Alpha")))]);
  });
  it("retains a fenced field whose first code line resembles another field",()=> {
    check(source('- Code: ```md\n  Name: literal code\n  ```\n  Name: Actual'),[
      table(row(cell("Code",true),cell("Name",true)),row({type:"tableCell",body:[{type:"code",language:"md",value:"Name: literal code"}]},cell("Actual"))),
    ]);
  });
  it("preserves nonbreaking spaces in exact column identities",()=> {
    check(source('- Name: A\n  \u00a0Name: B'),[table(row(cell("Name",true),cell("\u00a0Name",true)),row(cell("A"),cell("B")))]);
  });
});

describe("positional list tables",()=> {
  it("uses exactly two structural list levels",()=> {
    check(source('- - First\n  -\n    - A bullet\n    - Another bullet\n\n- - Second\n  - Last'),[
      table(row(cell("First"),{type:"tableCell",body:[{type:"list",ordered:false,tight:true,children:[{type:"listItem",body:[p("A bullet")]},{type:"listItem",body:[p("Another bullet")]}]}]}),row(cell("Second"),cell("Last"))),
    ]);
  });
  it("pads to the widest row, including empty header cells",()=> {
    check(source('- - Heading\n\n- - A\n  - B\n  - C','{header}'),[
      table(row(cell("Heading",true),cell("",true),cell("",true)),row(cell("A"),cell("B"),cell("C"))),
    ]);
  });
  it("retains explicit empty cells and a header-only table",()=> {
    check(source('- -\n  - Title','{header}'),[table(row(cell("",true),cell("Title",true)))]);
  });
  it("accepts empty tables",()=> { check(source(''),[table()]); });
  it("accepts ordinary unordered-list marker variations and relative indentation",()=> {
    check(source(' + * A\n   * B\n\n + * C\n   * D'),[table(row(cell("A"),cell("B")),row(cell("C"),cell("D")))]);
  });
  it("retains caption, ID and unrelated attributes",()=> {
    check(source('- - Data','[Caption] {#data class=compact}'),[{...table(row(cell("Data"))),title:{type:"title",value:"Caption"},id:"data",attributes:{class:"compact"}}]);
  });
  it("preserves block-level cell identities instead of compacting them",()=> {
    check(source('- - <p id="lead">Rich</p>'),[table(row({type:"tableCell",body:[{type:"paragraph",id:"lead",value:"Rich"}]}))]);
  });
  it("supports nested table containers without confusing closing fences",()=> {
    check(':::: table\n\n- - Outer\n  -\n    ::: table\n    - - Inner\n    :::\n\n::::',[table(row(cell("Outer"),{type:"tableCell",body:[table(row(cell("Inner")))]}))]);
  });
  it("keeps table-looking code literal",()=> {
    check(source('- - ```md\n    ::: table\n    - - literal\n    :::\n    ```'),[table(row({type:"tableCell",body:[{type:"code",language:"md",value:"::: table\n- - literal\n:::"}]}))]);
  });
  it("keeps indented cell code and its colon fences literal",()=> {
    check(source('- -     :::\n        code'),[table(row({type:"tableCell",body:[{type:"code",value:":::\ncode"}]}))]);
  });
  it("supports tab-indented cell continuations without changing code tabs",()=> {
    check(source('- - ```txt\n\t\tcode\n    ```'),[table(row({type:"tableCell",body:[{type:"code",language:"txt",value:"\tcode"}]}))]);
  });
  it("parses tables within quotes and list items",()=> {
    const input=source('- - A\n  - B');
    check(input.split('\n').map(line=>`> ${line}`).join('\n'),[{type:"blockquote",body:[table(row(cell("A"),cell("B")))]}]);
    check(`- Item\n\n${input.split('\n').map(line=>`  ${line}`).join('\n')}`,[{type:"list",ordered:false,tight:false,children:[{type:"listItem",body:[p("Item"),table(row(cell("A"),cell("B")))]}]}]);
  });
  it("resolves cell references defined after the table",()=> {
    check(`${source('- - [Guide]')}\n\n[Guide]: /guide`,[table(row({type:"tableCell",children:[{type:"linkReference",label:"Guide",referenceType:"shortcut",value:"Guide"}]})),{type:"definition",label:"Guide",url:"/guide"}]);
  });
});

describe("table settings and merges",()=> {
  it("transposes named headers into the first displayed column",()=> {
    check(source('- Name: Alpha\n  Status: Ready','{transpose align="start,end"}'),[
      {...table(row(cell("Name",true),cell("Alpha")),row(cell("Status",true),cell("Ready"))),align:["start","end"]},
    ]);
  });
  it("expands a single displayed alignment",()=> {
    check(source('- - A\n  - B','{!header align=center}'),[{...table(row(cell("A"),cell("B"))),align:["center","center"]}]);
  });
  it("keeps explicit default alignments",()=> {
    check(source('- - A\n  - B','{align="-, end"}'),[{...table(row(cell("A"),cell("B"))),align:[null,"end"]}]);
  });
  it("resolves rectangular merges before transposing",()=> {
    const merged={...cell("Wide"),colSpan:2,rowSpan:2};
    check(source('- - >\n  - Wide\n  - Ready\n\n- - ^\n  - ^\n  - Done'),[table(row(merged,cell("Ready")),row(cell("Done")))]);
    check(source('- - >\n  - Wide\n  - Ready\n\n- - ^\n  - ^\n  - Done','{transpose}'),[table(row(merged),row(),row(cell("Ready"),cell("Done")))]);
  });
  it("swaps unequal spans under transpose",()=> {
    check(source('- - >\n  - Wide\n  - Tail','{transpose}'),[table(row({...cell("Wide"),rowSpan:2}),row(),row(cell("Tail")))]);
  });
  it("keeps escaped and code-span markers literal",()=> {
    check(source('- - \\>\n  - \\^\n  - `>`\n  - `^`'),[table(row(cell(">"),cell("^"),{type:"tableCell",children:[{type:"inlineCode",value:">"}]},{type:"tableCell",children:[{type:"inlineCode",value:"^"}]}))]);
  });
});

describe("malformed list-table recovery",()=> {
  it.each([
    ['duplicate named field','- A: one\n  A: two',''],
    ['named records after positional data','- - one\n\n- A: two',''],
    ['too many positional cells for named columns','- A: one\n\n- - two\n  - extra',''],
    ['missing cell list','- plain row',''],
    ['ordered outer list','1. - A',''],
    ['ordered cell list','- 1. A',''],
    ['checked row','- [x] A: one',''],
    ['checked cell','- - [x] A',''],
    ['extra container content','Before\n\n- - A',''],
    ['extra row content','- - A\n\n  Extra',''],
    ['unindented field continuation','- A: one\n  Not a field',''],
    ['negated named headers','- A: one','{!header}'],
    ['string header setting','- - A','{header=true}'],
    ['string transpose setting','- - A','{transpose=false}'],
    ['boolean alignment','- - A','{align}'],
    ['unknown alignment','- - A','{align=justify}'],
    ['physical left alignment','- - A','{align=left}'],
    ['physical right alignment','- - A','{align=right}'],
    ['wrong alignment width','- - A\n  - B','{align="start,end,center"}'],
    ['dangling right merge','- - A\n  - >',''],
    ['first-row vertical merge','- - ^',''],
    ['header-crossing merge','- - Header\n\n- - ^','{header}'],
    ['partial rectangular continuation','- - >\n  - Wide\n\n- - ^\n  - Other',''],
    ['implicit slots in merged row','- - >\n  - Wide\n\n- - ^',''],
    ['a right merge ending in a continuation','- - >\n  - ^',''],
  ])("preserves the whole table for %s",(_name,body,settings)=> {
    const markdown=source(body,settings);
    const diagnostics: Diagnostic[]=[];
    const document=parse(markdown,{onDiagnostic:diagnostic=>diagnostics.push(diagnostic)});
    expect(document.body).toEqual([{type:"literal",display:"block",value:markdown}]);
    expect(diagnostics).toContainEqual(expect.objectContaining({code:"invalid-table"}));
    expect(parse(stringify(document))).toEqual(document);
    expect(parse(`${markdown}\n\nAfter`).body.at(-1)).toEqual(p("After"));
  });
});

it("keeps table content safe and code literal across both conversion boundaries",()=> {
  const diagnostics: Diagnostic[]=[];
  const document=parse(source('- - <script>secret()</script>\n  - ```html\n    <script>literal()</script>\n    ```'),{onDiagnostic:diagnostic=>diagnostics.push(diagnostic)});
  const output=stringify(document);
  expect(output).not.toContain('secret()');
  expect(output).toContain('<script>literal()</script>');
  expect(diagnostics).toContainEqual(expect.objectContaining({code:"html-filtered"}));
  expect(parse(output)).toEqual(document);
});

it("writes editable list-table source for both simple and rich cells",()=> {
  const document: Document={type:"document",version:1,body:[table(row(cell("A",true),cell("B",true)),row(cell("Value"),{type:"tableCell",body:[p("First"),p("Second")]}))]};
  const output=stringify(document);
  expect(output).toContain('::: table');
  expect(output).not.toContain('<table');
  expect(parse(output)).toEqual(document);
});

it("derives named output from edited headers without rematching values",()=> {
  const document=parse(source('- Name: Alpha\n  Status: Ready'));
  document.body[0]!.children![0]!.children![0]!.value='Renamed: field';
  const output=stringify(document);
  expect(output).toContain('Renamed\\: field:');
  expect(parse(output)).toEqual(document);
});

it("writes single-line named cells compactly and keeps rich bodies indented",()=> {
  const document=parse(source('- Name: Ada\n  Status: Ready: yes'));
  const output=stringify(document);
  expect(output).toContain('- Name: Ada\n  Status: Ready: yes');
  expect(parse(output)).toEqual(document);
  const rich=parse(source('- Notes:\n    First paragraph.\n\n    Second paragraph.'));
  const richOutput=stringify(rich);
  expect(richOutput).toMatch(/- Notes:\n    First paragraph\.\n[ \t]*\n    Second paragraph\./);
  expect(rich.body[0]!.children![1]!.children![0]).toMatchObject({type:"tableCell",body:[{type:"paragraph",value:"First paragraph."},{type:"paragraph",value:"Second paragraph."}]});
  expect(parse(richOutput)).toEqual(rich);
});
