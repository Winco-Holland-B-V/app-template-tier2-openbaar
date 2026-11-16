// @vitest-environment node
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

/**
 * Aanval (uitgave 43): de tests van de template uitzetten via de config van de app.
 * vitest.config.ts, playwright.config.ts, vite.config.ts en tsconfig.json zijn van het project;
 * guard:template ziet een wijziging daarin dus niet. guard:testlat vraagt Vitest, Vite en
 * Playwright zelf wat er verzameld wordt en waar `@` naartoe wijst.
 *
 * Getest in een kleine app in een tijdelijke map: de echte configs van deze template, een
 * eigen manifest met een paar "templatetests", en node_modules als koppeling.
 * Deze test is van de template.
 */
const WORTEL = resolve(__dirname, "../..");
const GUARD = join(WORTEL, "scripts/guard-testlat.mjs");

/** De punt los, zodat guard:testlat deze test zelf niet als uitgezet ziet. */
const PUNT = ".";

const VITE_CONFIG = `import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
`;

const TEMPLATE_SPEC = `import { expect, test } from "@playwright/test";
test("de pagina heeft headers", async () => { expect(1).toBe(1); });
test.describe("aanval: van een andere site", () => {
  test("POST wordt geweigerd", async () => { expect(1).toBe(1); });
});
test.describe("alleen met database", () => {
  test.skip(process.env.TESTLAT_NOOIT === undefined, "deze app heeft geen eigen database");
  test("inloggen", async () => { expect(1).toBe(1); });
});
`;

let map: string;
beforeEach(() => {
  map = mkdtempSync(join(tmpdir(), "guard-testlat-"));
  symlinkSync(join(WORTEL, "node_modules"), join(map, "node_modules"), "dir");
  for (const pad of [
    "package.json",
    "vitest.config.ts",
    "vitest.rls.config.ts",
    "playwright.config.ts",
    "tsconfig.json",
    "stack.config.json",
  ]) {
    copyFileSync(join(WORTEL, pad), join(map, pad));
  }
  schrijf({
    "vite.config.ts": VITE_CONFIG,
    ".claude/stack-manifest.json": JSON.stringify({
      vanDeTemplate: {
        vervangen: [
          "tests/unit/server-a.test.ts",
          "tests/rls/b.test.ts",
          "e2e/server-x.spec.ts",
          "src/lib/server/sessie.server.ts",
        ],
      },
    }),
    "tests/setup.ts": "export {};\n",
    "tests/unit/server-a.test.ts":
      'import { expect, it } from "vitest";\nit("a", () => expect(1).toBe(1));\n',
    "tests/rls/b.test.ts":
      'import { expect, it } from "vitest";\nit("b", () => expect(1).toBe(1));\n',
    "src/features/eigen.test.tsx":
      'import { expect, it } from "vitest";\nit("eigen", () => expect(1).toBe(1));\n',
    "src/lib/server/sessie.server.ts":
      'import { createServerClient } from "@supabase/ssr";\nexport const c = createServerClient;\n',
    "e2e/global-setup.ts": "export default async function globalSetup() {}\n",
    "e2e/server-x.spec.ts": TEMPLATE_SPEC,
    "e2e/eigen.spec.ts":
      'import { expect, test } from "@playwright/test";\ntest("eigen", async () => { expect(1).toBe(1); });\n',
  });
});
afterEach(() => rmSync(map, { recursive: true, force: true }));

function schrijf(bestanden: Record<string, string>) {
  for (const [naam, inhoud] of Object.entries(bestanden)) {
    mkdirSync(dirname(join(map, naam)), { recursive: true });
    writeFileSync(join(map, naam), inhoud);
  }
}

function pas(naam: string, van: string | RegExp, naar: string) {
  const oud = readFileSync(join(map, naam), "utf8");
  const nieuw = oud.replace(van, naar);
  expect(nieuw, `${naam}: ${String(van)} niet gevonden`).not.toBe(oud);
  writeFileSync(join(map, naam), nieuw);
}

function guard() {
  const env = { ...process.env };
  delete env.CI;
  const r = spawnSync(process.execPath, [GUARD], { cwd: map, encoding: "utf8", env });
  return { code: r.status, uitvoer: `${r.stdout}${r.stderr}` };
}

