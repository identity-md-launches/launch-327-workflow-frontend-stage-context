import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const git = (args) => execFileSync("git", args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
const list = (args) => git(args).toString().split("\0").filter(p => p && !p.startsWith("test/scratch/"));
const tracked = list(["ls-files", "-z"]);
const untracked = list(["ls-files", "--others", "--exclude-standard", "-z"]);
const files = [...new Set([...tracked, ...untracked])].sort();
const modified = list(["diff", "--name-only", "-z", "HEAD"]);
const allowed = p => /^(web|dist|docs)\//.test(p);
if (![...modified, ...untracked].every(allowed)) throw Error("Out-of-scope changes");
if (files.some(p => /(^|\/)(node_modules|\.cache|\.vite|playwright-report|test-results)(\/|$)/.test(p) || p.endsWith(".tgz"))) throw Error("Dependency/cache artifact in submission");
if (git(["ls-files", "--stage"]).toString().split("\n").some(l => l.startsWith("160000 "))) throw Error("Submodule in submission");
const total = files.reduce((sum, p) => sum + statSync(resolve(root, p)).size, 0);
// Read-only packing of existing history. It does not write repository metadata.
const packBytes = git(["pack-objects", "--stdout", "--all"]).length;
const manifest = JSON.parse(readFileSync(resolve(root, "dist/imd-deployment.json")));
const exportBytes = [...manifest.assets.map(a => a.path), "imd-deployment.json"].reduce((sum, p) => sum + statSync(resolve(root, "dist", p)).size, 0);
const report = {
  scopeCheck: "pass", modifiedExistingPaths: modified, allowedNewFileCount: untracked.length,
  prospectiveTrackedFileCount: files.length, prospectiveTreeBytes: total,
  existingHistoryPackBytes: packBytes, exportBytes, assetCount: manifest.assets.length,
  bundleBudgetBytes: 8388608, conservativeBudgetBytes: total + packBytes + 1048576,
  budgetMethod: "Full prospective tree bytes + packed retained history + 1 MiB allowance for Git object/header overhead. Final submission bundle cannot be created in the read-only Git metadata directory.",
  dependencyFilesIncluded: false, submodules: false,
  rootDesignFile: "docs/DESIGN.md used to respect the explicit path scope.",
  commitStatus: "git add -- web dist docs failed: .git/index.lock: Read-only file system",
};
if (report.conservativeBudgetBytes >= report.bundleBudgetBytes) throw Error("Submission budget exceeded");
writeFileSync(resolve(root, "docs/frontend/integrity.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
