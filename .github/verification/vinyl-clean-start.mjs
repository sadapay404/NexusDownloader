import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";

const [app, work, port] = process.argv.slice(2);
if (process.platform !== "win32" || !app || !work || !/^\d+$/.test(port)) throw new Error("Expected a clean Windows VM");
const bytes = await readFile(new URL("../fixtures/vinyl-test.mp4", import.meta.url));
const saved = join(work, "Normal Downloads");
await mkdir(saved);
const server = createServer((req, res) => {
  if (req.url !== "/vinyl-test.mp4") { res.writeHead(404).end(); return; }
  res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": bytes.length });
  res.end(req.method === "HEAD" ? undefined : bytes);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}/vinyl-test.mp4`;
const endpoint = `http://127.0.0.1:${port}`;
const child = spawn(app, [], {
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: join(work, "WebView2") },
  stdio: "inherit",
});
const stopped = once(child, "close").catch(() => []);
let stage = "opening the installed app";
let browser;
let page;
const diagnostics = [];
const invoke = (cmd, args = {}) => page.evaluate(({ cmd, args }) => window.__TAURI_INTERNALS__.invoke(cmd, args), { cmd, args });
const describe = (value) => value instanceof Error ? value.message : String(value);
try {
  await expect.poll(() => fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1500) })
    .then(res => res.ok).catch(() => false), { timeout: 45000 }).toBe(true);
  browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
  const context = browser.contexts()[0];
  page = context.pages()[0] ?? await context.waitForEvent("page", { timeout: 15000 });
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => diagnostics.push(`Renderer: ${error.message}`));
  const link = page.getByRole("textbox", { name: "Video link" });
  await expect(link).toBeVisible({ timeout: 15000 });
  console.log("Clean Start launch opened Home without tool or download-directory overrides.");
  stage = "showing the missing-tool prompt";
  const missing = await invoke("get_ytdlp_status");
  assert.equal(missing.installed, false, "Expected no preinstalled managed yt-dlp");
  const missingDeno = await invoke("get_deno_status");
  assert.equal(missingDeno.installed, false, "Expected no preinstalled managed Deno");
  await link.fill(url);
  await page.getByRole("button", { name: "Inspect link", exact: true }).click();
  await expect(page.getByText("yt-dlp Required", { exact: true })).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "Go to Settings", exact: true }).click();
  await expect(page.getByText("Tool Manager", { exact: true })).toBeVisible({ timeout: 15000 });
  stage = "running the real managed installs";
  const tools = ["ytdlp", "deno", "ffmpeg"];
  const status = await Promise.allSettled(tools.map(tool => invoke(`download_${tool}`)));
  const failures = status.flatMap((result, i) => result.status === "rejected" ? [`${tools[i]} install: ${describe(result.reason)}`] : []);
  for (let i = 0; i < tools.length; i++) console.log(`${tools[i]} installation: ${status[i].status}`);
  for (const failure of failures) console.error(failure);
  assert.deepEqual(failures, [], "Managed tool installation failed");
  for (const tool of tools) {
    if (tool === "ffmpeg") await invoke("set_tool_sources", { ytdlp: "managed", deno: "managed", ffmpeg: "managed", ytdlpLocalPath: "" });
    const result = await invoke(`get_${tool}_status`);
    assert.ok(result.runnable && result.isManaged, JSON.stringify(result));
    console.log(`${tool} runnable: ${result.version}`);
  }
  stage = "retrying the same link through Settings";
  await page.getByRole("link", { name: "NexusDownloader", exact: true }).click();
  await expect(link).toHaveValue(url, { timeout: 10000 });
  await page.getByRole("button", { name: "Retry link", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download Now", exact: true })).toBeVisible({ timeout: 30000 });
  stage = "saving a real file with the installed managed downloads";
  // Seed just the directory preference; CDP cannot select a folder in the OS dialog.
  await page.evaluate((dir) => {
    const setting = JSON.parse(localStorage.getItem("setting") ?? "{}");
    localStorage.setItem("setting", JSON.stringify({ ...setting, downloadDir: dir, ffmpegSource: "managed" }));
  }, saved);
  await page.reload();
  await page.getByRole("link", { name: "NexusDownloader", exact: true }).click();
  await link.fill(url);
  await page.getByRole("button", { name: "Inspect link", exact: true }).click();
  await page.getByRole("button", { name: "Download Now", exact: true }).click({ timeout: 30000 });
  await expect(page.getByText("Saved to disk", { exact: true })).toBeVisible({ timeout: 30000 });
  const files = await readdir(saved);
  assert.equal(files.length, 1);
  assert.deepEqual(await readFile(join(saved, files[0])), bytes);
  assert.deepEqual(diagnostics, []);
  console.log(`Managed install, startup and save passed (${bytes.length} matching bytes).`);
} catch (error) {
  console.error(`Clean-start failure (${stage}): ${describe(error)}`);
  for (const detail of diagnostics.slice(0, 5)) console.error(detail);
  const body = await page?.locator("body").innerText({ timeout: 1500 }).catch(() => "");
  if (body) console.error(`Installed UI: ${body.trim().replace(/\s+/g, " ").slice(-1300)}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (child.pid && child.exitCode === null) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
  await Promise.race([stopped, delay(5000, undefined, { ref: false })]);
  server.closeAllConnections();
  server.close();
}
