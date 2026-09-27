import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toHex } from "viem";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = async (path) =>
  JSON.parse(await readFile(resolve(root, path), "utf8"));
const h = await read("web/config/deployment-handoff.json");
const n = await read("web/config/network-handoff.json");
const workflow = await read("web/config/workflow.json");
export const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
if (
  h.version !== 1 ||
  h.chainId !== n.network.chainId ||
  BigInt(n.walletAddChain.chainId) !== BigInt(h.chainId)
)
  throw Error("Invalid chain handoff");
if (!/^0x[a-f0-9]{40}$/.test(workflow.poolSwapTest))
  throw Error("Invalid workflow router address");
if (
  !/^[a-f0-9]{40}$/.test(h.sourceCommit) ||
  !/^[a-f0-9]{64}$/.test(h.attestationHash)
)
  throw Error("Invalid attestation fields");
await mkdir(resolve(root, "dist/abi"), { recursive: true });
await mkdir(resolve(root, "dist/licenses"), { recursive: true });
await writeFile(
  resolve(root, "dist/licenses/DM-Sans.txt"),
  await readFile(resolve(root, "web/src/assets/OFL.txt")),
);
const contracts = [];
for (const c of h.contracts) {
  if (!/^[A-Za-z0-9_]+$/.test(c.name) || !/^0x[a-fA-F0-9]{40}$/.test(c.address))
    throw Error("Invalid contract");
  const path = `docs/abi/${c.name}.json`;
  // Read the implementation export from the exact deployed commit, not a guessed interface.
  const pinned = execFileSync("git", ["show", `${h.sourceCommit}:${path}`], {
    cwd: root,
  });
  const current = await readFile(resolve(root, path));
  if (!pinned.equals(current))
    throw Error(`${path} differs from deployed source`);
  const abi = JSON.parse(pinned);
  if (
    !Array.isArray(abi) ||
    keccak256(toHex(JSON.stringify(canonical(abi)))).slice(2) !== c.abiHash
  )
    throw Error(`ABI hash mismatch: ${c.name}`);
  const abiPath = `abi/${c.name}.json`;
  await writeFile(resolve(root, "dist", abiPath), pinned);
  contracts.push({
    name: c.name,
    address: c.address,
    abiHash: c.abiHash,
    abiPath,
  });
}
const assets = [];
async function walk(dir = "") {
  for (const entry of await readdir(resolve(root, "dist", dir), {
    withFileTypes: true,
  })) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw Error("Symlinks are not export assets");
    if (entry.isDirectory()) await walk(path);
    else if (path !== "imd-deployment.json") {
      const bytes = await readFile(resolve(root, "dist", path));
      if (bytes.length > 8388608) throw Error("Asset exceeds 8 MiB");
      assets.push({
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
}
await walk();
assets.sort((a, b) => a.path.localeCompare(b.path));
if (assets.length > 128) throw Error("Too many assets");
const manifest = {
  version: 1,
  launchId: h.launchId,
  chainId: h.chainId,
  sourceCommit: h.sourceCommit,
  attestationHash: h.attestationHash,
  contracts,
  assets,
  network: n.network,
  walletAddChain: n.walletAddChain,
  pool: h.manifest.pool,
  deploymentBlock: Math.min(...h.contracts.map((c) => c.blockNumber)),
  integrations: { poolSwapTest: workflow.poolSwapTest },
};
await writeFile(
  resolve(root, "dist/imd-deployment.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
const total = (
  await Promise.all(
    [...assets.map((a) => a.path), "imd-deployment.json"].map((p) =>
      stat(resolve(root, "dist", p)),
    ),
  )
).reduce((s, a) => s + a.size, 0);
if (total >= 8 * 1024 * 1024)
  throw Error("Export alone exceeds submission budget");
console.log(
  `Verified ${contracts.length} pinned ABIs; inventoried ${assets.length} assets; ${total} export bytes.`,
);
