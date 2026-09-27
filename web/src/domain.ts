import { BaseError, formatUnits, parseUnits } from "viem";

export const MAX_INPUT = (1n << 127n) - 1n;
export function amountValue(value: string, decimals: number) {
  if (!/^\d+(\.\d*)?$/.test(value.trim()))
    throw Error("Enter a positive amount using digits and a decimal point.");
  if ((value.split(".")[1]?.length ?? 0) > decimals)
    throw Error(`Use at most ${decimals} decimal places.`);
  const amount = parseUnits(value, decimals);
  if (amount <= 0n || amount > MAX_INPUT)
    throw Error("Enter an amount greater than zero and within the swap limit.");
  return amount;
}
export function limitBps(value: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(value))
    throw Error("Enter a price movement limit from 0.1% to 50%.");
  const bps = Math.round(Number(value) * 100);
  if (bps < 10 || bps > 5000)
    throw Error("Enter a price movement limit from 0.1% to 50%.");
  return BigInt(bps);
}
export function sqrt(n: bigint) {
  if (n < 0n) throw Error("Negative square root");
  if (n < 2n) return n;
  let x = n,
    y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
export function priceLimit(price: bigint, bps: bigint, buy: boolean) {
  const limit = sqrt((price * price * (10000n + (buy ? -bps : bps))) / 10000n);
  const minimum = 4295128740n,
    maximum = 1461446703485210103287273052203988822378723970341n;
  const bounded = limit < minimum ? minimum : limit > maximum ? maximum : limit;
  if (buy ? bounded >= price : bounded <= price)
    throw Error("Price limit is outside the usable pool range.");
  return bounded;
}
export function unpackDelta(delta: bigint, buy: boolean) {
  const amount0 = BigInt.asIntN(128, delta >> 128n);
  const amount1 = BigInt.asIntN(128, delta);
  return {
    spent: -(buy ? amount0 : amount1),
    received: buy ? amount1 : amount0,
  };
}
export function format(value: bigint | undefined, decimals = 18, digits = 6) {
  if (value === undefined) return "—";
  const full = formatUnits(value, decimals);
  const [whole, fraction] = full.split(".");
  if (value > 0n && whole === "0" && fraction && Number(full) < 10 ** -digits)
    return `< ${10 ** -digits}`;
  return `${BigInt(whole).toLocaleString("en-US")}${fraction ? "." + fraction.slice(0, digits).replace(/0+$/, "") : ""}`.replace(
    /\.$/,
    "",
  );
}
export function explain(error: unknown) {
  const e = error as { code?: number; message?: string; shortMessage?: string };
  if (e.code === 4001 || /user rejected|user denied/i.test(e.message ?? ""))
    return "Request declined in your wallet. You can try again.";
  const text =
    error instanceof BaseError
      ? error.shortMessage
      : e.message || "Request failed. Check your connection and try again.";
  if (/NoLiquidity/.test(text))
    return "No liquidity is in range. Fees stay in the pool until liquidity returns. Refresh later.";
  return text;
}
export function isUnknownChain(error: unknown): boolean {
  const e = error as {
    code?: number;
    message?: string;
    cause?: unknown;
    data?: { originalError?: unknown };
  };
  return (
    e.code === 4902 ||
    /unknown chain|unrecognized chain|chain.*not.*added/i.test(
      e.message ?? "",
    ) ||
    Boolean(e.cause && isUnknownChain(e.cause)) ||
    Boolean(e.data?.originalError && isUnknownChain(e.data.originalError))
  );
}
