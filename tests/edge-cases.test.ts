import { expect, it } from "vitest";
import { parse, stringify, type Document } from "../src/index.js";

it("writes prose colons without unnecessary escapes in paragraphs and lists",()=> {
  const source="Status: Open question. Meet at 10:30; https://example.test.\n\n- Coral Island: Underground exploration, ore and gems, and combat.\n\n- Fae Farm: Mine expeditions pair materials with creature encounters.";
  const document=parse(source);
  const output=stringify(document);
  expect(output).not.toContain("\\:");
  expect(parse(output)).toEqual(document);
});
it("keeps directive-shaped literal text and text beside links literal",()=> {
  for(const value of ["::toc","::: warning",":chip[label]{kind=plain}"]) {
    const document: Document={type:"document",version:1,body:[{type:"paragraph",value}]};
    expect(parse(stringify(document))).toEqual(document);
  }
  const document: Document={type:"document",version:1,body:[{type:"paragraph",children:[
    {type:"text",value:"Literal :chip"},{type:"link",value:"docs",url:"https://example.test"},
  ]}]};
  expect(parse(stringify(document))).toEqual(document);
});

it("keeps a literal colon before an inline directive from opening a leaf block",()=> {
  for(const continued of [false,true]) {
    const document: Document={type:"document",version:1,body:[{type:"paragraph",children:[
      ...(continued ? [{type:"text",value:"Text"},{type:"softBreak"}]:[]),
      {type:"text",value:":"},{type:"inline",subType:"chip",value:"Ready"},
    ]}]};
    expect(parse(stringify(document))).toEqual(document);
  }
});

it("writes readable destinations and preserves destinations needing delimiters",()=> {
  const readable="[Guide](../guides/start.md#setup) and ![Diagram](./assets/diagram.png).";
  expect(stringify(parse(readable))).toBe(`${readable}\n`);
  for(const source of ['[Guide](<../guides/start (advanced).md>)', '![Diagram](<./assets/diagram(final).png> "Example")']) {
    const document=parse(source);
    const output=stringify(document);
    expect(output).toContain("(<");
    expect(parse(output)).toEqual(document);
  }
});
it("keeps ordinary headings, lists, code and semantic inline content readable",()=> {
  for(const source of [
    "# Setup: Quick start\n\n- Item: description.\n- Next item: more detail.",
    "Use `const map = {ready: true}`.\n\n```ts\nconst ready: boolean = true;\n```",
    "Thanks, @[Ada Lovelace]#user-123. :chip[Ready]",
  ]) {
    const document=parse(source);
    expect(stringify(document)).toBe(`${source}\n`);
    expect(parse(stringify(document))).toEqual(document);
  }
});

it("writes intraword underscores and email link labels without unnecessary escapes",()=> {
  for(const source of [
    "Use snake_case, a_b_c and naïve_identifier.",
    "[support@example.test](mailto:support@example.test)",
  ]) {
    const document=parse(source);
    expect(stringify(document)).toBe(`${source}\n`);
    expect(parse(stringify(document))).toEqual(document);
  }
});
it("preserves explicitly plain URL and email text without creating autolinks",()=> {
  for(const value of ["https://example.test", "HTTP://example.test/path", "ftp://example.test/file", "www.example.test", "support@example.test"]) {
    const document: Document={type:"document",version:1,body:[{type:"paragraph",value}]};
    expect(parse(stringify(document))).toEqual(document);
  }
  for(const source of ["https://example.test", "www.example.test", "support@example.test"]) {
    const document=parse(source);
    const output=stringify(document);
    expect(output).not.toMatch(/\\[:@.]/);
    expect(parse(output)).toEqual(document);
  }
});
it("preserves ordinary document spacing, nested lists, tables, containers and tabs",()=> {
  for(const source of [
    "# Heading\n\nFirst paragraph.\n\nSecond paragraph.",
    "1. One\n2. Two\n\n- First\n  - Nested\n- Last",
    "| Name | State |\n| --- | --- |\n| snake_case | Ready: yes |",
    "::: warning [Before deploying] {#deployment-check}\n\nBack up first: verify backup.\n\n:::",
    ":::: tabs {group=language}\n::: tab [JavaScript] {value=js}\n```js\nconst ready = true;\n```\n:::\n::: tab [Python] {value=py}\n```py\nready = True\n```\n:::\n::::",
    "| First line\n| Second line\n|\n\nNext paragraph.",
  ]) {
    const document=parse(source);
    expect(parse(stringify(document))).toEqual(document);
  }
});

