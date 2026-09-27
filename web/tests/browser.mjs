import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  decodeFunctionData,
  encodeFunctionResult,
  encodeEventTopics,
  encodeAbiParameters,
  encodeErrorResult,
  toHex,
} from "viem";
import { protocol } from "../src/config.ts";

const root = resolve(import.meta.dirname, "../..");
const d = JSON.parse(await readFile(`${root}/dist/imd-deployment.json`));
const token = d.contracts.find((c) => c.name === "NFTD");
const hook = d.contracts.find((c) => c.name === "NFTHolderDiscountHook");
const tokenAbi = JSON.parse(await readFile(`${root}/dist/${token.abiPath}`));
const hookAbi = JSON.parse(await readFile(`${root}/dist/${hook.abiPath}`));
const evidence = `${root}/docs/frontend`;
await mkdir(evidence, { recursive: true });
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/preview/")) {
      res.writeHead(404).end();
      return;
    }
    const relative =
      decodeURIComponent(url.pathname.slice("/preview/".length)) ||
      "index.html";
    const path = resolve(root, "dist", relative);
    if (!path.startsWith(`${root}/dist/`)) {
      res.writeHead(403).end();
      return;
    }
    const data = await readFile(path);
    res
      .writeHead(200, {
        "Content-Type": types[extname(path)] || "application/octet-stream",
        "Cache-Control": "no-store",
      })
      .end(data);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/preview/`;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
});
const report = {
  checkedAt: new Date().toISOString(),
  servedAtSubpath: "/preview/",
  mockedTransactionsOnly: true,
  checks: [],
  screenshots: [],
  accessibility: [],
  consoleErrors: [],
  resourceFailures: [],
};
report.browser = await browser.version();
const pass = (name, details) => {
  report.checks.push({ name, result: "pass", ...details });
  console.log(`PASS ${name}`);
};
const zero = `0x${"0".repeat(64)}`;
const blockHash = `0x${"b".repeat(64)}`;
const account1 = "0x1111111111111111111111111111111111111111";
const account2 = "0x2222222222222222222222222222222222222222";
const pack = (a, b) =>
  BigInt.asIntN(256, (BigInt.asUintN(128, a) << 128n) | BigInt.asUintN(128, b));
function state(overrides = {}) {
  return {
    account: account1,
    chain: d.chainId,
    unknownChain: false,
    nft: 2n,
    liquidity: 100000n,
    allowance: 0n,
    accrued: [2000000000000000n, 50000000000000000n],
    calls: [],
    sends: [],
    rpcCalls: [],
    noCode: false,
    rpcDown: false,
    badChain: false,
    reject: "",
    failSwap: false,
    partial: false,
    nftFailure: false,
    revertReceipt: false,
    ...overrides,
  };
}
function block(number) {
  return {
    number: toHex(number),
    hash: blockHash,
    parentHash: zero,
    timestamp: "0x67000000",
    nonce: "0x0000000000000000",
    sha3Uncles: zero,
    logsBloom: `0x${"0".repeat(512)}`,
    transactionsRoot: zero,
    stateRoot: zero,
    receiptsRoot: zero,
    miner: account1,
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    size: "0x100",
    gasLimit: "0x1c9c380",
    gasUsed: "0x100",
    baseFeePerGas: "0x1",
    transactions: [],
    uncles: [],
  };
}
function receipt(hash, m) {
  return {
    transactionHash: hash,
    transactionIndex: "0x0",
    blockHash,
    blockNumber: toHex(d.deploymentBlock + 24),
    from: m.account,
    to: m.sends.find((s) => s.hash === hash)?.to || hook.address,
    cumulativeGasUsed: "0x186a0",
    gasUsed: "0x186a0",
    contractAddress: null,
    logs: [],
    logsBloom: `0x${"0".repeat(512)}`,
    status: m.revertReceipt ? "0x0" : "0x1",
    effectiveGasPrice: "0x1",
    type: "0x2",
  };
}
function mockLogs(poolId) {
  return [false, true].map((discounted, i) => ({
    address: hook.address,
    blockHash,
    blockNumber: toHex(d.deploymentBlock + i + 1),
    transactionHash: `0x${String(i + 7).repeat(64)}`,
    transactionIndex: toHex(i),
    logIndex: toHex(i),
    removed: false,
    topics: encodeEventTopics({
      abi: hookAbi,
      eventName: "FeeCharged",
      args: { poolId },
    }),
    data: encodeAbiParameters(
      [
        { type: "address" },
        { type: "bool" },
        { type: "address" },
        { type: "uint256" },
      ],
      [
        account1,
        discounted,
        i ? token.address : d.pool.pairedCurrency,
        i ? 50000000000000000n : 2000000000000000n,
      ],
    ),
  }));
}
async function rpc(m, request, wallet = false) {
  const { method, params = [] } = request;
  (wallet ? m.calls : m.rpcCalls).push({ method, params });
  if (m.reject === method) {
    m.reject = "";
    throw { code: 4001, message: "User rejected the request." };
  }
  if (!wallet && m.rpcDown)
    throw { code: -32000, message: "RPC is temporarily unavailable." };
  if (method === "eth_chainId")
    return toHex(wallet ? m.chain : m.badChain ? 1 : d.chainId);
  if (method === "eth_requestAccounts" || method === "eth_accounts")
    return [m.account];
  if (method === "wallet_switchEthereumChain") {
    if (m.unknownChain) throw { code: 4902, message: "Unknown chain" };
    m.chain = Number(params[0].chainId);
    return null;
  }
  if (method === "wallet_addEthereumChain") {
    assert.deepEqual(params[0], d.walletAddChain);
    m.unknownChain = false;
    return null;
  }
  if (method === "eth_blockNumber") return toHex(d.deploymentBlock + 25);
  if (method === "eth_getCode") return m.noCode ? "0x" : "0x6001600055";
  if (method === "eth_getBalance") return toHex(10n ** 20n);
  if (method === "eth_getBlockByNumber")
    return block(
      params[0] === "latest" ? d.deploymentBlock + 25 : Number(params[0]),
    );
  if (method === "eth_getLogs") {
    if (!m.poolId) return [];
    const logs = mockLogs(m.poolId).filter(
      (l) =>
        BigInt(l.blockNumber) >= BigInt(params[0].fromBlock) &&
        BigInt(l.blockNumber) <= BigInt(params[0].toBlock),
    );
    return [...logs, ...logs.slice(0, 1)]; // Duplicate event must not inflate lifetime totals.
  }
  if (method === "eth_estimateGas") return "0x493e0";
  if (method === "eth_gasPrice") return "0x1";
  if (method === "eth_getTransactionCount") return "0x0";
  if (method === "eth_getTransactionReceipt") return receipt(params[0], m);
  if (method === "eth_sendTransaction") {
    const transaction = params[0];
    const abi =
      transaction.to.toLowerCase() === token.address
        ? tokenAbi
        : transaction.to.toLowerCase() === hook.address
          ? hookAbi
          : protocol.router;
    const call = decodeFunctionData({ abi, data: transaction.data });
    if (call.functionName === "approve") {
      assert.equal(call.args[0].toLowerCase(), d.integrations.poolSwapTest);
      m.allowance = call.args[1];
    }
    if (call.functionName === "donateFees" && !m.revertReceipt)
      m.accrued = [0n, 0n];
    const hash = `0x${(m.sends.length + 10).toString(16).padStart(64, "0")}`;
    m.sends.push({
      ...transaction,
      hash,
      functionName: call.functionName,
      args: call.args,
    });
    return hash;
  }
  if (method === "eth_call") {
    const { to, data } = params[0];
    const address = to.toLowerCase();
    const abi =
      address === hook.address
        ? hookAbi
        : address === token.address
          ? tokenAbi
          : address === d.network.uniswapV4.stateView
            ? protocol.stateView
            : address === d.network.uniswapV4.quoter
              ? protocol.quoter
              : address === d.integrations.poolSwapTest
                ? protocol.router
                : protocol.collection;
    const decoded = decodeFunctionData({ abi, data });
    const { functionName, args = [] } = decoded;
    let result;
    switch (functionName) {
      case "poolManager":
      case "manager":
        result = d.network.uniswapV4.poolManager;
        break;
      case "COLLECTION":
        result = d.network.uniswapV4.positionManager;
        break;
      case "decimals":
        result = 18;
        break;
      case "symbol":
        result = "NFTD";
        break;
      case "getSlot0":
        m.poolId = args[0];
        result = [1n << 96n, 0, 0, 3000];
        break;
      case "getLiquidity":
        result = m.liquidity;
        break;
      case "accrued":
        result = m.accrued;
        break;
      case "feeBpsFor":
        result = m.nft > 0n && !m.nftFailure ? 50n : 100n;
        break;
      case "balanceOf":
        if (address !== token.address && m.nftFailure)
          throw { code: 3, message: "Collection read reverted", data: "0x" };
        result = address === token.address ? 10n ** 22n : m.nft;
        break;
      case "allowance":
        result = m.allowance;
        break;
      case "quoteExactInputSingle": {
        assert.equal(address, d.network.uniswapV4.quoter);
        assert.equal(params[0].from.toLowerCase(), m.account);
        result = [(args[0].exactAmount * 99n) / 100n, 100000n];
        break;
      }
      case "swap": {
        if (m.failSwap)
          throw {
            code: 3,
            message: "execution reverted: NoSwapOccurred",
            data: "0x",
          };
        assert.equal(address, d.integrations.poolSwapTest);
        assert.equal(params[0].from.toLowerCase(), m.account);
        assert.equal(args[2].takeClaims, false);
        assert.equal(args[2].settleUsingBurn, false);
        assert.equal(args[3], "0x");
        const buy = args[1].zeroForOne,
          requested = -args[1].amountSpecified;
        if (!buy && m.allowance < requested)
          throw { code: 3, message: "Insufficient allowance", data: "0x" };
        if (buy) assert.equal(BigInt(params[0].value), requested);
        const spent = m.partial ? requested / 2n : requested;
        const received = (spent * 99n) / 100n;
        result = pack(buy ? -spent : received, buy ? received : -spent);
        break;
      }
      case "approve":
        result = true;
        break;
      case "donateFees":
        if (m.liquidity === 0n)
          throw {
            code: 3,
            message: "NoLiquidity",
            data: encodeErrorResult({ abi: hookAbi, errorName: "NoLiquidity" }),
          };
        result = undefined;
        break;
      default:
        throw Error(`Unmocked call ${functionName}`);
    }
    return encodeFunctionResult({ abi, functionName, result });
  }
  throw Error(`Unmocked RPC ${method}`);
}
async function session(m, { wallet = true } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1080 },
    reducedMotion: "reduce",
  });
  await context.exposeFunction("__walletRequest", async (request) => {
    try {
      return { result: await rpc(m, request, true) };
    } catch (e) {
      return { error: { code: e.code, message: e.message } };
    }
  });
  if (wallet)
    await context.addInitScript(() => {
      const listeners = new Map();
      window.ethereum = {
        on(name, fn) {
          const list = listeners.get(name) || [];
          list.push(fn);
          listeners.set(name, list);
        },
        removeListener(name, fn) {
          listeners.set(
            name,
            (listeners.get(name) || []).filter((f) => f !== fn),
          );
        },
        emit(name, args) {
          for (const fn of listeners.get(name) || []) fn(args);
        },
        async request(request) {
          const response = await window.__walletRequest(request);
          if (response.error)
            throw Object.assign(new Error(response.error.message), {
              code: response.error.code,
            });
          if (request.method === "wallet_switchEthereumChain")
            this.emit("chainChanged", request.params[0].chainId);
          return response.result;
        },
      };
    });
  for (const rpcUrl of d.network.rpcUrls)
    await context.route(`${rpcUrl}/**`, routeRPC);
  for (const rpcUrl of d.network.rpcUrls) await context.route(rpcUrl, routeRPC);
  async function routeRPC(route) {
    try {
      const body = route.request().postDataJSON();
      const respond = async (request) => {
        try {
          return {
            jsonrpc: "2.0",
            id: request.id,
            result: await rpc(m, request),
          };
        } catch (e) {
          if (!e.code) console.error(e);
          return {
            jsonrpc: "2.0",
            id: request.id,
            error: { code: e.code || -32603, message: e.message, data: e.data },
          };
        }
      };
      const result = Array.isArray(body)
        ? await Promise.all(body.map(respond))
        : await respond(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(result),
      });
    } catch (e) {
      console.error(e);
      await route.abort();
    }
  }
  const page = await context.newPage();
  page.on("pageerror", (e) => report.consoleErrors.push(e.message));
  page.on("response", (response) => {
    if (response.status() >= 400 && response.url().startsWith(url))
      report.resourceFailures.push({
        status: response.status(),
        url: response.url(),
      });
  });
  await page.goto(url);
  await expect(
    page.getByRole("heading", { name: "More for holders. Back to the pool." }),
  ).toBeVisible();
  return { context, page };
}
async function ready(page) {
  await expect(page.getByText(/RPC verified · Block/)).toBeVisible({
    timeout: 20000,
  });
}
async function connect(page) {
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(
    page.getByRole("button", { name: /Disconnect 0x/ }),
  ).toBeVisible();
  await ready(page);
}
async function screenshot(page, file) {
  await page.screenshot({ path: `${evidence}/${file}`, fullPage: true });
  report.screenshots.push(file);
}
async function noOverflow(page) {
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Horizontal overflow",
  );
}
async function axe(page, label) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  report.accessibility.push({
    state: label,
    violations: result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => ({
        target: n.target,
        failureSummary: n.failureSummary,
      })),
    })),
  });
  assert.equal(
    result.violations.length,
    0,
    `${label}: ${result.violations.map((v) => v.id).join(", ")}`,
  );
}

try {
  const m = state();
  const { page, context } = await session(m);
  await ready(page);
  // Retry history after snapshot determines the mocked pool ID.
  await page.getByRole("button", { name: "Refresh history" }).click();
  await expect(page.getByText("1 of 2 swaps")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Get a quote" }),
  ).toBeDisabled();
  await screenshot(page, "desktop-disconnected.png");
  await axe(page, "desktop disconnected");
  pass(
    "Static subpath loads local JS, CSS, font, runtime manifest and verified ABIs",
  );
  pass("Disconnected actions locked; event counts deduplicate repeated logs");
  await page.keyboard.press("Tab");
  // Focus and activation use native keyboard semantics.
  await page.getByRole("button", { name: "Connect wallet" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /Disconnect/ })).toBeVisible();
  await ready(page);
  await expect(page.getByText("Holder rate")).toBeVisible();
  await page.locator("#amount").fill("-1");
  await page.getByRole("button", { name: "Get a quote" }).click();
  await expect(page.locator("#form-error")).toContainText("positive amount");
  await expect(page.locator("#amount")).toBeFocused();
  await page.locator("#amount").fill("0.01");
  await page.locator("#tolerance").fill("51");
  await page.getByRole("button", { name: "Get a quote" }).click();
  await expect(page.locator("#tolerance")).toBeFocused();
  await expect(page.locator("#tolerance")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.locator("#amount")).toHaveAttribute(
    "aria-invalid",
    "false",
  );
  await page.locator("#tolerance").fill("5");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Get a quote" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Confirm swap" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm swap" }),
  ).toBeDisabled();
  for (let i = 0; i < 50 && !await page.getByRole("checkbox").evaluate(el => el === document.activeElement); i++) {
    await page.keyboard.press("Tab");
  }
  await expect(page.getByRole("checkbox")).toBeFocused();
  await page.keyboard.press("Space");
  await screenshot(page, "desktop-connected.png");
  await axe(page, "desktop quote review");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Confirm swap" }),
  ).toBeFocused();
  assert(
    await page
      .getByRole("button", { name: "Confirm swap" })
      .evaluate((el) => el.matches(":focus-visible")),
  );
  await screenshot(page, "keyboard-focus.png");
  report.computedStyle = await page.evaluate(async () => {
    await document.fonts.ready;
    const selectors = [
      "body",
      ".intro-copy",
      ".collection-copy > p:not(.eyebrow)",
      ".primary",
      ".route-note",
      ".tiny",
    ];
    const pairs = selectors.map((selector) => {
      const element = document.querySelector(selector),
        style = getComputedStyle(element);
      let bg = style.backgroundColor,
        parent = element;
      while (bg === "rgba(0, 0, 0, 0)" && parent.parentElement) {
        parent = parent.parentElement;
        bg = getComputedStyle(parent).backgroundColor;
      }
      return {
        selector,
        foreground: style.color,
        background: bg,
        size: style.fontSize,
        weight: style.fontWeight,
      };
    });
    return {
      fontLoaded: document.fonts.check('500 16px "DM Sans"'),
      focus: getComputedStyle(document.activeElement).outline,
      pairs,
    };
  });
  await page.keyboard.press("Enter");
  await expect(page.getByText("Swap confirmed.")).toBeVisible({
    timeout: 15000,
  });
  assert.equal(m.sends.length, 1);
  assert.equal(m.sends[0].functionName, "swap");
  assert.equal(BigInt(m.sends[0].value), 10000000000000000n);
  assert.equal(m.sends[0].args[1].amountSpecified, -10000000000000000n);
  assert(m.sends[0].args[1].sqrtPriceLimitX96 < 1n << 96n);
  pass(
    "Keyboard connection, holder eligibility, invalid input focus, exact-input buy and receipt",
  );
  await page.getByRole("button", { name: "Sell NFTD" }).click();
  await page.locator("#amount").fill("1");
  await page.getByRole("button", { name: "Get a quote" }).click();
  await expect(
    page.getByRole("button", { name: "Approve 1 NFTD" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Approve 1 NFTD" }).click();
  await expect(
    page.getByText(
      "NFTD approval confirmed. Get a new quote to simulate your swap.",
    ),
  ).toBeVisible();
  assert.equal(m.allowance, 10n ** 18n);
  await page.getByRole("button", { name: "Get a quote" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Confirm swap" }).click();
  await expect(page.getByText("Swap confirmed.")).toBeVisible();
  assert.equal(m.sends.length, 3);
  assert.equal(m.sends[1].functionName, "approve");
  assert.equal(m.sends[2].args[1].zeroForOne, false);
  assert.equal(BigInt(m.sends[2].value || 0), 0n);
  pass(
    "Sell approval is exact and separate, spender is assigned PoolSwapTest, sell signs no ETH value",
  );
  await page.getByRole("button", { name: "Donate accrued fees" }).click();
  await expect(
    page.getByRole("button", { name: "Confirm fee donation" }),
  ).toBeVisible();
  assert.equal(m.sends.length, 3);
  await page.getByRole("button", { name: "Confirm fee donation" }).click();
  await expect(page.getByText("Fee donation confirmed.")).toBeVisible();
  assert.equal(m.sends[3].functionName, "donateFees");
  await expect(
    page.getByRole("button", { name: "Donate accrued fees" }),
  ).toBeDisabled();
  pass(
    "Donation preview simulates without sending, confirmation sends once and refreshes empty accrual",
  );

  m.accrued = [1n, 1n];
  m.liquidity = 0n;
  await page.getByRole("button", { name: "Refresh state" }).click();
  await ready(page);
  await expect(
    page.getByText("No liquidity in range. Fees are preserved."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Donate accrued fees" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Buy NFTD" }).click();
  m.partial = true;
  await page.locator("#amount").fill("0.01");
  await page.getByRole("button", { name: "Get a quote" }).click();
  await expect(page.getByText(/Partial fill in simulation/)).toBeVisible();
  pass(
    "Zero current liquidity blocks donation while a buy can cross into seeded liquidity; partial fill is disclosed",
  );
  m.partial = false;
  m.nft = 0n;
  m.account = account2;
  await page.evaluate(
    (a) => window.ethereum.emit("accountsChanged", [a]),
    account2,
  );
  await expect(page.getByText("Holder rate")).toHaveCount(0);
  await expect(page.getByText("1% of output")).toBeVisible();
  await expect(page.getByRole("button", { name: "Get a quote" })).toBeVisible();
  pass("Account changes invalidate trade reviews; non-holder rate updates");
  m.nftFailure = true;
  await page.getByRole("button", { name: "Refresh state" }).click();
  await ready(page);
  await expect(page.getByText("Unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("1% of output")).toBeVisible();
  pass(
    "Collection read failure displays unavailable NFT balance and the on-chain full fee",
  );
  m.failSwap = true;
  await page.getByRole("button", { name: "Get a quote" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: /reverted|NoSwapOccurred/ }),
  ).toBeVisible();
  assert.equal(m.sends.length, 4);
  pass("Router simulation failure reports revert and prevents a signature");
  m.failSwap = false;
  await page.getByRole("button", { name: "Get a quote" }).click();
  await page.getByRole("checkbox").check();
  m.reject = "eth_sendTransaction";
  await page.getByRole("button", { name: "Confirm swap" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Request declined" }),
  ).toBeVisible();
  assert.equal(m.sends.length, 4);
  pass("Wallet rejection remains recoverable and creates no transaction");
  await page.clock.install();
  await page.clock.fastForward(61000);
  await expect(page.getByRole("button", { name: "Confirm swap" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Get a quote" })).toBeVisible();
  pass("Quote expiry removes the signing control");
  await page.getByRole("button", { name: "Get a quote" }).click();
  await page.getByRole("checkbox").check();
  m.revertReceipt = true;
  await page.getByRole("button", { name: "Confirm swap" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Swap reverted" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Swap: reverted/ }),
  ).toBeVisible();
  m.revertReceipt = false;
  pass("Reverted receipt reports failure instead of confirmation");
  m.liquidity = 1000n;
  m.nftFailure = false;
  m.nft = 2n;
  await page.getByRole("button", { name: "Refresh state" }).click();
  await ready(page);
  await page.setViewportSize({ width: 780, height: 1024 });
  await noOverflow(page);
  await screenshot(page, "tablet.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await axe(page, "mobile connected");
  await screenshot(page, "mobile.png");
  await page.setViewportSize({ width: 320, height: 780 });
  await noOverflow(page);
  await screenshot(page, "mobile-320.png");
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await noOverflow(page);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });
  pass(
    "Reflow at 1440, 780, 390 and 320 CSS px; 320px text enlargement to 200%",
  );
  await context.close();

  const wrong = state({ chain: 1, unknownChain: true });
  const wrongSession = await session(wrong);
  await connect(wrongSession.page);
  await expect(
    wrongSession.page.getByRole("button", { name: "Get a quote" }),
  ).toBeDisabled();
  await wrongSession.page
    .getByRole("button", { name: "Switch to Sepolia" })
    .click();
  await expect(
    wrongSession.page.getByRole("button", { name: "Switch to Sepolia" }),
  ).toHaveCount(0);
  await ready(wrongSession.page);
  assert.deepEqual(
    wrong.calls
      .filter((c) => c.method.startsWith("wallet_"))
      .map((c) => c.method),
    [
      "wallet_switchEthereumChain",
      "wallet_addEthereumChain",
      "wallet_switchEthereumChain",
    ],
  );
  pass(
    "Wrong-chain action lock; unknown chain adds exact walletAddChain configuration and switches again",
  );
  await wrongSession.context.close();

  const missing = await session(state(), { wallet: false });
  await ready(missing.page);
  await missing.page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(
    missing.page
      .getByRole("alert")
      .filter({ hasText: "No browser wallet found" }),
  ).toBeVisible();
  pass("Missing-wallet recovery instructions");
  await missing.context.close();

  const noCode = await session(state({ noCode: true }));
  await expect(
    noCode.page.getByRole("alert").filter({ hasText: "No contract code" }),
  ).toBeVisible();
  await expect(
    noCode.page.getByRole("button", { name: "Get a quote" }),
  ).toBeDisabled();
  pass("Missing deployed bytecode locks contract actions");
  await noCode.context.close();

  const badChain = await session(state({ badChain: true }));
  await expect(
    badChain.page
      .getByRole("alert")
      .filter({ hasText: "Unable to read the pool" }),
  ).toContainText("RPC returned the wrong chain");
  pass("RPC chain mismatch is rejected");
  await badChain.context.close();

  const downState = state({ rpcDown: true });
  const down = await session(downState);
  await expect(
    down.page.getByRole("heading", { name: "Swap", exact: true }),
  ).toBeVisible();
  await expect(
    down.page.getByRole("alert").filter({ hasText: "Unable to read the pool" }),
  ).toBeVisible({ timeout: 20000 });
  await expect(
    down.page.getByRole("button", { name: "Get a quote" }),
  ).toBeDisabled();
  downState.rpcDown = false;
  await down.page.getByRole("button", { name: "Refresh state" }).click();
  await ready(down.page);
  pass("RPC outage locks actions; explicit refresh recovers reads");
  await down.context.close();

  const tamperedContext = await browser.newContext();
  await tamperedContext.route(`**/${token.abiPath}`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  const tamperedPage = await tamperedContext.newPage();
  await tamperedPage.goto(url);
  await expect(
    tamperedPage.getByRole("heading", {
      name: "Unable to verify this deployment",
    }),
  ).toBeVisible();
  await expect(tamperedPage.getByRole("alert")).toContainText(
    "ABI verification failed",
  );
  pass("Tampered implementation ABI prevents the app from enabling actions");
  await tamperedContext.close();
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.resourceFailures, []);
  report.result = "pass";
} catch (error) {
  report.result = "fail";
  report.failure = error.stack || error.message;
  console.error(error);
  for (const context of browser.contexts())
    for (const page of context.pages()) {
      await page
        .screenshot({ path: `${evidence}/failure.png`, fullPage: true })
        .catch(() => {});
      console.error((await page.locator("body").innerText()).slice(-5000));
    }
  process.exitCode = 1;
} finally {
  await writeFile(
    `${evidence}/browser-results.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
