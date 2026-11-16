import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * guard:server bewaakt de regels voor code die op de Worker draait (zie het script zelf en
 * docs/WERKWIJZE.md): één Supabase-client per verzoek, geen `getSession()` op de server,
 * geen bindingen van Cloudflare, en de Worker van de template als enige ingang.
 */
const WORTEL = resolve(__dirname, "../..");
const GUARD = join(WORTEL, "scripts/guard-server.mjs");

let map: string;
beforeEach(() => {
  map = mkdtempSync(join(tmpdir(), "guard-server-"));
  for (const pad of ["src", "workers"])
    cpSync(join(WORTEL, pad), join(map, pad), { recursive: true });
});
afterEach(() => {
  rmSync(map, { recursive: true, force: true });
});

function draai(bestanden: Record<string, string> = {}) {
  for (const [naam, inhoud] of Object.entries(bestanden)) {
    mkdirSync(dirname(join(map, naam)), { recursive: true });
    writeFileSync(join(map, naam), inhoud);
  }
  const r = spawnSync("node", [GUARD], { cwd: map, encoding: "utf8" });
  return { code: r.status, uitvoer: `${r.stdout}${r.stderr}` };
}

/** De echte import van workers/app.ts (in stukken, zodat de test op verwijzingen hem hier niet volgt). */
const ECHT = `import { maakWorker } ${"from"} "../src/lib/server/worker.server";`;

