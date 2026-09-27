import { decodeEventLog, type Address, type Hex } from "viem";
import { protocol, type Client, type Runtime } from "./config";
import { unpackDelta } from "./domain";

export interface Snapshot {
  block: bigint;
  fetchedAt: number;
  collection: Address;
  decimals: number;
  symbol: string;
  sqrtPrice: bigint;
  liquidity: bigint;
  accrued: readonly [bigint, bigint];
  nftBalance?: bigint;
  feeBps?: bigint;
  nativeBalance?: bigint;
  tokenBalance?: bigint;
  allowance?: bigint;
}
export async function readSnapshot(
  r: Runtime,
  client: Client,
  account?: Address,
): Promise<Snapshot> {
  const chainId = await client.getChainId();
  if (chainId !== r.d.chainId)
    throw Error(
      "RPC returned the wrong chain. Transactions are locked; retry another connection.",
    );
  const block = await client.getBlockNumber({ cacheTime: 0 });
  const addresses = [
    ...r.d.contracts.map((c) => c.address),
    r.d.network.uniswapV4.poolManager,
    r.d.network.uniswapV4.quoter,
    r.d.network.uniswapV4.stateView,
    r.d.integrations.poolSwapTest,
  ];
  await Promise.all(
    addresses.map(async (address) => {
      const code = await client.getCode({ address, blockNumber: block });
      if (!code || code === "0x")
        throw Error(`No contract code at ${address}. Transactions are locked.`);
    }),
  );
  const readHook = (functionName: string, args?: readonly unknown[]) =>
    client.readContract({
      address: r.hook.address,
      abi: r.hook.abi,
      functionName,
      args,
      blockNumber: block,
    });
  const readToken = (functionName: string, args?: readonly unknown[]) =>
    client.readContract({
      address: r.token.address,
      abi: r.token.abi,
      functionName,
      args,
      blockNumber: block,
    });
  const [
    manager,
    routerManager,
    collection,
    decimals,
    symbol,
    slot,
    liquidity,
    accrued,
  ] = await Promise.all([
    readHook("poolManager"),
    client.readContract({
      address: r.d.integrations.poolSwapTest,
      abi: protocol.router,
      functionName: "manager",
      blockNumber: block,
    }),
    readHook("COLLECTION"),
    readToken("decimals"),
    readToken("symbol"),
    client.readContract({
      address: r.d.network.uniswapV4.stateView,
      abi: protocol.stateView,
      functionName: "getSlot0",
      args: [r.poolId],
      blockNumber: block,
    }),
    client.readContract({
      address: r.d.network.uniswapV4.stateView,
      abi: protocol.stateView,
      functionName: "getLiquidity",
      args: [r.poolId],
      blockNumber: block,
    }),
    readHook("accrued", [r.poolId]),
  ]);
  if (
    String(manager).toLowerCase() !==
      r.d.network.uniswapV4.poolManager.toLowerCase() ||
    routerManager.toLowerCase() !== String(manager).toLowerCase()
  )
    throw Error("PoolManager binding mismatch. Transactions are locked.");
  if (
    String(collection).toLowerCase() !==
    r.d.network.uniswapV4.positionManager.toLowerCase()
  )
    throw Error("Collection binding mismatch. Transactions are locked.");
  if (Number(decimals) !== 18 || symbol !== "NFTD")
    throw Error("Token metadata differs from the deployed source.");
  const snapshot: Snapshot = {
    block,
    fetchedAt: Date.now(),
    collection: collection as Address,
    decimals: Number(decimals),
    symbol: String(symbol),
    sqrtPrice: slot[0],
    liquidity,
    accrued: accrued as readonly [bigint, bigint],
  };
  if (snapshot.sqrtPrice === 0n)
    throw Error(
      "The pool is not initialized. Refresh after the pool is opened.",
    );
  if (account) {
    const [nftBalance, feeBps, nativeBalance, tokenBalance, allowance] =
      await Promise.all([
        client
          .readContract({
            address: snapshot.collection,
            abi: protocol.collection,
            functionName: "balanceOf",
            args: [account],
            blockNumber: block,
          })
          .catch(() => undefined),
        readHook("feeBpsFor", [account]),
        client.getBalance({ address: account, blockNumber: block }),
        readToken("balanceOf", [account]),
        readToken("allowance", [account, r.d.integrations.poolSwapTest]),
      ]);
    Object.assign(snapshot, {
      nftBalance,
      feeBps,
      nativeBalance,
      tokenBalance,
      allowance,
    });
  }
  return snapshot;
}

