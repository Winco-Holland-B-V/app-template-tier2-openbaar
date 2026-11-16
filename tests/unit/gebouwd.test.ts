import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * De aanvallen op de build, met de echte build. Elke test zet een kopie van deze app in een
 * losse map, verandert er één ding aan zoals een bouwer (of zijn agent) dat zou doen, draait
 * `pnpm build` en daarna de guards zoals de check Code en de uitrol dat doen.
 *
 * De test leunt alleen op wat van de template is: een route die hij nodig heeft, zet hij er
 * zelf bij (`metProefroute`), en het domein in wrangler.jsonc zet hij zelf (`zetDomein`). Zo
 * werkt hij in elke app, met of zonder eigen domein, met of zonder de voorbeeldwinkel
 * (tests/unit/echte-app.test.ts bewijst dat).
 *
 *   a. een sleutel in de serverbundel of de uitgerolde config;
 *   c. een binding of geheime variabele in productie, via vite.config.ts;
 *   f. een preview of workers.dev-adres indexeerbaar maken.
 */
const WORTEL = resolve(__dirname, "../..");
// Elke test bouwt de app echt; op een trage machine duurt dat langer dan de gewone grens.
vi.setConfig({ testTimeout: 120_000 });
const NODIG = [
  "src",
  "workers",
  "public",
  "scripts",
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "react-router.config.ts",
  "wrangler.jsonc",
  "stack.config.json",
];

let map: string;
beforeEach(() => {
  map = mkdtempSync(join(tmpdir(), "gebouwd-"));
  for (const pad of NODIG) cpSync(join(WORTEL, pad), join(map, pad), { recursive: true });
  symlinkSync(join(WORTEL, "node_modules"), join(map, "node_modules"), "dir");
  execFileSync("git", ["init", "-q"], { cwd: map });
});
afterEach(() => {
  rmSync(map, { recursive: true, force: true });
});

function schrijf(pad: string, inhoud: string) {
  mkdirSync(dirname(join(map, pad)), { recursive: true });
  writeFileSync(join(map, pad), inhoud);
}

function pasAan(pad: string, wijzig: (tekst: string) => string) {
  const voor = readFileSync(join(map, pad), "utf8");
  const na = wijzig(voor);
  expect(na, `${pad} is niet gewijzigd: de test past niet meer bij het bestand`).not.toBe(voor);
  writeFileSync(join(map, pad), na);
}

function node(script: string, args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [join(map, script), ...args], {
    cwd: map,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, uitvoer: `${r.stdout}${r.stderr}` };
}

const bouw = (env: Record<string, string> = {}) =>
  node("scripts/bouwen.mjs", ["--logLevel", "error"], env);
const guards = () => ({
  cloudflare: node("scripts/guard-cloudflare.mjs", ["--gebouwd"]),
  secrets: node("scripts/guard-secrets.mjs"),
  server: node("scripts/guard-server.mjs"),
});

function alleBestanden(dir: string): string[] {
  return readdirSync(dir).flatMap((naam) => {
    const pad = join(dir, naam);
    return statSync(pad).isDirectory() ? alleBestanden(pad) : [pad];
  });
}

function gebouwdeTekst(deel: "client" | "server"): string {
  return alleBestanden(join(map, "dist", deel))
    .filter((f) => /\.(js|json|map)$/.test(f))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
}

const b64 = (tekst: string) => Buffer.from(tekst).toString("base64url");
/** Nep, en pas hier samengesteld: in git staat geen tekst die op een sleutel lijkt. */
const SERVICE_JWT = [
  b64('{"alg":"HS256","typ":"JWT"}'),
  b64('{"iss":"supabase","role":"service_role"}'),
  b64("nep-handtekening-voor-de-test"),
].join(".");
const GEHEIM_NIEUW = ["sb", "secret", "nepnepnepnepnepnepnepnep"].join("_");

/**
 * Zet het eigen domein in de kopie van wrangler.jsonc, of haalt het weg (null), wat de app
 * zelf ook had.
 */
function zetDomein(domein: string | null) {
  const pad = join(map, "wrangler.jsonc");
  const zonder = readFileSync(pad, "utf8").replace(/,?\s*"routes"\s*:\s*\[[^\]]*\]/, "");
  expect(zonder, "wrangler.jsonc heeft geen regel preview_urls meer").toMatch(
    /"preview_urls":\s*true/,
  );
  writeFileSync(
    pad,
    domein === null
      ? zonder
      : zonder.replace(
          /"preview_urls":\s*true/,
          `"preview_urls": true,\n  "routes": [{ "pattern": "${domein}", "custom_domain": true }]`,
        ),
  );
}

/**
 * Een eigen proefroute op `/__proef`, naast de routes van de app. src/routes.ts is van het
 * project; de test zet hem opzij en legt er één regel bij, in plaats van een scherm van de app
 * aan te passen.
 */
