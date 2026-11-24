import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { directory, installIpcFixture, requests, shortsUrl, videoInfo, watchUrl } from "./ipc-fixture.mjs";

const require = createRequire(import.meta.url);
const csp = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url)))
  .app.security.csp;
const button = (page, name) => page.getByRole("button", { name, exact: true });
const linkInput = (page) => page.getByRole("textbox", { name: "Video link" });
const taskCard = (page, text) => page.locator(".task-card").filter({ hasText: text });
const startCalls = (page) => requests(page, "start_download");
const emit = (page, event, payload) => page.evaluate(({ event, payload }) =>
  window.vinylFixture.emit(event, payload), { event, payload });
const row = (id, status, extra = {}) => ({
  id, status, url: watchUrl, title: `Audit ${id}`, thumbnail: "", formatLabel: "720p",
  createdAt: id.charCodeAt(0), percent: 0, speed: "", eta: "", downloaded: "", total: "", logs: [],
  params: { url: watchUrl, downloadDir: directory, downloadMode: "default" }, ...extra,
});

async function inspect(page, url = watchUrl) {
  await linkInput(page).fill(url);
  await button(page, "Inspect link").click();
  await expect(page.getByRole("heading", { name: "Choose quality" })).toBeVisible();
}

async function assertOrder(page, ...ids) {
  await expect.poll(async () => (await startCalls(page)).map(({ params }) => params.id)).toEqual(ids);
}

for (const themeMode of ["dark", "light"]) {
  test(`keyboard, names, headings and contrast at minimum size (${themeMode})`, async ({ page }) => {
    await page.setViewportSize({ width: 560, height: 510 });
    await installIpcFixture(page, { settings: { themeMode } });
    await page.goto("/");
    const repository = page.getByRole("link", { name: "NexusDownloader repository", exact: true });
    await expect(repository).toHaveAttribute("href", "https://github.com/sadapay404/NexusDownloader");
    await expect(page.getByRole("banner").getByRole("button", { name: /language|translate/i })).toHaveCount(0);
    await page.getByRole("link", { name: "NexusDownloader", exact: true }).focus();
    for (const name of ["Home", "Pending", "Downloads", "Tools"]) {
      await page.keyboard.press("Tab");
      await expect(button(page, name)).toBeFocused();
    }
    await page.keyboard.press("Tab");
    await expect(repository).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(button(page, "Settings")).toBeFocused();

    const check = async (route) => {
      if (!(await page.evaluate(() => Boolean(window.axe)))) {
        await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
      }
      const violations = await page.evaluate(async () => {
        const { violations } = await window.axe.run(document, {
          runOnly: { type: "rule", values: [
            "aria-required-attr", "aria-toggle-field-name", "button-name", "color-contrast",
            "link-name", "region", "role-img-alt", "select-name", "label",
          ] },
        });
        return violations.map(({ id, nodes }) => ({
          id, nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
        }));
      });
      expect(violations, `${themeMode} ${route}`).toEqual([]);
      const size = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth }));
      expect(size.page).toBeLessThanOrEqual(size.viewport);
    };
    await check("home");
    await inspect(page);
    await check("quality");
    await button(page, "Settings").click();
    await expect(page.getByText("Windows", { exact: true })).toBeVisible();
    const language = page.getByRole("combobox", { name: "Language" });
    await expect(language).toHaveValue("en-US");
    await check("settings");
    await language.selectOption("es-ES");
    await expect(page.getByRole("heading", { name: "Ajustes", exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "es-ES");
  });
}

test("the production CSP still boots and displays a proxied blob thumbnail", async ({ page }) => {
  await installIpcFixture(page, { settings: { proxy: "http://127.0.0.1:9999" } });
  await page.addInitScript(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === "fetch_thumbnail") {
        const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aezsAAAAASUVORK5CYII=";
        return Uint8Array.from(atob(png), (c) => c.charCodeAt(0)).buffer;
      }
      return invoke(cmd, args);
    };
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /content security policy|refused to/i.test(message.text())) {
      errors.push(message.text());
    }
  });
  await page.route("**/*", async (route) => {
    if (!route.request().isNavigationRequest()) return route.continue();
    const response = await route.fetch();
    return route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": csp } });
  });
  await page.goto("/");
  await inspect(page);
  const cover = page.locator(".cover-img");
  await expect(cover).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => cover.evaluate((image) => image.naturalWidth)).toBe(1);
  expect(errors).toEqual([]);
});