describe("guard:testlat", () => {
  vi.setConfig({ testTimeout: 60_000 });
  it("is groen op een app met de configs van de template (een overgeslagen test met de reden van de template mag)", () => {
    const r = guard();
    expect(r.code, r.uitvoer).toBe(0);
    expect(r.uitvoer).toContain("de afkorting @ wijst naar ./src");
  });

  it("de aanval: include versmallen, een naamfilter of een ontbrekend bestand in Vitest: rood", () => {
    pas("vitest.config.ts", /include:\s*\[[^\]]*\]/, 'include: ["src/features/**/*.test.tsx"]');
    pas("vitest.rls.config.ts", /include:\s*\[[^\]]*\]/, 'include: ["tests/rls/eigen/**"]');
    pas("vitest.config.ts", "globals: false,", 'globals: false,\n    testNamePattern: "eigen",');
    const r = guard();
    expect(r.code, r.uitvoer).not.toBe(0);
    expect(r.uitvoer).toContain("vitest.config.ts: verzamelt tests/unit/server-a.test.ts niet");
    expect(r.uitvoer).toContain("vitest.rls.config.ts: verzamelt tests/rls/b.test.ts niet");
    expect(r.uitvoer).toContain("testNamePattern");

    rmSync(join(map, "tests/unit/server-a.test.ts"));
    expect(guard().uitvoer).toContain(
      "tests/unit/server-a.test.ts: dit testbestand van de template ontbreekt",
    );
  });

  it("de aanval: testIgnore in playwright.config.ts: rood", () => {
    pas(
      "playwright.config.ts",
      'testDir: "./e2e",',
      'testDir: "./e2e",\n  testIgnore: ["**/server-*.spec.ts"],',
    );
    const r = guard();
    expect(r.code, r.uitvoer).not.toBe(0);
    expect(r.uitvoer).toContain(
      '"de pagina heeft headers" (e2e/server-x.spec.ts) staat niet in de lijst',
    );
  });

  it("grepInvert dat één test van de template weghaalt: rood", () => {
    pas("playwright.config.ts", 'testDir: "./e2e",', 'testDir: "./e2e",\n  grepInvert: /aanval/,');
    const r = guard();
    expect(r.code, r.uitvoer).not.toBe(0);
    expect(r.uitvoer).toContain("POST wordt geweigerd");
    expect(r.uitvoer).not.toContain('"de pagina heeft headers"');
  });

  it("een only in een eigen browsertest (de rest draait dan niet): rood", () => {
    pas("e2e/eigen.spec.ts", 'test("eigen"', `test${PUNT}only("eigen"`);
    const r = guard();
    expect(r.code, r.uitvoer).not.toBe(0);
    expect(r.uitvoer).toContain("e2e/eigen.spec.ts:2: `.only` in een browsertest");
  });

  it("uitzetten in een test van de template (skip met titel, fixme) of overslaan vanuit een eigen bestand: rood", () => {
    pas("tests/unit/server-a.test.ts", 'it("a"', `it${PUNT}skip("a"`);
    pas(
      "e2e/server-x.spec.ts",
      'test("de pagina heeft headers"',
      `test${PUNT}fixme("de pagina heeft headers"`,
    );
    schrijf({
      "e2e/hulp.ts":
        'import { test } from "@playwright/test";\ntest.skip(true, "even niet");\nexport const x = 1;\n',
    });
    pas(
      "e2e/server-x.spec.ts",
      "import { expect, test }",
      // In stukken, zodat de test op verwijzingen (template-afhankelijk) hem niet volgt.
      `${"import"} "./hulp";\nimport { expect, test }`,
    );
    const r = guard();
    expect(r.code, r.uitvoer).not.toBe(0);
    expect(r.uitvoer).toContain('tests/unit/server-a.test.ts:2: `.skip("...")`');
    expect(r.uitvoer).toContain("e2e/server-x.spec.ts:3: `.todo`, `.fixme` of `.fail`");
    expect(r.uitvoer).toContain(
      'POST wordt geweigerd" wordt overgeslagen, niet door de template zelf',
    );
  });

  it("de afkorting @ ombuigen of de servercode vervangen, in vite, vitest of tsconfig: rood", () => {
    pas(
      "vite.config.ts",
      '"@": fileURLToPath(new URL("./src"',
      '"@": fileURLToPath(new URL("./nep"',
    );
    pas(
      "vitest.config.ts",
      '"@": fileURLToPath',
      '"@supabase/ssr": "/tmp/nep-ssr.ts",\n      "@/lib/server/sessie.server": "/tmp/nep.ts",\n      "@": fileURLToPath',
    );
    pas(
      "tsconfig.json",
      '"@/*": ["./src/*"]',
      '"@/lib/server/*": ["./nep/*"],\n      "@/*": ["./src/*"]',
    );
    const r = guard();
    expect(r.code, r.uitvoer).not.toBe(0);
    expect(r.uitvoer).toMatch(
      /vite\.config\.ts: de afkorting `@` wijst naar .*nep, niet naar \.\/src/,
    );
    expect(r.uitvoer).toContain("vitest.config.ts: de afkorting @/lib/server/sessie.server buigt");
    expect(r.uitvoer).toContain("buigt `@supabase/ssr` om");
    expect(r.uitvoer).toContain('tsconfig.json: "paths" "@/lib/server/*" buigt');
  });
});

