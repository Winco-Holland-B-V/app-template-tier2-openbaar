import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Een test van de template moet groen zijn in een echte app, niet alleen naast het voorbeeld.
 * In uitgave 42 en 43 was een test van de template groen in de template en rood in elke app:
 * hij leunde op de voorbeeldwinkel (een route, een tabel, een afbeelding) of op "nog geen eigen
 * domein". Pas een oefenverbouwing van een echte webshop zag het.
 *
 * Deze test bootst daarom een echte app na uit de huidige stand van de template: alles wat van
 * het voorbeeld is, gaat weg (de winkelroutes, src/features/winkel, de migratie en de seed van
 * de voorbeeldshop, public/voorbeeldshop en de tests die bij het voorbeeld horen), en er komt een
 * kleine eigen app voor in de plaats: een eigen openbare pagina, een eigen pagina met inlog, een
 * browser-scherm, een vangroute, een eigen tabel met poort, een eigen src/site.ts, een eigen
 * domein in wrangler.jsonc en een eigen lijst voor de browser in stack.config.json. Daarin
 * draaien de typecontrole, de lint, de unittests, de guards die geen database nodig hebben en
 * de build.
 *
 * Wat dit bewijst: elke test en elk script van de template werkt in een app zonder het
 * voorbeeld en met een eigen domein. Wat het niet bewijst: de tests die een database of een
 * browser nodig hebben (tests/rls, e2e); die draaien in de databasejob van CI. Daarvoor geldt
 * dezelfde regel, zie docs/WERKWIJZE.md ("Tests van de template").
 *
 * tests/unit/afgeleide-app.test.ts doet het andere helft: een app van de vorige uitgave met
 * alleen het manifest eroverheen.
 *
 * Alleen in de template zelf (herkend zoals guard-template dat doet). In een app slaat hij over:
 * daar is niets na te bootsen. Kan hij in de template niet draaien (geen git, geen
 * node_modules), dan is dat in CI rood, niet stil.
 *
 * Deze test is van de template en komt met elke versie mee.
 */
const WORTEL = resolve(__dirname, "../..");
const RUIME_BUFFER = 256 * 1024 * 1024;

function isDeTemplate(repo: string): boolean {
  return /\/(?:app-template-tier(?:1|2|2-openbaar)|stack-template(?:-cloudflare|-light)?)(?:\.git)?$/.test(
    repo,
  );
}

function probeer(args: string[], cwd = WORTEL): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: RUIME_BUFFER }).trim();
  } catch {
    return null;
  }
}

const repo = process.env.GITHUB_REPOSITORY ?? probeer(["remote", "get-url", "origin"]) ?? "";
const inDeTemplate = isDeTemplate(repo);

/**
 * Wat van het voorbeeld is: een app heeft dit niet. Een map eindigt op `/`; een patroon met `*`
 * geldt voor één naam in die map.
 */
const VAN_HET_VOORBEELD = [
  "src/routes/winkel/",
  "src/features/winkel/",
  "src/routes/routes.test.tsx",
  "supabase/migrations/*_voorbeeldshop.sql",
  "supabase/seed.sql",
  "public/voorbeeldshop/",
  "tests/rls/voorbeeldshop.test.ts",
  "tests/rls/klantportaal.test.ts",
  "e2e/voorbeeldshop.spec.ts",
  "e2e/voorbeeldshop-server.spec.ts",
  "e2e/voorbeeldshop-sessie.spec.ts",
  "e2e/klantportaal.spec.ts",
  "e2e/happy-path.spec.ts",
];

function isVanHetVoorbeeld(pad: string): boolean {
  return VAN_HET_VOORBEELD.some((patroon) => {
    if (patroon.endsWith("/")) return pad.startsWith(patroon);
    if (!patroon.includes("*")) return pad === patroon;
    const [voor, na] = patroon.split("*") as [string, string];
    return pad.startsWith(voor) && pad.endsWith(na) && !pad.slice(voor.length).includes("/");
  });
}

/** De eigen app: wat een bouwer na het weghalen van het voorbeeld zelf schrijft. */
/**
 * De bestanden van de eigen app. Er staat `FROM` in plaats van het gewone woord, zodat
 * tests/unit/template-afhankelijk.test.ts dit niet voor imports van de template houdt;
 * `eigenBestanden()` zet het terug.
 */
