import {
  createPublicClient,
  custom,
  defineChain,
  encodeAbiParameters,
  fallback,
  http,
  isAddress,
  keccak256,
  parseAbi,
  toHex,
  zeroAddress,
  type Abi,
  type Address,
  type EIP1193Provider,
} from "viem";

export interface Deployment {
  version: number;
  launchId: string;
  chainId: number;
  sourceCommit: string;
  attestationHash: string;
  contracts: {
    name: string;
    address: Address;
    abiHash: string;
    abiPath: string;
  }[];
  assets: { path: string; sha256: string }[];
  network: {
    chainId: number;
    name: string;
    testnet: boolean;
    rpcUrls: string[];
    explorer: string;
    nativeCurrency: { name: string; symbol: string; decimals: number };
    faucets: string[];
    uniswapV4: Record<
      | "poolManager"
      | "quoter"
      | "stateView"
      | "universalRouter"
      | "positionManager"
      | "permit2",
      Address
    >;
  };
  walletAddChain: {
    chainId: `0x${string}`;
    chainName: string;
    rpcUrls: string[];
    nativeCurrency: { name: string; symbol: string; decimals: number };
    blockExplorerUrls: string[];
  };
  pool: {
    fee: number;
    tickSpacing: number;
    pairedCurrency: Address;
    initialPrice: string;
  };
  deploymentBlock: number;
  integrations: { poolSwapTest: Address };
}
export const keyTuple =
  "(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)";
// Protocol interfaces only. Launch ABIs always load from the deployment manifest.
export const protocol = {
  stateView: parseAbi([
    "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
    "function getLiquidity(bytes32 poolId) view returns (uint128)",
  ]),
  collection: parseAbi([
    "function balanceOf(address owner) view returns (uint256)",
  ]),
  router: parseAbi([
    `function swap(${keyTuple} key, (bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) params, (bool takeClaims, bool settleUsingBurn) testSettings, bytes hookData) payable returns (int256 delta)`,
    "function manager() view returns (address)",
  ]),
  quoter: parseAbi([
    `function quoteExactInputSingle((${keyTuple} poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)`,
  ]),
};
export const canonical = (x: unknown): unknown =>
  Array.isArray(x)
    ? x.map(canonical)
    : x && typeof x === "object"
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, canonical((x as Record<string, unknown>)[k])]),
        )
      : x;
export function relativePath(path: string) {
  return (
    /^[\w./-]+$/.test(path) &&
    !path.startsWith("/") &&
    !path.split("/").some((p) => p === ".." || p === ".")
  );
}
export async function loadDeployment() {
  const base = new URL("./", window.location.href);
  const response = await fetch(new URL("imd-deployment.json", base), {
    cache: "no-store",
  });
  if (!response.ok)
    throw Error("Deployment configuration could not load. Reload this page.");
  const d: Deployment = await response.json();
  if (
    d.version !== 1 ||
    !d.network ||
    d.chainId !== d.network.chainId ||
    BigInt(d.walletAddChain.chainId) !== BigInt(d.chainId)
  )
    throw Error(
      "Deployment chain configuration is inconsistent. Actions are locked.",
    );
  if (
    !d.network.rpcUrls.length ||
    d.network.rpcUrls.some((u) => !u.startsWith("https://"))
  )
    throw Error("Public RPC configuration is missing.");
  if (
    d.contracts.length !== 2 ||
    new Set(d.contracts.map((c) => c.name)).size !== 2 ||
    !isAddress(d.integrations.poolSwapTest)
  )
    throw Error("Deployment contract configuration is invalid.");
  if (d.pool.pairedCurrency !== zeroAddress)
    throw Error("This interface requires the attested native ETH pool.");
  const loaded = await Promise.all(
    d.contracts.map(async (c) => {
      if (!isAddress(c.address) || !relativePath(c.abiPath))
        throw Error("Invalid deployment address or ABI path.");
      const r = await fetch(new URL(c.abiPath, base));
      if (!r.ok) throw Error(`Cannot load ${c.name} ABI. Reload this page.`);
      const abi: Abi = await r.json();
      if (
        !Array.isArray(abi) ||
        keccak256(toHex(JSON.stringify(canonical(abi)))).slice(2) !== c.abiHash
      )
        throw Error(
          `ABI verification failed for ${c.name}. Actions are locked.`,
        );
      return { ...c, abi };
    }),
  );
  const token = loaded.find((c) => c.name === "NFTD");
  const hook = loaded.find((c) => c.name === "NFTHolderDiscountHook");
  if (!token || !hook) throw Error("Required launch contracts are missing.");
  const chain = defineChain({
    id: d.chainId,
    name: d.network.name,
    nativeCurrency: d.network.nativeCurrency,
    rpcUrls: { default: { http: d.network.rpcUrls } },
    blockExplorers: { default: { name: "Explorer", url: d.network.explorer } },
    testnet: d.network.testnet,
  });
  const key = {
    currency0: d.pool.pairedCurrency,
    currency1: token.address,
    fee: d.pool.fee,
    tickSpacing: d.pool.tickSpacing,
    hooks: hook.address,
  };
  const poolId = keccak256(
    encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "currency0", type: "address" },
            { name: "currency1", type: "address" },
            { name: "fee", type: "uint24" },
            { name: "tickSpacing", type: "int24" },
            { name: "hooks", type: "address" },
          ],
        },
      ],
      [key],
    ),
  );
  return { d, token, hook, chain, key, poolId };
}
export type Runtime = Awaited<ReturnType<typeof loadDeployment>>;
export function makeClient(r: Runtime, provider?: EIP1193Provider) {
  const transports = r.d.network.rpcUrls.map((url) =>
    http(url, { timeout: 10000, retryCount: 0 }),
  );
  return createPublicClient({
    chain: r.chain,
    transport: fallback(
      provider
        ? [...transports, custom(provider, { retryCount: 0 })]
        : transports,
      { retryCount: 0 },
    ),
  });
}
export type Client = ReturnType<typeof makeClient>;
