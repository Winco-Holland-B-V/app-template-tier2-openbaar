import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { browserRegels } from "./lib/browser-regels.mjs";
import { cloudflareConfig } from "./lib/cloudflare-config.mjs";
import { stackConfig } from "./lib/stack-config.mjs";

/**
 * `pnpm build`: `react-router build` (de schermen in dist/client, de servercode in
 * dist/server, samen één Worker), maar zonder de testlogin.
 *
 * De testlogin (`pnpm testlogin`) staat in .env.development.local, dat Vite alleen in de
 * dev-server leest. Staat hij toch in de omgeving of in .env.local (zoals bij
 * `pnpm test:e2e`, dat .env.local inleest), dan zou hij in de gebouwde bestanden komen:
 * src/lib/env.ts geeft heel import.meta.env aan de controle, en dan neemt Vite elke
 * VITE_-waarde op, in de schermen en in de servercode. Een waarde in de omgeving gaat bij Vite vóór elk .env-bestand, dus
 * leeg maken vóór het bouwen houdt hem eruit.
 *
 * Het tweede wat hier gebeurt: het eigen domein van de app (de route in wrangler.jsonc) gaat
 * als `VITE_PRODUCTIEDOMEIN` de build in. De servercode weet daarmee welk adres het echte
 * is; op elk ander adres (workers.dev, previews, je eigen computer) stuurt hij `noindex` en
 * een robots.txt die alles weigert (src/lib/server/). Zonder eigen domein blijft de waarde
 * leeg en is geen enkel adres productie. De waarde komt altijd uit wrangler.jsonc: wat er in
 * de omgeving of in een .env-bestand staat, wordt hier overschreven.
 *
 * Het derde: de eigen aanvullingen van de app op de Content-Security-Policy (`browser` in
 * stack.config.json, zie scripts/lib/browser-regels.mjs) gaan als `VITE_BROWSER_REGELS` de
 * build in, alleen als ze kloppen; anders weigert de build. Ook die waarde komt altijd uit
 * stack.config.json, nooit uit de omgeving of een .env-bestand.
 *
 * Dit staat hier en niet alleen in vite.config.ts, omdat dat bestand van het project is
 * en bij het bijwerken niet meekomt. Dit script komt met elke versie mee.
 */
export const ALLEEN_DEV = ["VITE_TESTLOGIN_EMAIL", "VITE_TESTLOGIN_WACHTWOORD"];

const reactRouter = fileURLToPath(
  new URL("../node_modules/@react-router/dev/bin.cjs", import.meta.url),
);
const env = { ...process.env };
for (const naam of ALLEEN_DEV) env[naam] = "";
try {
  env.VITE_PRODUCTIEDOMEIN = cloudflareConfig().hostname ?? "";
  const { regels, fouten } = browserRegels(stackConfig());
  if (fouten.length > 0) {
    throw new Error(
      `stack.config.json, \`browser\`: de build weigert, want deze aanvullingen op de Content-Security-Policy mogen niet:\n  ${fouten.join("\n  ")}\nZie docs/WERKWIJZE.md, "Server en browser".`,
    );
  }
  env.VITE_BROWSER_REGELS = JSON.stringify(regels);
} catch (fout) {
  console.error(fout instanceof Error ? fout.message : String(fout));
  process.exit(1);
}
const r = spawnSync(process.execPath, [reactRouter, "build", ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});
process.exit(r.status ?? 1);
