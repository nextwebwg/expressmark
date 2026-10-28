import { parseCompatible as parse, stringifyCompatible as stringify } from "./compatible.js";
import { describe, expect, it } from "vitest";
import { type Document } from "../src/index.js";

// Every accepted spelling of a construct writes back byte for byte, and reads
// back as the same document, spelling included.
const spellings: [string, string][] = [
  ["underscore emphasis and strong","Use _care_ and __check twice__.\n"],
  ["asterisk emphasis and strong","Use *care* and **check twice**.\n"],
  ["star bullets","* One\n* Two\n"],
  ["plus bullets","+ One\n+ Two\n"],
  ["dash bullets","- One\n- Two\n"],
  ["parenthesis ordered list","1) One\n2) Two\n"],
  ["repeated ordered numbers","1. One\n1. Two\n1. Three\n"],
  ["incrementing ordered numbers","3. One\n4. Two\n"],
  ["setext level one","Title\n=====\n"],
  ["setext level two","Section\n---\n"],
  ["ATX heading","## Section\n"],
  ["closed ATX heading","## Section ##\n"],
  ["closed ATX heading with attributes","## Section {#s} ###\n"],
  ["tilde fence","~~~js\nconst x = 1;\n~~~\n"],
  ["long backtick fence","`````js\nconst x = 1;\n`````\n"],
  ["indented code","    const x = 1;\n    const y = 2;\n"],
  ["asterisk thematic break","***\n"],
  ["spaced thematic break","* * *\n"],
  ["underscore thematic break","___\n"],
  ["long dash thematic break","-----\n"],
  ["two-space hard break","First line  \nsecond line\n"],
  ["three-space hard break","First line   \nsecond line\n"],
  ["backslash hard break","First line\\\nsecond line\n"],
  ["angle autolink","See <https://example.com>.\n"],
  ["angle email autolink","Mail <ada@example.com>.\n"],
  ["bare autolink","See https://example.com today.\n"],
  ["inline link","See [docs](https://example.com).\n"],
  ["link target in angle brackets with a single-quoted title","See [docs](<https://example.com/a b> 'Docs').\n"],
  ["pipe table","| Name | State |\n| --- | --- |\n| Alpha | Ready |\n"],
  ["padded pipe table","| Name  | State |\n|:------|------:|\n| Alpha | Ready |\n"],
  ["named list table","::: table\n\n- Name: Alpha\n  State: Ready\n\n- Name: Beta\n  State: Done\n\n:::\n"],
  ["positional list table","::: table {header}\n\n- - Name\n  - State\n\n- - Alpha\n  - Ready\n\n:::\n"],
  ["colon callout","::: warning [Careful]\nBody.\n:::\n"],
  ["alert callout","> [!warning] Careful\n> Body.\n"],
  ["adjacent tabs","::: tab [npm]\nA\n:::\n\n::: tab [pnpm]\nB\n:::\n"],
  ["explicit tabs group","::::tabs\n::: tab [npm]\nA\n:::\n\n::: tab [pnpm]\nB\n:::\n::::\n"],
  ["attribute separators and quoting","## Deploy {#deploy & open label='Go now'}\n"],
  ["compact container header","::::warning[Careful]{#c}\nBody.\n::::\n"],
  ["uppercase container type","::: WARNING [Careful]\nBody.\n:::\n"],
  ["longer container fence","::::: note\nBody.\n:::::\n"],
  ["image attributes","![Diagram](d.svg){width=640 & responsive}\n"],
  ["chip attributes","A :chip[Ready]{tone='green'} chip.\n"],
  ["line block indentation","|   Morgan Lee\n| 42 Example\n  Street\n"],
  ["fence info setting order","```ts {show-line-numbers & title=\"deploy.ts\"} extra\ncode\n```\n"],
  ["uppercase task marker","- [X] Done\n- [ ] Open\n"],
  ["lowercase task marker","- [x] Done\n"],
  ["bare mention","Thanks @ada for this.\n"],
  ["bracketed mention","Thanks @[Ada Lovelace] for this.\n"],
  ["longer code span","Use ``code`` here.\n"],
  ["reference definition with angle destination","[Guide]\n\n[Guide]: <https://example.com/a b> 'Guide'\n"],
  ["frontmatter in authored key order","---\ntitle: Guide\nid: guide\ntags:\n  - one\n---\n\nBody.\n"],
];

describe("authored forms", () => {
  it.each(spellings)("%s", (_name, source) => {
    const document = parse(source);
    const output = stringify(document);
    expect(output).toBe(source);
    expect(parse(output)).toEqual(document);
  });
});

describe("preferred forms", () => {
  it("writes new content in the preferred spelling", () => {
    const document: Document = {type:"document",version:1,syntax:"compatible",body:[
      {type:"heading",level:1,value:"Title"},
      {type:"paragraph",children:[{type:"emphasis",value:"care"},{type:"text",value:" "},{type:"strong",value:"twice"},{type:"break"},{type:"link",url:"https://example.com",value:"https://example.com"}]},
      {type:"list",ordered:false,tight:true,children:[{type:"listItem",checked:true,body:[{type:"paragraph",value:"Done"}]}]},
      {type:"code",language:"js",value:"x"},
      {type:"horizontalRule"},
    ]};
    expect(stringify(document)).toBe("# Title\n\n*care* **twice**\\\n[https://example.com](https://example.com)\n\n- [x] Done\n\n```js\nx\n```\n\n---\n");
  });
  it("falls back to the preferred spelling when an edit invalidates the recorded one", () => {
    const document = parse("Title\n=====\n\n    code\n\n<https://example.com>\n");
    document.body[0] = {...document.body[0]!, level:3};
    document.body[1] = {...document.body[1]!, language:"js"};
    document.body[2]!.children![0] = {...document.body[2]!.children![0]!, value:"Example"};
    expect(stringify(document)).toBe("### Title\n\n```js\ncode\n```\n\n[Example](https://example.com)\n");
  });
  it("writes an edited attribute list canonically and an edited header in the preferred form", () => {
    const document = parse("## Deploy {#deploy & open}\n\n::::warning[Careful]{#c}\nBody.\n::::\n");
    document.body[0]!.attributes = {open:false};
    document.body[1]!.title = {type:"title",value:"Changed"};
    expect(stringify(document)).toBe("## Deploy {#deploy !open}\n\n:::: warning [Changed] {#c}\nBody.\n::::\n");
  });
});
