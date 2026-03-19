import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 15000,
  use: {
    baseURL: "http://127.0.0.1:3813",
    headless: true,
  },
  webServer: {
    command: "python3 -m http.server 3813 --bind 127.0.0.1",
    url: "http://127.0.0.1:3813",
    reuseExistingServer: true,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