test("draft selection survives reload without restoring the countdown", async ({ page }) => {
  await installIpcFixture(page);
  await page.clock.install();
  await page.goto("/");
  await inspect(page);
  await button(page, "720p").click();
  await expect(button(page, "720p")).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Choose quality" })).toBeVisible();
  await expect(button(page, "720p")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/Continuing in \d+s/)).toHaveCount(0);
  await page.clock.runFor(5400);
  expect(await startCalls(page)).toEqual([]);
  await button(page, "Download 720p").click();
  await expect.poll(async () => (await startCalls(page))[0]?.params.videoFormat).toBe("v-720");
});

test("a first-run clipboard link survives Settings and retries only when asked", async ({ page }) => {
  await installIpcFixture(page, { clipboard: watchUrl, ytdlpReady: false });
  await page.goto("/");
  await expect(page.getByText("yt-dlp Required", { exact: true })).toBeVisible();
  await button(page, "Go to Settings").click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("download_ytdlp"));
  await page.getByRole("navigation").getByRole("button", { name: "Home", exact: true }).click();
  await expect(linkInput(page)).toHaveValue(watchUrl);
  expect(await startCalls(page)).toEqual([]);
  await button(page, "Retry link").click();
  await expect(page.getByRole("heading", { name: "Choose quality" })).toBeVisible();
  expect(await startCalls(page)).toEqual([]);
});

test("portrait Quick Download obeys the cap and shows the source dimensions", async ({ page }) => {
  await installIpcFixture(page, {
    info: videoInfo({ portrait: true }),
    settings: { homeDownloadBehavior: "quick", quickMaxHeight: 720 },
  });
  await page.goto("/");
  await linkInput(page).fill(shortsUrl);
  await linkInput(page).press("Enter");
  await expect.poll(async () => (await startCalls(page))[0]?.params.videoFormat).toBe("v-720");
  const [{ params }] = await startCalls(page);
  await expect(page.locator(".task-card").filter({ hasText: "720p" })).toContainText(/720×1280/);
  expect((await requests(page, "db_upsert_task")).map(({ task }) => task.id)).toEqual([params.id, params.id]);
  expect(await requests(page, "db_delete_task")).toEqual([]);
});

test("FIFO starts only after tool settings and failed cancellation keeps the slot", async ({ page }) => {
  await installIpcFixture(page, { initialTasks: [row("C", "queued"), row("A", "queued"), row("B", "queued")],
    settings: { maxConcurrentDownloads: 1 } });
  await page.goto("/downloads");
  await assertOrder(page, "A");
  const calls = await page.evaluate(() => window.vinylFixture.calls.map(({ cmd }) => cmd));
  expect(calls.indexOf("set_js_runtime")).toBeLessThan(calls.indexOf("start_download"));
  expect(calls.indexOf("set_tool_sources")).toBeLessThan(calls.indexOf("start_download"));
  await page.evaluate(() => { window.vinylFixture.cancelError = "err_cancel_not_confirmed"; });
  await button(taskCard(page, "Audit A"), "Cancel Download").click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel Download", exact: true }).click();
  await expect(page.getByText(/could not confirm that the downloader stopped/i)).toBeVisible();
  await assertOrder(page, "A");
  await emit(page, "download-complete", { id: "A", outputFile: "", fileSizeBytes: 0 });
  await expect(taskCard(page, "Audit A")).toContainText("Failed");
  await expect.poll(async () => (await requests(page, "db_upsert_task")).find(({ task }) => task.id === "A")?.task.error).toBe("err_download_no_output");
  await assertOrder(page, "A", "B");
  await emit(page, "download-complete", { id: "B", outputFile: `${directory}/B.mp4`, fileSizeBytes: 123 });
  await assertOrder(page, "A", "B", "C");
});

test("failed retry write and unavailable drive both keep existing history after reload", async ({ page }) => {
  const outputFile = "Q:/offline/kept.mp4";
  await installIpcFixture(page, {
    initialTasks: [row("A", "error", { error: "Original download error" }),
      row("B", "completed", { outputFile, fileSizeBytes: 200 })],
    unavailable: [outputFile],
  });
  await page.goto("/downloads");
  await expect(taskCard(page, "Audit B")).toContainText(/saved file unavailable/i);
  await page.evaluate(() => { window.vinylFixture.rejectWrites = true; });
  await button(taskCard(page, "Audit A"), "Edit and Retry").click();
  await page.getByRole("dialog").getByRole("button", { name: "Edit and Retry", exact: true }).click();
  await expect(page.getByText(/could not retry|retry failed/i)).toBeVisible();
  expect(await requests(page, "db_delete_task")).toEqual([]);
  expect(await requests(page, "db_delete_tasks")).toEqual([]);
  await page.reload();
  await expect(taskCard(page, "Audit A")).toContainText("Failed");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("verification-rows"))
    .find(({ id }) => id === "A").error)).toBe("Original download error");
  await expect(taskCard(page, "Audit B")).toContainText(/saved file unavailable/i);
  expect(await startCalls(page)).toEqual([]);
});
