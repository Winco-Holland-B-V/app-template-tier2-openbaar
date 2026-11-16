import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Twee aanvallen uit uitgave 43 die de runtime niet kan tegenhouden, en guard:server nu wel:
 *
 *   - een route die zelf antwoorden bewaart (Cache API of `cf.cacheEverything`): de Worker zet
 *     `private, no-store`, maar de body is al die van de vorige, ingelogde bezoeker;
 *   - een loader die iets wijzigt: een GET van een andere site komt door de Origin-controle
 *     (terecht, anders breken gewone links), dus de bijwerking draait met het cookie van de
 *     bezoeker.
 *
 * Getest op een kopie van src/ en workers/ van deze app, met één bestand erbij.
 * Deze test is van de template.
 */
const WORTEL = resolve(__dirname, "../..");
const GUARD = join(WORTEL, "scripts/guard-server.mjs");

let map: string;
beforeEach(() => {
  map = mkdtempSync(join(tmpdir(), "guard-server-extra-"));
  for (const pad of ["src", "workers"])
    cpSync(join(WORTEL, pad), join(map, pad), { recursive: true });
});
afterEach(() => rmSync(map, { recursive: true, force: true }));

function draai(bestanden: Record<string, string>) {
  for (const [naam, inhoud] of Object.entries(bestanden)) {
    mkdirSync(dirname(join(map, naam)), { recursive: true });
    writeFileSync(join(map, naam), inhoud);
  }
  const r = spawnSync(process.execPath, [GUARD], { cwd: map, encoding: "utf8" });
  return { code: r.status, uitvoer: `${r.stdout}${r.stderr}` };
}

describe("guard:server: een browser-scherm haalt zijn scherm uit een .client-bestand", () => {
  const route = (bron: string) =>
    `import Scherm from "${bron}";\nimport { browserScherm } from "@/lib/browser-scherm";\nconst scherm = browserScherm({ titel: "x", scherm: Scherm });\nexport default scherm.Scherm;\n`;
  it("uit een .client-bestand: groen", () => {
    const r = draai({ "src/routes/scanner.tsx": route("@/features/scanner/scanner.client") });
    expect(r.code, r.uitvoer).toBe(0);
  });
  it("rechtstreeks uit het scherm: rood", () => {
    const r = draai({ "src/routes/scanner.tsx": route("@/features/scanner/scanner") });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("src/routes/scanner.tsx");
    expect(r.uitvoer).toContain(".client");
  });
});

describe("guard:server: de eigen aanvullingen op de Content-Security-Policy", () => {
  it("een goede lijst is groen; scripts van elders, een jokerteken of geen reden is rood", () => {
    const met = (browser: unknown) =>
      draai({ "stack.config.json": JSON.stringify({ database: false, browser }) });
    const goed = met({
      afbeeldingen_van: { "https://beeld.leverancier.nl": "productfoto's van de leverancier" },
      webassembly: "de barcodescanner",
    });
    expect(goed.code, goed.uitvoer).toBe(0);
    for (const fout of [
      { scripts_van: { "https://cdn.voorbeeld.nl": "een bibliotheek" } },
      { afbeeldingen_van: { "*": "alles" } },
      { verbindingen_met: { "https://beeld.leverancier.nl": "" } },
      { webassembly: true },
    ]) {
      const r = met(fout);
      expect(r.code, JSON.stringify(fout)).not.toBe(0);
      expect(r.uitvoer).toContain("stack.config.json");
    }
  });
});

describe("guard:server: een route bewaart geen antwoorden zelf", () => {
  it("de aanval: een loader met caches.open, match en put wordt geweigerd", () => {
    const r = draai({
      "src/routes/product.tsx": [
        "export async function loader({ request }: { request: Request }) {",
        "  const cache = await caches.open('prijzen');",
        "  const hit = await cache.match(request);",
        "  if (hit) return hit;",
        "  const vers = new Response('persoonlijke prijs');",
        "  await cache.put(request, vers.clone());",
        "  return vers;",
        "}",
        "",
      ].join("\n"),
    });
    expect(r.code, r.uitvoer).not.toBe(0);
    expect(r.uitvoer).toContain("src/routes/product.tsx:2");
    expect(r.uitvoer).toContain("openbaarCache");
  });

  it("caches.default, globalThis.caches, cacheEverything en cacheTtl: overal in src/ en workers/", () => {
    for (const [naam, code] of [
      [
        "src/lib/bewaar.server.ts",
        "export const c = () => caches.default.put('a', new Response());",
      ],
      ["src/features/x/hulp.ts", "export const c = () => globalThis.caches.open('x');"],
      [
        "src/routes/a.tsx",
        "export const loader = () => fetch('https://x.nl', { cf: { cacheEverything: true } });",
      ],
      [
        "src/routes/b.tsx",
        "export const loader = () => fetch('https://x.nl', { cf: { cacheTtl: 600 } });",
      ],
      ["workers/extra.ts", "export const c = caches;"],
    ]) {
      const r = draai({ [naam as string]: `${code}\n` });
      expect(r.code, naam).not.toBe(0);
      expect(r.uitvoer).toContain(naam);
      rmSync(join(map, naam as string));
    }
  });

  it("uitleg in commentaar en een eigen veld dat caches heet mogen", () => {
    const r = draai({
      "src/routes/uitleg.tsx":
        "// Gebruik geen caches.default of cacheEverything; zie openbaarCache.\nexport const instellingen = { caches: 2 };\nexport const loader = () => null;\n",
    });
    expect(r.code, r.uitvoer).toBe(0);
  });
});

