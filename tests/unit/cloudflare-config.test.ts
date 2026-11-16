import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * `wrangler.jsonc` is van het project (naam en adres verschillen per app), maar een
 * paar regels moeten in elke app gelijk zijn, anders staat de app ergens open of
 * maakt de server de pagina's niet. `scripts/lib/cloudflare-config.mjs` controleert dat; deze
 * test draait die controle zoals CI dat doet: als los Node-proces in een map.
 */
const LIB = resolve(__dirname, "../../scripts/lib/cloudflare-config.mjs");
/** De eigen wrangler.jsonc van deze repo: in de template de tijdelijke stand, in een app vaak de standaardstand. */
const EIGEN = readFileSync(resolve(__dirname, "../../wrangler.jsonc"), "utf8");

/** wrangler.jsonc met commentaar, zoals de template hem levert: de tijdelijke stand. */
const TIJDELIJK_JSONC = `// Hoe deze app op Cloudflare draait.
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "cf-proef",
  "compatibility_date": "2026-11-10",
  // De servercode: één Worker die elke pagina maakt.
  "main": "./workers/app.ts",
  "workers_dev": true,
  "preview_urls": true
  // Standaardstand, zodra er een eigen domein is:
  // "routes": [{ "pattern": "<app>.<domein>", "custom_domain": true }]
}
`;

let map: string;

beforeEach(() => {
  map = mkdtempSync(join(tmpdir(), "cf-config-"));
});

afterEach(() => {
  rmSync(map, { recursive: true, force: true });
});

const GOED = {
  name: "cf-proef",
  compatibility_date: "2026-11-10",
  main: "./workers/app.ts",
  workers_dev: true,
  preview_urls: true,
  routes: [{ pattern: "cf-proef.stagetwo.nl", custom_domain: true }],
};

/** De tijdelijke stand: geen eigen domein, alleen het workers.dev-adres achter Access. */
const TIJDELIJK = {
  name: "cf-proef",
  compatibility_date: "2026-11-10",
  main: "./workers/app.ts",
  workers_dev: true,
  preview_urls: true,
};

function schrijf(inhoud: string): void {
  writeFileSync(join(map, "wrangler.jsonc"), inhoud);
}

function controleer(): { code: number | null; uitvoer: string } {
  const code = `import(${JSON.stringify(pathToFileURL(LIB).href)}).then((m) => console.log(JSON.stringify(m.cloudflareConfig())))`;
  const r = spawnSync("node", ["--input-type=module", "-e", code], { cwd: map, encoding: "utf8" });
  return { code: r.status, uitvoer: `${r.stdout}${r.stderr}` };
}

function controleerConfig(config: object): { code: number | null; uitvoer: string } {
  schrijf(JSON.stringify(config));
  return controleer();
}

