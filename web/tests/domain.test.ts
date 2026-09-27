import test from "node:test";
import assert from "node:assert/strict";
import {
  amountValue,
  isUnknownChain,
  limitBps,
  priceLimit,
  sqrt,
  unpackDelta,
} from "../src/domain";
import { canonical, relativePath } from "../src/config";
import { switchNetwork } from "../src/wallet";
import type { Deployment } from "../src/config";
import type { WalletProvider } from "../src/wallet";

test("amounts preserve decimal precision and reject invalid, zero, rounded and overflow inputs", () => {
  assert.equal(amountValue("1.000000000000000001", 18), 1000000000000000001n);
  assert.equal(amountValue("0.000001", 6), 1n);
  for (const value of [
    "",
    "-1",
    "0",
    "1e3",
    "1,000",
    "0.0000001",
    "999999999999999999999999999999999999999999",
  ])
    assert.throws(() => amountValue(value, 6));
});
test("price limits use directional integer square roots and reject unsupported tolerance", () => {
  const current = 1n << 96n;
  const buy = priceLimit(current, limitBps("5"), true);
  const sell = priceLimit(current, limitBps("5"), false);
  assert(buy < current && sell > current);
  assert(buy * buy <= (current * current * 9500n) / 10000n);
  assert((buy + 1n) * (buy + 1n) > (current * current * 9500n) / 10000n);
  for (const input of ["0", "50.01", "1e1", "-1", "0.001"])
    assert.throws(() => limitBps(input));
  assert.equal(sqrt(9n), 3n);
  assert.equal(sqrt(10n), 3n);
});
test("packed deltas distinguish spent and net received for both directions", () => {
  const pack = (a: bigint, b: bigint) =>
    BigInt.asIntN(
      256,
      (BigInt.asUintN(128, a) << 128n) | BigInt.asUintN(128, b),
    );
  assert.deepEqual(unpackDelta(pack(-100n, 98n), true), {
    spent: 100n,
    received: 98n,
  });
  assert.deepEqual(unpackDelta(pack(98n, -100n), false), {
    spent: 100n,
    received: 98n,
  });
});
test("ABI canonicalization sorts object keys while preserving array order", () => {
  assert.equal(
    JSON.stringify(canonical([{ z: 1, a: { y: 2, b: 3 } }, 4])),
    '[{"a":{"b":3,"y":2},"z":1},4]',
  );
  for (const path of [
    "../abi.json",
    "https://site/abi",
    "/abi/a.json",
    "abi/../a.json",
    "abi/%2e%2e/a.json",
  ])
    assert.equal(relativePath(path), false);
  assert.equal(relativePath("abi/NFTD.json"), true);
});
test("unknown chain adds exact handoff parameters then switches; rejection does not add", async () => {
  const d = {
    walletAddChain: {
      chainId: "0xaa36a7",
      chainName: "Sepolia",
      rpcUrls: ["https://rpc.example"],
    },
  } as unknown as Deployment;
  const calls: { method: string; params?: unknown }[] = [];
  const provider = {
    request: async (request: { method: string; params?: unknown }) => {
      calls.push(request);
      if (calls.length === 1) throw { code: 4902 };
      return request.method === "eth_chainId" ? "0xaa36a7" : null;
    },
  } as unknown as WalletProvider;
  assert.equal(await switchNetwork(provider, d), 11155111);
  assert.deepEqual(
    calls.map((c) => c.method),
    [
      "wallet_switchEthereumChain",
      "wallet_addEthereumChain",
      "wallet_switchEthereumChain",
      "eth_chainId",
    ],
  );
  assert.deepEqual(calls[1].params, [d.walletAddChain]);
  assert(isUnknownChain({ data: { originalError: { code: 4902 } } }));
  assert(!isUnknownChain({ code: 4001, message: "User rejected" }));
});
