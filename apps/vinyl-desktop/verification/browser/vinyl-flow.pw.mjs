import { expect, test } from "@playwright/test";
import {
  directory,
  installIpcFixture,
  requests,
  shareUrl,
  shortsUrl,
  title,
  watchUrl,
} from "./ipc-fixture.mjs";

const quality = (page, name) => page.getByRole("button", { name, exact: true });
const countdown = (page) => page.getByText(/Continuing in \d+s/);
const waitToExpire = (page) => page.clock.runFor(5250);

async function inspect(page, url = watchUrl) {
  await page.getByRole("textbox", { name: "Video link" }).fill(url);
  await quality(page, "Inspect link").click();
  await expect(page.getByRole("heading", { name: "Choose quality" })).toBeVisible();
}

async function lastDownload(page) {
  await expect.poll(() => requests(page, "start_download")).toHaveLength(1);
  return (await requests(page, "start_download"))[0].params;
}

test("clipboard watch URL uses upstream IPC contracts for 1080p and renders injected progress events", async ({
  page,
}) => {
  await installIpcFixture(page, { clipboard: watchUrl });
  await page.clock.install();
  await page.goto("/");
  await expect(page.getByText(title, { exact: true }).last()).toBeVisible();
  await expect(page.locator(".cover-img")).toHaveAttribute("src", "/vinyl.webp");
  await expect(page.locator(".video-duration")).toHaveText("2:23");
  await expect(quality(page, "1080p")).toHaveAttribute("aria-pressed", "true");
  expect(await requests(page, "fetch_video_info")).toEqual([
    expect.objectContaining({ url: watchUrl }),
  ]);
  expect(await requests(page, "start_download")).toEqual([]);
  await quality(page, "Continue").click();
  await expect(page.getByText("Continuing in 5s")).toBeVisible();
  await waitToExpire(page);
  const { id, videoFormat, audioFormat, downloadDir, url } = await lastDownload(page);
  expect({ videoFormat, audioFormat, downloadDir, url }).toEqual({
    videoFormat: "v-1080",
    audioFormat: "a-140",
    downloadDir: directory,
    url: watchUrl,
  });
  await expect(page).toHaveURL(/\/downloads$/);
  await page.evaluate(
    ({ id }) =>
      window.vinylFixture.emit("download-progress", {
        id,
        percent: 34.7,
        speed: "2.5 MiB/s",
        eta: "00:14",
      }),
    { id },
  );
  await expect(page.getByText("34.7%")).toBeVisible();
  await expect(page.getByText("ETA 00:14")).toBeVisible();
  await expect(page.getByText("2.5 MiB/s").first()).toBeVisible();
  await page.evaluate(
    ({ id }) =>
      window.vinylFixture.emit("download-complete", {
        id,
        outputFile: "C:\\Users\\fixture\\Downloads\\A Vinyl Study.mp4",
        fileSizeBytes: 1073484,
      }),
    { id },
  );
  await expect(page.getByText("Saved to disk")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Folder: A Vinyl Study.mp4" })).toBeVisible();
});

for (const [name, next] of [
  ["1080p", "1080p"],
  ["720p", "720p"],
  ["More", "1080p"],
]) {
  test(`${name} cancels autoplay immediately, leaving manual Download ${next}`, async ({
    page,
  }) => {
    await installIpcFixture(page);
    await page.clock.install();
    await page.goto("/");
    await inspect(page);
    await quality(page, "Continue").click();
    await expect(countdown(page)).toBeVisible();
    await quality(page, name).click();
    await expect(countdown(page)).toHaveCount(0);
    await expect(quality(page, `Download ${next}`)).toBeVisible();
    if (name === "More") {
      for (const tier of ["144p", "240p", "360p", "2K", "4K"])
        await expect(quality(page, tier)).toBeVisible();
    }
    await waitToExpire(page);
    expect(await requests(page, "start_download")).toEqual([]);
    await quality(page, `Download ${next}`).click();
    expect((await lastDownload(page)).videoFormat).toBe(`v-${parseInt(next, 10)}`);
  });
}

test("shorts copied on return select the real portrait 1080p rendition", async ({ page }) => {
  await installIpcFixture(page, { portrait: true });
  await page.goto("/");
  await expect(page.getByRole("link", { name: "NexusDownloader" })).toBeVisible();
  await expect(
    page.getByText("Proudly Created by Sheikh Arsalan in Colaboration with Mubashir"),
  ).toBeVisible();
  await page.evaluate((next) => {
    window.vinylFixture.clipboard = next;
    window.dispatchEvent(new Event("focus"));
  }, shortsUrl);
  await expect(quality(page, "1080p")).toHaveAttribute("aria-pressed", "true");
  await quality(page, "720p").click();
  await quality(page, "Download 720p").click();
  expect(await lastDownload(page)).toEqual(
    expect.objectContaining({ videoFormat: "v-720", url: shortsUrl }),
  );
});

test("a missing 1080p format never offers automatic Continue and full controls remain", async ({
  page,
}) => {
  await installIpcFixture(page, { clipboard: shareUrl, top: 720 });
  await page.goto("/");
  await expect(page.getByText(/1080p isn’t offered/)).toBeVisible();
  await expect(quality(page, "1080p")).toBeDisabled();
  await expect(quality(page, "Continue")).toHaveCount(0);
  await quality(page, "Formats & advanced").click();
  await expect(page.getByText("Audio Only", { exact: true })).toBeVisible();
  await expect(page.getByText("Download Directory", { exact: true })).toBeVisible();
  expect(await requests(page, "start_download")).toEqual([]);
});

test("a save folder must be chosen before the countdown", async ({ page }) => {
  await installIpcFixture(page, { directory: "" });
  await page.goto("/");
  await inspect(page);
  await quality(page, "Continue").click();
  await expect(countdown(page)).toHaveCount(0);
  await expect(quality(page, "Select")).toBeFocused();
  expect(await requests(page, "start_download")).toEqual([]);
  await quality(page, "Select").click();
  await quality(page, "Continue").click();
  await expect(countdown(page)).toBeVisible();
});

test("an unavailable FFmpeg never submits or starts a countdown", async ({ page }) => {
  await installIpcFixture(page, { ffmpegReady: false });
  await page.goto("/");
  await inspect(page);
  await quality(page, "Continue").click();
  await expect(page.getByText(/A download tool is not ready/)).toBeVisible();
  await expect(countdown(page)).toHaveCount(0);
  expect(await requests(page, "start_download")).toEqual([]);
});

test("verification errors stay in upstream setup instead of reporting success", async ({
  page,
}) => {
  await installIpcFixture(page, { fetchFailure: "Sign in to confirm you’re not a bot" });
  await page.goto("/");
  await page.getByRole("textbox", { name: "Video link" }).fill(watchUrl);
  await quality(page, "Inspect link").click();
  await expect(page.getByText("Cookie Settings", { exact: true }).last()).toBeVisible();
  await expect(quality(page, "Continue")).toHaveCount(0);
  expect(await requests(page, "start_download")).toEqual([]);
});

test("leaving the pending tab clears autoplay and does not submit from another page", async ({
  page,
}) => {
  await installIpcFixture(page);
  await page.clock.install();
  await page.goto("/");
  await inspect(page);
  await quality(page, "Continue").click();
  await expect(countdown(page)).toBeVisible();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Video link" })).toBeVisible();
  await waitToExpire(page);
  expect(await requests(page, "start_download")).toEqual([]);
});
