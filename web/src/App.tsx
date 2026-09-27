import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createWalletClient,
  custom,
  formatUnits,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { loadDeployment, makeClient, protocol, type Runtime } from "./config";
import { amountValue, explain, format, limitBps, priceLimit } from "./domain";
import {
  readSnapshot,
  scanHistory,
  simulateSwap,
  type History,
  type Snapshot,
} from "./services";
import {
  assertWallet,
  browserWallet,
  switchNetwork,
  type WalletProvider,
} from "./wallet";

type Quote = {
  amount: bigint;
  buy: boolean;
  limit: bigint;
  quoted: bigint;
  received?: bigint;
  spent?: bigint;
  at: number;
  needsApproval: boolean;
};
type Transaction = {
  hash: Hex;
  label: string;
  state: "pending" | "confirmed" | "reverted" | "unknown";
};
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
function Arrow({ down = false }: { down?: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path d={down ? "M12 4v16m-6-6 6 6 6-6" : "M5 12h14m-6-6 6 6-6 6"} />
    </svg>
  );
}
function External({
  children,
  href,
  className = "",
}: {
  children: ReactNode;
  href: string;
  className?: string;
}) {
  return (
    <a className={className} href={href} target="_blank" rel="noreferrer">
      {children}
      <span aria-hidden="true"> ↗</span>
      <span className="sr-only"> (opens a new tab)</span>
    </a>
  );
}
function Amount({
  value,
  decimals = 18,
  unit,
}: {
  value?: bigint;
  decimals?: number;
  unit: string;
}) {
  return (
    <span
      title={
        value === undefined
          ? undefined
          : `${formatUnits(value, decimals)} ${unit}`
      }
    >
      {format(value, decimals)} <small>{unit}</small>
    </span>
  );
}

export default function App() {
  const [runtime, setRuntime] = useState<Runtime>();
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    let active = true;
    loadDeployment()
      .then((r) => {
        if (active) setRuntime(r);
      })
      .catch((e) => {
        if (active) setLoadError(explain(e));
      });
    return () => {
      active = false;
    };
  }, []);
  if (!runtime)
    return (
      <div className="boot">
        <div className="brand">
          <span className="brandmark" aria-hidden="true">
            h.
          </span>{" "}
          Holder Discount
        </div>
        <main>
          <h1>
            {loadError
              ? "Unable to verify this deployment"
              : "Opening the pool…"}
          </h1>
          <p role={loadError ? "alert" : "status"}>
            {loadError ||
              "Loading the deployment and checking the contract interfaces."}
          </p>
          {loadError && (
            <button onClick={() => window.location.reload()}>
              Reload configuration
            </button>
          )}
        </main>
      </div>
    );
  return <Pool runtime={runtime} />;
}

