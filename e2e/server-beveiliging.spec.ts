import { expect, test } from "@playwright/test";
import { browsertestPaginas, databaseModus } from "./stack-config";

/**
 * De beveiliging die de Worker van de template op elk verzoek en antwoord zet, getest op de
 * gebouwde app in de echte Workers-omgeving (zie playwright.config.ts). De regels zelf
 * staan in src/lib/server/ en in docs/WERKWIJZE.md ("Code op de server"); de tests per
 * regel in tests/unit/server-*.test.ts. Hier: werkt het ook echt, met React Router ertussen?
 *
 * De adressen zijn die van de template zelf (`/login`, `/login/terug`, `/robots.txt`, een
 * adres dat niet bestaat) en de twee pagina's die de app in stack.config.json noemt
 * (`browsertest`: een openbare pagina en een pagina met inlog, zie e2e/stack-config.ts). Noemt
 * de app ze niet, dan slaat de test die delen over en zegt hij waarom. Zo werkt deze test in
 * elke app; in de template wijzen de twee pagina's naar de voorbeeldwinkel, en
 * e2e/voorbeeldshop-server.spec.ts toetst daar de rest (een productpagina met een action,
 * doorklikken in de winkel).
 *
 * Deze tests gelden met en zonder database: zonder database stuurt `/login` door naar `/`, en
 * weigert de Worker een vreemd verzoek nog vóór er een route aan te pas komt.
 * Deze test is van de template.
 */
const VREEMD = "https://evil.example";
const metDatabase = databaseModus() !== "geen";
const { openbarePagina, paginaMetInlog } = browsertestPaginas();
const GEEN_OPENBARE =
  'deze app noemt geen openbare pagina (stack.config.json: "browsertest": { "openbare_pagina": "/..." })';
const GEEN_MET_INLOG =
  'deze app noemt geen pagina met inlog (stack.config.json: "browsertest": { "pagina_met_inlog": "/..." })';

/** Het gegevensverzoek van React Router bij een pagina: `/` wordt `/_.data`, `/x` wordt `/x.data`. */
const gegevens = (pad: string) => (pad === "/" ? "/_.data" : `${pad.replace(/\/$/, "")}.data`);

/** Een pagina met scripts van React Router: de openbare pagina, anders de inlogpagina. */
const PAGINA = openbarePagina ?? (metDatabase ? "/login" : "/");

/** Alle adressen die deze test kent, met hun gegevensverzoek. */
const ADRESSEN = [
  ...new Set([
    "/",
    "/_.data",
    "/login",
    "/login.data",
    "/login/terug",
    "/bestaat-niet",
    ...[openbarePagina, paginaMetInlog].flatMap((p) => (p ? [p, gegevens(p)] : [])),
  ]),
];

test("een pagina krijgt de beveiligingsheaders, en elk script in de pagina de eenmalige code", async ({
  request,
}) => {
  const antwoord = await request.get(PAGINA);
  expect(antwoord.status()).toBe(200);
  const headers = antwoord.headers();
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  const csp = headers["content-security-policy"] ?? "";
  const nonce = /script-src 'self' 'nonce-([^']+)'/.exec(csp)?.[1] ?? "";
  expect(nonce.length).toBeGreaterThan(15);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).not.toContain("'unsafe-eval'");
  expect(/script-src[^;]*'unsafe-inline'/.test(csp)).toBe(false);
  const html = await antwoord.text();
  const scripts = html.match(/<script\b[^>]*>/g) ?? [];
  expect(scripts.length).toBeGreaterThan(0);
  for (const script of scripts) {
    // JSON-LD is geen script dat draait; alles wat wél draait, heeft de code.
    if (script.includes('type="application/ld+json"')) continue;
    expect(script).toContain(`nonce="${nonce}"`);
  }
  // Een tweede verzoek krijgt een andere code.
  const tweede = (await request.get(PAGINA)).headers()["content-security-policy"] ?? "";
  expect(tweede).not.toContain(nonce);
});

test("met die strenge regels werkt de pagina nog in de browser: niets geweigerd (ook geen eval)", async ({
  page,
}) => {
  const fouten: string[] = [];
  page.on("pageerror", (e) => fouten.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") fouten.push(m.text());
  });
  // Wat de Content-Security-Policy weigert, meldt de browser als gebeurtenis, niet altijd in
  // de console (een opgevangen `eval` van Zod bijvoorbeeld). Daarom luisteren we ernaar.
  await page.addInitScript(() => {
    const meldingen: string[] = [];
    Object.assign(window, { __cspMeldingen: meldingen });
    document.addEventListener("securitypolicyviolation", (e) =>
      meldingen.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  await page.goto(PAGINA);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // Alle scripts zijn geladen en hebben gedraaid.
  await page.waitForLoadState("networkidle");
  const cspMeldingen = await page.evaluate(
    () => (window as Window & { __cspMeldingen?: string[] }).__cspMeldingen ?? [],
  );
  expect(cspMeldingen, "meldingen van de Content-Security-Policy").toEqual([]);
  expect(fouten.filter((f) => /Content Security Policy|Refused to/i.test(f))).toEqual([]);
});

test("een script dat iemand in de pagina weet te krijgen, draait niet", async ({ page }) => {
  await page.goto(PAGINA);
  const geweigerd = page.waitForEvent("console", (m) => /Content Security Policy/i.test(m.text()));
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.__ingebroken = true";
    document.body.appendChild(script);
    const vreemd = document.createElement("script");
    vreemd.src = "https://evil.example/steel.js";
    document.body.appendChild(vreemd);
  });
  await geweigerd;
  expect(await page.evaluate(() => "__ingebroken" in window)).toBe(false);
});