describe("cloudflareConfig: de twee standen", () => {
  it("geeft naam, stand en hostname terug bij een goede config, ook met commentaar", () => {
    schrijf(`// uitleg\n${JSON.stringify(GOED, null, 2)}`);
    const r = controleer();
    expect(r.code).toBe(0);
    expect(JSON.parse(r.uitvoer)).toEqual({
      worker: "cf-proef",
      stand: "standaard",
      hostname: "cf-proef.stagetwo.nl",
    });
  });

  it("accepteert de tijdelijke stand: workers_dev aan zonder routes", () => {
    const r = controleerConfig(TIJDELIJK);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.uitvoer)).toEqual({
      worker: "cf-proef",
      stand: "tijdelijk",
      hostname: null,
    });
  });

  it("accepteert de tijdelijke stand ook met een lege lijst routes", () => {
    const r = controleerConfig({ ...TIJDELIJK, routes: [] });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.uitvoer).stand).toBe("tijdelijk");
  });

  it("weigert workers_dev uit naast een eigen domein: dan tonen de previews achter Access niets", () => {
    const r = controleerConfig({ ...GOED, workers_dev: false });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("workers_dev");
    expect(r.uitvoer).toContain("There is nothing here yet");
    expect(r.uitvoer).toContain("standaard");
    expect(r.uitvoer).toContain("tijdelijk");
  });

  it("weigert workers_dev uit zonder routes", () => {
    const r = controleerConfig({ ...TIJDELIJK, workers_dev: false });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("workers_dev");
  });

  it("weigert een config zonder workers_dev: wrangler zet het dan stilletjes aan", () => {
    const { workers_dev: _weg, ...zonder } = GOED;
    const r = controleerConfig(zonder);
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("workers_dev");
  });

  it("weigert een route zonder custom_domain in de standaardstand", () => {
    const r = controleerConfig({ ...GOED, routes: [{ pattern: "cf-proef.stagetwo.nl/*" }] });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("custom_domain");
  });

  it("weigert twee eigen domeinen: de standaardstand heeft precies één adres", () => {
    const r = controleerConfig({
      ...GOED,
      routes: [
        { pattern: "cf-proef.stagetwo.nl", custom_domain: true },
        { pattern: "tweede.stagetwo.nl", custom_domain: true },
      ],
    });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("precies één route");
    expect(r.uitvoer).toContain("standaard");
    expect(r.uitvoer).toContain("tijdelijk");
  });

  it("weigert een eigen domein plus een zone-route: die tweede route staat zonder Access", () => {
    const r = controleerConfig({
      ...GOED,
      routes: [
        { pattern: "cf-proef.stagetwo.nl", custom_domain: true },
        { pattern: "stagetwo.nl/app/*", zone_name: "stagetwo.nl" },
      ],
    });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("precies één route");
    expect(r.uitvoer).toContain("standaard");
  });

  it("weigert single-page-application: een onbekend adres hoort bij de server uit te komen", () => {
    const r = controleerConfig({
      ...GOED,
      assets: { not_found_handling: "single-page-application" },
    });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("`assets`");
    expect(r.uitvoer).toContain("servercode");
  });

  it("laat assets alleen door zonder inhoud of met not_found_handling none", () => {
    expect(controleerConfig({ ...GOED, assets: {} }).code).toBe(0);
    expect(controleerConfig({ ...GOED, assets: { not_found_handling: "none" } }).code).toBe(0);
  });

  it("weigert een route op workers.dev, met een jokerteken of met een pad: dat is geen eigen domein", () => {
    for (const pattern of [
      "cf-proef.stagetwo.workers.dev",
      "pr-12-cf-proef.stagetwo.workers.dev",
      "*.stagetwo.nl",
      "app.stagetwo.nl/*",
      "localhost",
      "127.0.0.1",
    ]) {
      const r = controleerConfig({ ...GOED, routes: [{ pattern, custom_domain: true }] });
      expect(r.code, pattern).not.toBe(0);
      expect(r.uitvoer, pattern).toContain("geen eigen domein");
    }
  });

  it("weigert een route met extra velden (zoals een zone)", () => {
    const r = controleerConfig({
      ...GOED,
      routes: [{ pattern: "cf-proef.stagetwo.nl", custom_domain: true, zone_name: "stagetwo.nl" }],
    });
    expect(r.code).not.toBe(0);
  });

  it("keurt de wrangler.jsonc van deze repo zelf goed, in welke stand die ook staat", () => {
    schrijf(EIGEN);
    const r = controleer();
    expect(r.code, r.uitvoer).toBe(0);
    expect(["tijdelijk", "standaard"]).toContain(JSON.parse(r.uitvoer).stand);
  });

  it("keurt een wrangler.jsonc met commentaar goed in de tijdelijke stand", () => {
    schrijf(TIJDELIJK_JSONC);
    const r = controleer();
    expect(r.code, r.uitvoer).toBe(0);
    expect(JSON.parse(r.uitvoer).stand).toBe("tijdelijk");
  });

  it("keurt een wrangler.jsonc met commentaar goed in de standaardstand", () => {
    // De voorbeeldroute uit het commentaar aanzetten; workers_dev blijft aan.
    const standaard = TIJDELIJK_JSONC.replace(/^(\s*"preview_urls": true)$/m, "$1,").replace(
      /^(\s*)\/\/ ("routes": \[\{ "pattern": )"<app>\.<domein>"/m,
      '$1$2"cf-proef.stagetwo.nl"',
    );
    expect(standaard).toMatch(/^\s*"routes":/m);
    schrijf(standaard);
    const r = controleer();
    expect(r.code, r.uitvoer).toBe(0);
    expect(JSON.parse(r.uitvoer).stand).toBe("standaard");
  });

  it("meldt duidelijk dat het bestand ontbreekt", () => {
    const r = controleer();
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("wrangler.jsonc");
  });

  it("meldt duidelijk dat het bestand geen geldige JSON is", () => {
    schrijf("{ name: ");
    const r = controleer();
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("wrangler.jsonc");
    expect(r.uitvoer).toContain("JSON");
  });
});

