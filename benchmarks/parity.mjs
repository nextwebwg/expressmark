// Compare a candidate checkout's output with a base checkout's on every input
// set: the parsed document, its diagnostics, its exact and canonical writing,
// in both syntaxes and both HTML profiles. Exits non-zero on any difference.
// Usage: node benchmarks/parity.mjs --base=<path-or-git-ref> [--candidate=<path>] [--sets=a,b]
import { checkouts } from "./checkout.mjs";
import { inputSet, setNames } from "./corpus.mjs";

const legs = checkouts();
for (const leg of legs) console.log(`${leg.name}: expressmark ${leg.version} (${leg.engine}) at ${leg.dir} ${leg.commit.slice(0, 12)}`);
const [reference, candidate] = await Promise.all(legs.map(leg => import(leg.entry)));
const sets = process.argv.find(arg => arg.startsWith("--sets="))?.slice(7).split(",") ?? setNames;
const variants = ["compatible", "standard"].flatMap(syntax => [false, true].flatMap(trustedHtml => [false, true].map(lint => ({ syntax, trustedHtml, lint }))));
const describeVariant = ({ syntax, trustedHtml, lint }) => `${syntax}${trustedHtml ? " trusted" : ""}${lint ? " lint" : ""}`;

// Writing without the recorded source text exercises the canonical writer.
const canonical = document => ({ ...document, source: Object.fromEntries(Object.entries(document.source ?? {}).filter(([key]) => !["text", "blocks", "head", "trusted"].includes(key))) });
function outcome(library, source, { lint, ...options }) {
  const diagnostics = [];
  try {
    const document = library.parse(source, { ...options, ...(lint ? { lint: true } : {}), onDiagnostic: diagnostic => diagnostics.push(diagnostic) });
    const written = library.stringify(document, options);
    let fresh;
    try { fresh = library.stringify(canonical(document), options); } catch (error) { fresh = `threw: ${error.message}`; }
    return JSON.stringify({ document, diagnostics, written, fresh });
  } catch (error) { return `threw: ${error.message}`; }
}
let failures = 0;
for (const set of sets) {
  const documents = await inputSet(set);
  for (const variant of variants) {
    const options = { ...(variant.trustedHtml ? { trustedHtml: true } : {}), syntax: variant.syntax, lint: variant.lint };
    let differing = 0;
    for (const [index, source] of documents.entries()) {
      const expected = outcome(reference, source, options), actual = outcome(candidate, source, options);
      if (expected === actual) continue;
      if (differing++ < 3) { let at = 0; while (expected[at] === actual[at]) at++; console.log(`${set}[${index}] ${describeVariant(variant)}: ${JSON.stringify(source.slice(0, 120))}\n  expected …${expected.slice(Math.max(0, at - 200), at + 200)}\n  actual   …${actual.slice(Math.max(0, at - 200), at + 200)}`); }
    }
    failures += differing;
    console.log(`${set} ${describeVariant(variant)}: ${documents.length - differing}/${documents.length} identical`);
  }
}
process.exit(failures ? 1 : 0);
