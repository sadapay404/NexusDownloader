import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";

// Run only against a disposable installed Windows bundle. Serve a synthetic MP4 locally.
if (process.platform !== "win32" || process.argv.length !== 5) {
  throw new Error(
    "Usage on Windows: node native-download.mjs <app.exe> <save directory> <yt-dlp.exe>",
  );
}
const [app, destination, ytdlp] = process.argv.slice(2);
const bytes = await readFile(new URL("../fixtures/vinyl-test.mp4", import.meta.url));
const sha = (data) => createHash("sha256").update(data).digest("hex");
const fixtureHash = "d3c35bb793efaed7d75a0675ba8eb18ebb0d5b15b44419d01a48c109741049f4";
if (sha(bytes) !== fixtureHash) throw new Error("Unexpected fixture bytes");
await mkdir(destination, { recursive: true });
if ((await readdir(destination)).length) throw new Error("Save directory must be empty");

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

const server = createServer((req, res) => {
  if (req.url !== "/vinyl-test.mp4" || !["GET", "HEAD"].includes(req.method)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": bytes.length });
  res.end(req.method === "HEAD" ? undefined : bytes);
});
const testPort = await listen(server);
const reserved = createTcpServer();
const debugPort = await listen(reserved);
await new Promise((resolve, reject) =>
  reserved.close((error) => (error ? reject(error) : resolve())),
);
const endpoint = `http://127.0.0.1:${debugPort}`;

const child = spawn(app, [`--yt-dlp-path=${ytdlp}`, `--dir=${destination}`], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1`,
  },
  stdio: "inherit",
});
let exited = false;
let launchError;
child.on("error", (error) => {
  launchError = error;
});
child.on("exit", () => {
  exited = true;
});
const stopped = once(child, "close").catch(() => []);
let browser;
try {
  await expect
    .poll(
      async () => {
        if (launchError) throw launchError;
        if (exited)
          throw new Error(`NexusDownloader exited before its WebView appeared (${child.exitCode})`);
        return fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1500) })
          .then((response) => response.ok)
          .catch(() => false);
      },
      { message: "Installed NexusDownloader must open a real WebView2 window", timeout: 45000 },
    )
    .toBe(true);
  browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent("page", { timeout: 15000 }));
  const link = page.getByRole("textbox", { name: "Video link" });
  await expect(link).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("link", { name: "NexusDownloader", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByText("Windows", { exact: true })).toBeVisible();
  await expect(page.getByText("v0.2.0", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "NexusDownloader", exact: true }).click();
  await link.fill(`http://127.0.0.1:${testPort}/vinyl-test.mp4`);
  await page.getByRole("button", { name: "Inspect link", exact: true }).click();
  await page.getByRole("button", { name: "Download Now", exact: true }).click({ timeout: 30000 });
  await expect(page.getByText("Saved to disk", { exact: true })).toBeVisible({ timeout: 30000 });

  const files = await readdir(destination);
  if (files.length !== 1 || !files[0].endsWith(".mp4"))
    throw new Error(`Unexpected output: ${files.join(", ")}`);
  if (sha(await readFile(join(destination, files[0]))) !== fixtureHash)
    throw new Error("Saved MP4 differs from the fixture");
  console.log(
    `Native Tauri → yt-dlp → Windows save passed: ${files[0]} (${bytes.length} bytes, SHA-256 ${fixtureHash}).`,
  );
} finally {
  await browser?.close().catch(() => {});
  if (!exited && !launchError) child.kill();
  await Promise.race([stopped, delay(5000, undefined, { ref: false })]);
  server.closeAllConnections();
  server.close();
}