describe("cloudflareConfig: alleen wat op de lijst staat (geen opslag van Cloudflare)", () => {
  for (const sleutel of ["d1_databases", "r2_buckets", "kv_namespaces"]) {
    it(`weigert ${sleutel}`, () => {
      const r = controleerConfig({ ...GOED, [sleutel]: [{ binding: "X", id: "y" }] });
      expect(r.code).not.toBe(0);
      expect(r.uitvoer).toContain(sleutel);
      expect(r.uitvoer).toContain("gegevens staan in Supabase");
    });
  }

  it("weigert durable_objects", () => {
    const binding = { bindings: [{ name: "X", class_name: "Y" }] };
    const boven = controleerConfig({ ...GOED, durable_objects: binding });
    expect(boven.code).not.toBe(0);
    expect(boven.uitvoer).toContain("durable_objects");
  });

  it("eist main: de servercode in workers/app.ts, met of zonder ./ ervoor", () => {
    expect(controleerConfig({ ...GOED, main: "workers/app.ts" }).code).toBe(0);
    const { main: _weg, ...zonder } = GOED;
    const ontbreekt = controleerConfig(zonder);
    expect(ontbreekt.code).not.toBe(0);
    expect(ontbreekt.uitvoer).toContain("`main` moet");
    const anders = controleerConfig({ ...GOED, main: "src/worker.ts" });
    expect(anders.code).not.toBe(0);
    expect(anders.uitvoer).toContain("workers/app.ts");
  });

  for (const sleutel of [
    "queues",
    "hyperdrive",
    "vectorize",
    "workflows",
    "services",
    "ai",
    "secrets_store_secrets",
    "tail_consumers",
    "logpush",
    "triggers",
    "unsafe",
    "send_email",
    "mtls_certificates",
    "dispatch_namespaces",
    "version_metadata",
    "browser",
    "define",
    "alias",
    "build",
    "site",
    "migrations",
  ]) {
    it(`weigert ${sleutel}, ook leeg en ook nu er servercode is`, () => {
      const r = controleerConfig({ ...GOED, [sleutel]: [] });
      expect(r.code).not.toBe(0);
      expect(r.uitvoer).toContain(`\`${sleutel}\``);
    });
  }

  it("weigert een onbekende nieuwe sleutel, met een nette melding", () => {
    const r = controleerConfig({
      ...GOED,
      containers: [{ class_name: "X", image: "./Dockerfile" }],
    });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("`containers`");
    expect(r.uitvoer).toContain("staat niet op de lijst");
  });

  it("noemt alle verboden sleutels in één keer", () => {
    const r = controleerConfig({ ...GOED, kv_namespaces: [], containers: [], r2_buckets: [] });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("kv_namespaces");
    expect(r.uitvoer).toContain("containers");
    expect(r.uitvoer).toContain("r2_buckets");
  });

  it("weigert env helemaal: geen tweede omgeving met een eigen naam, adres of variabelen", () => {
    for (const omgeving of [
      {},
      { production: {} },
      { production: { name: "andere-worker" } },
      { preview: { vars: { VITE_OMGEVING: "test" } } },
      { production: { routes: [{ pattern: "ander.stagetwo.nl", custom_domain: true }] } },
    ]) {
      const r = controleerConfig({ ...GOED, env: omgeving });
      expect(r.code, JSON.stringify(omgeving)).not.toBe(0);
      expect(r.uitvoer).toContain("`env` hoort er niet in");
    }
  });

  it("weigert keep_vars, aan of uit: variabelen uit het dashboard blijven dan staan", () => {
    for (const waarde of [true, false]) {
      const r = controleerConfig({ ...GOED, keep_vars: waarde });
      expect(r.code).not.toBe(0);
      expect(r.uitvoer).toContain("`keep_vars` hoort er niet in");
    }
  });

  it("weigert assets.binding: de servercode krijgt geen binding, ook niet naar de bestanden", () => {
    const r = controleerConfig({ ...GOED, assets: { binding: "ASSETS" } });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("`assets`");
    expect(r.uitvoer).toContain("binding");
  });

  it("weigert observability die logregels naar een andere plek stuurt", () => {
    for (const observability of [
      { enabled: true, logs: { enabled: true, destinations: ["https://logs.example"] } },
      { enabled: true, destinations: ["x"] },
      { enabled: true, traces: { enabled: true, destinations: ["x"] } },
      { enabled: "ja" },
    ]) {
      const r = controleerConfig({ ...GOED, observability });
      expect(r.code, JSON.stringify(observability)).not.toBe(0);
      expect(r.uitvoer).toContain("`observability`");
    }
    expect(
      controleerConfig({
        ...GOED,
        observability: { enabled: true, head_sampling_rate: 0.5, logs: { invocation_logs: true } },
      }).code,
    ).toBe(0);
  });

  it("weigert een onbekende instelling in compatibility_flags", () => {
    const r = controleerConfig({ ...GOED, compatibility_flags: ["nodejs_compat", "iets_nieuws"] });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("`compatibility_flags`");
  });

  it("weigert een waarde van de verkeerde soort op een toegestane sleutel", () => {
    expect(controleerConfig({ ...GOED, name: { naam: "x" } }).code).not.toBe(0);
    expect(controleerConfig({ ...GOED, name: "Andere Naam" }).code).not.toBe(0);
    expect(controleerConfig({ ...GOED, preview_urls: "ja" }).code).not.toBe(0);
    expect(controleerConfig({ ...GOED, compatibility_date: 20261110 }).code).not.toBe(0);
    expect(controleerConfig({ ...GOED, routes: { pattern: "x" } }).code).not.toBe(0);
  });

  it("laat de bekende onschuldige sleutels door", () => {
    const r = controleerConfig({
      $schema: "node_modules/wrangler/config-schema.json",
      ...GOED,
      compatibility_flags: ["nodejs_compat"],
      observability: { enabled: true },
      vars: { VITE_OMGEVING: "test" },
    });
    expect(r.code, r.uitvoer).toBe(0);
  });
});

