import { describe, expect, it } from "vitest";
import { parse, stringify, type Document, type Node } from "../src/index.js";
import { renderHtml } from "../src/render.js";

const paragraph = (value: string): Node => ({type:"paragraph",value});
const callout = (subType: string, body: Node[], title?: string, spelling?: "alert"): Node => ({type:"container",subType,...(title ? {title:{type:"title",value:title}}:{}),...(spelling ? {spelling}:{}),body});

// Each source is canonical: both spellings parse to one callout and write back as authored.
const cases: [string, string, Node[]][] = [
  ["an alert with a title","> [!warning] Before deploying\n> Back up the database first.\n",[callout("warning",[paragraph("Back up the database first.")],"Before deploying","alert")]],
  ["the same callout as a colon container","::: warning [Before deploying]\nBack up the database first.\n:::\n",[callout("warning",[paragraph("Back up the database first.")],"Before deploying")]],
  ["an alert without a title, holding several blocks","> [!note]\n> First.\n>\n> - Item\n",[callout("note",[paragraph("First."),{type:"list",ordered:false,tight:true,children:[{type:"listItem",body:[paragraph("Item")]}]}])].map(node => ({...node,spelling:"alert" as const}))],
  ["GitHub and custom types keep their names","> [!important]\n> Read this.\n\n> [!caution]\n> Careful.\n\n> [!recipe] Soup\n> Stir.\n",
    [callout("important",[paragraph("Read this.")],undefined,"alert"),callout("caution",[paragraph("Careful.")],undefined,"alert"),callout("recipe",[paragraph("Stir.")],"Soup","alert")]],
  ["an empty alert","> [!tip]\n",[callout("tip",[],undefined,"alert")]],
  ["a body that would underline the marker starts after a blank line","> [!note]\n>\n> ---\n",[callout("note",[{type:"horizontalRule"}],undefined,"alert")]],
  ["a structural type keeps an ordinary quotation","> [!details] More\n",[{type:"blockquote",body:[paragraph("[!details] More")]}]],
  ["a marker needs a following space or line end","> [!note]x\n",[{type:"blockquote",body:[paragraph("[!note]x")]}]],
];

describe("alert conformance", () => {
  it.each(cases)("%s", (_name, source, body) => {
    const document = parse(source);
    expect(document).toEqual({type:"document",version:1,body});
    expect(stringify(document)).toBe(source);
  });
  it("matches the type case-insensitively", () => {
    expect(parse("> [!NOTE] Heads up\n> Text.").body).toEqual([callout("note",[paragraph("Text.")],"Heads up","alert")]);
  });
  it("reads the marker as an alert even when a link definition shares its label", () => {
    const document = parse("> [!note]\n> Text.\n\nSee [!note].\n\n[!note]: /notes\n");
    expect(document.body[0]).toEqual(callout("note",[paragraph("Text.")],undefined,"alert"));
    expect(document.body[1]?.children?.[1]).toMatchObject({type:"linkReference",label:"!note"});
    expect(stringify(document)).toBe("> [!note]\n> Text.\n\nSee [!note].\n\n[!note]: /notes\n");
  });
});

describe("alert writing", () => {
  it("protects literal marker text in an ordinary quotation", () => {
    const document: Document = {type:"document",version:1,body:[{type:"blockquote",body:[paragraph("[!note] is literal")]}]};
    expect(stringify(document)).toBe("> \\[!note] is literal\n");
    expect(parse(stringify(document))).toEqual(document);
  });
  it("writes the preferred colon form for new callouts and for alerts with attributes", () => {
    const seen: string[] = [];
    expect(stringify({type:"document",version:1,body:[callout("tip",[paragraph("New.")])]})).toBe("::: tip\nNew.\n:::\n");
    expect(stringify({type:"document",version:1,body:[{...callout("tip",[paragraph("Tagged.")],undefined,"alert"),id:"t"}]},{onDiagnostic:d => seen.push(d.code)})).toBe('::: tip {id="t"}\nTagged.\n:::\n');
    expect(seen).toEqual(["unsupported-alert"]);
  });
});

describe("alert HTML", () => {
  it("renders an alert exactly as the equivalent colon container", () => {
    const alert = renderHtml(parse("> [!warning] Before deploying\n> Back up first."));
    expect(alert).toBe(renderHtml(parse("::: warning [Before deploying]\nBack up first.\n:::")));
    expect(alert).toBe('<section data-type="warning"><header>Before deploying</header><p>Back up first.</p></section>');
  });
});
