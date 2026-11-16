import { existsSync } from "node:fs";
import { fail, pass } from "./lib/changed-files.mjs";
import { cloudflareConfig, GEBOUWD, gebouwdeConfig } from "./lib/cloudflare-config.mjs";

/**
 * Houdt `wrangler.jsonc` binnen de afspraken van de stack: één Worker met de servercode
 * in workers/app.ts, elk adres achter Access, alleen openbare variabelen, en geen opslag
 * van Cloudflare zelf (D1, R2, KV, Durable Objects of een sleutel die niet op de lijst
 * staat). Gegevens staan in Supabase.
 *
 * De controle zelf staat in `scripts/lib/cloudflare-config.mjs`; de uitrol gebruikt
 * dezelfde controle als poort. Deze guard draait hem al op de pull request, zodat een
 * app die om opslag vraagt niet kan mergen in plaats van pas bij de uitrol te stranden.
 * Ontbreekt het bestand of is het niet te lezen, dan faalt de guard ook.
 *
 * Wat er werkelijk wordt uitgerold, is de config die de build maakt (dist/server/wrangler.json).
 * Die krijgt dezelfde controle: is er gebouwd, dan kijkt deze guard ook daarnaar. Met
 * `--gebouwd` is dat verplicht; zo draait hij in de check Code na de build en in de uitrol
 * vlak voor `wrangler deploy`. Zie het tweede deel van `scripts/lib/cloudflare-config.mjs`.
 */
const gebouwdVerplicht = process.argv.includes("--gebouwd");
let config;
try {
  config = cloudflareConfig();
} catch (fout) {
  fail("wrangler.jsonc houdt zich niet aan de afspraken van de stack.", [
    fout instanceof Error ? fout.message : String(fout),
    "",
    "Gegevens en geheime sleutels horen in Supabase; Cloudflare maakt en serveert de pagina's en regelt de toegang.",
    "Zie de regels in AGENTS.md en de uitleg in docs/WERKWIJZE.md.",
  ]);
}

let gebouwd = "";
if (gebouwdVerplicht || existsSync(GEBOUWD)) {
  try {
    gebouwdeConfig();
    gebouwd = ", en de gebouwde config ook";
  } catch (fout) {
    fail("Wat de build heeft gemaakt, houdt zich niet aan de afspraken van de stack.", [
      fout instanceof Error ? fout.message : String(fout),
      "",
      "Uitgerold wordt wat de build maakt, niet wrangler.jsonc. Dit verschil komt uit de build:",
      "kijk in vite.config.ts, react-router.config.ts en public/. Staat er een oude build,",
      "draai dan `pnpm build` opnieuw.",
    ]);
  }
}

pass(
  config.stand === "tijdelijk"
    ? `wrangler.jsonc klopt (tijdelijke stand: ${config.worker} op workers.dev, zolang er geen eigen domein is)${gebouwd}`
    : `wrangler.jsonc klopt (${config.worker} op ${config.hostname})${gebouwd}`,
);
