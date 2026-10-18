import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("Usage: node benchmarks/report.mjs <results.json>");
const data = JSON.parse(readFileSync(file, "utf8"));
console.log(`Node ${data.environment.node}; ${data.environment.cpu}; ${data.measuredAt}\n`);
for (const operation of ["parse", "stringify", "round-trip", "to-html"]) {
  console.log(`## ${operation}\n\n| Fixture | Bytes | Implementation | Median µs/op | Min–max µs/op |\n| --- | ---: | --- | ---: | ---: |`);
  for (const result of data.results.filter(row => row.operation === operation)) {
    console.log(`| ${result.fixture} | ${result.bytes} | ${result.library} | ${result.medianUs.toFixed(2)} | ${result.minUs.toFixed(2)}–${result.maxUs.toFixed(2)} |`);
  }
  console.log("");
}