it("preserves marked whitespace and neighboring rich content through Markdown",()=> {
  for(const type of ["strong","emphasis","delete"]) for(const value of ["Hello "," Hello"," ","\tHello\t","\u00a0Hello\u00a0"]) {
    const document={type:"document",version:1,body:[{type:"paragraph",children:[
      {type,value},{type:"inline",subType:"mention",value:"Ada",ref:"user-123"},
    ]}]} as const;
    expect(parse(stringify(document as never)),`${type}: ${JSON.stringify(value)}`).toEqual(document);
  }
});
it("preserves adjacent and nested marks rather than merging their delimiters",()=> {
  const nodes=[
    [{type:"strong",value:"One"},{type:"strong",value:"Two"}],
    [{type:"strong",children:[{type:"emphasis",value:"Both"}]}],
    [{type:"text",value:"before"},{type:"strong",value:"!"},{type:"text",value:"after"}],
    [{type:"text",value:"before"},{type:"emphasis",value:"🧶"},{type:"text",value:"after"}],
  ];
  for(const children of nodes) {
    const document={type:"document",version:1,body:[{type:"paragraph",children}]} as const;
    expect(parse(stringify(document as never))).toEqual(document);
  }
  expect(stringify({type:"document",version:1,body:[{type:"paragraph",children:[{type:"strong",value:"Ordinary"}]}]})).toBe("**Ordinary**\n");
});
it("keeps literal character-reference text rather than decoding it on reparse",()=> {
  const document={type:"document",version:1,body:[{type:"paragraph",value:"Use &copy;, &#32; and &#x41; literally; A & B stays readable."}]} as const;
  expect(parse(stringify(document as never))).toEqual(document);
  expect(stringify(document as never)).toContain("A & B");
});
it("preserves empty and whitespace-only paragraphs between authored blocks",()=> {
  const document={type:"document",version:1,body:[{type:"paragraph",value:"Before"},
    {type:"paragraph",value:""},{type:"paragraph",value:" \t"},{type:"paragraph",value:"After"}]} as const;
  expect(parse(stringify(document as never))).toEqual(document);
});