const EIGEN_RUW: Record<string, string> = {
  "src/site.ts": `/** Hoe deze site heet. Van het project. */
export const SITE = {
  naam: "Eigen app",
  omschrijving: "Een eigen app op de openbare template, zonder de voorbeeldwinkel.",
  logo: "/icon-512.png",
};
`,
  "src/routes.ts": `import { index, type RouteConfig, route } FROM "@react-router/dev/routes";

export default [
  index("routes/start.tsx"),
  route("notities", "routes/notities.tsx"),
  route("login", "routes/login.tsx"),
  route("login/terug", "routes/login-terug.ts"),
  route("sitemap.xml", "routes/sitemap.ts"),
  route("robots.txt", "routes/robots.ts"),
  route("*", "routes/oude-app.tsx"),
] satisfies RouteConfig;
`,
  "src/onderdelen.ts": `export type Onderdeel = { pad: string; naam: string; kop?: string };

export const ONDERDELEN: Onderdeel[] = [
  { pad: "/", naam: "Start", kop: "Eigen app" },
  { pad: "/notities", naam: "Notities" },
];

export const GEEN_ONDERDEEL: string[] = ["/login", "/robots.txt", "/sitemap.xml"];
`,
  "src/routes/start.tsx": `import { openbaarCache } FROM "@/lib/server/sessie.server";
import { vindbaarAdres } FROM "@/lib/vindbaar/adres.server";
import { paginaMeta } FROM "@/lib/vindbaar/meta";
import { SITE } FROM "@/site";
import type { Route } FROM "./+types/start";

export function loader({ context }: Route.LoaderArgs) {
  openbaarCache(context, { seconden: 300 });
  return { adres: vindbaarAdres(context).adres };
}

export const meta: Route.MetaFunction = ({ loaderData }) =>
  paginaMeta({
    site: SITE,
    titel: "Welkom",
    omschrijving: SITE.omschrijving,
    adres: loaderData?.adres,
  });

export default function Start() {
  return (
    <main>
      <h1>Eigen app</h1>
      <p>Een openbare pagina, voor iedereen gelijk.</p>
    </main>
  );
}
`,
  "src/routes/notities.tsx": `import { data } FROM "react-router";
import { supabaseVoorVerzoek, vereisGebruiker } FROM "@/lib/server/sessie.server";
import { paginaMeta } FROM "@/lib/vindbaar/meta";
import { SITE } FROM "@/site";
import type { Route } FROM "./+types/notities";

export async function loader({ context }: Route.LoaderArgs) {
  await vereisGebruiker(context);
  const { data: rijen, error } = await supabaseVoorVerzoek(context)
    .from("notities")
    .select("id, omschrijving")
    .order("omschrijving");
  if (error) throw data("De notities konden niet geladen worden.", { status: 503 });
  return { notities: rijen ?? [] };
}

export const meta: Route.MetaFunction = () =>
  paginaMeta({ site: SITE, titel: "Notities", omschrijving: "Je notities.", zoekmachines: false });

export default function Notities({ loaderData }: Route.ComponentProps) {
  return (
    <main>
      <h1>Notities</h1>
      <ul>
        {loaderData.notities.map((n) => (
          <li key={n.id}>{n.omschrijving}</li>
        ))}
      </ul>
    </main>
  );
}
`,
  // De schermen van vóór de overstap, als browser-scherm achter een vangroute.
  "src/routes/oude-app.tsx": `import OudeApp FROM "@/features/oud/oude-app.client";
import { browserScherm } FROM "@/lib/browser-scherm";
import { SITE } FROM "@/site";

const scherm = browserScherm({ titel: SITE.naam, scherm: OudeApp });
export const clientLoader = scherm.clientLoader;
export const HydrateFallback = scherm.HydrateFallback;
export const meta = scherm.meta;
export const headers = scherm.headers;
export default scherm.Scherm;
`,
  "src/features/oud/oude-app.client.tsx": `export { default } FROM "./oude-app";
`,
  "src/features/oud/oude-app.tsx": `import { useState } FROM "react";

/** Een scherm van vóór de overstap: het draait alleen in de browser. */
export default function OudeApp() {
  const [teller, setTeller] = useState(0);
  const breedte = typeof window === "undefined" ? 0 : window.innerWidth;
  return (
    <main>
      <h1>Oude app</h1>
      <p>Breedte van het scherm: {breedte}</p>
      <button type="button" onClick={() => setTeller(teller + 1)}>
        {teller}
      </button>
    </main>
  );
}
`,
  "src/routes/sitemap.ts": `import { openbaarCache } FROM "@/lib/server/sessie.server";
import { vindbaarAdres } FROM "@/lib/vindbaar/adres.server";
import { sitemapAntwoord } FROM "@/lib/vindbaar/sitemap";
import type { Route } FROM "./+types/sitemap";

export function loader({ context }: Route.LoaderArgs) {
  openbaarCache(context, { seconden: 3600 });
  const { absoluut } = vindbaarAdres(context);
  return sitemapAntwoord([{ adres: absoluut("/"), gewijzigd: null }]);
}
`,
  "src/routes/robots.ts": `import { openbaarCache } FROM "@/lib/server/sessie.server";
import { vindbaarAdres } FROM "@/lib/vindbaar/adres.server";
import { robotsAntwoord } FROM "@/lib/vindbaar/sitemap";
import type { Route } FROM "./+types/robots";

export function loader({ context }: Route.LoaderArgs) {
  openbaarCache(context, { seconden: 86400 });
  const { absoluut } = vindbaarAdres(context);
  return robotsAntwoord({ sitemap: absoluut("/sitemap.xml"), verboden: ["/notities", "/login"] });
}
`,
  "supabase/seed.sql": "-- Geen voorbeeldgegevens in deze app.\n",
  // De .gitignore van een app van de gewone tier 2: zonder de gegenereerde bestanden van de
  // server (.react-router/, worker-configuration.d.ts). De lint mag daar niet op leunen.
  ".gitignore": "node_modules/\ndist/\n.env\n.env.*\n!.env.example\ntest-results/\n",
  "supabase/migrations/20990101000000_notities.sql": `-- Een eigen tabel van deze app: niet het voorbeeld van de template.
create table public.notities (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  omschrijving text not null
);

alter table public.notities enable row level security;

create policy "notities_eigen" on public.notities
  for all to authenticated
  using (public.is_goedgekeurde_klant() and owner_id = auth.uid())
  with check (public.is_goedgekeurde_klant() and owner_id = auth.uid());
`,
  "tests/rls/notities.test.ts": `import { describe, it } FROM "vitest";
import { controleerAfscherming } FROM "./lib/afscherming";

describe("notities", () => {
  it("B ziet de notitie van A niet", async () => {
    await controleerAfscherming({
      tabel: "notities",
      maakRijAlsA: async (a) => {
        const { data, error } = await a.client
          .from("notities")
          .insert({ omschrijving: "van A", owner_id: a.id })
          .select("id")
          .single();
        if (error) throw error;
        return data.id;
      },
    });
  });
});
`,
};