describe("guard:server: een loader wijzigt niets", () => {
  const route = (loader: string) =>
    `import { supabaseVoorVerzoek } from "@/lib/server/sessie.server";\n${loader}\nexport default function P() { return null; }\n`;

  for (const [wat, loader] of [
    [
      "insert",
      'export async function loader({ context }) {\n  await supabaseVoorVerzoek(context).from("bezoeken").insert({ pad: "/" });\n  return null;\n}',
    ],
    [
      "update over meer regels",
      'export async function loader({ context }) {\n  await supabaseVoorVerzoek(context)\n    .from("klanten")\n    .update({ actief: false })\n    .eq("id", 1);\n  return null;\n}',
    ],
    [
      "delete",
      'export async function loader({ context, params }) {\n  await supabaseVoorVerzoek(context).from("wagen").delete().eq("id", params.id);\n  return null;\n}',
    ],
    [
      "upsert in een pijlfunctie",
      'export const loader = async ({ context }) => {\n  await supabaseVoorVerzoek(context).from("x").upsert({ a: 1 });\n  return null;\n};',
    ],
    [
      "rpc zonder markering",
      'export async function loader({ context }) {\n  const { data } = await supabaseVoorVerzoek(context).rpc("account_verwijderen", {});\n  return data;\n}',
    ],
    [
      "bestand uploaden",
      'export async function loader({ context }) {\n  await supabaseVoorVerzoek(context).storage.from("b").upload("a.txt", "x");\n  return null;\n}',
    ],
    [
      "rpc met een markering die door code van de aanroep gescheiden is",
      'export async function loader({ context }) {\n  // alleen lezen: telt\n  const s = supabaseVoorVerzoek(context);\n  return s.rpc("tel_bezoek", {});\n}',
    ],
    [
      "uitloggen",
      "export async function loader({ context }) {\n  await supabaseVoorVerzoek(context).auth.signOut();\n  return null;\n}",
    ],
    [
      "fetch met POST",
      'export async function loader() {\n  await fetch("https://api.voorbeeld.nl/x", { method: "POST", body: "{}" });\n  return null;\n}',
    ],
  ] as const) {
    it(`${wat}: rood`, () => {
      const r = draai({ "src/routes/account.tsx": route(loader) });
      expect(r.code, r.uitvoer).not.toBe(0);
      expect(r.uitvoer).toContain("src/routes/account.tsx");
      expect(r.uitvoer).toContain("action");
    });
  }

  /** Een stack.config.json met deze leesfuncties (en hun reden). */
  const LEESFUNCTIES = JSON.stringify({
    database: true,
    leesfuncties: {
      aantal_producten: "telt de openbare producten, wijzigt niets",
      is_goedgekeurd: "vraagt of dit account is goedgekeurd, wijzigt niets",
      zoek: "zoekt in de openbare producten, wijzigt niets",
    },
  });

  for (const [wat, loader] of [
    [
      "lezen met select en een rpc naar een functie uit leesfuncties",
      'export async function loader({ context }) {\n  const s = supabaseVoorVerzoek(context);\n  const { data } = await s.from("x").select("id");\n  const { data: n } = await s.rpc("aantal_producten", {});\n  return { data, n };\n}',
    ],
    [
      "een rpc uit leesfuncties, met een markering die naar de lijst verwijst",
      'export async function loader({ context }) {\n  // alleen lezen: staat in leesfuncties\n  const { data } = await supabaseVoorVerzoek(context).rpc("is_goedgekeurd", {});\n  return data;\n}',
    ],
    [
      "een rpc uit leesfuncties in een pijlfunctie",
      'export const loader = async ({ context }) => supabaseVoorVerzoek(context).rpc("zoek", {});',
    ],
  ] as const) {
    it(`${wat}: groen`, () => {
      const r = draai({
        "src/routes/account.tsx": route(loader),
        "stack.config.json": LEESFUNCTIES,
      });
      expect(r.code, r.uitvoer).toBe(0);
    });
  }

  for (const [wat, loader] of [
    [
      "searchParams.delete en een gewone fetch",
      'export async function loader({ request }) {\n  const adres = new URL(request.url);\n  adres.searchParams.delete("utm");\n  await fetch("https://api.voorbeeld.nl/koers");\n  return adres.toString();\n}',
    ],
    [
      "schrijven in een action",
      'export async function loader() {\n  return null;\n}\nexport async function action({ context }) {\n  await supabaseVoorVerzoek(context).from("x").insert({ a: 1 });\n  await supabaseVoorVerzoek(context).rpc("plaats", {});\n  return null;\n}',
    ],
  ] as const) {
    it(`${wat}: groen`, () => {
      const r = draai({ "src/routes/account.tsx": route(loader) });
      expect(r.code, r.uitvoer).toBe(0);
    });
  }
});