it("keeps unknown safe native elements stable through canonical writing",()=> {
  const document=parse('A <abbr title="Application Programming Interface">API</abbr>.\n\n<aside>Safe <kbd>Enter</kbd>.</aside>');
  expect(parse(stringify(document))).toEqual(document);
});
it("diagnoses duplicate IDs without rewriting identities",()=> {
  const diagnostics: unknown[]=[];
  const doc=parse('## One {#same}\n\n## Two {#same}',{onDiagnostic:d=>diagnostics.push(d)});
  expect(doc.body.map(n=>n.id)).toEqual(["same","same"]);
  expect(diagnostics).toContainEqual(expect.objectContaining({code:"duplicate-id"}));
});
it("rejects invalid AST child contexts and broken table grids",()=> {
  expect(()=>stringify({type:"document",version:1,body:[{type:"paragraph",children:[{type:"paragraph",value:"invalid"}]}]})).toThrow(/inline/);
  expect(()=>stringify({type:"document",version:1,body:[{type:"table",children:[{type:"tableRow",children:[{type:"tableCell",header:true,value:"A"}]},{type:"tableRow",children:[{type:"tableCell",value:"B",colSpan:2}]}]}]})).toThrow(/span/);
});
it("preserves duplicate YAML final values and custom reserved structural metadata",()=> {
  const diagnostics: unknown[]=[];
  const doc=parse('---\ntitle: Old\ntitle: New\nversion: product-v2\nbody: customer-data\ncustom: null\n---\nText',{onDiagnostic:d=>diagnostics.push(d)});
  expect(doc).toMatchObject({version:1,title:{value:"New"},metadata:{version:"product-v2",body:"customer-data",custom:null}});
  expect(diagnostics).toContainEqual(expect.objectContaining({code:"duplicate-metadata-key"}));
  expect(parse(stringify(doc))).toEqual(doc);
});
it("does not restore active or structural values from forged native attribute payloads",()=> {
  const doc=parse('<p data-attributes="{&quot;onclick&quot;:&quot;run()&quot;,&quot;style&quot;:&quot;background:url(javascript:run())&quot;,&quot;id&quot;:&quot;forged&quot;,&quot;ref&quot;:&quot;forged&quot;,&quot;__proto__&quot;:&quot;polluted&quot;}">Safe</p>');
  const output=stringify(doc);
  expect(output).not.toMatch(/onclick|javascript:|forged|__proto__/);
});
it("keeps Markdown and literal code inside inline native wrappers",()=> {
  const doc=parse('A <span>**strong** :chip[Ready] `<script>code</script>`</span>.');
  expect(parse(stringify(doc))).toEqual(doc);
});
it("preserves neighboring explicit group boundaries and block-context tab grouping",()=> {
  const doc=parse(':::: tabs\n::: tab [One]\nFirst\n:::\n::::\n\n:::: tabs\n::: tab [Two]\nSecond\n:::\n::::');
  expect(doc.body).toHaveLength(2);
  expect(parse(stringify(doc))).toEqual(doc);
  const contextual=parse('- Item\n\n  ::: tab [A]\n  A\n  :::\n\n- Item\n\n  ::: tab [B]\n  B\n  :::\n\n> ::: tab [C]\n> C\n> :::');
  expect(contextual.body).toHaveLength(2);
  expect(parse(stringify(contextual))).toEqual(contextual);
});
it("escapes pipe text and code inside tables without changing cell content",()=> {
  const doc=parse('| Text | Code |\n| --- | --- |\n| a \\| b | `a\\|b` |');
  expect(parse(stringify(doc))).toEqual(doc);
});
it("refuses nonrectangular authored merge rows before GFM padding",()=> {
  const diagnostics: unknown[]=[];
  const doc=parse('| A | B | C |\n| --- | --- | --- |\n| > | Span |',{onDiagnostic:d=>diagnostics.push(d)});
  expect(doc.body[0]?.type).toBe("literal");
  expect(diagnostics).toContainEqual(expect.objectContaining({code:"invalid-table-merge"}));
});
it("keeps code spans inside a represented line and uses safe fence metadata",()=> {
  const doc=parse('| One `not\n| code` line');
  expect(JSON.stringify(doc)).not.toContain('"inlineCode"');
  expect(parse(stringify(doc))).toEqual(doc);
  const code={type:"document",version:1,body:[{type:"code",value:"```\n~~~",language:"custom`lang"}]} as const;
  expect(parse(stringify(code as never))).toEqual(code);
});
it("builds merged table cells instead of line blocks",()=> {
  const doc=parse('| A | B | C |\n| --- | --- | --- |\n| > | Span | Ready |\n| ^ | ^ | Next |');
  expect(doc.body).toHaveLength(1);
  expect(doc.body[0]?.children?.[1]?.children?.[0]).toMatchObject({type:"tableCell",value:"Span",colSpan:2,rowSpan:2});
});
it("keeps an ordinary list label that resembles a task unchecked",()=> {
  const doc={type:"document",version:1,body:[{type:"list",ordered:false,tight:true,children:[{type:"listItem",body:[{type:"paragraph",value:"[x] Done"}]}]}]} as const;
  expect(parse(stringify(doc as never))).toEqual(doc);
});
it("normalizes absent optional nulls while preserving null metadata and rejecting non-JSON data",()=> {
  const doc={type:"document",version:1,id:null,title:null,metadata:{custom:null},body:[{type:"paragraph",value:"Text",children:null,attributes:null}]} as never;
  expect(parse(stringify(doc))).toEqual({type:"document",version:1,metadata:{custom:null},body:[{type:"paragraph",value:"Text"}]});
  expect(()=>stringify({type:"document",version:1,metadata:{number:Infinity},body:[]})).toThrow(/JSON/);
});
it("rejects malformed supplied scalar fields, metadata, groups and rich grids",()=> {
  const invalid=[
    {type:"list",ordered:false,children:[{type:"listItem",checked:"false",body:[]}]},
    {type:"table",children:[{type:"tableRow",children:[{type:"tableCell",header:"true",value:"A"}]}]},
    {type:"paragraph",children:[{type:"link",value:"No URL"}]},
    {type:"paragraph",children:[{type:"image",url:"a.png"}]},
    {type:"code",value:"code",language:123},
    {type:"group",display:"block",value:"not children"},
    {type:"lineBlock",value:"first\nsecond"},
    {type:"table",children:[{type:"tableRow",children:[{type:"tableCell",header:true,value:"A"}]},{type:"tableRow",children:[{type:"tableCell",attributes:{class:"rich"},rowSpan:2,value:"overflow"}]}]},
    {type:"table",children:[{type:"tableRow",children:[{type:"tableCell",header:true,value:"A"},{type:"tableCell",header:true,value:"B"}]},{type:"tableRow",children:[{type:"tableCell",attributes:{class:"rich"},value:"gap"}]}]},
    {type:"table",align:["invalid"],children:[{type:"tableRow",children:[{type:"tableCell",value:"A"}]}]},
  ];
  for(const node of invalid) expect(()=>stringify({type:"document",version:1,body:[node]} as never),JSON.stringify(node)).toThrow(expect.objectContaining({name:"ConversionError"}));
  expect(()=>stringify({type:"document",version:1,metadata:[],body:[]} as never)).toThrow(/mapping/);
  expect(()=>stringify({type:"document",version:1,body:[{type:"container",subType:"note",title:{type:"title",children:[{type:"text",value:"One"},{type:"break"},{type:"text",value:"Two"}]},body:[]}]})).toThrow(/title/);
});
it("rejects one-line identity and tight-wrapper title violations without corrupting source",()=> {
  expect(()=>stringify({type:"document",version:1,body:[{type:"heading",level:2,id:"line\nbreak",value:"Title"}]})).toThrow(/ID/);
  expect(()=>stringify({type:"document",version:1,body:[{type:"container",subType:"note",title:{type:"title",value:" padded "},body:[]}]})).toThrow(/title/);
  const root={type:"document",version:1,id:"line\nbreak",body:[]} as const;
  expect(parse(stringify(root as never))).toEqual(root);
});
it("quotes attributes with grammar escapes, retaining literal tabs and backslash text",()=> {
  const doc=parse('::: note {label="tab\tand \\\\n" id="item\tkey"}\nText\n:::');
  expect(doc.body[0]?.attributes?.label).toBe('tab\tand \\n');
  expect(parse(stringify(doc))).toEqual(doc);
});
it("rejects metadata fields that cannot retain their designated AST home",()=> {
  for(const metadata of [{tags:2},{tags:["valid",2]},{description:3},{id:"orphan"},{title:"orphan"}]) {
    expect(()=>stringify({type:"document",version:1,metadata,body:[]} as never)).toThrow(expect.objectContaining({name:"ConversionError"}));
  }
  const diagnostics: unknown[]=[];
  const source=stringify({type:"document",version:1,id:"designated",title:{type:"title",value:"Designated"},metadata:{id:"shadow",title:"Shadow",description:"Valid **description**",tags:["valid"],custom:null},body:[]},{onDiagnostic:diagnostic=>diagnostics.push(diagnostic)});
  expect(parse(source)).toEqual({type:"document",version:1,id:"designated",title:{type:"title",value:"Designated"},metadata:{description:"Valid **description**",tags:["valid"],custom:null},body:[]});
  expect(diagnostics.filter((value: unknown)=>(value as {code:string}).code === "metadata-conflict")).toHaveLength(2);
});
