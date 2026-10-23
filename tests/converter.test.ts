import { expect, it } from "vitest";
import { parse, stringify } from "../src/index.js";

it.each(["a@word", "a@[Ada]", "(@word)", "!@[Ada]", "日@word", "/@word"])("requires whitespace or a line start before mentions: %s", source => {
  expect(parse(source).body).toEqual([{type:"paragraph",value:source}]);
  expect(stringify(parse(source))).toBe(`${source}\n`);
});

it.each(["@ada", "Hello @ada", "Hello\n@ada", "Hello\t@[Ada]", "Hello\u00a0@ada"])("recognizes mentions at a whitespace boundary: %s", source => {
  expect(JSON.stringify(parse(source))).toContain('"subType":"mention"');
  expect(parse(stringify(parse(source)))).toEqual(parse(source));
});

it.each([
  ':mention[Ada Lovelace]',
  ':mention[Ada Lovelace]{ref="org/user-123"}',
  ':mention[Ada]{#acknowledgement}',
  ':MENTION[Ada]',
  ':MeNtIoN{ref=ada}',
])("keeps replaced named mention source literal: %s", source => {
  const document = parse(source);
  expect(document.body).toEqual([{type:"paragraph",value:source}]);
  expect(parse(stringify(document))).toEqual(document);
});

it.each([
  '@[Ada Lovelace]',
  '@ada-lovelace',
  '@[Ada Lovelace]#user-123{#acknowledgement}',
  '@ada-lovelace#user-123',
  '@[**Ada Lovelace**]{ref="org/user-123"}',
])("round-trips the replacement mention source form: %s", source => {
  const document = parse(source);
  expect(document.body[0]?.children?.[0]).toMatchObject({type:"inline",subType:"mention"});
  const output = stringify(document);
  expect(output).toBe(`${source}\n`);
  expect(parse(output)).toEqual(document);
});

it("keeps ordinary formatting and other directives beside the removed mention form", () => {
  const document = parse('Old :mention[**Ada**], current @[Ada], :chip[Ready] and :mentioning[Topic].');
  const children = document.body[0]?.children ?? [];
  expect(children.filter(node => node.type === "inline" && node.subType === "mention")).toHaveLength(1);
  expect(children).toContainEqual({type:"strong",value:"Ada"});
  expect(children).toContainEqual({type:"inline",subType:"chip",value:"Ready"});
  expect(children).toContainEqual({type:"inline",subType:"mentioning",value:"Topic"});
  expect(parse(stringify(document))).toEqual(document);
});

it("parses authored identities, metadata, inline structure and mention references", () => {
  const document = parse('---\nid: guide\ntitle: "Deploy **safely**"\ncustom: {enabled: true}\n---\n## Deploy {#deploy}\n\nThanks, @[Ada Lovelace]#user-123{#thanks}.');
  expect(document).toMatchObject({type:"document",version:1,id:"guide",metadata:{custom:{enabled:true}},body:[{type:"heading",level:2,id:"deploy",value:"Deploy"},{type:"paragraph",children:[{type:"text",value:"Thanks, "},{type:"inline",subType:"mention",value:"Ada Lovelace",ref:"user-123",id:"thanks"},{type:"text",value:"."}]}]});
  expect(parse(stringify(document))).toEqual(document);
});

it("normalizes adjacent tabs and retains string and flag code attributes", () => {
  const document = parse('::: tab [npm]\n```ts {title="deploy.ts" highlight=1,3-4 & show-line-numbers}\na\nb\nc\nd\n```\n:::\n\n::: tab [pnpm]\nSecond.\n:::');
  expect(document.body).toMatchObject([{type:"container",subType:"tabs",body:[{subType:"tab",body:[{type:"code",title:"deploy.ts",value:"a\nb\nc\nd",attributes:{highlight:"1,3-4",showLineNumbers:true}}]},{subType:"tab"}]}]);
  expect(parse(stringify(document))).toEqual(document);
});

it("drops unsafe HTML and its script contents, keeping literal code", () => {
  const diagnostics: unknown[] = [];
  const document = parse('<script>alert("secret")</script>\n\nSafe <span onclick="run()">text</span>.\n\n`<script>literal</script>`', {onDiagnostic: diagnostic => diagnostics.push(diagnostic)});
  const output = stringify(document);
  expect(output).not.toContain('secret');
  expect(output).not.toContain('onclick');
  expect(output).toContain('`<script>literal</script>`');
  expect(diagnostics.length).toBeGreaterThan(0);
  expect(stringify({type:"document",version:1,body:[{type:"html",display:"block",value:'<script>secret()</script><p onclick="x()">Safe</p>'}]})).not.toMatch(/secret|onclick/);
});

it("round-trips ordinary Markdown, tasks, nested containers and explicit tab settings", () => {
  const samples = [
    '# Title\n\nOne *emphasis* and **strong**, ~~removed~~, [link](https://example.com "Title") and ![alt](image.png){width=100}.\n\n> quote\n>\n> - nested\n\n3. First\n4. Second\n\n- [x] Done\n- [ ] Todo\n\n---',
    ':::: note [Outer **title**] {#outer}\n::: warning [Inner]\nCaution.\n:::\n\n```txt\n::: literal\n```\n::::',
    ':::: tabs {group=language & default=js}\n::: tab [JavaScript] {value=js}\nJS\n:::\n\n::: tab [TypeScript] {value=ts}\nTS\n:::\n::::',
    '| One **bold\n| second** line\n|\n| Fourth\n\nNext.',
    '| First | Second | Status |\n| --- | --- | --- |\n| > | Release checks | Ready |\n| ^ | ^ | Verified |',
    'A :chip[**Ready**]{tone=green} and :custom{open !disabled count=3} with @ada#ref, @[Name]{ref="org/name"}.',
    '<p id="lead" style="text-align:center;color:purple">Read <u>underlined</u> and <mark>highlighted</mark>.</p>',
  ];
  for (const sample of samples) {
    const document = parse(sample);
    expect(parse(stringify(document)),sample).toEqual(document);
  }
});

