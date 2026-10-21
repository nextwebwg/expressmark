import { describe, expect, it } from "vitest";
import { ConversionError, parse, stringify, type Document, type Node } from "../src/index.js";
import { renderHtml } from "../src/render.js";

const ref = (label: string, referenceType: NonNullable<Node["referenceType"]>, value = label): Node => ({type:"linkReference",label,referenceType,value});
const definition = (label: string, url: string, title?: string): Node => ({type:"definition",label,url,...(title ? {title}:{})});
const document = (...body: Node[]): Document => ({type:"document",version:1,body});

// Each source is canonical: the authored forms and definition placement survive
// a parse and write byte for byte.
const sources: [string, string, Node[]][] = [
  ["full, collapsed and shortcut forms","[Guide][docs], [Guide][] and [Guide].\n\n[docs]: /guide \"Read me\"\n\n[Guide]: /start\n",
    [{type:"paragraph",children:[ref("docs","full","Guide"),{type:"text",value:", "},ref("Guide","collapsed"),{type:"text",value:" and "},ref("Guide","shortcut"),{type:"text",value:"."}]},definition("docs","/guide","Read me"),definition("Guide","/start")]],
  ["a definition mid-document","[Intro]: /intro\n\nSee [Intro].\n\n## Next\n",
    [definition("Intro","/intro"),{type:"paragraph",children:[{type:"text",value:"See "},ref("Intro","shortcut"),{type:"text",value:"."}]},{type:"heading",level:2,value:"Next"}]],
  ["an image reference and a destination needing brackets","![Logo][logo]\n\n[logo]: <a(b).png>\n",
    [{type:"paragraph",children:[{type:"imageReference",label:"logo",referenceType:"full",alt:"Logo"}]},definition("logo","a(b).png")]],
  ["a definition inside a quote stays there","> [q]: /q\n\n[q]\n",
    [{type:"blockquote",body:[definition("q","/q")]},{type:"paragraph",children:[ref("q","shortcut")]}]],
  ["an unresolved reference stays text","[Missing][unknown]\n",[{type:"paragraph",value:"[Missing][unknown]"}]],
];

describe("link reference conformance", () => {
  it.each(sources)("%s", (_name, source, body) => {
    const parsed = parse(source);
    expect(parsed).toEqual(document(...body));
    expect(stringify(parsed)).toBe(source);
  });
});

describe("link reference writing", () => {
  it("changes a target or title in its definition, in place", () => {
    const parsed = parse("[Guide]\n\n[Guide]: /old\n\nAfter.");
    parsed.body[1] = {...parsed.body[1]!, url:"/new", title:"Updated"};
    expect(stringify(parsed)).toBe('[Guide]\n\n[Guide]: /new "Updated"\n\nAfter.\n');
  });
  it("writes the full form when edited text no longer names the label", () => {
    const parsed = parse("[Guide] and [Guide][]\n\n[Guide]: /g");
    const [shortcut, , collapsed] = parsed.body[0]!.children!;
    shortcut!.value = "The guide"; collapsed!.value = "This guide";
    expect(stringify(parsed)).toBe("[The guide][Guide] and [This guide][Guide]\n\n[Guide]: /g\n");
  });
  it("closes a shortcut that the following text would extend", () => {
    const value = document({type:"paragraph",children:[ref("a","shortcut"),{type:"text",value:"(not a destination)"}]},definition("a","/a"));
    expect(stringify(value)).toBe("[a][](not a destination)\n\n[a]: /a\n");
    expect(parse(stringify(value))).toEqual({...value,body:[{type:"paragraph",children:[ref("a","collapsed"),{type:"text",value:"(not a destination)"}]},definition("a","/a")]});
  });
  it("escapes literal brackets that name a defined label, and only those", () => {
    const value = document({type:"paragraph",value:"Literal [guide] and [other]."},definition("Guide","/g"));
    expect(stringify(value)).toBe("Literal \\[guide] and [other].\n\n[Guide]: /g\n");
    expect(parse(stringify(value))).toEqual(value);
  });
  it.each<[string, Document]>([
    ["an unbalanced label",document(definition("a]b","/x"))],
    ["a missing reference type",document({type:"paragraph",children:[{type:"linkReference",label:"a",value:"a"}]})],
    ["a definition in inline content",document({type:"paragraph",children:[definition("a","/a")]})],
  ])("rejects %s", (_name, value) => {
    expect(() => stringify(value)).toThrow(ConversionError);
  });
});

describe("link reference HTML", () => {
  it("resolves references against the first definition and renders definitions as nothing", () => {
    expect(renderHtml(parse('[Guide][docs] ![Logo][logo]\n\n[docs]: /guide "Read me"\n[DOCS]: /ignored\n[logo]: /logo.png'))).toBe('<p><a href="/guide" title="Read me">Guide</a> <img src="/logo.png" alt="Logo" /></p>');
  });
  it("renders an unresolved supplied reference as its source text", () => {
    expect(renderHtml(document({type:"paragraph",children:[ref("gone","full","Text"),{type:"imageReference",label:"x",referenceType:"collapsed",alt:"X"}]}))).toBe("<p>[Text][gone]![X][]</p>");
  });
});