describe("guard:testlat zelf is niet vanuit de app uit te zetten", () => {
  const ci = parse(readFileSync(join(WORTEL, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<string, { steps: { run?: string; if?: string }[] }>;
  };
  const stappen = ci.jobs.checks?.steps ?? [];

  it("de job Code roept hem rechtstreeks aan, zonder voorwaarde, met het resultaat van de unittests", () => {
    const stap = stappen.find((s) =>
      (s.run ?? "").startsWith("node scripts/guard-testlat.mjs --unit-resultaat "),
    );
    expect(stap).toBeDefined();
    expect(stap?.if).toBeUndefined();
    const pad = (stap?.run ?? "").split(" ").at(-1) ?? "";
    const unittests = stappen.find((s) => (s.run ?? "").includes("--config vitest.config.ts"));
    expect(unittests?.run).toContain(`--outputFile.json=${pad}`);
    expect(unittests?.run).toContain("--includeTaskLocation");
  });

  it("de databasejob geeft het resultaat van de RLS-tests aan de guard", () => {
    const db = Object.values(ci.jobs).flatMap((j) => j.steps);
    const rls = db.find((s) => (s.run ?? "").includes("--config vitest.rls.config.ts"));
    const stap = db.find((s) =>
      (s.run ?? "").startsWith("node scripts/guard-testlat.mjs --rls-resultaat "),
    );
    expect(stap).toBeDefined();
    expect(rls?.run).toContain(`--outputFile.json=${(stap?.run ?? "").split(" ").at(-1)}`);
    expect(rls?.run).toContain("--includeTaskLocation");
    expect(stap?.if).toBe(rls?.if);
  });

  it("de Kwaliteitspoort roept geen script uit package.json aan (dat is van de app)", () => {
    const alle = Object.values(ci.jobs).flatMap((j) => j.steps.map((s) => s.run ?? ""));
    const viaPakket = alle.filter((run) =>
      /\bpnpm (?:run )?(?:check|guard|test|lint|typecheck)\b/.test(run),
    );
    expect(viaPakket).toEqual([]);
  });

  it("staat in pnpm guard, voor wie lokaal pnpm check draait", () => {
    const pkg = JSON.parse(readFileSync(join(WORTEL, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["guard:testlat"]).toBe("node scripts/guard-testlat.mjs");
    expect(pkg.scripts.guard).toContain("pnpm guard:testlat");
  });
});

/**
 * De waarheid uit de run (punt 5): drie manieren om een test van de template uit te zetten
 * die geen regel op de tekst ziet. De guard leest het resultaat van een echte run van Vitest
 * en legt het naast de tests in het templatebestand.
 */
describe("guard:testlat: draaide elke test van de template echt?", () => {
  vi.setConfig({ testTimeout: 120_000 });

  function templatetest(inhoud: string) {
    writeFileSync(join(map, "tests/unit/server-a.test.ts"), inhoud);
  }

  /** Draait de unittests in de kleine app zoals de Kwaliteitspoort, en dan de guard. */
  function metRun(soort: "unit" | "rls" = "unit") {
    const env = { ...process.env };
    delete env.CI;
    const config = soort === "unit" ? "vitest.config.ts" : "vitest.rls.config.ts";
    const uit = `.testlat/${soort}.json`;
    spawnSync(
      process.execPath,
      [
        join(WORTEL, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        config,
        "--reporter=json",
        `--outputFile.json=${uit}`,
        "--includeTaskLocation",
        ...(soort === "unit" ? ["tests/unit/server-a.test.ts"] : []),
      ],
      { cwd: map, encoding: "utf8", env },
    );
    const r = spawnSync(process.execPath, [GUARD, `--${soort}-resultaat`, uit], {
      cwd: map,
      encoding: "utf8",
      env,
    });
    return { code: r.status, uitvoer: `${r.stdout}${r.stderr}` };
  }

  const KOP = 'import { describe, expect, it } from "vitest";\n';

  it("alles gedraaid, ook een it.each: groen", () => {
    templatetest(
      `${KOP}it("a", () => expect(1).toBe(1));\nit.each([1, 2])("b %s", (n) => expect(n).toBeGreaterThan(0));\n`,
    );
    const r = metRun();
    expect(r.code, r.uitvoer).toBe(0);
  });

  it("de test onder een andere naam overslaan (const t = it; t.skip): rood", () => {
    templatetest(`${KOP}const t = it;\nt${PUNT}skip("a", () => expect(1).toBe(1));\n`);
    const r = metRun();
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain('tests/unit/server-a.test.ts:3: "a" is niet gedraaid');
  });

  it("overslaan op een vaste waarde (it.skipIf(1), runIf(0)): rood", () => {
    templatetest(
      `${KOP}it${PUNT}skipIf(1)("a", () => expect(1).toBe(1));\nit.runIf(0)("b", () => expect(1).toBe(1));\n`,
    );
    const r = metRun();
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain('"a" is niet gedraaid');
    expect(r.uitvoer).toContain('"b" is niet gedraaid');
  });

  it("de test in een lege each-tabel (describe.each([])): rood", () => {
    templatetest(
      `${KOP}it("a", () => expect(1).toBe(1));\ndescribe.each([])("suite %s", () => {\n  it("b", () => expect(1).toBe(1));\n});\n`,
    );
    const r = metRun();
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain(
      "tests/unit/server-a.test.ts:4: deze test van de template kwam in de run niet voor",
    );
  });

  it("overslaan met een echte voorwaarde uit het templatebestand zelf (runIf in de template): groen", () => {
    templatetest(
      `${KOP}const inDeTemplate = process.env.TESTLAT_NOOIT !== undefined;\nit("a", () => expect(1).toBe(1));\nit.runIf(inDeTemplate)("b", () => expect(1).toBe(1));\ndescribe.runIf(inDeTemplate)("c", () => {\n  it("d", () => expect(1).toBe(1));\n});\n`,
    );
    const r = metRun();
    expect(r.code, r.uitvoer).toBe(0);
  });

  it("een testbestand van de template dat niet in de run zat: rood; en de RLS-tests apart", () => {
    rmSync(join(map, "tests/unit/server-a.test.ts"));
    writeFileSync(
      join(map, "tests/unit/server-a.test.ts"),
      `${KOP}it("a", () => expect(1).toBe(1));\n`,
    );
    // Alleen het eigen bestand gedraaid, niet dat van de template.
    const env = { ...process.env };
    delete env.CI;
    spawnSync(
      process.execPath,
      [
        join(WORTEL, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        "vitest.config.ts",
        "--reporter=json",
        "--outputFile.json=.testlat/unit.json",
        "--includeTaskLocation",
        "src/features/eigen.test.tsx",
      ],
      { cwd: map, encoding: "utf8", env },
    );
    const r = spawnSync(process.execPath, [GUARD, "--unit-resultaat", ".testlat/unit.json"], {
      cwd: map,
      encoding: "utf8",
      env,
    });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain(
      "tests/unit/server-a.test.ts: dit testbestand van de template is in de run niet gedraaid",
    );

    writeFileSync(
      join(map, "tests/rls/b.test.ts"),
      `${KOP}const t = it;\nt${PUNT}skip("b", () => expect(1).toBe(1));\n`,
    );
    const rls = metRun("rls");
    expect(rls.code).not.toBe(0);
    expect(rls.uitvoer).toContain('tests/rls/b.test.ts:3: "b" is niet gedraaid');
  });
});