function metProefroute(inhoud: string) {
  renameSync(join(map, "src/routes.ts"), join(map, "src/routes-van-de-app.ts"));
  schrijf(
    "src/routes.ts",
    `import { type RouteConfig, route } from "@react-router/dev/routes";
import vanDeApp ${"from"} "./routes-van-de-app";

export default [route("__proef", "routes/__proef.tsx"), ...vanDeApp] satisfies RouteConfig;
`,
  );
  schrijf("src/routes/__proef.tsx", inhoud);
}

describe("de echte build van deze app", () => {
  it("is groen voor alle guards, en de Supabase-client van de server zit in de Worker", () => {
    expect(bouw().code).toBe(0);
    const g = guards();
    expect(g.cloudflare.code, g.cloudflare.uitvoer).toBe(0);
    expect(g.secrets.code, g.secrets.uitvoer).toBe(0);
    expect(g.server.code, g.server.uitvoer).toBe(0);
    expect(gebouwdeTekst("server")).toContain("createServerClient");
  });

  it("geen vals alarm: een import met service in de naam waarvan het ongebruikte deel bij het bouwen verdwijnt", () => {
    schrijf(
      "src/lib/service-role.ts",
      'export const ROL_VOOR_BEHEER = "service_role";\nexport const serviceTekst = "Onze klantenservice helpt je verder.";\n',
    );
    metProefroute(
      // (in stukken, zodat de test op verwijzingen dit niet voor een echte import houdt)
      `import { serviceTekst } ${"from"} "@/lib/service-role";

export default function Proef() {
  return <p>{serviceTekst}</p>;
}
`,
    );
    expect(bouw().code).toBe(0);
    expect(gebouwdeTekst("client")).toContain("klantenservice");
    const g = guards();
    expect(g.secrets.code, g.secrets.uitvoer).toBe(0);
  });
});

describe("aanval a: een service role-sleutel in de serverbundel of de uitgerolde config", () => {
  for (const [vorm, sleutel] of [
    ["JWT-vorm", SERVICE_JWT],
    ["sb_secret_", GEHEIM_NIEUW],
  ] as const) {
    it(`${vorm} in een loader (alleen servercode): guard:secrets is rood op de gebouwde Worker`, () => {
      metProefroute(`import type { LoaderFunctionArgs } from "react-router";
import { vereisGebruiker } ${"from"} "@/lib/server/sessie.server";

export async function loader({ context }: LoaderFunctionArgs) {
  await vereisGebruiker(context);
  await fetch("https://x.supabase.co/rest/v1/prijzen", { headers: { apikey: "${sleutel}" } });
  return null;
}

export default function Proef() {
  return <p>proef</p>;
}
`);
      expect(bouw().code).toBe(0);
      // De sleutel staat alleen in de Worker, niet in wat de bezoeker downloadt.
      expect(gebouwdeTekst("server")).toContain(sleutel);
      expect(gebouwdeTekst("client")).not.toContain(sleutel);
      const r = guards().secrets;
      expect(r.code).not.toBe(0);
      expect(r.uitvoer).toContain("dist/server/");
    });

    it(`${vorm} als variabele onder een openbare naam in wrangler.jsonc: rood op de gebouwde config`, () => {
      pasAan("wrangler.jsonc", (t) =>
        t.replace(
          '"preview_urls": true',
          `"preview_urls": true,\n  "vars": { "VITE_SUPABASE_ANON_KEY": "${sleutel}" }`,
        ),
      );
      expect(bouw().code).toBe(0);
      const r = guards().secrets;
      expect(r.code).not.toBe(0);
      expect(r.uitvoer).toContain("dist/server/wrangler.json");
    });

    it(`${vorm} als VITE_SUPABASE_ANON_KEY in de omgeving van de build: rood`, () => {
      expect(
        bouw({
          VITE_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
          VITE_SUPABASE_ANON_KEY: sleutel,
        }).code,
      ).toBe(0);
      expect(guards().secrets.code).not.toBe(0);
    });
  }

  it("een .dev.vars naast de app komt in de gebouwde Worker en maakt de guard rood, wat erin staat", () => {
    schrijf(".dev.vars", "MIJN_SLEUTEL=een-waarde-zonder-herkenbare-vorm\n");
    expect(bouw().code).toBe(0);
    const r = guards().secrets;
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain(".dev.vars");
  });
});

