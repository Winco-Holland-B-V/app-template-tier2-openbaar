import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { GEEN_ONDERDEEL, ONDERDELEN } from "../../src/onderdelen";

/**
 * De lijst met onderdelen (src/onderdelen.ts) blijft bij met de router. De browsertest
 * e2e/onderdelen.spec.ts opent elk onderdeel uit die lijst; een hoofdpad dat er niet in
 * staat, opent hij dus nooit. Deze test maakt dat rood, zodat niemand eraan hoeft te denken.
 *
 * Welke hoofdpaden er zijn, zegt scripts/lib/onderdelen.mjs: de routes uit src/routes.ts, een
 * router in een scherm (`<Route path="/...">`, `path: "/..."`) of een eigen keuze op het pad
 * (`pathname === "/plugin"`, `pad.startsWith("/beheer")`). /stagetwo-tier2:updaten gebruikt dezelfde regel om
 * src/onderdelen.ts te vullen, dus test en plugin tellen nooit verschillend.
 *
 * Deze test is van de template en komt met elke versie mee.
 */
const WORTEL = resolve(__dirname, "../..");
const LIB = pathToFileURL(resolve(WORTEL, "scripts/lib/onderdelen.mjs")).href;
type Route = { path?: string; index?: boolean; children?: Route[] };
const { hoofdpad, hoofdpaden, padenInTekst, padenUitRoutes } = (await import(LIB)) as {
  hoofdpad: (pad: string) => string | null;
  hoofdpaden: (map: string) => Promise<string[]>;
  padenInTekst: (tekst: string) => string[];
  padenUitRoutes: (routes: Route[]) => string[];
};
const hoofdpadenVanDeApp = await hoofdpaden(WORTEL);

/**
 * Is dit de template zelf (herkend zoals guard-template dat doet)? Eén test hieronder noemt de
 * routes van de template bij naam; een app heeft andere routes en slaat die over (gevonden
 * met tests/unit/afgeleide-app.test.ts, uitgave 43).
 */
const repo =
  process.env.GITHUB_REPOSITORY ??
  (() => {
    try {
      return execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: WORTEL,
        encoding: "utf8",
      }).trim();
    } catch {
      return "";
    }
  })();
const inDeTemplate =
  /\/(?:app-template-tier(?:1|2|2-openbaar)|stack-template(?:-cloudflare|-light)?)(?:\.git)?$/.test(
    `/${repo}`,
  );

