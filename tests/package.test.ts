import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

it("ships a working ESM converter with declarations to a fresh package consumer", () => {
  const consumer = mkdtempSync(join(tmpdir(), "expressmark-consumer-"));
  const options = { cwd: consumer, encoding: "utf8" as const, shell: process.platform === "win32" };
  try {
    const [packed] = JSON.parse(execFileSync("npm", ["pack", root, "--ignore-scripts", "--json"], options)) as {
      filename: string; files: { path: string }[];
    }[];
    expect(packed).toBeDefined();
    const files = packed!.files.map(({ path }) => path);
    expect(files).toEqual(expect.arrayContaining(["LICENSE", "README.md", "package.json", "dist/index.js", "dist/index.d.ts"]));
    expect(files.every((path) => /^(?:dist\/|LICENSE$|README.md$|package.json$)/.test(path))).toBe(true);
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(consumer, packed!.filename)], options);
    const installed = JSON.parse(readFileSync(join(consumer, "node_modules/expressmark/package.json"), "utf8"));
    expect(installed.name).toBe("expressmark");
    expect(installed.repository.url).toBe("git+https://github.com/nextwebwg/expressmark.git");
    expect(installed.repository.directory).toBeUndefined();
    expect(installed.license).toBe("MIT");
    expect(installed.dependencies).toMatchObject({parseman:"0.55.3", "sanitize-html":"2.18.1"});
    expect(installed.dependencies["markdown-it"]).toBeUndefined();
    expect(readFileSync(join(consumer, "node_modules/expressmark/LICENSE"), "utf8"))
      .toBe(readFileSync(join(root, "LICENSE"), "utf8"));
    const exports = execFileSync(process.execPath, ["--input-type=module", "--eval",
      'import * as api from "expressmark"; console.log(JSON.stringify(Object.keys(api)));'], options);
    expect(JSON.parse(exports)).toEqual(["ConversionError", "anchorText", "headingAnchors", "parse", "stringify"]);
    const rendered = execFileSync(process.execPath, ["--input-type=module", "--eval",
      'import {parse} from "expressmark"; import {renderHtml} from "expressmark/render"; console.log(renderHtml(parse("# Hello"), {transformers:{heading:(_node,ctx)=>`<aside>${ctx.renderChildren()}</aside>`}}));'], options);
    expect(rendered.trim()).toBe("<aside>Hello</aside>");
    const converted = execFileSync(process.execPath, ["--input-type=module", "--eval", 'import {parse,stringify} from "expressmark"; const doc=parse("::: warning [Check]\\nBackup first.\\n:::"); console.log(stringify(doc));'], options);
    expect(converted).toContain("warning");
    const table = execFileSync(process.execPath, ["--input-type=module", "--eval", 'import {parse,stringify} from "expressmark"; const doc=parse("::: table {transpose}\\n- Name: Alpha\\n  Role: Reviewer\\n:::"); const markdown=stringify(doc); console.log(JSON.stringify({doc,again:parse(markdown),markdown}));'], options);
    const result=JSON.parse(table);
    expect(result.doc.body[0]).toMatchObject({type:"table",children:[{children:[{header:true,value:"Name"},{value:"Alpha"}]},{children:[{header:true,value:"Role"},{value:"Reviewer"}]}]});
    expect(result.again).toEqual(result.doc);
    expect(result.markdown).toContain("table");
    writeFileSync(join(consumer, "index.ts"), 'import {parse,stringify,type Document} from "expressmark"; import {renderHtml,type HtmlTransformer} from "expressmark/render"; const doc: Document = parse("# Hello"); stringify(doc); const heading: HtmlTransformer = (_node,ctx) => ctx.renderDefault(); renderHtml(doc,{transformers:{heading}});\n');
    const tsc = fileURLToPath(new URL("./bin/tsc", import.meta.resolve("typescript/package.json")));
    execFileSync(process.execPath, [tsc, "--strict", "--noEmit", "--skipLibCheck", "--target", "ES2023",
      "--module", "NodeNext", "index.ts"], options);
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});
