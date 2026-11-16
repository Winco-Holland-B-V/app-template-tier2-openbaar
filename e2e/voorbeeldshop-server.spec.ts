import { expect, test } from "@playwright/test";
import { databaseModus } from "./stack-config";

/**
 * De beveiliging van de Worker op de pagina's van de voorbeeldwinkel: wat de algemene test
 * (e2e/server-beveiliging.spec.ts, van de template) niet kan, omdat het pagina's van dit
 * voorbeeld nodig heeft. Een productpagina met een action (`/producten/<slug>`), de wagen met
 * zijn formulier, en doorklikken in de winkel.
 *
 * Deze test is van het project: hij hoort bij de voorbeeldwinkel en gaat met de winkel weg.
 */
const VREEMD = "https://evil.example";
const PRODUCT = "/producten/een-product";
const metDatabase = databaseModus() !== "geen";

test("doorklikken in de winkel haalt gegevens op (.data), zonder dat de strenge regels iets weigeren", async ({
  page,
}) => {
  test.skip(!metDatabase, "zonder database is er geen winkel");
  const meldingen: string[] = [];
  await page.exposeFunction("__cspMelding", (m: string) => meldingen.push(m));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as Window & { __cspMelding?: (m: string) => void }).__cspMelding?.(
        `${e.violatedDirective} ${e.blockedURI}`,
      ),
    );
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Producten" })).toBeVisible();
  const gegevens = page.waitForRequest((r) => r.url().includes(".data"));
  await page
    .getByRole("navigation", { name: "Winkel" })
    .getByRole("link", { name: "Winkelwagen" })
    .click();
  await gegevens;
  await expect(page).toHaveURL(/\/login\?volgende=%2Fwagen$/);
  expect(meldingen).toEqual([]);
});

test.describe("een schrijvend verzoek vanaf een andere site, op de winkel", () => {
  for (const pad of [PRODUCT, `${PRODUCT}.data`, "/wagen", "/wagen.data"]) {
    test(`POST naar ${pad} met een vreemde Origin wordt geweigerd`, async ({ request }) => {
      const antwoord = await request.post(pad, { headers: { Origin: VREEMD }, form: { a: "1" } });
      expect(antwoord.status()).toBe(403);
    });
  }

  test("ook zonder Origin en met Origin null, op de productpagina met een action", async ({
    request,
  }) => {
    expect((await request.post(PRODUCT, { form: { a: "1" } })).status()).toBe(403);
    expect(
      (await request.post(PRODUCT, { headers: { Origin: "null" }, form: { a: "1" } })).status(),
    ).toBe(403);
  });

  test("een formulier op een andere pagina dat naar de wagen post: geweigerd", async ({
    page,
    baseURL,
  }) => {
    await page.goto("about:blank");
    await page.setContent(
      `<form method="post" action="${baseURL}/wagen"><input name="doe" value="bestellen"><button>Bestel</button></form>`,
    );
    const antwoord = page.waitForResponse((r) => r.request().method() === "POST");
    await page.getByRole("button", { name: "Bestel" }).click();
    expect((await antwoord).status()).toBe(403);
  });
});

test("de cache van de winkel: de lijst op / vijf minuten, de rest private", async ({ request }) => {
  for (const pad of ["/", "/_.data"]) {
    expect((await request.get(pad)).headers()["cache-control"], pad).toBe("public, max-age=300");
  }
  for (const pad of ["/producten", "/producten/bestaat-niet", "/wagen.data"]) {
    const antwoord = await request.get(pad, { maxRedirects: 0 });
    expect(antwoord.headers()["cache-control"], pad).toBe("private, no-store");
    expect(antwoord.headers()["x-robots-tag"], pad).toBe("noindex, nofollow");
  }
});

test("de wagen zonder sessie: de omleiding, nooit de inhoud", async ({ request }) => {
  test.skip(!metDatabase, "zonder database is er geen winkelwagen");
  const antwoord = await request.get("/wagen", { maxRedirects: 0 });
  expect(antwoord.status()).toBe(302);
  expect(await antwoord.text()).not.toContain("Regels in je winkelwagen");
});