/**
 * wrangler.jsonc staat in git, en de servercode kan elke variabele lezen. Daarom mag er in
 * `vars` alleen staan wat ook in de bundel van de browser mag: de openbare waarden.
 */
describe("cloudflareConfig: in vars alleen openbare variabelen", () => {
  it("laat de openbare waarden door: de Supabase-URL en de anon-sleutel", () => {
    const r = controleerConfig({
      ...GOED,
      vars: {
        VITE_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
        VITE_SUPABASE_ANON_KEY: "sb_publishable_abcdefghijkl",
        VITE_SUPABASE_SCHEMA: "public",
        VITE_INLOGDIENST: "cloudflare",
        VITE_SENTRY_DSN: "",
      },
    });
    expect(r.code, r.uitvoer).toBe(0);
  });

  for (const naam of ["SUPABASE_SERVICE_ROLE_KEY", "STRIPE_SECRET_KEY", "OMGEVING", "API_TOKEN"]) {
    it(`weigert ${naam} in vars`, () => {
      const boven = controleerConfig({ ...GOED, vars: { [naam]: "x" } });
      expect(boven.code).not.toBe(0);
      expect(boven.uitvoer).toContain(`\`vars.${naam}\``);
      expect(boven.uitvoer).toContain("Supabase Edge Function");
    });
  }

  it("weigert vars die geen object zijn", () => {
    const r = controleerConfig({ ...GOED, vars: ["VITE_OMGEVING"] });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("`vars`");
  });

  it("weigert een waarde in vars die geen tekst is, ook onder een openbare naam", () => {
    for (const waarde of [{ sleutel: "geheim" }, ["a"], 12, true, null]) {
      const r = controleerConfig({ ...GOED, vars: { VITE_SUPABASE_URL: waarde } });
      expect(r.code, JSON.stringify(waarde)).not.toBe(0);
      expect(r.uitvoer).toContain("hoort een tekst te zijn");
    }
  });
});

/**
 * De preview van een pull request krijgt zijn config uit main, niet uit de pull request:
 * alleen de gebouwde code komt uit de PR. Zo kan een PR geen andere Worker kiezen en niets
 * aan de Worker koppelen.
 */
describe("previewConfig: de config van een preview komt uit main", () => {
  async function preview(config: object): Promise<Record<string, unknown>> {
    const lib = (await import(pathToFileURL(LIB).href)) as {
      previewConfig: (c: object, p: { worker: string; assets: string }) => Record<string, unknown>;
    };
    return lib.previewConfig(config, {
      worker: "/tmp/dist/server/index.js",
      assets: "/tmp/dist/client",
    });
  }

  it("houdt de naam van de app: een preview is een versie van dezelfde Worker, achter dezelfde Access", async () => {
    const uit = await preview(GOED);
    expect(uit.name).toBe("cf-proef");
    expect(uit.workers_dev).toBe(true);
    expect(uit.preview_urls).toBe(true);
  });

  it("wijst naar de gebouwde code en bundelt die niet opnieuw", async () => {
    const uit = await preview(GOED);
    expect(uit.main).toBe("/tmp/dist/server/index.js");
    expect(uit.assets).toEqual({ directory: "/tmp/dist/client" });
    expect(uit.no_bundle).toBe(true);
    expect(uit.find_additional_modules).toBe(true);
  });

  it("neemt geen routes mee en niets wat niet op de lijst staat", async () => {
    const uit = await preview({
      ...GOED,
      vars: { VITE_OMGEVING: "test" },
    });
    expect(Object.keys(uit).sort()).toEqual([
      "assets",
      "compatibility_date",
      "find_additional_modules",
      "main",
      "name",
      "no_bundle",
      "preview_urls",
      "rules",
      "vars",
      "workers_dev",
    ]);
    expect(uit.vars).toEqual({ VITE_OMGEVING: "test" });
  });
});