describe("guard:server", () => {
  it("is groen op de servercode van deze app", () => {
    const r = draai();
    expect(r.code, r.uitvoer).toBe(0);
  });

  it("een eigen Supabase-client bovenin een route: rood (die zou van alle bezoekers tegelijk zijn)", () => {
    for (const regel of [
      'import { createClient } from "@supabase/supabase-js";\nconst supabase = createClient("https://x.supabase.co", "sleutel");',
      'import { createServerClient } from "@supabase/ssr";\nexport const gedeeld = createServerClient("u", "k", { cookies: { getAll: () => [] } });',
      'import * as s from "@supabase/supabase-js";\nconst c = s.createClient("u", "k");',
    ]) {
      const r = draai({
        "src/routes/prijzen.tsx": `${regel}\nexport function loader() { return null; }\n`,
      });
      expect(r.code, regel).not.toBe(0);
      expect(r.uitvoer).toContain("src/routes/prijzen.tsx");
      expect(r.uitvoer).toContain("supabaseVoorVerzoek");
    }
  });

  it("een eigen client in een los bestand voor de server: ook rood", () => {
    const r = draai({
      "src/lib/admin.server.ts":
        'import { createClient } from "@supabase/supabase-js";\nexport const admin = () => createClient("u", "k");\n',
    });
    expect(r.code).not.toBe(0);
  });

  it("getSession() in servercode: rood, want die gelooft het cookie zonder controle", () => {
    const r = draai({
      "src/routes/mijn.tsx":
        'import { supabaseVoorVerzoek } from "@/lib/server/sessie.server";\nexport async function loader({ context }) {\n  const { data } = await supabaseVoorVerzoek(context).auth.getSession();\n  return data.session?.user ?? null;\n}\n',
    });
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("getSession()");
  });

  it("getSession() in een scherm van de browser mag: daar is het de eigen sessie", () => {
    const r = draai({
      "src/features/x/hook.ts":
        "export const lees = (s: { auth: { getSession(): unknown } }) => s.auth.getSession();\n",
    });
    expect(r.code, r.uitvoer).toBe(0);
  });

  it("een module van Cloudflare zelf (bindingen): rood, in de broncode en in de gebouwde Worker", () => {
    const bron = draai({
      "src/routes/x.tsx":
        'import { env } from "cloudflare:workers";\nexport const loader = () => env;\n',
    });
    expect(bron.code).not.toBe(0);
    expect(bron.uitvoer).toContain("bindingen");
    rmSync(join(map, "src/routes/x.tsx"));
    const gebouwd = draai({
      "dist/server/assets/build.js": 'import{env}from"cloudflare:workers";export{env};',
    });
    expect(gebouwd.code).not.toBe(0);
    expect(gebouwd.uitvoer).toContain("dist/server/assets/build.js");
    rmSync(join(map, "dist"), { recursive: true });
    expect(
      draai({ "dist/server/assets/build.js": 'const x=await import("cloudflare:sockets");' }).code,
    ).not.toBe(0);
  });

  it("een eigen Worker in workers/app.ts, om de beveiliging van de template heen: rood", () => {
    for (const eigen of [
      'import { createRequestHandler } from "react-router";\nconst h = createRequestHandler(() => import("virtual:react-router/server-build"), "production");\nexport default { fetch: (r: Request) => h(r) };\n',
      `${ECHT}\nimport { extra } from "eigen-pakket";\nexport default maakWorker({ build: extra, mode: "production", omgeving: {} });\n`,
      `${ECHT}\nconst w = maakWorker({ build: () => import("virtual:react-router/server-build"), mode: "production", omgeving: {} });\nexport default { fetch: (r: Request, e: unknown, c: ExecutionContext) => (new URL(r.url).pathname === "/open" ? new Response("open") : w.fetch(r, e, c)) };\n`,
      // Via de afkorting @/: die bepaalt de build, en kan dus naar een ander bestand wijzen.
      'import { maakWorker } from "@/lib/server/worker.server";\nexport default maakWorker({ build: () => import("virtual:react-router/server-build"), mode: "production", omgeving: {} });\n',
    ]) {
      const r = draai({ "workers/app.ts": eigen });
      expect(r.code, eigen.slice(0, 60)).not.toBe(0);
      expect(r.uitvoer).toContain("workers/app.ts");
    }
  });

  it("een eigen src/entry.server.tsx, of geen: rood", () => {
    const eigen = draai({
      "src/entry.server.tsx":
        'export { default } from "@react-router/dev/config/defaults/entry.server.web";\n',
    });
    expect(eigen.code).not.toBe(0);
    expect(eigen.uitvoer).toContain("src/entry.server.tsx");
    rmSync(join(map, "src/entry.server.tsx"));
    expect(draai().code).not.toBe(0);
  });

  it("toelichting en tests mogen de woorden gewoon noemen", () => {
    const r = draai({
      "src/routes/uitleg.tsx":
        "// Gebruik hier geen createClient of getSession(); zie de regels.\nexport const loader = () => null;\n",
      "src/routes/uitleg.test.tsx":
        'import { createClient } from "@supabase/supabase-js";\nexport const c = createClient;\n',
    });
    expect(r.code, r.uitvoer).toBe(0);
  });

  it("zit in pnpm guard, in de check Code en in de uitrol", () => {
    const pkg = JSON.parse(readFileSync(join(WORTEL, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["guard:server"]).toBe("node scripts/guard-server.mjs");
    expect(pkg.scripts.guard).toContain("pnpm guard:server");
    const ci = parse(readFileSync(join(WORTEL, ".github/workflows/ci.yml"), "utf8")) as {
      jobs: Record<string, { steps: { run?: string; if?: string }[] }>;
    };
    const stap = ci.jobs.checks?.steps.find((s) => s.run === "node scripts/guard-server.mjs");
    expect(stap).toBeDefined();
    expect(stap?.if).toBeUndefined();
  });
});

describe("de Supabase-client van de browser", () => {
  it("weigert op de server te laden: daar zou hij van alle bezoekers tegelijk zijn", () => {
    const bron = readFileSync(join(WORTEL, "src/lib/supabase.ts"), "utf8");
    expect(bron).toMatch(/if \(typeof document === "undefined"\) \{\s*throw new Error\(/);
    expect(bron.indexOf('typeof document === "undefined"')).toBeLessThan(
      bron.indexOf("createBrowserClient<"),
    );
  });
});
