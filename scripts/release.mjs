import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
function requireCleanTree() {
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) {
    throw new Error("Publish only from a clean source tree");
  }
}
// CI runs the release's metadata and git checks in the same container, then
// stops: the preflight never reaches the ref, version or publish steps.
if (process.argv.includes("--preflight")) {
  if (pkg.name !== "expressmark" || pkg.private || pkg.license !== "MIT") {
    throw new Error("Release metadata must describe the public MIT expressmark package");
  }
  requireCleanTree();
  console.log("Release preflight passed");
  process.exit(0);
}
if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== "nextwebwg/expressmark"
  || process.env.GITHUB_REF !== "refs/heads/main") {
  throw new Error("Publish only through this repository's protected main release workflow");
}
if (pkg.name !== "expressmark" || pkg.private || pkg.license !== "MIT"
  || pkg.version !== process.env.RELEASE_VERSION) {
  throw new Error("Requested version must match the public MIT expressmark package on main");
}
requireCleanTree();
execFileSync("corepack", ["pnpm", "pack", "--pack-destination", ".release"], { stdio: "inherit" });
execFileSync("npm", ["publish", `.release/expressmark-${pkg.version}.tgz`,
  "--access", "public", "--tag", "latest", "--provenance"], { stdio: "inherit" });
