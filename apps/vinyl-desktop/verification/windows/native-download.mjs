import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";

// Run only against a disposable installed Windows bundle. Serve a synthetic MP4 locally.
if (process.platform !== "win32" || ![5, 6].includes(process.argv.length)) {
  throw new Error(
    "Usage on Windows: node native-download.mjs <app.exe> <save directory> <yt-dlp.exe> [runner debug port]",
  );
}
const [app, destination, ytdlp, runnerPort] = process.argv.slice(2);
const soakMinutes = Number(process.env.VINYL_NATIVE_SOAK_MINUTES ?? "0");
if (![0, 60].includes(soakMinutes)) throw new Error("Native soak duration must be 0 or 60 minutes");
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

// Append a valid MP4 free box to distinguish a newer representation at the same link.
const changedBytes = Buffer.concat([bytes, Buffer.from([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65])]);
let currentBytes = bytes;
let requests = 0;
const slowGets = new Map();
const activeSlowResponses = new Set();
const server = createServer((req, res) => {
  ++requests;
  const path = new URL(req.url, "http://localhost").pathname;
  const slow = path.startsWith("/slow/");
  if ((path !== "/vinyl-test.mp4" && !slow) || !["GET", "HEAD"].includes(req.method)) {
    res.writeHead(404).end();
    return;
  }
  const source = slow ? bytes : currentBytes;
  res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": source.length });
  if (req.method === "HEAD") { res.end(); return; }
  if (!slow) { res.end(source); return; }
  const gets = (slowGets.get(path) ?? 0) + 1;
  slowGets.set(path, gets);
  // The pinned generic extractor first makes a GET to identify the media.
  // Stall the subsequent download GET, not the extractor's initial probe.
  if (gets === 1) { res.end(source); return; }
  activeSlowResponses.add(res);
  res.write(source.subarray(0, 1024));
  // Keep a real in-flight HTTP transfer open until the job is cancelled.
  const timeout = setTimeout(() => res.destroy(), 30000);
  res.on("close", () => { clearTimeout(timeout); activeSlowResponses.delete(res); });
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
const invoke = (cmd, args = {}) => page.evaluate(({ cmd, args }) =>
  window.__TAURI_INTERNALS__.invoke(cmd, args), { cmd, args });
const base = `http://127.0.0.1:${testPort}`;
const getTask = async (id) => (await invoke("db_get_tasks")).find((task) => task.id === id);
async function prepare(id, { url = `${base}/vinyl-test.mp4`, downloadDir = destination, ...options } = {}) {
  const params = { url, downloadDir, downloadMode: "default", noPlaylist: true, ...options, id };
  await invoke("db_upsert_task", { task: {
    id, url, title: "Native verification", status: "queued", createdAt: Date.now(), params,
  } });
  return params;
}
async function waitTask(id, status) {
  await expect.poll(async () => (await getTask(id))?.status, {
    message: `Native task ${id} must finish as ${status}`, timeout: 30000,
  }).toBe(status);
  return getTask(id);
}
async function cancelTransfer(id, downloadDir) {
  const params = await prepare(id, { url: `${base}/slow/${id}.mp4`, downloadDir, outputTemplate: "Slow.%(ext)s" });
  await invoke("start_download", { params });
  await expect.poll(() => activeSlowResponses.size, { timeout: 15000 }).toBeGreaterThan(0);
  await invoke("cancel_download", { id });
  const cancelled = await waitTask(id, "cancelled");
  if (cancelled.outputFile || cancelled.fileSizeBytes) throw new Error("Cancelled job reported completed media");
  await expect.poll(() => activeSlowResponses.size, { timeout: 5000 }).toBe(0);
  if ((await readdir(downloadDir)).some((name) => name.endsWith(".mp4"))) throw new Error("Cancellation left a final media file");
  slowGets.delete(`/slow/${id}.mp4`);
  await invoke("db_delete_task", { id });
}

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
  stage = "saving a changed rendition without reusing or overwriting an earlier save";
  const firstTask = (await invoke("db_get_tasks")).find((item) => item.status === "completed" && item.url === `${base}/vinyl-test.mp4`);
  if (!firstTask?.outputFile || firstTask.fileSizeBytes !== bytes.length) throw new Error("No durable completed row after the UI save");
  currentBytes = changedBytes;
  const params = await prepare("native-keep-both", firstTask.params);
  await invoke("start_download", { params });
  const second = await waitTask("native-keep-both", "completed");
  if (second.outputFile === firstTask.outputFile || !second.outputFile ||
      second.fileSizeBytes !== changedBytes.length || sha(await readFile(second.outputFile)) !== sha(changedBytes) ||
      sha(await readFile(firstTask.outputFile)) !== fixtureHash) {
    throw new Error("A repeat download did not keep both byte-verified saves");
  }
  if ((await readdir(destination)).length !== 2) throw new Error("Expected exactly two completed saves");

  stage = "rejecting a stale exact format ID and a no-output simulation flag";
  await invoke("start_download", { params: await prepare("native-unavailable", { videoFormat: "not-offered", videoHasAudio: true }) });
  const unavailable = await waitTask("native-unavailable", "error");
  if (unavailable.outputFile || !/requested format is not available/i.test(unavailable.error)) {
    throw new Error(`Unexpected response to stale format ID: ${unavailable.error}`);
  }
  const simulation = await prepare("native-simulation", { customArgs: "--simulate" });
  await assert.rejects(invoke("start_download", { params: simulation }), /err_unsupported_custom_option/);
  if ((await readdir(destination)).length !== 2) throw new Error("Failed jobs created extra output");
  await invoke("db_delete_task", { id: "native-simulation" });

  stage = "cancelling a real in-flight transfer";
  const soakDir = join(dirname(destination), "Native regression transfers");
  await mkdir(soakDir);
  await cancelTransfer("native-cancel", soakDir);
  console.log(`Native keep-both, stale format, no-output guard and transfer cancellation passed (${basename(second.outputFile)}).`);

  if (soakMinutes) {
    stage = "running the requested 60-minute installed Windows soak";
    const started = performance.now();
    let cycles = 0;
    let cancels = 0;
    while (performance.now() - started < soakMinutes * 60000) {
      const id = `native-soak-${++cycles}`;
      await invoke("start_download", { params: await prepare(id, { downloadDir: soakDir }) });
      const task = await waitTask(id, "completed");
      if (!task.outputFile || task.fileSizeBytes !== changedBytes.length ||
          sha(await readFile(task.outputFile)) !== sha(changedBytes)) throw new Error(`Invalid save in cycle ${cycles}`);
      await rm(task.outputFile);
      await invoke("db_delete_task", { id });
      if (cycles % 5 === 0) {
        await cancelTransfer(`${id}-cancel`, soakDir);
        await rm(soakDir, { recursive: true });
        await mkdir(soakDir);
        cancels++;
      }
      if (cycles % 10 === 0) console.log(`${cycles} verified saves, ${cancels} stops, ${Math.round((performance.now() - started) / 1000)} seconds.`);
      if (browserErrors.length) throw new Error(browserErrors[0]);
      await delay(1000);
    }
    console.log(`Installed Windows soak passed: ${cycles} verified saves, ${cancels} stops, ${Math.round((performance.now() - started) / 1000)} elapsed seconds.`);
  }
  if (browserErrors.length) throw new Error(`Installed renderer error: ${browserErrors[0]}`);
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
