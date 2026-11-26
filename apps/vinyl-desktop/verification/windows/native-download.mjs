import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";
import { verifyCreditsDialog } from "../credits.mjs";

// Run only against a disposable installed Windows bundle. Serve a synthetic MP4 locally.
if (process.platform !== "win32" || ![5, 6].includes(process.argv.length)) {
  throw new Error(
    "Usage on Windows: node native-download.mjs <app.exe> <save directory> <yt-dlp.exe> [runner debug port]",
  );
}
const [app, destination, ytdlp, runnerPort] = process.argv.slice(2);
if (runnerPort && (!/^\d+$/.test(runnerPort) || +runnerPort < 1024 || +runnerPort > 65535)) {
  throw new Error("Invalid runner debug port");
}
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

let requests = 0;
const server = createServer((req, res) => {
  ++requests;
  if (req.url !== "/vinyl-test.mp4" || !["GET", "HEAD"].includes(req.method)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": bytes.length });
  res.end(req.method === "HEAD" ? undefined : bytes);
});
const testPort = await listen(server);
let debugPort = Number(runnerPort);
if (!runnerPort) {
  const reserved = createTcpServer();
  debugPort = await listen(reserved);
  await new Promise((resolve, reject) =>
    reserved.close((error) => (error ? reject(error) : resolve())),
  );
}
const endpoint = `http://127.0.0.1:${debugPort}`;

const child = spawn(app, [`--yt-dlp-path=${ytdlp}`, `--dir=${destination}`], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
    WEBVIEW2_USER_DATA_FOLDER: join(dirname(destination), "WebView2 smoke profile"),
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
let page;
let stage = "connecting to the installed app's WebView2";
const browserErrors = [];
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
  page = context.pages()[0] ?? (await context.waitForEvent("page", { timeout: 15000 }));
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => browserErrors.push(error.message));
  stage = "checking the installed renderer and Settings";
  const link = page.getByRole("textbox", { name: "Video link" });
  await expect(link).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("link", { name: "NexusDownloader", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByText("Windows", { exact: true })).toBeVisible();
  await expect(page.getByText("v0.2.0", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "NexusDownloader", exact: true }).click();
  stage = "checking Credits dismissal in the installed WebView2";
  await verifyCreditsDialog(page);
  console.log("Installed Credits opened and closed by button, blurred backdrop, and Escape.");
  stage = "inspecting the synthetic MP4";
  await link.fill(`http://127.0.0.1:${testPort}/vinyl-test.mp4`);
  await page.getByRole("button", { name: "Inspect link", exact: true }).click();
  const download = page.getByRole("button", { name: "Download Now", exact: true });
  await expect(download).toBeVisible({ timeout: 30000 });
  stage = "starting the native download and waiting for saved-file confirmation";
  await download.click();
  await expect(page.getByText("Saved to disk", { exact: true })).toBeVisible({ timeout: 30000 });

  const files = await readdir(destination);
  if (files.length !== 1 || !files[0].endsWith(".mp4"))
    throw new Error(`Unexpected output: ${files.join(", ")}`);
  if (sha(await readFile(join(destination, files[0]))) !== fixtureHash)
    throw new Error("Saved MP4 differs from the fixture");
  console.log(
    `Native Tauri → yt-dlp → Windows save passed: ${files[0]} (${bytes.length} bytes, SHA-256 ${fixtureHash}).`,
  );
} catch (error) {
  const screen = await page
    ?.locator("body")
    .innerText({ timeout: 1500 })
    .then((text) => text.trim().replace(/\s+/g, " ").slice(-1700))
    .catch(() => "unavailable");
  console.error(`Windows smoke: ${stage}; fixture HTTP requests: ${requests}.`);
  console.error(error instanceof Error ? error.message : String(error));
  if (browserErrors.length) console.error(`Renderer errors: ${browserErrors.slice(-5).join("; ")}`);
  if (screen) console.error(`Installed UI: ${screen}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (!exited && !launchError) {
    const killed = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 5000,
      windowsHide: true,
    });
    if (killed.status !== 0) child.kill();
  }
  await Promise.race([stopped, delay(5000, undefined, { ref: false })]);
  server.closeAllConnections();
  server.close();
}
