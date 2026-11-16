#!/usr/bin/env node
/**
 * Controleert de gebouwde code van een pull request vlak voordat hij als preview wordt
 * geüpload. Draait in preview-uitrollen.yml, met de scripts van main: de pull request heeft
 * zijn eigen controles al gedraaid, maar met zijn eigen versie van die controles. Deze stap
 * vertrouwt daar niet op.
 *
 *   - geen geheime sleutel in de gebouwde bestanden (guard-secrets);
 *   - geen module van Cloudflare zelf in de gebouwde Worker (guard-server);
 *   - geen kant-en-klare pagina of eigen robots.txt om de servercode heen (bestandFouten).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bestandFouten } from "./lib/cloudflare-config.mjs";

const fouten = bestandFouten("dist/client");
if (fouten.length) {
  console.error(
    `✗ De gebouwde bestanden van deze pull request kloppen niet:\n  ${fouten.join("\n  ")}`,
  );
  process.exit(1);
}
for (const guard of ["guard-secrets.mjs", "guard-server.mjs"]) {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL(guard, import.meta.url))], {
    stdio: "inherit",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
console.log("✓ de gebouwde pull request mag als preview online");
