import { readFileSync } from "node:fs";

/**
 * De databasestand uit stack.config.json, zoals de browsertests hem nodig hebben.
 * Dezelfde drie standen als scripts/lib/stack-config.mjs; hier apart in TypeScript
 * omdat Playwright dit bestand laadt en het klein moet blijven.
 */
export type DatabaseModus = "eigen" | "gedeeld" | "geen";

export function databaseModus(): DatabaseModus {
  try {
    const config: unknown = JSON.parse(readFileSync("stack.config.json", "utf8"));
    const database = (config as { database?: unknown }).database;
    if (database === false) return "geen";
    if (database === "gedeeld") return "gedeeld";
    return "eigen";
  } catch {
    return "eigen";
  }
}

/**
 * Welke pagina's van de app de browsertests van de serverlaag (e2e/server-*.spec.ts) gebruiken,
 * naast de routes van de template zelf (`/login`, `/login/terug`, `/robots.txt`, een adres dat
 * niet bestaat). Ze staan in stack.config.json, onder `browsertest`:
 *
 *   "browsertest": { "openbare_pagina": "/", "pagina_met_inlog": "/account" }
 *
 * - `openbare_pagina`: een pagina die voor iedereen gelijk is en om een openbare cache vraagt
 *   (`openbaarCache`). Daarop toetst de test de cacheregel.
 * - `pagina_met_inlog`: een pagina die zonder sessie naar `/login` stuurt (`vereisGebruiker`).
 *
 * Heeft de app zo'n pagina niet (nog niet), dan slaat de test dat deel over, met een regel die
 * zegt waarom. Een pad begint met `/`, zonder `?` of `#`.
 */
export type Browsertest = { openbarePagina: string | null; paginaMetInlog: string | null };

export function browsertestPaginas(): Browsertest {
  const pad = (waarde: unknown) =>
    typeof waarde === "string" && /^\/[^?#\s]*$/.test(waarde) ? waarde : null;
  try {
    const config: unknown = JSON.parse(readFileSync("stack.config.json", "utf8"));
    const blok = (config as { browsertest?: Record<string, unknown> }).browsertest ?? {};
    return {
      openbarePagina: pad(blok.openbare_pagina),
      paginaMetInlog: pad(blok.pagina_met_inlog),
    };
  } catch {
    return { openbarePagina: null, paginaMetInlog: null };
  }
}
