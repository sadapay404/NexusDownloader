import { expect } from "@playwright/test";

// Shared by renderer tests and the installed Windows WebView2 smoke test.
export async function verifyCreditsDialog(page) {
  const creator = page.getByRole("button", { name: "Sheikh Arsalan", exact: true });
  const credits = page.getByRole("dialog", { name: "Credits", exact: true });
  const close = credits.getByRole("button", { name: "Close", exact: true });

  await expect(credits).toBeHidden();
  await creator.click();
  await expect(credits).toBeVisible();
  await expect(close).toBeFocused();
  await expect(credits.locator(".credits-row")).toHaveCount(5);
  await expect(credits).not.toContainText(/yt-dlp-gui|\bMIT\b|branding only/);
  await expect(credits.getByText("Sheikh Arsalan", { exact: true })).toBeVisible();
  await expect(credits.getByText("Proprietary — All Rights Reserved", { exact: true })).toBeVisible();
  const academy = credits.getByText("Digital Sheikh Nexus Academy", { exact: true });
  const copyright = credits.getByText("© 2026 Sheikh Arsalan & Nexus Academy", { exact: true });
  for (const value of [academy, copyright]) {
    await expect(value).toBeVisible();
    const fits = await value.evaluate((cell) => {
      const range = document.createRange();
      range.selectNodeContents(cell);
      const lines = range.getClientRects();
      const { left, right } = cell.getBoundingClientRect();
      return lines.length === 1 && lines[0].left >= left - 1 && lines[0].right <= right + 1;
    });
    expect(fits, "Academy text must fit entirely on one line").toBe(true);
  }
  const blur = await credits.evaluate((dialog) => getComputedStyle(dialog, "::backdrop").backdropFilter);
  expect(blur).toContain("blur(");

  await academy.click();
  await expect(credits).toBeVisible();
  await close.click();
  await expect(credits).toBeHidden();
  await expect(creator).toBeFocused();

  await creator.press("Enter");
  await expect(credits).toBeVisible();
  await page.mouse.click(8, 8); // Outside the centered card, on the blurred backdrop.
  await expect(credits).toBeHidden();
  await expect(creator).toBeFocused();

  await creator.press("Space");
  await expect(credits).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(credits).toBeHidden();
  await expect(creator).toBeFocused();
}