it("keeps authored strings, resolves normalized duplicate attributes last, and protects mention boundaries", () => {
  const diagnostics: unknown[]=[];
  const document=parse('::: DETAILS {open=false & OPEN=foo #old id=new}\nemail: ada@example.com; https://example.com/@person; `@code`; \\@literal.\n:::',{onDiagnostic:d=>diagnostics.push(d)});
  expect(document.body[0]).toMatchObject({subType:"details",id:"new",attributes:{open:"foo"}});
  expect(diagnostics.length).toBeGreaterThan(0);
  expect(JSON.stringify(document)).not.toContain('"subType":"mention"');
});

it("rejects lossy supplied ASTs instead of choosing or dropping content", () => {
  expect(()=>stringify({type:"document",version:1,body:[{type:"unknown",value:"data"}]})).toThrow(/block nodes/);
  expect(()=>stringify({type:"document",version:1,body:[{type:"paragraph",value:"a",children:[]}]})).toThrow(/cannot combine/);
  expect(()=>stringify({type:"document",version:2,body:[]} as never)).toThrow(/version 1/);
});

it("filters active HTML, handlers, unsafe URLs and CSS on both conversion boundaries", () => {
  const input='<p onclick="x()" style="color:red;background-image:url(javascript:x);text-align:center"><a href="javascript:run()">Click</a><img src="data:text/html,evil" onerror="x()"><iframe>hidden</iframe><svg><script>secret</script></svg></p>';
  const document=parse(input);
  const output=stringify(document);
  expect(output).not.toMatch(/onclick|onerror|javascript:|data:text|hidden|secret|iframe|svg|background-image/);
  expect(output).toContain('color:red');
  expect(output).toContain('text-align:center');
  const code=parse('```html\n<script>keep me</script>\n```');
  expect(stringify(code)).toContain('<script>keep me</script>');
});

it("imports rich native tables as editable spans and block cells", () => {
  const source='<table><tr><th>A</th><th>B</th></tr><tr><td colspan="2" style="background-color:#ffeeaa"><p>One</p><ul><li>Two</li></ul></td></tr></table>';
  const document=parse(source);
  expect(document.body[0]).toMatchObject({type:"table",children:[{children:[{header:true},{header:true}]},{children:[{colSpan:2,attributes:{style:"background-color:#ffeeaa"},body:[{type:"paragraph"},{type:"list"}]}]}]});
  expect(parse(stringify(document))).toEqual(document);
});

it("preserves malformed regions as literal recovery and reports invalid YAML", () => {
  const diagnostics: unknown[]=[];
  const document=parse('---\ntitle: [not a title]\n---\n\n::: warning\nUnclosed.',{onDiagnostic:d=>diagnostics.push(d)});
  // An unclosed container runs to the end of its enclosing block.
  expect(document.body.map(node=>node.type)).toEqual(["literal","container"]);
  expect(diagnostics.length).toBe(2);
});

it("preserves rich-cell custom attributes and authored flag values in safe native fallback", () => {
  const document={type:"document",version:1,body:[{type:"table",align:["start","end"],children:[{type:"tableRow",children:[{type:"tableCell",header:true,value:"A"},{type:"tableCell",header:true,value:"B"}]},{type:"tableRow",children:[{type:"tableCell",colSpan:2,attributes:{columnWidths:"100,120",textAlign:"center",backgroundColor:"#ffeeaa",responsive:false},body:[{type:"paragraph",value:"Rich"},{type:"paragraph",value:"body"}]}]}]}]} as const;
  const parsed=parse(stringify(document as never));
  expect(parsed).toEqual(document);
});

it("keeps inline extensions within native wrappers and blockifies disclosure/figure text", () => {
  const document=parse('Hi <span class="label">**bold** and :chip[Ready]</span>.\n\n<details open><summary>Read more</summary>Plain body <em>text</em>.</details>\n\n<figure><img src="a.png" alt="A"><figcaption>Caption</figcaption></figure>');
  expect(document.body[0]).toMatchObject({children:[{value:"Hi "},{type:"group",children:[{type:"strong"},{type:"text"},{type:"inline",subType:"chip"}]},{value:"."}]});
  expect(document.body[1]).toMatchObject({subType:"details",title:{type:"title",value:"Read more"},body:[{type:"paragraph"}]});
  expect(document.body[2]).toMatchObject({subType:"figure",body:[{type:"paragraph",children:[{type:"image"}]}]});
  expect(parse(stringify(document))).toEqual(document);
});

it("reports inline attachment diagnostics once when reusing parsed tokens", () => {
  const diagnostics: unknown[] = [];
  const document = parse("A :chip[Ready]{tone=red tone=green}.", { onDiagnostic: diagnostic => diagnostics.push(diagnostic) });
  expect(document.body[0]?.children?.[1]).toMatchObject({ type: "inline", subType: "chip", attributes: { tone: "green" } });
  expect(diagnostics).toEqual([expect.objectContaining({ code: "duplicate-attribute" })]);
});


it.each(["left", "right"])("rejects physical table alignment in AST input: %s", alignment => {
  expect(() => stringify({type:"document",version:1,body:[{type:"table",align:[alignment],children:[]}]} as never)).toThrow(/alignment/);
});
