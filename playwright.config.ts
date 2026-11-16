import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// De testomgeving wordt geschreven door `pnpm env:local` en staat niet in git.
if (existsSync(".env.test")) process.loadEnvFile(".env.test");
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

/**
 * De browsertests draaien tegen de app zoals ze live gaat: een klantportaal
 * (`VITE_INLOGDIENST=cloudflare,mailcode`). Klanten loggen in met de code uit de lokale
 * mailvanger, medewerkers via een nagebootste inlogdienst; een wachtwoord kent deze build niet.
 * De link in de inlogmail gaat naar deze poort (`site_url` in supabase/config.toml;
 * tests/unit/klantportaal-lokaal.test.ts houdt die twee gelijk).
 */
const PORT_KLANTPORTAAL = 4173;
const PORT = PORT_KLANTPORTAAL;

function omgevingMet(extra: Record<string, string>): Record<string, string> {
  const omgeving: Record<string, string> = {};
  for (const [naam, waarde] of Object.entries(process.env)) {
    if (waarde !== undefined) omgeving[naam] = waarde;
  }
  return { ...omgeving, ...extra };
}

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Bewust de gebouwde app (schermen én servercode, in de echte Workers-omgeving), niet de
    // dev-server: je test wat er ook echt live gaat.
    // De poort staat in het preview-script; hier niet nog eens meegeven, want dan
    // krijgt Vite de vlag dubbel en bindt hij op een andere poort.
    command: "pnpm build && pnpm preview",
    env: omgevingMet({ VITE_INLOGDIENST: "cloudflare,mailcode" }),
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 180_000,
  },
});