describe("aanval c: een binding of geheime variabele in productie, via vite.config.ts", () => {
  const metPluginConfig = (config: string) => (t: string) =>
    t.replace(
      'cloudflare({ viteEnvironment: { name: "ssr" } })',
      `cloudflare({ viteEnvironment: { name: "ssr" }, config: ${config} })`,
    );

  for (const [naam, config, sleutel] of [
    [
      "een D1-database",
      '{ d1_databases: [{ binding: "DB", database_name: "x", database_id: "00000000-0000-0000-0000-000000000000" }] }',
      "d1_databases",
    ],
    [
      "een KV-opslag",
      '{ kv_namespaces: [{ binding: "KV", id: "0123456789abcdef0123456789abcdef" }] }',
      "kv_namespaces",
    ],
    ["een R2-bucket", '{ r2_buckets: [{ binding: "BESTANDEN", bucket_name: "x" }] }', "r2_buckets"],
    [
      "een koppeling met een andere Worker",
      '{ services: [{ binding: "ANDERE", service: "worker-met-sleutels" }] }',
      "services",
    ],
    ["een geheime variabele", '{ vars: { API_TOKEN: "x" } }', "vars.API_TOKEN"],
    ["een andere naam voor de Worker", '{ name: "worker-van-een-ander" }', "name"],
    [
      "een extra adres",
      '{ routes: [{ pattern: "open.klant.nl", custom_domain: true }] }',
      "routes",
    ],
  ] as const) {
    it(`${naam}: wrangler.jsonc is schoon, de gebouwde config niet, en guard:cloudflare is rood`, () => {
      pasAan("vite.config.ts", metPluginConfig(config));
      // De controle op wrangler.jsonc alleen ziet niets.
      expect(node("scripts/guard-cloudflare.mjs").code).toBe(0);
      expect(bouw().code).toBe(0);
      const r = guards().cloudflare;
      expect(r.code).not.toBe(0);
      expect(r.uitvoer).toContain(`\`${sleutel}\``);
      expect(r.uitvoer).toContain("dist/server/wrangler.json");
      // En zonder vlag (pnpm check na een build) ook.
      expect(node("scripts/guard-cloudflare.mjs").code).not.toBe(0);
    });
  }

  it("een andere config als bron (configPath): rood", () => {
    schrijf(
      "andere/wrangler.jsonc",
      JSON.stringify({
        name: "cf-proef",
        main: "../workers/app.ts",
        compatibility_date: "2026-11-10",
        workers_dev: true,
        kv_namespaces: [{ binding: "KV", id: "0123456789abcdef0123456789abcdef" }],
      }),
    );
    pasAan("vite.config.ts", (t) =>
      t.replace(
        'cloudflare({ viteEnvironment: { name: "ssr" } })',
        'cloudflare({ viteEnvironment: { name: "ssr" }, configPath: "./andere/wrangler.jsonc" })',
      ),
    );
    expect(bouw().code).toBe(0);
    expect(guards().cloudflare.code).not.toBe(0);
  });

  it("de build naar een andere map: de gecontroleerde plek is leeg, dus rood", () => {
    pasAan("react-router.config.ts", (t) =>
      t.replace('buildDirectory: "dist"', 'buildDirectory: "uit"'),
    );
    expect(bouw().code).toBe(0);
    const r = guards().cloudflare;
    expect(r.code).not.toBe(0);
  });
});

describe("een browser-scherm: de zware code van een scherm blijft uit de Worker", () => {
  /**
   * Een nagemaakte zware bibliotheek (zoals een Excel- of PDF-maker): een megabyte aan tekst
   * die zich slecht laat inpakken, met een herkenbaar merkteken.
   */
  const MERK = "ZWARE_BIBLIOTHEEK_MERKTEKEN";
  function zwareBibliotheek() {
    let x = 7;
    const stukken: string[] = [];
    for (let i = 0; i < 40_000; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      stukken.push(x.toString(36).padStart(6, "0"));
    }
    schrijf(
      "src/features/proef/zwaar.ts",
      `export const MERK = "${MERK}";\nexport const TABEL = ${JSON.stringify(stukken)};\n`,
    );
    schrijf(
      "src/features/proef/scherm.tsx",
      `import { MERK, TABEL } ${"from"} "./zwaar";\n\nexport default function Zwaar() {\n  return <p>{MERK} {TABEL.length}</p>;\n}\n`,
    );
  }
  const routeMet = (bron: string) => `import Zwaar from "${bron}";
import { browserScherm } ${"from"} "@/lib/browser-scherm";

const scherm = browserScherm({ titel: "Zwaar", scherm: Zwaar });
export const clientLoader = scherm.clientLoader;
export const HydrateFallback = scherm.HydrateFallback;
export const meta = scherm.meta;
export const headers = scherm.headers;
export default scherm.Scherm;
`;
  const workerGrootte = () =>
    alleBestanden(join(map, "dist", "server"))
      .filter((f) => /\.(js|mjs)$/.test(f))
      .reduce((som, f) => som + gzipSync(readFileSync(f)).length, 0);

  it("via een .client-bestand: in de browser wel, in de Worker niet", () => {
    zwareBibliotheek();
    schrijf("src/features/proef/scherm.client.tsx", `export { default } ${"from"} "./scherm";\n`);
    metProefroute(routeMet("@/features/proef/scherm.client"));
    const r = bouw();
    expect(r.code, r.uitvoer).toBe(0);
    expect(gebouwdeTekst("client")).toContain(MERK);
    expect(gebouwdeTekst("server")).not.toContain(MERK);
    console.log(`Worker met het browser-scherm: ${(workerGrootte() / 1024).toFixed(0)} KB gzip`);
  });

  it("zonder .client-bestand zit alles in de Worker, en weigert de hulp bij het starten", () => {
    zwareBibliotheek();
    metProefroute(routeMet("@/features/proef/scherm"));
    const r = bouw();
    expect(r.code, r.uitvoer).toBe(0);
    expect(gebouwdeTekst("server")).toContain(MERK);
    console.log(`Worker zonder de hulp: ${(workerGrootte() / 1024).toFixed(0)} KB gzip`);
  });
});

