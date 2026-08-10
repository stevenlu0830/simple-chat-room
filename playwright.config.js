import { defineConfig, devices } from '@playwright/test';

const PORT = 3100; // separate from the dev server on 3000
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests',
  // Each test opens two browser contexts; state leaks between tests through
  // the server's in-memory room, so keep files serial-safe by not sharing names.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL,
    trace: 'retain-on-failure',   // full timeline + DOM snapshots for failures
    video: 'retain-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  // Playwright boots the real server before the suite and kills it after.
  // This is what makes it end-to-end: no mocked WebSocket anywhere.
  webServer: {
    command: 'node server.js',
    env: { PORT: String(PORT) },
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
  },
});