export interface Activity {
  hash: Hex;
  index: number;
  block: bigint;
  kind: "swap" | "donation";
  discounted?: boolean;
  currency?: Address;
  fee?: bigint;
  amount0?: bigint;
  amount1?: bigint;
}
export interface History {
  fees0: bigint;
  fees1: bigint;
  swaps: number;
  discounted: number;
  donated0: bigint;
  donated1: bigint;
  from: bigint;
  through: bigint;
  target: bigint;
  complete: boolean;
  activity: Activity[];
}
export async function scanHistory(
  r: Runtime,
  client: Client,
  signal: AbortSignal,
  progress: (h: History) => void,
) {
  if ((await client.getChainId()) !== r.d.chainId)
    throw Error(
      "RPC returned the wrong chain. History is unavailable until the connection is corrected.",
    );
  const latest = await client.getBlockNumber({ cacheTime: 0 });
  if (latest < BigInt(r.d.deploymentBlock))
    throw Error("RPC is behind the deployment block. Try refreshing later.");
  const target = latest > 6n ? latest - 6n : 0n;
  const anchor = await client.getBlock({ blockNumber: target });
  const h: History = {
    fees0: 0n,
    fees1: 0n,
    swaps: 0,
    discounted: 0,
    donated0: 0n,
    donated1: 0n,
    from: BigInt(r.d.deploymentBlock),
    through: BigInt(r.d.deploymentBlock) - 1n,
    target,
    complete: false,
    activity: [],
  };
  let size = 2000n;
  const seen = new Set<string>();
  for (let from = h.from; from <= target;) {
    signal.throwIfAborted();
    const to = from + size - 1n > target ? target : from + size - 1n;
    let logs;
    try {
      logs = await client.getLogs({
        address: r.hook.address,
        fromBlock: from,
        toBlock: to,
      });
    } catch (error) {
      if (size > 125n) {
        size /= 2n;
        continue;
      }
      throw error;
    }
    signal.throwIfAborted();
    for (const log of logs) {
      if (
        log.removed ||
        !log.transactionHash ||
        log.logIndex === null ||
        !log.blockNumber
      )
        continue;
      const id = `${log.transactionHash}:${log.logIndex}`;
      if (seen.has(id)) continue;
      seen.add(id);
      let event: { eventName: string; args: Record<string, unknown> };
      try {
        event = decodeEventLog({
          abi: r.hook.abi,
          data: log.data,
          topics: log.topics,
          strict: true,
        }) as typeof event;
      } catch {
        continue;
      }
      const a = event.args as Record<string, unknown>;
      if (a.poolId !== r.poolId) continue;
      const common = {
        hash: log.transactionHash,
        index: log.logIndex,
        block: log.blockNumber,
      };
      if (event.eventName === "FeeCharged") {
        const currency = a.currency as Address,
          fee = a.fee as bigint;
        if (currency.toLowerCase() === r.key.currency0.toLowerCase())
          h.fees0 += fee;
        else if (currency.toLowerCase() === r.key.currency1.toLowerCase())
          h.fees1 += fee;
        else throw Error("A fee event contains an unexpected currency.");
        h.swaps++;
        if (a.discounted) h.discounted++;
        h.activity.push({
          ...common,
          kind: "swap",
          currency,
          fee,
          discounted: Boolean(a.discounted),
        });
      } else if (event.eventName === "FeesDonated") {
        h.donated0 += a.amount0 as bigint;
        h.donated1 += a.amount1 as bigint;
        h.activity.push({
          ...common,
          kind: "donation",
          amount0: a.amount0 as bigint,
          amount1: a.amount1 as bigint,
        });
      }
    }
    h.activity = h.activity
      .sort((a, b) => Number(b.block - a.block) || b.index - a.index)
      .slice(0, 6);
    h.through = to;
    progress({ ...h, activity: [...h.activity] });
    from = to + 1n;
  }
  signal.throwIfAborted();
  const end = await client.getBlock({ blockNumber: target });
  if (end.hash !== anchor.hash)
    throw Error(
      "Chain history changed while loading. Refresh to rebuild the totals.",
    );
  h.complete = true;
  progress({ ...h });
}

export function swapCall(
  r: Runtime,
  account: Address,
  buy: boolean,
  amount: bigint,
  limit: bigint,
) {
  return {
    account,
    address: r.d.integrations.poolSwapTest,
    abi: protocol.router,
    functionName: "swap" as const,
    args: [
      r.key,
      { zeroForOne: buy, amountSpecified: -amount, sqrtPriceLimitX96: limit },
      { takeClaims: false, settleUsingBurn: false },
      "0x",
    ] as const,
    value: buy ? amount : 0n,
  };
}
export async function simulateSwap(
  r: Runtime,
  client: Client,
  account: Address,
  buy: boolean,
  amount: bigint,
  limit: bigint,
) {
  const simulation = await client.simulateContract(
    swapCall(r, account, buy, amount, limit),
  );
  const result = unpackDelta(simulation.result, buy);
  if (result.spent <= 0n || result.received <= 0n || result.spent > amount)
    throw Error(
      "No usable fill inside this price limit. Adjust the amount or price limit and quote again.",
    );
  return { ...result, request: simulation.request };
}