function eigenBestanden(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(EIGEN_RUW).map(([pad, inhoud]) => [pad, inhoud.replace(/\bFROM "/g, 'from "')]),
  );
}

/** Een eigen domein, zoals elke app in productie. */
function metEigenDomein(tekst: string): string {
  const zonderRoutes = tekst.replace(/,?\s*"routes"\s*:\s*\[[^\]]*\]/, "");
  return zonderRoutes.replace(
    /"preview_urls":\s*true/,
    '"preview_urls": true,\n  "routes": [{ "pattern": "app.eigen-domein.nl", "custom_domain": true }]',
  );
}

/** De types van de eigen database: het klantportaal van de template en de eigen tabel. */
function eigenTypes(template: string): string {
  const begin = template.indexOf("  public: {");
  const eind = template.indexOf("\ntype DatabaseWithoutInternals");
  if (begin === -1 || eind === -1)
    throw new Error("src/lib/database.types.ts heeft een onbekende vorm");
  const eigen = `  public: {
    Tables: {
      klanten: {
        Row: { aangemeld_op: string; e_mail: string; goedgekeurd: boolean; user_id: string };
        Insert: { aangemeld_op?: string; e_mail: string; goedgekeurd?: boolean; user_id: string };
        Update: { aangemeld_op?: string; e_mail?: string; goedgekeurd?: boolean; user_id?: string };
        Relationships: [];
      };
      notities: {
        Row: { id: string; omschrijving: string; owner_id: string };
        Insert: { id?: string; omschrijving: string; owner_id: string };
        Update: { id?: string; omschrijving?: string; owner_id?: string };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      is_goedgekeurde_klant: { Args: Record<PropertyKey, never>; Returns: boolean };
      is_medewerker: { Args: Record<PropertyKey, never>; Returns: boolean };
      klant_aanmelden: { Args: Record<PropertyKey, never>; Returns: undefined };
      sessie_via_cloudflare: { Args: Record<PropertyKey, never>; Returns: boolean };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};
`;
  return template.slice(0, begin) + eigen + template.slice(eind);
}

/** Bouwt de nagebootste app uit de huidige stand (ook wat nog niet gecommit is). */
function bouwEchteApp(): string {
  const map = mkdtempSync(join(tmpdir(), "echte-app-"));
  const bestanden = (probeer(["ls-files", "-co", "--exclude-standard", "-z"]) ?? "")
    .split("\0")
    .filter(Boolean);
  for (const pad of bestanden) {
    if (isVanHetVoorbeeld(pad) || !existsSync(join(WORTEL, pad))) continue;
    mkdirSync(dirname(join(map, pad)), { recursive: true });
    copyFileSync(join(WORTEL, pad), join(map, pad));
  }
  for (const [pad, inhoud] of Object.entries(eigenBestanden())) {
    mkdirSync(dirname(join(map, pad)), { recursive: true });
    writeFileSync(join(map, pad), inhoud);
  }
  const wrangler = join(map, "wrangler.jsonc");
  writeFileSync(wrangler, metEigenDomein(readFileSync(wrangler, "utf8")));
  const types = join(map, "src/lib/database.types.ts");
  writeFileSync(types, eigenTypes(readFileSync(types, "utf8")));

  // stack.config.json: geen vrije functie van de voorbeeldwinkel, wel een eigen lijst voor de
  // browser (afbeeldingen van een leverancier en een scanner met WebAssembly).
  const configPad = join(map, "stack.config.json");
  const config = JSON.parse(readFileSync(configPad, "utf8"));
  config.klantportaal_vrije_functies = {};
  config.browser = {
    afbeeldingen_van: {
      "https://beeld.leverancier.example": "productfoto's van de leverancier",
    },
    webassembly: "de barcodescanner op het scherm voor de voorraad",
  };
  config.browsertest = { openbare_pagina: "/", pagina_met_inlog: "/notities" };
  writeFileSync(configPad, `${JSON.stringify(config, null, 2)}\n`);

  const inApp = (...args: string[]) =>
    execFileSync("git", args, { cwd: map, encoding: "utf8", maxBuffer: RUIME_BUFFER });
  inApp("init", "-q", "-b", "main");
  inApp("config", "user.email", "test@example.invalid");
  inApp("config", "user.name", "Nagebootste app");
  inApp("config", "commit.gpgsign", "false");
  inApp("remote", "add", "origin", "https://github.com/Klant/eigen-webshop.git");
  inApp("add", "-A");
  inApp("commit", "-q", "-m", "eigen app op de openbare template");
  symlinkSync(join(WORTEL, "node_modules"), join(map, "node_modules"), "dir");
  return map;
}

/** De omgeving van een app in CI: niets van deze testrun of van de template-CI. */
function omgevingVanDeApp(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [sleutel, waarde] of Object.entries(process.env)) {
    if (/^(?:GITHUB_|VITEST|VITE_|TEST$|NODE_ENV$|PR_BODY$)/.test(sleutel)) continue;
    env[sleutel] = waarde;
  }
  return env;
}

