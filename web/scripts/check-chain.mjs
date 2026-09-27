import { readFile, writeFile } from "node:fs/promises";
import {
  createPublicClient,
  http,
  parseAbi,
  encodeAbiParameters,
  keccak256,
} from "viem";
const root = new URL("../../", import.meta.url);
const d = JSON.parse(await readFile(new URL("dist/imd-deployment.json", root)));
const report = {
  checkedAt: new Date().toISOString(),
  readOnly: true,
  broadcasts: 0,
  endpoints: [],
};
for (const url of d.network.rpcUrls) {
  const record = { url };
  report.endpoints.push(record);
  try {
    const client = createPublicClient({
      transport: http(url, { timeout: 12000, retryCount: 0 }),
    });
    record.chainId = await client.getChainId();
    if (record.chainId !== d.chainId)
      throw Error("RPC chain differs from handoff");
    record.block = String(await client.getBlockNumber());
    record.code = [];
    for (const c of [
      ...d.contracts,
      ...Object.entries({
        ...d.network.uniswapV4,
        PoolSwapTest: d.integrations.poolSwapTest,
      }).map(([name, address]) => ({ name, address })),
    ]) {
      const code = await client.getCode({ address: c.address });
      record.code.push({
        name: c.name,
        address: c.address,
        bytes: code ? (code.length - 2) / 2 : 0,
      });
    }
    const hook = d.contracts.find((c) => c.name === "NFTHolderDiscountHook");
    const token = d.contracts.find((c) => c.name === "NFTD");
    const abi = JSON.parse(
      await readFile(new URL(`dist/${hook.abiPath}`, root)),
    );
    record.collection = await client.readContract({
      address: hook.address,
      abi,
      functionName: "COLLECTION",
    });
    record.poolManager = await client.readContract({
      address: hook.address,
      abi,
      functionName: "poolManager",
    });
    record.routerManager = await client.readContract({
      address: d.integrations.poolSwapTest,
      abi: parseAbi(["function manager() view returns (address)"]),
      functionName: "manager",
    });
    const poolId = keccak256(
      encodeAbiParameters(
        [
          { type: "address" },
          { type: "address" },
          { type: "uint24" },
          { type: "int24" },
          { type: "address" },
        ],
        [
          d.pool.pairedCurrency,
          token.address,
          d.pool.fee,
          d.pool.tickSpacing,
          hook.address,
        ],
      ),
    );
    record.poolId = poolId;
    record.slot0 = (
      await client.readContract({
        address: d.network.uniswapV4.stateView,
        abi: parseAbi([
          "function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)",
        ]),
        functionName: "getSlot0",
        args: [poolId],
      })
    ).map(String);
    record.liquidity = String(
      await client.readContract({
        address: d.network.uniswapV4.stateView,
        abi: parseAbi([
          "function getLiquidity(bytes32) view returns (uint128)",
        ]),
        functionName: "getLiquidity",
        args: [poolId],
      }),
    );
    record.result = "read checks completed";
  } catch (e) {
    record.error = e.shortMessage || e.message;
  }
  console.log(JSON.stringify(record));
}
await writeFile(
  new URL("docs/frontend/live-chain.json", root),
  JSON.stringify(report, null, 2) + "\n",
);