function Pool({ runtime: r }: { runtime: Runtime }) {
  const [provider, setProvider] = useState<WalletProvider>();
  const [account, setAccount] = useState<Address>();
  const [walletChain, setWalletChain] = useState<number>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [readError, setReadError] = useState("");
  const [reading, setReading] = useState(false);
  const [history, setHistory] = useState<History>();
  const [historyError, setHistoryError] = useState("");
  const [historyVersion, setHistoryVersion] = useState(0);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [tx, setTx] = useState<Transaction>();
  const [buy, setBuy] = useState(true);
  const [amount, setAmount] = useState("");
  const [tolerance, setTolerance] = useState("5");
  const [formError, setFormError] = useState("");
  const [invalidField, setInvalidField] = useState<"amount" | "tolerance">();
  const [quote, setQuote] = useState<Quote>();
  const [accepted, setAccepted] = useState(false);
  const [donationReview, setDonationReview] = useState(false);
  const [now, setNow] = useState(Date.now());
  const generation = useRef(0),
    readGeneration = useRef(0),
    actionLock = useRef(false);
  const correctChain = walletChain === r.d.chainId;
  const client = useMemo(
    () => makeClient(r, correctChain ? provider : undefined),
    [r, provider, correctChain],
  );
  const explorer = r.d.network.explorer;
  const walletReady = Boolean(account && provider && correctChain);
  const verified = Boolean(
    snapshot && now - snapshot.fetchedAt < 90000 && !readError,
  );
  const canAct = walletReady && verified && !busy;
  const quoteFresh = Boolean(quote && now - quote.at < 60000);
  const currentInputUnit = buy ? "ETH" : "NFTD",
    currentOutputUnit = buy ? "NFTD" : "ETH";

  const invalidate = useCallback(() => {
    generation.current++;
    readGeneration.current++;
    setSnapshot(undefined);
    setQuote(undefined);
    setAccepted(false);
    setDonationReview(false);
    setTx(undefined);
    setNotice("");
    setError("");
  }, []);
  useEffect(() => {
    if (!provider) return;
    const accountsChanged = (...args: unknown[]) => {
      invalidate();
      const a = args[0] as string[];
      setAccount(a[0] && isAddress(a[0]) ? a[0] : undefined);
    };
    const chainChanged = (...args: unknown[]) => {
      invalidate();
      setWalletChain(Number(args[0]));
    };
    const disconnected = () => {
      invalidate();
      setAccount(undefined);
      setWalletChain(undefined);
    };
    provider.on("accountsChanged", accountsChanged);
    provider.on("chainChanged", chainChanged);
    provider.on("disconnect", disconnected);
    return () => {
      provider.removeListener("accountsChanged", accountsChanged);
      provider.removeListener("chainChanged", chainChanged);
      provider.removeListener("disconnect", disconnected);
    };
  }, [provider, invalidate]);

  const refresh = useCallback(async () => {
    const id = ++readGeneration.current;
    setReading(true);
    try {
      const state = await readSnapshot(r, client, account);
      if (id === readGeneration.current) {
        setSnapshot(state);
        setReadError("");
      }
      return state;
    } catch (e) {
      if (id === readGeneration.current) {
        setReadError(explain(e));
        setSnapshot(undefined);
        setQuote(undefined);
        setDonationReview(false);
      }
      throw e;
    } finally {
      if (id === readGeneration.current) setReading(false);
    }
  }, [r, client, account]);
  useEffect(() => {
    void refresh().catch(() => {});
    const timer = setInterval(() => {
      if (!actionLock.current) void refresh().catch(() => {});
    }, 30000);
    return () => {
      clearInterval(timer);
      readGeneration.current++;
    };
  }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setHistory(undefined);
    setHistoryError("");
    scanHistory(r, client, controller.signal, (h) => {
      if (!controller.signal.aborted) setHistory(h);
    }).catch((e) => {
      if (!controller.signal.aborted) setHistoryError(explain(e));
    });
    return () => controller.abort();
  }, [r, client, historyVersion]);

  async function action(
    label: string,
    callback: (guard: () => void) => Promise<void>,
  ) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(label);
    setError("");
    setNotice("");
    const epoch = generation.current;
    const guard = () => {
      if (generation.current !== epoch)
        throw Error("Your wallet changed. Review the action again.");
    };
    try {
      await callback(guard);
    } catch (e) {
      setNotice("");
      setError(explain(e));
    } finally {
      actionLock.current = false;
      setBusy("");
    }
  }
  async function connect() {
    await action("Connecting wallet…", async () => {
      const p = browserWallet();
      if (!p)
        throw Error(
          "No browser wallet found. Open this page in an Ethereum wallet browser or install a browser wallet, then try again.",
        );
      const accounts = await p.request({ method: "eth_requestAccounts" });
      if (!accounts[0])
        throw Error(
          "Your wallet did not share an account. Try connecting again.",
        );
      const chain = Number(await p.request({ method: "eth_chainId" }));
      invalidate();
      setProvider(p);
      setAccount(accounts[0]);
      setWalletChain(chain);
    });
  }
  async function switchChain() {
    if (!provider) return;
    await action(`Switching to ${r.d.network.name}…`, async () => {
      const chain = await switchNetwork(provider, r.d);
      invalidate();
      setWalletChain(chain);
    });
  }
  function disconnect() {
    invalidate();
    setAccount(undefined);
    setWalletChain(undefined);
    setProvider(undefined);
  }
  async function preflight(guard: () => void) {
    if (!account || !provider || !correctChain)
      throw Error(`Connect your wallet on ${r.d.network.name} first.`);
    await assertWallet(provider, r.d, account);
    guard();
    const state = await refresh();
    guard();
    return state;
  }
  async function confirmReceipt(hash: Hex, label: string) {
    setTx({ hash, label, state: "pending" });
    setNotice(`${label} submitted. Waiting for confirmation…`);
    try {
      const receipt = await client.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        timeout: 120000,
      });
      setTx({
        hash,
        label,
        state: receipt.status === "success" ? "confirmed" : "reverted",
      });
      if (receipt.status !== "success")
        throw Error(
          `${label} reverted. Check the transaction in the explorer, then refresh.`,
        );
      setNotice(`${label} confirmed.`);
      await refresh().catch(() => {});
      setHistoryVersion((v) => v + 1);
    } catch (e) {
      setTx((current) =>
        current?.state === "pending"
          ? { ...current, state: "unknown" }
          : current,
      );
      throw e;
    }
  }
  function resetTrade() {
    setQuote(undefined);
    setAccepted(false);
    setFormError("");
    setInvalidField(undefined);
  }
  async function getQuote() {
    setFormError("");
    setInvalidField(undefined);
    let raw: bigint, bps: bigint;
    try {
      raw = amountValue(
        amount,
        buy ? r.d.network.nativeCurrency.decimals : (snapshot?.decimals ?? 18),
      );
    } catch (e) {
      setFormError(explain(e));
      setInvalidField("amount");
      document.getElementById("amount")?.focus();
      return;
    }
    try {
      bps = limitBps(tolerance);
    } catch (e) {
      setFormError(explain(e));
      setInvalidField("tolerance");
      document.getElementById("tolerance")?.focus();
      return;
    }
    setQuote(undefined);
    setAccepted(false);
    await action("Getting a live quote…", async (guard) => {
      const state = await preflight(guard);
      const balance = buy ? state.nativeBalance : state.tokenBalance;
      if (balance === undefined || raw > balance)
        throw Error(
          `Insufficient ${currentInputUnit} balance. Lower the amount and quote again.`,
        );
      const { result } = await client.simulateContract({
        address: r.d.network.uniswapV4.quoter,
        abi: protocol.quoter,
        functionName: "quoteExactInputSingle",
        args: [
          { poolKey: r.key, zeroForOne: buy, exactAmount: raw, hookData: "0x" },
        ],
        account: account!,
      });
      guard();
      if (result[0] <= 0n)
        throw Error(
          "No output quoted. Try a different amount or refresh the pool.",
        );
      const limit = priceLimit(state.sqrtPrice, bps, buy);
      const needsApproval = !buy && (state.allowance ?? 0n) < raw;
      const sim = needsApproval
        ? undefined
        : await simulateSwap(r, client, account!, buy, raw, limit);
      guard();
      setQuote({
        amount: raw,
        buy,
        limit,
        quoted: result[0],
        spent: sim?.spent,
        received: sim?.received,
        at: Date.now(),
        needsApproval,
      });
      setNotice(
        needsApproval
          ? "Quote ready. Approve NFTD before the final swap simulation."
          : "Simulation ready. Review the amounts and price limit before signing.",
      );
    });
  }
  async function approve() {
    if (!quote) return;
    await action("Preparing NFTD approval…", async (guard) => {
      await preflight(guard);
      const { request } = await client.simulateContract({
        account: account!,
        address: r.token.address,
        abi: r.token.abi,
        functionName: "approve",
        args: [r.d.integrations.poolSwapTest, quote.amount],
      });
      await assertWallet(provider!, r.d, account!);
      guard();
      const wallet = createWalletClient({
        account: account!,
        chain: r.chain,
        transport: custom(provider!),
      });
      setNotice(
        "Approve only the entered NFTD amount for PoolSwapTest in your wallet.",
      );
      const hash = await wallet.writeContract(request);
      setQuote(undefined);
      setAccepted(false);
      await confirmReceipt(hash, "NFTD approval");
      setNotice(
        "NFTD approval confirmed. Get a new quote to simulate your swap.",
      );
    });
  }
  async function swap() {
    if (!quote || !accepted || !quoteFresh || quote.needsApproval) return;
    await action("Checking your swap…", async (guard) => {
      await preflight(guard);
      if (Date.now() - quote.at >= 60000)
        throw Error("This quote expired. Get a new quote before signing.");
      const sim = await simulateSwap(
        r,
        client,
        account!,
        quote.buy,
        quote.amount,
        quote.limit,
      );
      if (
        sim.received < (quote.received ?? quote.quoted) ||
        sim.spent > (quote.spent ?? quote.amount)
      ) {
        setQuote(undefined);
        throw Error(
          "The simulated amounts changed. Get a new quote and review them again.",
        );
      }
      await assertWallet(provider!, r.d, account!);
      guard();
      const wallet = createWalletClient({
        account: account!,
        chain: r.chain,
        transport: custom(provider!),
      });
      setNotice(
        "Confirm the swap in your wallet. The price limit applies; the received amount is not guaranteed.",
      );
      const hash = await wallet.writeContract(sim.request);
      setQuote(undefined);
      setAccepted(false);
      await confirmReceipt(hash, "Swap");
    });
  }
  async function donate() {
    await action(
      donationReview ? "Checking your donation…" : "Previewing the donation…",
      async (guard) => {
        const state = await preflight(guard);
        if (state.liquidity === 0n)
          throw Error(
            "No liquidity is in range. Fees remain available for a later donation.",
          );
        if (state.accrued[0] === 0n && state.accrued[1] === 0n)
          throw Error(
            "There are no accrued fees to donate. Refresh after a swap.",
          );
        const { request } = await client.simulateContract({
          account: account!,
          address: r.hook.address,
          abi: r.hook.abi,
          functionName: "donateFees",
          args: [r.key],
        });
        guard();
        if (!donationReview) {
          setDonationReview(true);
          setNotice(
            "Donation preview ready. Existing pool fees go to in-range liquidity providers. You pay only network gas.",
          );
          return;
        }
        await assertWallet(provider!, r.d, account!);
        guard();
        const wallet = createWalletClient({
          account: account!,
          chain: r.chain,
          transport: custom(provider!),
        });
        const hash = await wallet.writeContract(request);
        setDonationReview(false);
        await confirmReceipt(hash, "Fee donation");
      },
    );
  }
  const gating = !account
    ? "Connect your wallet to quote and trade."
    : !correctChain
      ? `Switch your wallet to ${r.d.network.name} to continue.`
      : !verified
        ? "Waiting for verified pool state. Refresh if this takes too long."
        : "";
  const discountedShare =
    history?.complete && history.swaps
      ? `${((100 * history.discounted) / history.swaps).toFixed(1)}%`
      : history?.complete
        ? "No swaps yet"
        : "—";
  const poolPrice = snapshot
    ? Number(
        formatUnits(
          (snapshot.sqrtPrice * snapshot.sqrtPrice * 10n ** 18n) / (1n << 192n),
          snapshot.decimals,
        ),
      )
    : undefined;

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="site-header wrap">
        <a href="#" className="brand" aria-label="Holder Discount home">
          <span className="brandmark" aria-hidden="true">
            h.
          </span>
          <span>
            Holder<span className="brand-secondary"> Discount</span>
          </span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#pool">Pool</a>
          <a href="#collection">Collection</a>
          <a href="#activity">Activity</a>
        </nav>
        <div className="wallet-zone">
          <span className="network-tag">
            <span aria-hidden="true" className="dot" />
            {r.d.network.name} testnet
          </span>
          {account ? (
            <button
              className="wallet-button"
              onClick={disconnect}
              disabled={Boolean(busy)}
              title={account}
            >
              Disconnect {short(account)}
            </button>
          ) : (
            <button
              className="wallet-button"
              onClick={connect}
              disabled={Boolean(busy)}
            >
              Connect wallet <Arrow />
            </button>
          )}
        </div>
      </header>
      <main id="main" className="wrap">
        <section className="intro" aria-labelledby="page-title">
          <div>
            <p className="eyebrow">
              <span className="little-star" aria-hidden="true">
                ✳
              </span>{" "}
              A little ownership. A lower fee.
            </p>
            <h1 id="page-title">
              More for holders.
              <br />
              <span>Back to the pool.</span>
            </h1>
            <p className="intro-copy">
              Hold a Uniswap v4 Positions NFT and cut your hook fee in half.
              Every collected fee can go back to liquidity providers.
            </p>
          </div>
          <div className="intro-note">
            <span className="pill">ETH / NFTD</span>
            <p>
              A holder-powered pool
              <br />
              on {r.d.network.name}.
            </p>
            <span className="tiny">Uniswap v4 · 0.30% LP fee</span>
          </div>
        </section>
        {account && !correctChain && (
          <div className="warning network-warning" role="status">
            <div>
              <strong>Your wallet is on another network</strong>
              <p>
                This pool is on {r.d.network.name}. Your wallet can add the
                network if needed.
              </p>
            </div>
            <button onClick={switchChain} disabled={Boolean(busy)}>
              Switch to {r.d.network.name}
            </button>
          </div>
        )}
        <div className="live-line">
          <span>
            <span
              className={`dot ${snapshot ? "" : "muted-dot"}`}
              aria-hidden="true"
            />
            {reading
              ? "Reading pool state…"
              : snapshot
                ? `RPC verified · Block ${snapshot.block.toLocaleString("en-US")}`
                : "Pool state unavailable"}
          </span>
          <button
            className="text-button"
            disabled={reading || Boolean(busy)}
            onClick={() => void refresh().catch(() => {})}
          >
            Refresh state <span aria-hidden="true">↻</span>
          </button>
        </div>
        {readError && (
          <div className="warning" role="alert">
            <strong>Unable to read the pool</strong>
            <p>{readError}</p>
            <p>
              Check your connection and use “Refresh state” to retry. Actions
              remain locked.
            </p>
          </div>
        )}
        <div className="main-grid" id="pool">
          <div className="overview">
            <section
              className="membership panel"
              id="collection"
              aria-labelledby="collection-title"
            >
              <div className="collection-copy">
                <p className="eyebrow">The holder advantage</p>
                <h2 id="collection-title">Your NFT. Your discount.</h2>
                <p>One position NFT brings your hook fee from 1% to 0.5%.</p>
                <External
                  href={`${explorer}/address/${snapshot?.collection ?? r.d.network.uniswapV4.positionManager}`}
                >
                  Uniswap v4 Positions NFT
                </External>
                <div className="collection-details">
                  <div>
                    <span>Your NFT balance</span>
                    <strong>
                      {account
                        ? snapshot?.nftBalance === undefined
                          ? "Unavailable"
                          : snapshot.nftBalance.toLocaleString("en-US")
                        : "Connect to view"}
                    </strong>
                  </div>
                  <div>
                    <span>Your hook fee</span>
                    <strong>
                      {account && snapshot?.feeBps !== undefined
                        ? `${Number(snapshot.feeBps) / 100}%`
                        : "—"}
                      {snapshot?.feeBps === 50n && (
                        <span className="holder-badge">Holder rate</span>
                      )}
                    </strong>
                  </div>
                </div>
              </div>
              <div className="nft-art" aria-hidden="true">
                <div className="ticket">
                  <div className="ticket-top">
                    <span>POSITION / 04</span>
                    <span>↗</span>
                  </div>
                  <div className="flower">
                    <i />
                    <i />
                    <i />
                    <i />
                  </div>
                  <div className="ticket-bottom">
                    <b>
                      50%<small>less hook fee</small>
                    </b>
                    <span>v4</span>
                  </div>
                </div>
              </div>
              <p className="collection-footnote">
                Fee applies to swap output for these exact-input trades, in
                addition to the pool’s LP fee.
              </p>
            </section>
            <section className="metrics" aria-label="Lifetime fee statistics">
              <article className="metric">
                <span className="metric-label">Lifetime fees collected</span>
                <strong>
                  <Amount
                    value={history?.complete ? history.fees0 : undefined}
                    unit="ETH"
                  />
                </strong>
                <span className="second-value">
                  <Amount
                    value={history?.complete ? history.fees1 : undefined}
                    unit="NFTD"
                  />
                </span>
                <span className="tiny">Counted separately by currency</span>
              </article>
              <article className="metric">
                <span className="metric-label">Swaps with a discount</span>
                <strong>{discountedShare}</strong>
                <span className="second-value">
                  {history?.complete
                    ? `${history.discounted.toLocaleString("en-US")} of ${history.swaps.toLocaleString("en-US")} swaps`
                    : "Loading event history"}
                </span>
                <span className="tiny">
                  Share of swaps, including zero-fee swaps
                </span>
              </article>
            </section>
            <section
              className="donation panel"
              aria-labelledby="donation-title"
            >
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Give back, permissionlessly</p>
                  <h2 id="donation-title">Put fees back to work.</h2>
                </div>
                <span className="circle-arrow" aria-hidden="true">
                  ↗
                </span>
              </div>
              <p>
                Return accrued fees to liquidity providers currently in range.
                Anyone can trigger a donation.
              </p>
              <div className="accrued">
                <div>
                  <span>Ready to donate</span>
                  <strong>
                    <Amount value={snapshot?.accrued[0]} unit="ETH" />
                  </strong>
                </div>
                <span aria-hidden="true">+</span>
                <div>
                  <span>From this pool</span>
                  <strong>
                    <Amount value={snapshot?.accrued[1]} unit="NFTD" />
                  </strong>
                </div>
              </div>
              {donationReview && (
                <p className="review-note">
                  This sends existing pool fees to in-range LPs. Nothing goes to
                  your wallet. You pay network gas; the final donated total may
                  change before inclusion.
                </p>
              )}
              <div className="donation-action">
                <button
                  disabled={
                    !canAct ||
                    snapshot?.liquidity === 0n ||
                    snapshot?.accrued.every((n) => n === 0n)
                  }
                  onClick={donate}
                >
                  {donationReview
                    ? "Confirm fee donation"
                    : "Donate accrued fees"}{" "}
                  <Arrow />
                </button>
                {donationReview && (
                  <button
                    className="text-button"
                    disabled={Boolean(busy)}
                    onClick={() => setDonationReview(false)}
                  >
                    Cancel
                  </button>
                )}
                <span className="tiny">
                  {gating ||
                    (snapshot?.liquidity === 0n
                      ? "No liquidity in range. Fees are preserved."
                      : snapshot?.accrued.every((n) => n === 0n)
                        ? "No accrued fees yet. Check back after a swap."
                        : "Only gas comes from your wallet.")}
                </span>
              </div>
            </section>
          </div>
          <section className="swap panel" aria-labelledby="swap-title">
            <div className="section-heading">
              <h2 id="swap-title">Swap</h2>
              <span className="pill">Exact input</span>
            </div>
            <div className="direction" role="group" aria-label="Swap direction">
              <button
                aria-pressed={buy}
                disabled={Boolean(busy)}
                onClick={() => {
                  setBuy(true);
                  resetTrade();
                }}
              >
                Buy NFTD
              </button>
              <button
                aria-pressed={!buy}
                disabled={Boolean(busy)}
                onClick={() => {
                  setBuy(false);
                  resetTrade();
                }}
              >
                Sell NFTD
              </button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void getQuote();
              }}
            >
              <div className="amount-box">
                <label htmlFor="amount">You pay up to</label>
                <div className="amount-row">
                  <input
                    id="amount"
                    name="amount"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0.00"
                    value={amount}
                    disabled={Boolean(busy)}
                    aria-invalid={invalidField === "amount"}
                    aria-describedby="amount-help form-error"
                    onChange={(e) => {
                      setAmount(e.target.value);
                      resetTrade();
                    }}
                  />
                  <span className="token">
                    <span
                      className={`token-icon ${buy ? "eth" : ""}`}
                      aria-hidden="true"
                    >
                      {buy ? "♦" : "h"}
                    </span>
                    {currentInputUnit}
                  </span>
                </div>
                <p id="amount-help">
                  Balance:{" "}
                  <Amount
                    value={
                      buy ? snapshot?.nativeBalance : snapshot?.tokenBalance
                    }
                    unit={currentInputUnit}
                  />
                </p>
              </div>
              <div className="flow-arrow" aria-hidden="true">
                <Arrow down />
              </div>
              <div className="amount-box receive">
                <span className="input-label">Estimated receive</span>
                <div className="amount-row">
                  <output aria-label="Estimated received amount">
                    {quote ? format(quote.received ?? quote.quoted) : "—"}
                  </output>
                  <span className="token">
                    <span
                      className={`token-icon ${buy ? "" : "eth"}`}
                      aria-hidden="true"
                    >
                      {buy ? "h" : "♦"}
                    </span>
                    {currentOutputUnit}
                  </span>
                </div>
                <p>
                  {quote?.needsApproval
                    ? "Quoter estimate · final simulation after approval"
                    : "After LP and hook fees · before network gas"}
                </p>
              </div>
              <div className="tolerance">
                <label htmlFor="tolerance">
                  Price movement limit <span className="tiny">0.1–50%</span>
                </label>
                <div>
                  <input
                    id="tolerance"
                    aria-invalid={invalidField === "tolerance"}
                    name="price-movement-limit"
                    inputMode="decimal"
                    value={tolerance}
                    disabled={Boolean(busy)}
                    aria-describedby="price-help form-error"
                    onChange={(e) => {
                      setTolerance(e.target.value);
                      resetTrade();
                    }}
                  />
                  <span>%</span>
                </div>
              </div>
              <p id="price-help" className="tiny">
                Bounds the pool’s price from the current spot price. It may fill
                only part of your input.
              </p>
              <p id="form-error" className="field-error" role="alert">
                {formError}
              </p>
              <div className="swap-facts">
                <div>
                  <span>Spot price</span>
                  <span>
                    {poolPrice === undefined
                      ? "—"
                      : `1 ETH ≈ ${poolPrice.toLocaleString("en-US", { maximumSignificantDigits: 6 })} NFTD`}
                  </span>
                </div>
                <div>
                  <span>Pool LP fee</span>
                  <span>{r.d.pool.fee / 10000}%</span>
                </div>
                <div>
                  <span>Your hook fee</span>
                  <span>
                    {snapshot?.feeBps !== undefined
                      ? `${Number(snapshot.feeBps) / 100}% of output`
                      : "Connect to view"}
                  </span>
                </div>
                {quote?.spent !== undefined && (
                  <div>
                    <span>Simulated spend</span>
                    <span>
                      <Amount value={quote.spent} unit={currentInputUnit} />
                    </span>
                  </div>
                )}
              </div>
              <div className="route-note">
                <strong>Test router · PoolSwapTest</strong>
                <p>
                  No on-chain minimum received amount or deadline. A price limit
                  can produce a partial fill; unused ETH is refunded.
                </p>
              </div>
              {quote && (
                <>
                  <p className="tiny quote-expiry">
                    {quoteFresh
                      ? `Quote expires in ${Math.max(0, 60 - Math.floor((now - quote.at) / 1000))}s`
                      : "Quote expired. Get a new quote."}
                    {quote.spent !== undefined &&
                      quote.spent < quote.amount &&
                      " · Partial fill in simulation"}
                  </p>
                  {quote.needsApproval ? (
                    <p className="review-note">
                      Step 1: approve exactly {format(quote.amount)} NFTD for
                      PoolSwapTest. Step 2: get a new quote, then confirm the
                      swap.
                    </p>
                  ) : (
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={accepted}
                        disabled={Boolean(busy)}
                        onChange={(e) => setAccepted(e.target.checked)}
                      />
                      I understand the received amount is not guaranteed and
                      this trade may partially fill.
                    </label>
                  )}
                </>
              )}
              {quote?.needsApproval ? (
                <button
                  type="button"
                  className="primary wide"
                  disabled={!canAct || !quoteFresh}
                  onClick={approve}
                >
                  Approve {format(quote.amount)} NFTD <Arrow />
                </button>
              ) : quote && quoteFresh ? (
                <button
                  type="button"
                  className="primary wide"
                  disabled={!canAct || !accepted}
                  onClick={swap}
                >
                  Confirm swap <Arrow />
                </button>
              ) : (
                <button
                  type="submit"
                  className="primary wide"
                  disabled={!canAct}
                >
                  {busy.includes("quote") ? "Getting quote…" : "Get a quote"}{" "}
                  <Arrow />
                </button>
              )}
              {quote && (
                <button
                  type="submit"
                  className="text-button wide"
                  disabled={!canAct}
                >
                  Refresh quote
                </button>
              )}
              <p className="gating">
                {gating ||
                  "Review in your wallet before any transaction is sent."}
              </p>
            </form>
            <div className="swap-footer">
              <span className="dot" aria-hidden="true" />
              Sepolia assets have no intended monetary value.
            </div>
          </section>
        </div>
        <section
          className="status-panel"
          aria-label="Wallet and transaction status"
        >
          <p role="status">
            {busy ||
              notice ||
              (account
                ? `Connected: ${account}`
                : "Your wallet stays in control. Connect to see your balance and fee.")}
          </p>
          <p role="alert" className="field-error">
            {error}
          </p>
          {tx && (
            <p>
              <External href={`${explorer}/tx/${tx.hash}`}>
                {tx.label}: {tx.state} · {short(tx.hash)}
              </External>
              {tx.state === "unknown" &&
                " — Confirmation is unknown. Check the explorer before retrying."}
            </p>
          )}
        </section>
        <section
          className="activity-section"
          id="activity"
          aria-labelledby="activity-title"
        >
          <div className="section-heading">
            <div>
              <p className="eyebrow">On-chain, in the open</p>
              <h2 id="activity-title">Pool activity</h2>
            </div>
            <button
              className="text-button"
              disabled={Boolean(busy)}
              onClick={() => setHistoryVersion((v) => v + 1)}
            >
              Refresh history <span aria-hidden="true">↻</span>
            </button>
          </div>
          <p className="tiny history-note">
            {history?.complete
              ? `Lifetime history from block ${history.from.toLocaleString("en-US")} through ${history.target.toLocaleString("en-US")} · six-block confirmation buffer.`
              : history
                ? `Loading history: blocks ${history.from.toLocaleString("en-US")}–${history.through.toLocaleString("en-US")} of ${history.target.toLocaleString("en-US")}. Totals stay hidden until complete.`
                : "Loading events from the deployment block. Lifetime totals appear after the full history is verified."}
          </p>
          {historyError && (
            <p role="alert" className="warning">
              History could not finish: {historyError} Use “Refresh history” to
              retry. Partial data is not a lifetime total.
            </p>
          )}
          <div className="activity-list">
            {history?.activity.length ? (
              history.activity.map((a) => (
                <div className="activity-row" key={`${a.hash}:${a.index}`}>
                  <div className="activity-icon" aria-hidden="true">
                    {a.kind === "swap" ? "⇄" : "↗"}
                  </div>
                  <div>
                    <strong>
                      {a.kind === "swap"
                        ? a.discounted
                          ? "Swap · holder fee"
                          : "Swap · standard fee"
                        : "Fees returned to LPs"}
                    </strong>
                    <span>Block {a.block.toLocaleString("en-US")}</span>
                  </div>
                  <div className="activity-value">
                    {a.kind === "swap" ? (
                      <Amount
                        value={a.fee}
                        unit={
                          a.currency?.toLowerCase() === r.key.currency0
                            ? "ETH"
                            : "NFTD"
                        }
                      />
                    ) : (
                      <>
                        <Amount value={a.amount0} unit="ETH" /> +{" "}
                        <Amount value={a.amount1} unit="NFTD" />
                      </>
                    )}
                    <External href={`${explorer}/tx/${a.hash}`}>
                      View transaction
                    </External>
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-state">
                <span aria-hidden="true">↔</span>
                <p>
                  {history?.complete
                    ? "No swaps or donations yet."
                    : "Waiting for verified pool events."}
                  <small>
                    {history?.complete
                      ? "The first pool transactions will appear here."
                      : "Public RPCs may take a moment to return the full history."}
                  </small>
                </p>
              </div>
            )}
          </div>
        </section>
        <section className="details-section">
          <details>
            <summary>How eligibility and fees work</summary>
            <div className="details-body">
              <p>
                The hook checks the transaction’s originating EOA, not an
                address in hookData. Your displayed fee is indicative for this
                connected address. The fee rounds up to the smallest unit and is
                capped at the output amount. If the collection check fails, the
                contract uses the full 1% fee.
              </p>
              <p>
                Contract and ERC-4337 wallets are judged by the relayer or
                bundler EOA. An NFT-holding relayer passes the discount to its
                users. An EIP-7702 account can hold a borrowed NFT during its
                transaction. Eligibility only lowers a fee; it never authorizes
                an action.
              </p>
              <p>
                Collected fees stay as claims in PoolManager until donated.
                Donations benefit in-range LPs, never the caller. Zero in-range
                liquidity prevents donation and preserves the claims. Swaps may
                still cross into liquidity, including the first buy into the
                one-sided NFTD pool.
              </p>
              <p>
                Exact-output swaps are not offered because PoolSwapTest cannot
                enforce a maximum final input. Network gas is additional to all
                displayed amounts.
              </p>
            </div>
          </details>
          <details>
            <summary>Contracts and deployment</summary>
            <div className="details-body contract-grid">
              {r.d.contracts.map((c) => (
                <div key={c.name}>
                  <span>{c.name}</span>
                  <External
                    href={`${explorer}/address/${c.address}`}
                    className="address"
                  >
                    {c.address}
                  </External>
                  <a href={`./${c.abiPath}`}>View verified ABI JSON</a>
                </div>
              ))}
              {[
                ["PoolSwapTest", r.d.integrations.poolSwapTest],
                ...Object.entries(r.d.network.uniswapV4),
              ].map(([name, address]) => (
                <div key={name}>
                  <span>{name}</span>
                  <External
                    href={`${explorer}/address/${address}`}
                    className="address"
                  >
                    {address}
                  </External>
                </div>
              ))}
              <div>
                <span>Source commit</span>
                <code>{r.d.sourceCommit}</code>
              </div>
              <div>
                <span>Attestation hash</span>
                <code>{r.d.attestationHash}</code>
              </div>
              <div>
                <span>Pool ID</span>
                <code>{r.poolId}</code>
              </div>
              <a href="./imd-deployment.json">
                View runtime deployment manifest
              </a>
            </div>
          </details>
        </section>
      </main>
      <footer className="wrap site-footer">
        <a className="brand" href="#">
          <span className="brandmark small" aria-hidden="true">
            h.
          </span>
          Holder Discount
        </a>
        <span>Built around shared liquidity.</span>
        <External href={r.d.network.faucets[0]}>Get test ETH</External>
      </footer>
    </>
  );
}
