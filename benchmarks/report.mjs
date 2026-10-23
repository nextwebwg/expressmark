import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("Usage: node benchmarks/report.mjs <results.json>");
const data = JSON.parse(readFileSync(file, "utf8"));
console.log(`Node ${data.environment.node}; ${data.environment.cpu}; ${data.measuredAt}\n`);
const mb = bytes => (bytes / 1048576).toFixed(2);
if (data.schema === "compare") {
  for (const leg of data.legs) console.log(`- ${leg.name}: expressmark ${leg.version} (${leg.engine}), ${leg.commit.slice(0, 12)}${leg.dirty ? " with uncommitted changes" : ""}`);
  console.log(`\nLoad average at start: ${data.environment.loadAverage.map(value => value.toFixed(2)).join(", ")}; ${data.protocol.rounds} interleaved rounds.\n`);
  console.log("| Input set | Syntax | Documents | Base median ms (Q1–Q3) | Candidate median ms (Q1–Q3) | Ratio | Round ratios | Base retained MB | Candidate retained MB | Base peak MB | Candidate peak MB | Outputs differing |");
  console.log("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  const span = leg => `${leg.medianMs.toFixed(2)} (${leg.q1Ms.toFixed(2)}–${leg.q3Ms.toFixed(2)})`;
  for (const row of data.results) {
    console.log(`| ${row.set} | ${row.syntax} | ${row.documents} | ${span(row.base)} | ${span(row.candidate)} | ${row.ratio.toFixed(3)}× | ${row.minRoundRatio.toFixed(3)}–${row.maxRoundRatio.toFixed(3)} | ${mb(row.base.retainedBytes)} | ${mb(row.candidate.retainedBytes)} | ${mb(row.base.peakBytes)} | ${mb(row.candidate.peakBytes)} | ${row.differing} |`);
  }
} else {
  for (const operation of ["parse", "stringify", "round-trip", "to-html"]) {
    console.log(`## ${operation}\n\n| Fixture | Bytes | Implementation | Median µs/op | Min–max µs/op |\n| --- | ---: | --- | ---: | ---: |`);
    for (const result of data.results.filter(row => row.operation === operation)) {
      console.log(`| ${result.fixture} | ${result.bytes} | ${result.library} | ${result.medianUs.toFixed(2)} | ${result.minUs.toFixed(2)}–${result.maxUs.toFixed(2)} |`);
    }
    console.log("");
  }
}
