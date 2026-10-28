// Resolve the expressmark checkouts a comparison measures: the base, named by
// `--base=<path-or-git-ref>`, and the candidate, this checkout unless
// `--candidate=<path>` names another. A ref becomes a detached worktree in the
// ignored work directory, installed through the shared pnpm store and built.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const argument = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function worktree(ref) {
  const commit = git(repository, ["rev-parse", "--verify", `${ref}^{commit}`]);
  const dir = fileURLToPath(new URL(`work/base-${commit.slice(0, 12)}`, import.meta.url));
  if (!existsSync(dir)) {
    git(repository, ["worktree", "add", "--detach", dir, commit]);
    execFileSync("corepack", ["pnpm", "install", "--frozen-lockfile"], { cwd: dir, stdio: "inherit" });
  }
  if (!existsSync(`${dir}/dist/index.js`)) execFileSync("corepack", ["pnpm", "build"], { cwd: dir, stdio: "inherit" });
  return dir;
}
function describe(name, dir) {
  const root = realpathSync(dir);
  if (!existsSync(`${root}/dist/index.js`)) throw new Error(`${root} has no build; run pnpm build there`);
  const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
  const engine = pkg.dependencies?.["markdown-it"] ? `markdown-it ${pkg.dependencies["markdown-it"]}` : `parseman ${pkg.dependencies?.parseman}`;
  return { name, dir: root, entry: `${root}/dist/index.js`, version: pkg.version, engine, commit: git(root, ["rev-parse", "HEAD"]), dirty: Boolean(git(root, ["status", "--porcelain", "--untracked-files=no"])) };
}

/** The base and candidate checkouts, with what each leg runs. */
export function checkouts() {
  const base = argument("base");
  if (!base) throw new Error("Usage: --base=<path-or-git-ref> [--candidate=<path>]");
  const baseDir = existsSync(resolve(base)) ? resolve(base) : worktree(base);
  return [describe("base", baseDir), describe("candidate", resolve(argument("candidate") ?? repository))];
}
