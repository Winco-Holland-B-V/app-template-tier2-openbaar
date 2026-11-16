import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * De zoekregel voor de hoofdpaden van een app, op één plek. Twee lezers:
 * - tests/unit/onderdelen.test.ts (van de template) vergelijkt ze met src/onderdelen.ts;
 * - /stagetwo-tierN:updaten draait dit bestand (`node scripts/lib/onderdelen.mjs` in de app)
 *   om src/onderdelen.ts eenmalig te vullen als het nog ontbreekt.
 * Zo tellen plugin en test nooit verschillend.
 *
 * Herkend:
 * - de routes van de app, uit `src/routes.ts`. Dat bestand wordt geladen en uitgelezen
 *   zoals React Router dat doet (`index(...)`, `route("klanten", ...)`, `layout`, `prefix`,
 *   ook genest), niet met een zoekpatroon: een pad staat er zonder `/` en een kind hoort
 *   onder zijn ouder.
 * - in de rest van src/ (niet in tests): een router in een scherm (`<Route path="/...">`,
 *   `path={"/..."}` en `path: "/..."`), en een eigen keuze op het pad: `pathname ===
 *   "/plugin"`, `pathname.startsWith("/beheer")`, en hetzelfde met een naam die het pad
 *   vasthoudt (`const pad = window.location.pathname; if (pad === "/hallo")`) of
 *   `case "/x":` in een `switch (pad)`.
 * Alleen paden die met een `/` beginnen tellen; het hoofdpad is het eerste stuk:
 * `/klanten/:id` hoort bij `/klanten`. Niet herkend, met opzet: een vangroute (`*`, de
 * browser-schermen van een omgezette app: hun eigen router telt wel), een bestand
 * (`/robots.txt`, `/sitemap.xml`) en een vergelijking op het pad van een ander adres dan de
 * pagina (`foto.pathname.startsWith("/storage/")`).

 * Dit bestand is van de template en komt met elke versie mee.
 */

const ROUTER = /\bpath(?:=\{?|:\s*)["'`](\/[^"'`]*)["'`]/g;
const PAD = String.raw`["'\`](\/[^"'\`]*)["'\`]`;

function bestanden(map) {
  if (!existsSync(map)) return [];
  return readdirSync(map).flatMap((naam) => {
    const pad = join(map, naam);
    if (statSync(pad).isDirectory()) return bestanden(pad);
    return /\.tsx?$/.test(naam) && !/\.test\.tsx?$/.test(naam) ? [pad] : [];
  });
}

/** Het hoofdpad: `/klanten/:id` wordt `/klanten`; null voor `/:id` en `/*`. */
export function hoofdpad(pad) {
  const eerste = String(pad).split("/").filter(Boolean)[0];
  if (eerste === undefined) return "/";
  if (eerste.startsWith(":") || eerste.startsWith("*")) return null;
  return `/${eerste}`;
}

/** Namen die het pad vasthouden: `pathname` zelf, en `x` in `const x = ....pathname`. */
function padNamen(tekst) {
  const namen = new Set(["pathname"]);
  for (const m of tekst.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*[\w$.?]*\bpathname\b/g,
  )) {
    if (m[1]) namen.add(m[1]);
  }
  for (const m of tekst.matchAll(/\{\s*pathname\s*:\s*([A-Za-z_$][\w$]*)\s*\}/g)) {
    if (m[1]) namen.add(m[1]);
  }
  return [...namen];
}

/** Alle paden (nog niet ingekort) die in één bestand een route of een keuze op het pad zijn. */
export function padenInTekst(tekst) {
  const paden = [...tekst.matchAll(ROUTER)].map((m) => m[1] ?? "");
  // `pathname` telt los (`const { pathname } = useLocation()`) of als deel van het adres van
  // de pagina of het verzoek (`location.pathname`, `url.pathname`), niet van een willekeurig
  // adres: `foto.pathname.startsWith("/storage/")` is een afbeelding, geen scherm.
  const naam = `(?:${padNamen(tekst)
    .map((n) => (n === "pathname" ? "(?:(?<![\\w$.])|(?<=\\b(?:location|url)\\.))pathname" : n))
    .join("|")})`;
  const patronen = [
    new RegExp(`\\b${naam}\\s*[!=]==?\\s*${PAD}`, "g"),
    new RegExp(`${PAD}\\s*[!=]==?\\s*(?:[\\w$]+\\.)*${naam}\\b`, "g"),
    new RegExp(`\\b${naam}\\??\\.startsWith\\(\\s*${PAD}`, "g"),
  ];
  for (const patroon of patronen) for (const m of tekst.matchAll(patroon)) paden.push(m[1] ?? "");
  if (new RegExp(`\\bswitch\\s*\\(\\s*(?:[\\w$]+\\.)*${naam}\\s*\\)`).test(tekst)) {
    for (const m of tekst.matchAll(new RegExp(`\\bcase\\s+${PAD}\\s*:`, "g")))
      paden.push(m[1] ?? "");
  }
  return paden;
}

/**
 * De volledige paden uit een routelijst van React Router (wat `src/routes.ts` oplevert):
 * `route("klanten", ..., [route(":id", ...)])` geeft `/klanten` en `/klanten/:id`, een
 * `index` het pad van zijn ouder, en een `layout` voegt niets toe.
 */
export function padenUitRoutes(routes, ouder = "") {
  return routes.flatMap((r) => {
    const pad = r.path ? `${ouder}/${r.path}`.replace(/\/+/g, "/") : ouder;
    const zelf = r.path || r.index ? [pad || "/"] : [];
    return [...zelf, ...padenUitRoutes(r.children ?? [], pad)];
  });
}

/** De routes uit `src/routes.ts` van de app in `map`; een lege lijst als dat bestand er niet is. */
async function routesVan(map) {
  const bestand = join(map, "src", "routes.ts");
  if (!existsSync(bestand)) return [];
  let geladen;
  try {
    geladen = await import(pathToFileURL(bestand).href);
  } catch (oorzaak) {
    throw new Error(
      `src/routes.ts is niet te laden (${oorzaak?.message ?? oorzaak}). Draai eerst \`pnpm install\`.`,
    );
  }
  const routes = await geladen.default;
  if (!Array.isArray(routes)) throw new Error("src/routes.ts levert geen lijst met routes op.");
  return routes;
}

/** De hoofdpaden van de app in `map`, gesorteerd. */
export async function hoofdpaden(map = process.cwd()) {
  const uit = new Set();
  const paden = padenUitRoutes(await routesVan(map));
  for (const bestand of bestanden(join(map, "src"))) {
    paden.push(...padenInTekst(readFileSync(bestand, "utf8")));
  }
  for (const pad of paden) {
    const hoofd = hoofdpad(pad);
    // Een bestand (robots.txt, sitemap.xml, een afbeelding) is geen scherm.
    if (hoofd && !hoofd.includes(".")) uit.add(hoofd);
  }
  return [...uit].sort();
}

// Los gedraaid (zo doet updaten het): de hoofdpaden van de app in deze map, als JSON.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await hoofdpaden())}\n`);
}
