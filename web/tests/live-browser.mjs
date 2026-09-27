import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium, expect } from "@playwright/test";
const root = resolve(import.meta.dirname, "../..");
const report = {
  checkedAt: new Date().toISOString(),
  mocked: false,
  walletConnected: false,
  transactionsSent: 0,
  consoleErrors: [],
  requestFailures: [],
};
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".woff2": "font/woff2",
};
const server = createServer(async (request, response) => {
  try {
    const path =
      request.url === "/preview/"
        ? "index.html"
        : request.url.replace(/^\/preview\//, "");
    if (path.includes("..") || path.startsWith("/"))
      throw Error("Invalid path");
    response.setHeader("Content-Type", types[extname(path)] || "text/plain");
    response.end(await readFile(`${root}/dist/${path}`));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  headless: true,
});
let page;
try {
  report.browser = await browser.version();
  page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  page.on("pageerror", (e) => report.consoleErrors.push(e.message));
  page.on("requestfailed", (request) =>
    report.requestFailures.push({
      url: request.url(),
      error: request.failure()?.errorText,
    }),
  );
  await page.goto(`http://127.0.0.1:${server.address().port}/preview/`);
  await expect(page.getByText(/RPC verified · Block/)).toBeVisible({
    timeout: 45000,
  });
  await expect(page.getByText(/Lifetime history from block/)).toBeVisible({
    timeout: 45000,
  });
  report.poolState = await page.locator(".live-line").innerText();
  report.price = await page.locator(".swap-facts").innerText();
  report.history = await page.locator(".history-note").innerText();
  report.metrics = await page.locator(".metrics").innerText();
  report.result = "pass";
  await page.screenshot({
    path: `${root}/docs/frontend/live-desktop.png`,
    fullPage: true,
  });
} catch (e) {
  report.result = "unavailable";
  report.error = e.message;
  report.pageText = page ? await page.locator("body").innerText() : "";
  process.exitCode = 1;
} finally {
  await writeFile(
    `${root}/docs/frontend/live-browser.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  await browser.close();
  await new Promise((r) => server.close(r));
}