const STAPPEN: Array<[string, string, string[]]> = [
  ["types van de Worker", "node_modules/.bin/wrangler", ["types"]],
  ["types van de routes", "node_modules/.bin/react-router", ["typegen"]],
  ["typecontrole", "node_modules/.bin/tsc", ["--noEmit"]],
  ["lint", "node_modules/.bin/biome", ["check", "."]],
  // Ruimere tijd per test: deze run draait naast de gewone unittests, op dezelfde machine.
  [
    "unittests",
    "node_modules/.bin/vitest",
    ["run", "--config", "vitest.config.ts", "--testTimeout", "60000"],
  ],
  ["guard:tests", "node", ["scripts/guard-tests.mjs"]],
  ["guard:migrations", "node", ["scripts/guard-migrations.mjs"]],
  ["guard:rls", "node", ["scripts/guard-rls.mjs"]],
  ["guard:rls-tests", "node", ["scripts/guard-rls-tests.mjs"]],
  ["guard:secrets", "node", ["scripts/guard-secrets.mjs"]],
  ["guard:escapes", "node", ["scripts/guard-escape-hatches.mjs"]],
  ["guard:template", "node", ["scripts/guard-template.mjs"]],
  ["guard:cloudflare", "node", ["scripts/guard-cloudflare.mjs"]],
  ["guard:server", "node", ["scripts/guard-server.mjs"]],
  ["guard:testlat", "node", ["scripts/guard-testlat.mjs"]],
  ["build", "node", ["scripts/bouwen.mjs", "--logLevel", "error"]],
  ["guard:cloudflare na de build", "node", ["scripts/guard-cloudflare.mjs", "--gebouwd"]],
  ["guard:secrets na de build", "node", ["scripts/guard-secrets.mjs"]],
];

