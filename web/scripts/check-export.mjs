import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { keccak256, toHex } from "viem";
const base = new URL("../../", import.meta.url);
const read = async (p) => JSON.parse(await readFile(new URL(p, base), "utf8"));
const manifest = await read("dist/imd-deployment.json");
const handoff = await read("web/config/deployment-handoff.json");
const network = await read("web/config/network-handoff.json");
const canonical = (x) =>
  Array.isArray(x)
    ? x.map(canonical)
    : x && typeof x === "object"
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, canonical(x[k])]),
        )
      : x;
for (const key of [
  "version",
  "launchId",
  "chainId",
  "sourceCommit",
  "attestationHash",
])
  assert.deepEqual(manifest[key], handoff[key]);
assert.deepEqual(manifest.network, network.network);
assert.deepEqual(manifest.walletAddChain, network.walletAddChain);
assert.deepEqual(
  manifest.contracts.map(({ abiPath, ...c }) => c),
  handoff.contracts.map(({ name, address, abiHash }) => ({
    name,
    address,
    abiHash,
  })),
);
const all = await readdir(new URL("dist/", base), {
  recursive: true,
  withFileTypes: true,
});
const files = all
  .filter((x) => x.isFile())
  .map((x) => fileURLToPath(new URL("dist/", base)).replace(/\/$/, "")).length;
assert.equal(files - 1, manifest.assets.length);
assert(manifest.assets.length <= 128);
let total = 0;
for (const asset of manifest.assets) {
  assert(
    /^[\w./-]+$/.test(asset.path) &&
      !asset.path.includes("..") &&
      !asset.path.startsWith("/"),
  );
  const bytes = await readFile(new URL(`dist/${asset.path}`, base));
  assert(bytes.length <= 8388608);
  total += bytes.length;
  assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
}
assert.equal(
  new Set(manifest.assets.map((a) => a.path)).size,
  manifest.assets.length,
);
for (const c of manifest.contracts)
  assert.equal(
    keccak256(
      toHex(JSON.stringify(canonical(await read(`dist/${c.abiPath}`)))),
    ).slice(2),
    c.abiHash,
  );
assert(total < 32 * 1024 * 1024);
console.log(
  `PASS: handoff, network, ABI binding, ${files - 1} asset hashes, ${total} asset bytes.`,
);