/**
 * Drie omzeilingen uit de aanval van ronde 2: een schrijvende functie met een valse markering
 * `// alleen lezen`, een schrijvende middleware (die ook bij elke GET draait), en `getSession`
 * via een losse verwijzing.
 */
describe("guard:server: leesfuncties, middleware en getSession in elke vorm", () => {
  const MET_LIJST = JSON.stringify({
    database: true,
    leesfuncties: { openbare_producten: "de openbare catalogus, wijzigt niets" },
  });

  it("een schrijvende rpc met een valse markering `// alleen lezen` in een loader: rood", () => {
    const r = draai({
      "stack.config.json": MET_LIJST,
      "src/routes/bestel.tsx": [
        'import { supabaseVoorVerzoek } from "@/lib/server/sessie.server";',
        "export async function loader({ context }: { context: unknown }) {",
        "  // alleen lezen: de catalogus ophalen",
        '  const { data } = await supabaseVoorVerzoek(context).rpc("bestelling_plaatsen", {',
        "    p_sleutel: crypto.randomUUID(),",
        "  });",
        "  return data;",
        "}",
        "export default function Scherm() { return null; }",
        "",
      ].join("\n"),
    });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("bestelling_plaatsen");
    expect(r.uitvoer).toContain("leesfuncties");
  });

  it("een rpc met een naam die niet vaststaat: rood", () => {
    const r = draai({
      "stack.config.json": MET_LIJST,
      "src/routes/x.tsx":
        "export async function loader({ context, params }) {\n  return supabaseVoorVerzoek(context).rpc(params.naam, {});\n}\n",
    });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("niet vaststaat");
  });

  it("een leesfunctie die in de migratie niet stable is, of geen reden heeft: rood", () => {
    const r = draai({
      "stack.config.json": JSON.stringify({
        database: true,
        leesfuncties: { bestelling_plaatsen: "leest alleen, zegt iemand", tel: "" },
      }),
      "supabase/migrations/20260101000000_x.sql":
        "create function public.bestelling_plaatsen(p uuid)\nreturns uuid\nlanguage plpgsql\nsecurity definer\nas $$ begin return p; end; $$;\n",
    });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("bestelling_plaatsen is in de migraties niet `stable`");
    expect(r.uitvoer).toContain("leesfunctie tel heeft geen reden");
  });

  it("een stable leesfunctie uit de migraties: groen", () => {
    const r = draai({
      "stack.config.json": MET_LIJST,
      "supabase/migrations/20260101000000_x.sql":
        "create function public.openbare_producten(p_slug text default null)\nreturns table (id uuid)\nlanguage sql\nstable\nsecurity definer\nas $$ select null::uuid $$;\n",
      "src/routes/x.tsx":
        'export async function loader({ context }) {\n  return supabaseVoorVerzoek(context).rpc("openbare_producten", {});\n}\n',
    });
    expect(r.code, r.uitvoer).toBe(0);
  });

  for (const [wat, bron] of [
    [
      "een array van middleware",
      'export const middleware = [\n  async ({ context }) => {\n    await supabaseVoorVerzoek(context).from("bezoek_log").insert({ pad: "/" });\n  },\n];\n',
    ],
    [
      "middleware met een type",
      'export const middleware: Route.MiddlewareFunction[] = [\n  async ({ context }) => {\n    await supabaseVoorVerzoek(context).rpc("tel_bezoek", {});\n  },\n];\n',
    ],
    [
      "unstable_middleware",
      'export const unstable_middleware = [async ({ context }) => { await supabaseVoorVerzoek(context).from("x").delete().eq("id", 1); }];\n',
    ],
  ] as const) {
    it(`een schrijvende middleware (${wat}): rood`, () => {
      const r = draai({ "src/routes/bezoek.tsx": bron });
      expect(r.code).not.toBe(0);
      expect(r.uitvoer).toContain("de middleware");
    });
  }

  it("een middleware die alleen leest: groen", () => {
    const r = draai({
      "src/routes/bezoek.tsx":
        "export const middleware = [\n  async ({ context }, volgende) => {\n    await gebruiker(context);\n    return volgende();\n  },\n];\n",
    });
    expect(r.code, r.uitvoer).toBe(0);
  });

  for (const [wat, regel] of [
    ["losgekoppeld", "  const haal = auth.getSession;\n  return (await haal()).data;"],
    ["uitgepakt", "  const { getSession } = auth;\n  return (await getSession()).data;"],
    ["met blokhaken", '  return (await auth["getSession"]()).data;'],
  ] as const) {
    it(`getSession ${wat} in servercode: rood`, () => {
      const r = draai({
        "src/lib/server/wie.server.ts": `export async function wie(auth) {\n${regel}\n}\n`,
      });
      expect(r.code).not.toBe(0);
      expect(r.uitvoer).toContain("getSession");
    });
  }
});