describe("een echte app zonder het voorbeeld (alleen in de template zelf)", () => {
  it("weet wat van het voorbeeld is", () => {
    expect(isVanHetVoorbeeld("src/routes/winkel/wagen.tsx")).toBe(true);
    expect(isVanHetVoorbeeld("supabase/migrations/20261114120000_voorbeeldshop.sql")).toBe(true);
    expect(isVanHetVoorbeeld("supabase/migrations/20261114100000_klantportaal.sql")).toBe(false);
    expect(isVanHetVoorbeeld("src/routes/login.tsx")).toBe(false);
    expect(isVanHetVoorbeeld("public/voorbeeldshop/mok.png")).toBe(true);
    expect(metEigenDomein('"preview_urls": true\n}')).toContain("app.eigen-domein.nl");
    expect(
      metEigenDomein('"preview_urls": true,\n  "routes": [{ "pattern": "x.nl" }]\n}'),
    ).not.toContain("x.nl");
  });

  it.runIf(inDeTemplate)(
    "typecontrole, lint, unittests, guards en build zijn groen in een app met een eigen domein en zonder voorbeeld",
    () => {
      if (probeer(["rev-parse", "HEAD"]) === null || !existsSync(join(WORTEL, "node_modules"))) {
        const reden = "geen git of geen node_modules";
        if (process.env.CI) throw new Error(`De echte app kan niet nagebootst worden: ${reden}.`);
        console.warn(`echte app overgeslagen: ${reden}`);
        return;
      }
      const map = bouwEchteApp();
      try {
        const env = omgevingVanDeApp();
        const fouten: string[] = [];
        for (const [naam, opdracht, args] of STAPPEN) {
          const uit = spawnSync(opdracht, args, {
            cwd: map,
            env,
            encoding: "utf8",
            maxBuffer: RUIME_BUFFER,
          });
          if (uit.status !== 0) {
            const tekst = `${uit.stdout ?? ""}\n${uit.stderr ?? ""}${uit.error ? `\n${uit.error}` : ""}`;
            fouten.push(`${naam}:\n${tekst.trim().split("\n").slice(-60).join("\n")}`);
          }
        }
        // Het voorbeeld is echt weg: anders bewijst de test niets.
        expect(readdirSync(join(map, "src/routes"))).not.toContain("winkel");
        expect(existsSync(join(map, "public/voorbeeldshop"))).toBe(false);
        expect(fouten, "rood in een echte app").toEqual([]);
      } finally {
        if (!process.env.ECHTE_APP_BEWAREN) rmSync(map, { recursive: true, force: true });
        else console.log(`echte app bewaard in ${map}`);
      }
    },
    900_000,
  );
});