describe("de eigen aanvullingen op de Content-Security-Policy (browser in stack.config.json)", () => {
  const config = (browser: unknown) =>
    schrijf("stack.config.json", JSON.stringify({ database: true, browser }, null, 2));

  it("komen uit stack.config.json in de Worker, niet uit de omgeving of een .env-bestand", () => {
    config({
      afbeeldingen_van: { "https://beeld.leverancier.nl": "productfoto's van de leverancier" },
      webassembly: "de barcodescanner",
    });
    const vals = JSON.stringify({
      img: ["https://evil.example"],
      connect: ["https://evil.example"],
    });
    schrijf(".env.production", `VITE_BROWSER_REGELS=${vals}\n`);
    expect(bouw({ VITE_BROWSER_REGELS: vals }).code).toBe(0);
    const server = gebouwdeTekst("server");
    expect(server).toContain("beeld.leverancier.nl");
    expect(server).not.toContain("evil.example");
  });

  it("een lijst die niet mag (een script van elders, een jokerteken): de build weigert", () => {
    for (const browser of [
      { scripts_van: { "https://cdn.voorbeeld.nl": "een bibliotheek" } },
      { afbeeldingen_van: { "https:": "alle afbeeldingen" } },
    ]) {
      config(browser);
      const r = bouw();
      expect(r.code, JSON.stringify(browser)).not.toBe(0);
      expect(r.uitvoer).toContain("Content-Security-Policy");
    }
  });
});

describe("aanval f: een preview of workers.dev-adres indexeerbaar maken", () => {
  it("het productiedomein komt uit wrangler.jsonc, niet uit de omgeving of een .env-bestand", () => {
    zetDomein("shop.klant.nl");
    schrijf(".env.production", "VITE_PRODUCTIEDOMEIN=pr-12-cf-proef.stagetwo.workers.dev\n");
    expect(bouw({ VITE_PRODUCTIEDOMEIN: "actueel-cf-proef.stagetwo.workers.dev" }).code).toBe(0);
    const server = gebouwdeTekst("server");
    expect(server).toMatch(/VITE_PRODUCTIEDOMEIN["']?:\s*["']shop\.klant\.nl["']/);
    expect(server).not.toContain("pr-12-cf-proef.stagetwo.workers.dev");
    expect(server).not.toContain("actueel-cf-proef.stagetwo.workers.dev");
  });

  it("zonder eigen domein is er geen productiedomein, wat de omgeving ook zegt", () => {
    zetDomein(null);
    expect(bouw({ VITE_PRODUCTIEDOMEIN: "cf-proef.stagetwo.workers.dev" }).code).toBe(0);
    const server = gebouwdeTekst("server");
    expect(server).toMatch(/VITE_PRODUCTIEDOMEIN["']?:\s*["']["']/);
    expect(server).not.toContain("cf-proef.stagetwo.workers.dev");
  });

  it("een workers.dev-adres als route in wrangler.jsonc: de build weigert", () => {
    zetDomein("cf-proef.stagetwo.workers.dev");
    const r = bouw();
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("geen eigen domein");
  });

  it("een eigen robots.txt of een losse pagina in public/: rood op de gebouwde bestanden", () => {
    schrijf("public/robots.txt", "User-agent: *\nAllow: /\n");
    schrijf("public/actie.html", "<h1>Actie</h1>");
    expect(bouw().code).toBe(0);
    const r = guards().cloudflare;
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("dist/client/robots.txt");
    expect(r.uitvoer).toContain("dist/client/actie.html");
  });

  it("public/_headers weghalen of de regel voor workers.dev eruit: rood", () => {
    rmSync(join(map, "public/_headers"));
    expect(bouw().code).toBe(0);
    const r = guards().cloudflare;
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("_headers");
  });
});
