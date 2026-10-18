import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== "nextwebwg/expressmark"
  || process.env.GITHUB_REF !== "refs/heads/main") {
  throw new Error("Publish only through this repository's protected main release workflow");
}
if (pkg.name !== "expressmark" || pkg.private || pkg.license !== "MIT"
  || pkg.version !== process.env.RELEASE_VERSION) {
  throw new Error("Requested version must match the public MIT expressmark package on main");
}
if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) {
  throw new Error("Publish only from a clean source tree");
}
execFileSync("corepack", ["pnpm", "pack", "--pack-destination", ".release"], { stdio: "inherit" });
execFileSync("npm", ["publish", `.release/expressmark-${pkg.version}.tgz`,
  "--access", "public", "--tag", "latest", "--provenance"], { stdio: "inherit" });
