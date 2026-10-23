import { describe, expect, it } from "vitest";
import { parse, stringify, type Document } from "../src/index.js";
import { semantic } from "./semantic.js";

// Each case once crashed parsing or writing, or lost content.
const roundTrips = (source: string): Document => {
  const document = parse(source);
  const output = stringify(document);
  expect(semantic(parse(output))).toEqual(semantic(document));
  return document;
};

describe("inline rules inside link labels", () => {
  it.each([
    "[Check out these icons by @prayag17!](https://example.com/icons)",
    "[A :chip[Ready] link](/u)",
    "[![Logo](/logo.png){width=40}](/home)",
  ])("parses %s as a link", source => {
    expect(roundTrips(source).body[0]?.children?.[0]?.type).toBe("link");
  });
});

describe("safe HTML maps within its context", () => {
  it("wraps inline HTML blocks in paragraphs", () => {
    expect(semantic(roundTrips('<a href="/x"><img src="a.png" alt="A"></a>').body)).toEqual([{type:"paragraph",children:[{type:"link",url:"/x",children:[{type:"image",url:"a.png",alt:"A"}]}]}]);
  });
  it("keeps a block inside inline HTML as inline HTML", () => {
    const document = roundTrips('<a href="/x"><div>Block</div></a>');
    expect(document.body[0]?.children?.[0]?.children?.[0]).toMatchObject({type:"html",display:"inline"});
  });
  it("gives a table cell holding blocks a block body", () => {
    expect(roundTrips("<table><tr><td><div><p>Inside</p></div></td></tr></table>").body[0]?.children?.[0]?.children?.[0]).toMatchObject({type:"tableCell",body:[{type:"group",display:"block"}]});
  });
  it("keeps a lone table row as block HTML", () => {
    expect(roundTrips("<tr><td>Cell</td></tr>").body[0]).toMatchObject({type:"html",display:"block"});
  });
  it("writes a div split by blank lines with a trailing comment", () => {
    expect(() => stringify(parse("<div>\n\n*x*\n\n</div> <!-- end -->"))).not.toThrow();
  });
  it("collapses whitespace in HTML titles", () => {
    expect(roundTrips("<details>\n<summary>\n  Show\n  more\n</summary>\n<p>Body</p>\n</details>").body[0]?.title).toEqual({type:"title",value:"Show more"});
  });
  it("keeps an HTML table with irregular spans as HTML", () => {
    expect(roundTrips('<table><tr><td rowspan="3">A</td></tr><tr><td>B</td><td>C</td></tr></table>').body[0]).toMatchObject({type:"html",display:"block"});
  });
  it("keeps a link definition whose title spans lines", () => {
    const source="[foo]: /url '\ntitle\nline1\n'\n\n[foo]";
    expect(semantic(parse(source).body[0])).toEqual({type:"definition",label:"foo",url:"/url",title:"\ntitle\nline1\n"});
    expect(stringify(parse(source))).toBe(`${source}\n`);
  });
  it("writes an image with a multiline tooltip as native HTML", () => {
    expect(stringify(parse('<img src="a.png" alt="A" title="Line one\nLine two">'))).toContain("<img");
  });
});

describe("containers end with their enclosing block", () => {
  it("keeps the content after an unclosed container in a list item", () => {
    expect(semantic(parse("- item\n  ::: note\n  x\n\n# Heading outside").body).at(-1)).toEqual({type:"heading",level:1,value:"Heading outside"});
  });
  it("leaves a fence outside the list item to its own block", () => {
    expect(semantic(parse("- item\n  ::: note\n  x\n:::\n\nAfter").body).map(node => node.type)).toEqual(["list","paragraph","paragraph"]);
  });
  it("closes a container at its own fence inside the item", () => {
    expect(semantic(parse("- item\n  ::: note\n  x\n  :::\n- next").body[0]?.children?.[0]?.body?.[1])).toEqual({type:"container",subType:"note",body:[{type:"paragraph",value:"x"}]});
  });
});

describe("tight list items", () => {
  it.each(["- item\n  ::: note\n  x\n  :::\n", "- item\n  ```js\n  x\n  ```\n", "- item\n  > q\n", "- item\n  ## H\n"])("keep their blocks touching: %j", source => {
    const document = parse(source);
    expect(document.body[0]?.tight).toBe(true);
    expect(stringify(document)).toBe(source);
  });
});