test.describe("aanval: een schrijvend verzoek vanaf een andere site", () => {
  for (const pad of ADRESSEN) {
    test(`POST naar ${pad} met een vreemde Origin wordt geweigerd`, async ({ request }) => {
      const antwoord = await request.post(pad, { headers: { Origin: VREEMD }, form: { a: "1" } });
      expect(antwoord.status()).toBe(403);
      expect(antwoord.headers()["cache-control"]).toBe("private, no-store");
    });
  }

  test("ook zonder Origin, met Origin null, en met andere methodes", async ({ request }) => {
    for (const pad of ["/login", "/login.data", ...(paginaMetInlog ? [paginaMetInlog] : [])]) {
      expect((await request.post(pad, { form: { a: "1" } })).status(), pad).toBe(403);
      expect(
        (await request.post(pad, { headers: { Origin: "null" }, form: { a: "1" } })).status(),
        pad,
      ).toBe(403);
      for (const methode of ["put", "patch", "delete"] as const) {
        expect(
          (await request[methode](pad, { headers: { Origin: VREEMD } })).status(),
          `${methode} ${pad}`,
        ).toBe(403);
      }
    }
  });

  test("een formulier op een andere pagina dat hierheen post (uitloggen): geweigerd door de server", async ({
    page,
    baseURL,
  }) => {
    await page.goto("about:blank");
    await page.setContent(
      `<form method="post" action="${baseURL}/login"><input name="doe" value="uitloggen"><button>Uitloggen</button></form>`,
    );
    const antwoord = page.waitForResponse((r) => r.request().method() === "POST");
    await page.getByRole("button", { name: "Uitloggen" }).click();
    expect((await antwoord).status()).toBe(403);
  });

  test("een verzoek van de app zelf komt wel bij React Router aan", async ({
    request,
    baseURL,
  }) => {
    const antwoord = await request.post("/bestaat-niet", {
      headers: { Origin: baseURL ?? "" },
      form: { a: "1" },
    });
    expect(antwoord.status()).not.toBe(403);
  });
});

test.describe("aanval: een adres dat niet het echte domein is in een zoekmachine krijgen", () => {
  test("elke pagina, elk gegevensverzoek en elke omleiding krijgt noindex", async ({ request }) => {
    for (const pad of ADRESSEN) {
      const antwoord = await request.get(pad, { maxRedirects: 0 });
      expect(antwoord.headers()["x-robots-tag"], pad).toBe("noindex, nofollow");
    }
  });

  test("robots.txt weigert alles, ook met een Host die zich voordoet als een echt domein", async ({
    request,
  }) => {
    for (const headers of [
      {},
      { "X-Forwarded-Host": "shop.klant.nl" },
      { Forwarded: "host=shop.klant.nl" },
    ] as Record<string, string>[]) {
      const antwoord = await request.get("/robots.txt", { headers });
      expect(antwoord.status()).toBe(200);
      expect(await antwoord.text()).toBe("User-agent: *\nDisallow: /\n");
    }
  });
});

test.describe("de cacheregel, met React Router ertussen", () => {
  test("zonder cookie krijgt de openbare pagina de cache waar ze om vraagt", async ({
    request,
  }) => {
    test.skip(openbarePagina === null, GEEN_OPENBARE);
    const pad = openbarePagina ?? "/";
    for (const adres of [pad, gegevens(pad)]) {
      const antwoord = await request.get(adres);
      expect(antwoord.headers()["cache-control"], adres).toMatch(/^public, max-age=\d+$/);
      expect(antwoord.headers().vary, adres).toContain("Cookie");
      expect(antwoord.headers()["set-cookie"], adres).toBeUndefined();
    }
  });

  test("met een cookie, welk dan ook, is hetzelfde adres private, no-store", async ({
    request,
  }) => {
    test.skip(openbarePagina === null, GEEN_OPENBARE);
    const pad = openbarePagina ?? "/";
    for (const adres of [pad, gegevens(pad)]) {
      const antwoord = await request.get(adres, { headers: { Cookie: "iets=abc" } });
      expect(antwoord.headers()["cache-control"], adres).toBe("private, no-store");
    }
  });

  test("al het andere is private, no-store: inloggen, omleidingen, 404 en de routelijst", async ({
    request,
  }) => {
    for (const pad of [
      "/login",
      "/login.data",
      "/login/terug",
      "/bestaat-niet",
      "/__manifest?paths=%2F&version=x",
      "/robots.txt",
      ...(paginaMetInlog ? [paginaMetInlog, gegevens(paginaMetInlog)] : []),
    ]) {
      const antwoord = await request.get(pad, { maxRedirects: 0 });
      expect(antwoord.headers()["cache-control"], pad).toBe("private, no-store");
    }
  });
});

test("een pagina die alleen met inlog mag, stuurt een bezoeker zonder sessie naar de inlogpagina", async ({
  request,
}) => {
  test.skip(!metDatabase, "zonder database is er niets met inlog");
  test.skip(paginaMetInlog === null, GEEN_MET_INLOG);
  const pad = paginaMetInlog ?? "/";
  const antwoord = await request.get(pad, { maxRedirects: 0 });
  expect(antwoord.status()).toBe(302);
  expect(antwoord.headers().location).toBe(`/login?volgende=${encodeURIComponent(pad)}`);
  const data = await request.get(gegevens(pad), { maxRedirects: 0 });
  expect([302, 202, 204]).toContain(data.status());
  expect(await data.text()).not.toContain("Je bent ingelogd als");
});
