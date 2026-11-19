import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./browser",
  testMatch: "*.pw.mjs",
  fullyParallel: true,
  workers: 2,
  use: {
    baseURL: "http://127.0.0.1:15690",
    viewport: { width: 1060, height: 760 },
    locale: "en-US",
    reducedMotion: "reduce",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined },
    trace: "retain-on-failure",
  },
  webServer: {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    command: "vite preview --host 127.0.0.1 --port 15690 --strictPort",
    url: "http://127.0.0.1:15690",
    reuseExistingServer: false,
  },
});
