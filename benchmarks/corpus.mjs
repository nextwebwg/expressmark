// Input sets shared by the comparison runner and the parity check.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const here = new URL("./", import.meta.url);
const work = new URL("work/", here);
const readFixture = name => readFileSync(new URL(`fixtures/${name}.md`, here), "utf8");

// Spec examples are downloaded once into the ignored work directory and
// verified against these digests, so every run reads the same bytes.
const specs = {
  commonmark: { file: "commonmark-0.31.2.json", url: "https://spec.commonmark.org/0.31.2/spec.json", sha256: "d431b29d97b6f73e69d547109cf5081578fac931e72afe95639ebe766c1b2a20" },
  gfm: { file: "gfm-0.29.txt", url: "https://raw.githubusercontent.com/github/cmark-gfm/828322d1ee4facdab56f0d3edccb13e9af90dcd2/test/spec.txt", sha256: "7d8e5814befec287ac116786d81ff14e0adc9b13295b4494649e995408fd871c" },
};
const sha256 = text => createHash("sha256").update(text).digest("hex");

async function spec(name) {
  const { file, url, sha256: expected } = specs[name];
  const path = new URL(`spec/${file}`, work);
  let text = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (text === undefined) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    text = await response.text();
    mkdirSync(new URL("spec/", work), { recursive: true });
    writeFileSync(path, text);
  }
  if (sha256(text) !== expected) throw new Error(`${file} does not match its pinned digest`);
  if (name === "commonmark") return JSON.parse(text).map(example => example.markdown);
  // GFM's spec.txt fences each example; a `.` line separates Markdown from HTML.
  const examples = [];
  for (const match of text.matchAll(/^`{32} example[^\n]*\n([\s\S]*?)^\.\n/gm)) examples.push(match[1].replaceAll("→", "\t"));
  return examples;
}

function fixtures() {
  const prose = readFixture("prose");
  return [
    "# Hello\n\nA **small** document with a [link](https://example.com).\n",
    prose,
    prose.repeat(64),
    readFixture("expressive"),
    // Many sibling containers: container scanning must stay linear in the document.
    Array.from({ length: 1000 }, (_, i) => `::: note [Note ${i}]\nText **${i}**.\n:::`).join("\n\n"),
  ];
}

// Third-party READMEs are read from a local directory and never committed;
// `readme-corpus.txt` lists the repositories they came from.
function readmes() {
  const dir = process.env.BENCH_READMES ?? new URL("readmes/", work).pathname;
  if (!existsSync(dir)) throw new Error(`README corpus not found at ${dir}; set BENCH_READMES`);
  return readdirSync(dir).filter(name => name.endsWith(".md")).sort().map(name => readFileSync(`${dir}/${name}`, "utf8"));
}

export const setNames = ["fixtures", "commonmark", "gfm", "readmes"];
/** The documents of one input set, in a stable order. */
export async function inputSet(name) {
  if (name === "fixtures") return fixtures();
  if (name === "readmes") return readmes();
  if (name in specs) return spec(name);
  throw new Error(`Unknown input set ${name}`);
}
export function digest(documents) {
  return sha256(documents.join("\0"));
}