describe("src/onderdelen.ts", () => {
  const routes = new Set(hoofdpadenVanDeApp);
  const inLijst = new Set(ONDERDELEN.map((o) => hoofdpad(o.pad)));
  const bewustNiet = new Set(GEEN_ONDERDEEL.map(hoofdpad));

  it("elk hoofdpad in de router staat in de lijst (of bewust in GEEN_ONDERDEEL)", () => {
    const zonder = [...routes].filter((p) => !inLijst.has(p) && !bewustNiet.has(p)).sort();
    expect(
      zonder,
      "hoofdpaden zonder regel in src/onderdelen.ts: zet ze in ONDERDELEN (of in GEEN_ONDERDEEL als het geen onderdeel is)",
    ).toEqual([]);
  });

  it("elk onderdeel in de lijst heeft een route", () => {
    const weg = ONDERDELEN.filter((o) => !routes.has(hoofdpad(o.pad) ?? "")).map((o) => o.pad);
    expect(weg, "onderdelen zonder route in src/").toEqual([]);
  });

  it("elk onderdeel heeft een pad dat met / begint en een naam", () => {
    for (const o of ONDERDELEN) {
      expect(o.pad, o.naam).toMatch(/^\//);
      expect(o.naam.trim(), o.pad).not.toBe("");
    }
  });
});

describe("scripts/lib/onderdelen.mjs: welke paden tellen", () => {
  it.runIf(inDeTemplate)(
    "de routes van deze app: de voorbeeldshop (met de lijst op /), /klanten en /login uit src/routes.ts",
    () => {
      expect(hoofdpadenVanDeApp).toEqual([
        "/",
        "/bestellingen",
        "/klanten",
        "/login",
        "/producten",
        "/wagen",
      ]);
    },
  );

  it("src/routes.ts: index, route, layout en prefix, ook genest onder hun ouder", () => {
    const routes: Route[] = [
      { index: true },
      { path: "klanten", children: [{ index: true }, { path: ":id" }, { path: "nieuw" }] },
      // layout: geen eigen pad, de kinderen tellen op het niveau van de layout
      { children: [{ path: "login" }, { path: "orders/:id/regels" }] },
      // prefix("beheer", [...]) levert het pad al samengevoegd op
      { path: "beheer/gebruikers" },
      { path: "*" },
    ];
    expect(padenUitRoutes(routes)).toEqual([
      "/",
      "/klanten",
      "/klanten",
      "/klanten/:id",
      "/klanten/nieuw",
      "/login",
      "/orders/:id/regels",
      "/beheer/gebruikers",
      "/*",
    ]);
    expect([...new Set(padenUitRoutes(routes).map(hoofdpad))]).toEqual([
      "/",
      "/klanten",
      "/login",
      "/orders",
      "/beheer",
      null,
    ]);
  });

  it("een router: Route path, path={...} en path: in een lijst", () => {
    const tekst = '<Route path="/klanten/:id" /> <Route path={"/orders"} /> { path: "/rapport" }';
    expect(padenInTekst(tekst).map(hoofdpad)).toEqual(["/klanten", "/orders", "/rapport"]);
  });

  it("een eigen keuze op het pad, ook via een naam die het pad vasthoudt (zoals stagetwo-site)", () => {
    const tekst = [
      "const pad = window.location.pathname;",
      'if (pad === "/beheer/voorbeeld") {} else if (pad === "/") {}',
      'if (url.pathname.startsWith("/api/")) {}',
      'if ("/hallo" === pad) {}',
      'switch (pad) { case "/plugin": break; }',
    ].join("\n");
    expect(padenInTekst(tekst).map(hoofdpad).sort()).toEqual([
      "/",
      "/api",
      "/beheer",
      "/hallo",
      "/plugin",
    ]);
  });

  it("een omgezette app: vangroute, browser-schermen met een eigen router, bestanden en adressen van foto's", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } =
      await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const map = realpathSync(mkdtempSync(join(tmpdir(), "onderdelen-")));
    try {
      mkdirSync(join(map, "src/features/oud"), { recursive: true });
      symlinkSync(resolve(WORTEL, "node_modules"), join(map, "node_modules"), "dir");
      writeFileSync(
        join(map, "src/routes.ts"),
        [
          'import { index, route } from "@react-router/dev/routes";',
          "export default [",
          '  route("login", "routes/login.tsx"),',
          '  route("sitemap.xml", "routes/sitemap.ts"),',
          '  route("robots.txt", "routes/robots.ts"),',
          '  route("bekijk/:code", "routes/bekijk.tsx"),',
          '  route("shop/*", "routes/shop.tsx"),',
          '  index("routes/browser-app.tsx", { id: "start" }),',
          '  route("*", "routes/browser-app.tsx"),',
          "];",
        ].join("\n"),
      );
      writeFileSync(
        join(map, "src/features/oud/app.tsx"),
        [
          '<Route path="/selectie" element={<Selectie />} />',
          '<Route path="/beheer/*" element={<Beheer />} />',
          'if (foto.pathname.startsWith("/storage/")) {}',
          'const u = new URL(src); if (u.pathname === "/render/image") {}',
        ].join("\n"),
      );
      // Zoals /stagetwo-tier2:updaten het draait: los, in de map van de app.
      const uit = execFileSync(process.execPath, [resolve(WORTEL, "scripts/lib/onderdelen.mjs")], {
        cwd: map,
        encoding: "utf8",
      });
      expect(JSON.parse(uit)).toEqual(["/", "/beheer", "/bekijk", "/login", "/selectie", "/shop"]);
    } finally {
      rmSync(map, { recursive: true, force: true });
    }
  });

  it("geen pad: een relatief pad, een vergelijking met iets anders dan het pad, een los woord", () => {
    const tekst =
      'const naam = "/x"; if (soort === "/y") {} <Route path="details" /> "/z".startsWith("/")';
    expect(padenInTekst(tekst)).toEqual([]);
  });
});
