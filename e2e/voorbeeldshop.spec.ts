import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { inloggen } from "./inloggen";
import { databaseModus } from "./stack-config";

// De voorbeeldshop leest uit de eigen database (met de seed uit supabase/seed.sql).
test.skip(databaseModus() !== "eigen", "deze app heeft geen eigen database");

/**
 * De voorbeeldshop in de echte keten: de gebouwde Worker, de lokale Supabase met de seed, een
 * echte browser. Wat dit bewijst:
 *
 *   - een zoekmachine (zonder JavaScript) krijgt titel, og-tags en JSON-LD in de HTML;
 *   - twee klanten zien op hetzelfde adres elk hun eigen prijs, een anonieme bezoeker geen van
 *     beide; alleen die anonieme pagina mag in een cache;
 *   - een klant kan bestellen, met en zonder JavaScript, en dubbel versturen is één bestelling.
 *
 * De twee klanten en hun prijzen staan in supabase/seed.sql; ze zijn daar goedgekeurd. Ze loggen
 * in zoals elke klant: met de code uit de mail (e2e/inloggen.ts). Inloggen zonder JavaScript,
 * de link uit de mail, medewerkers en goedkeuren staan in e2e/klantportaal.spec.ts.
 */
const KLANT_A = {
  email: "klant-a@voorbeeld.nl",
  password: "voorbeeldshop-klant-a",
  prijs: "11,00",
};
const KLANT_B = {
  email: "klant-b@voorbeeld.nl",
  password: "voorbeeldshop-klant-b",
  prijs: "12,50",
};
const KOFFIE = "/producten/koffiebonen-huismelange";
const BASISPRIJS = "14,95";

async function inloggenAls(page: Page, wie: { email: string; password: string }) {
  await inloggen(page, { email: wie.email, wachtwoord: wie.password });
}

/** Een browser zonder JavaScript, met de sessie van een klant die al is ingelogd. */
async function zonderJavaScript(browser: Browser, wie: { email: string; password: string }) {
  const metJs = await browser.newContext();
  await inloggenAls(await metJs.newPage(), wie);
  const sessie = await metJs.storageState();
  await metJs.close();
  return browser.newContext({ javaScriptEnabled: false, storageState: sessie });
}

function jsonLd(html: string): Record<string, unknown>[] {
  const blokken = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  return blokken.flatMap((b) => {
    const waarde: unknown = JSON.parse(b[1] ?? "null");
    return (Array.isArray(waarde) ? waarde : [waarde]) as Record<string, unknown>[];
  });
}

function metaInhoud(html: string, sleutel: string): string | null {
  const m = html.match(new RegExp(`<meta (?:property|name)="${sleutel}" content="([^"]*)"`));
  return m?.[1] ?? null;
}

test.describe("vindbaar zonder JavaScript", () => {
  test("een productpagina heeft titel, og-tags, canonical en JSON-LD in de HTML", async ({
    request,
  }) => {
    const antwoord = await request.get(KOFFIE);
    expect(antwoord.status()).toBe(200);
    const html = await antwoord.text();
    expect(html).toContain("<title>Koffiebonen huismelange · Voorbeeldwinkel</title>");
    expect(metaInhoud(html, "description")).toContain("Een kilo hele bonen");
    expect(metaInhoud(html, "og:title")).toBe("Koffiebonen huismelange");
    expect(metaInhoud(html, "og:type")).toBe("product");
    expect(metaInhoud(html, "og:url")).toMatch(
      /^https?:\/\/[^/]+\/producten\/koffiebonen-huismelange$/,
    );
    expect(metaInhoud(html, "og:image")).toMatch(
      /^https?:\/\/[^/]+\/voorbeeldshop\/koffiebonen\.png$/,
    );
    expect(metaInhoud(html, "twitter:card")).toBe("summary_large_image");
    expect(html).toMatch(
      /<link rel="canonical" href="https?:\/\/[^"]+\/producten\/koffiebonen-huismelange"/,
    );

    const ld = jsonLd(html);
    const product = ld.find((d) => d["@type"] === "Product");
    expect(product).toMatchObject({
      name: "Koffiebonen huismelange",
      offers: { "@type": "Offer", price: "14.95", priceCurrency: "EUR" },
    });
    expect(ld.some((d) => d["@type"] === "BreadcrumbList")).toBe(true);
    // De hoofdfoto laadt met voorrang en heeft zijn maten.
    expect(html).toMatch(/<img[^>]*width="800"[^>]*height="800"[^>]*loading="eager"/);
  });

  test("de lijst op / heeft ItemList, WebSite en Organization", async ({ request }) => {
    const html = await (await request.get("/")).text();
    const soorten = jsonLd(html).map((d) => d["@type"]);
    expect(soorten).toEqual(expect.arrayContaining(["ItemList", "WebSite", "Organization"]));
    expect(html).toContain("<title>Producten · Voorbeeldwinkel</title>");
    // Een verborgen product staat er niet in.
    expect(html).not.toContain("Proefpakket najaar");
  });

  test("het oude adres /producten stuurt blijvend door naar /", async ({ request }) => {
    const antwoord = await request.get("/producten", { maxRedirects: 0 });
    expect(antwoord.status()).toBe(301);
    expect(antwoord.headers().location).toBe("/");
  });

  test("een onbekend product geeft een echte 404", async ({ request }) => {
    const antwoord = await request.get("/producten/bestaat-niet");
    expect(antwoord.status()).toBe(404);
    const html = await antwoord.text();
    expect(html).toContain("Pagina niet gevonden");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow"/>');
    expect(antwoord.headers()["cache-control"]).toBe("private, no-store");
  });

  test("de sitemap noemt de zichtbare producten, met lastmod, en geen verborgen", async ({
    request,
  }) => {
    const antwoord = await request.get("/sitemap.xml");
    expect(antwoord.status()).toBe(200);
    expect(antwoord.headers()["content-type"]).toContain("application/xml");
    const xml = await antwoord.text();
    expect(xml).toMatch(
      /<loc>https?:\/\/[^<]+\/producten\/koffiebonen-huismelange<\/loc>\s*<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/,
    );
    expect(xml).not.toContain("proefpakket-najaar");
  });

  test("de wagen en de bestellingen staan niet open en horen niet in Google", async ({
    request,
  }) => {
    for (const pad of ["/wagen", "/bestellingen"]) {
      const antwoord = await request.get(pad, { maxRedirects: 0 });
      expect(antwoord.status(), pad).toBe(302);
      expect(antwoord.headers().location, pad).toBe(`/login?volgende=${encodeURIComponent(pad)}`);
    }
  });

  test("een productnaam met </script> breekt niet uit de pagina", async ({ request }) => {
    const url = process.env.SUPABASE_URL;
    const sleutel = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !sleutel) throw new Error("SUPABASE_URL of SUPABASE_SERVICE_ROLE_KEY ontbreekt.");
    const admin = createClient(url, sleutel, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const slug = `e2e-kwaad-${Date.now()}`;
    const naam = 'Kwaad </script><script>window.gekraakt=1</script> & "<!--';
    const { data, error } = await admin
      .from("producten")
      .insert({
        slug,
        naam,
        omschrijving: naam,
        basisprijs_centen: 100,
        voorraad: 1,
        zichtbaar: true,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    try {
      const html = await (await request.get(`/producten/${slug}`)).text();
      expect(html).not.toContain("<script>window.gekraakt");
      const product = jsonLd(html).find((d) => d["@type"] === "Product");
      expect(product?.name).toBe(naam);
    } finally {
      await admin.from("producten").delete().eq("id", data.id);
    }
  });
});

test.describe("een afbeelding wijst nooit naar een ander domein", () => {
  test("een afbeelding met een backslash (`/\\elders.example/...`) komt niet in de database, en een pad in og:image blijft op het eigen domein", async ({
    request,
  }) => {
    const url = process.env.SUPABASE_URL;
    const sleutel = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !sleutel) throw new Error("SUPABASE_URL of SUPABASE_SERVICE_ROLE_KEY ontbreekt.");
    const admin = createClient(url, sleutel, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const slug = `e2e-beeld-${Date.now()}`;
    const product = {
      slug,
      naam: "Beeld",
      basisprijs_centen: 100,
      voorraad: 1,
      zichtbaar: true,
    };
    for (const afbeelding of ["/\\elders.example/volg.png", "/\telders.example/volg.png"]) {
      const { error } = await admin.from("producten").insert({ ...product, afbeelding });
      expect(error?.code, afbeelding).toBe("23514");
    }
    const { data, error } = await admin
      .from("producten")
      .insert({ ...product, afbeelding: "/voorbeeldshop/koffie.png" })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    try {
      const antwoord = await request.get(`/producten/${slug}`);
      const html = await antwoord.text();
      const beeld = /property="og:image" content="([^"]+)"/.exec(html)?.[1] ?? "";
      expect(new URL(beeld).pathname).toBe("/voorbeeldshop/koffie.png");
      expect(new URL(beeld).host).not.toContain("elders");
      expect(html).not.toContain("elders.example");
    } finally {
      await admin.from("producten").delete().eq("id", data.id);
    }
  });
});

test.describe("de prijs van de één komt nooit bij de ander", () => {
  test("twee klanten zien op hetzelfde adres elk hun eigen prijs; anoniem geen van beide", async ({
    browser,
    request,
  }) => {
    const prijsOp = async (r: APIRequestContext) => {
      const antwoord = await r.get(KOFFIE);
      // Bedragen staan met een harde spatie op de pagina (€ 11,00 breekt niet af), en React
      // zet soms een leeg commentaar tussen twee stukken tekst.
      const html = (await antwoord.text()).replaceAll("\u00a0", " ").replaceAll("<!-- -->", "");
      return { html, cache: antwoord.headers()["cache-control"] };
    };

    const a = await browser.newContext();
    const b = await browser.newContext();
    try {
      await inloggenAls(await a.newPage(), KLANT_A);
      await inloggenAls(await b.newPage(), KLANT_B);

      // Tegelijk opvragen: de antwoorden mogen niet door elkaar lopen.
      const [vanA, vanB, anoniem] = await Promise.all([
        prijsOp(a.request),
        prijsOp(b.request),
        prijsOp(request),
      ]);

      expect(vanA.html).toContain(`Jouw prijs € ${KLANT_A.prijs}`);
      expect(vanA.html).not.toContain(KLANT_B.prijs);
      expect(vanB.html).toContain(`Jouw prijs € ${KLANT_B.prijs}`);
      expect(vanB.html).not.toContain(KLANT_A.prijs);
      expect(anoniem.html).toContain(`€ ${BASISPRIJS}`);
      expect(anoniem.html).not.toContain(KLANT_A.prijs);
      expect(anoniem.html).not.toContain(KLANT_B.prijs);
      expect(anoniem.html).not.toContain("Jouw prijs");

      // Alleen de anonieme pagina mag in een cache.
      expect(anoniem.cache).toMatch(/^public, max-age=\d+$/);
      expect(vanA.cache).toBe("private, no-store");
      expect(vanB.cache).toBe("private, no-store");

      // Ook in de JSON-LD van de klant staat de openbare prijs, nooit de zijne.
      const product = jsonLd(vanA.html).find((d) => d["@type"] === "Product");
      expect(product).toMatchObject({ offers: { price: "14.95" } });

      // Hetzelfde voor de gegevens die React Router bij het navigeren ophaalt.
      const dataA = await a.request.get(`${KOFFIE}.data`);
      expect(dataA.headers()["cache-control"]).toBe("private, no-store");
      const dataAnoniem = await request.get(`${KOFFIE}.data`);
      expect(dataAnoniem.headers()["cache-control"]).toMatch(/^public, max-age=\d+$/);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

test.describe("bestellen", () => {
  test("met JavaScript: in de wagen, bestellen, en de bestelling staat er met de eigen prijs", async ({
    page,
  }) => {
    await inloggenAls(page, KLANT_A);
    await page.goto(KOFFIE);
    await expect(page.getByTestId("prijs")).toContainText(`Jouw prijs € ${KLANT_A.prijs}`);
    await page.getByLabel("Aantal").fill("2");
    await page.getByRole("button", { name: "In winkelwagen" }).click();
    await expect(page.getByRole("status")).toContainText("Ligt in je winkelwagen");
    // De pagina is blijven staan: met JavaScript gaat dit zonder herladen.
    await expect(page).toHaveURL(new RegExp(`${KOFFIE}$`));

    await page.getByRole("link", { name: "Naar de winkelwagen" }).click();
    await expect(page.getByRole("heading", { name: "Winkelwagen" })).toBeVisible();
    await expect(page.getByText(`€ ${KLANT_A.prijs} per stuk`)).toBeVisible();
    await page.getByRole("button", { name: "Bestellen" }).click();

    await expect(page).toHaveURL(/\/bestellingen\?geplaatst=/);
    await expect(page.getByText("Bedankt, je bestelling is geplaatst.")).toBeVisible();
    const bestelling = page.getByTestId("bestelling").first();
    await expect(bestelling).toContainText("× Koffiebonen huismelange");
    await expect(bestelling).toContainText(`€ ${KLANT_A.prijs}`);
    await expect(bestelling).not.toContainText(BASISPRIJS);
  });

  test("zonder JavaScript: dezelfde weg met gewone formulieren, en dubbel versturen is één bestelling", async ({
    browser,
  }) => {
    const context = await zonderJavaScript(browser, KLANT_B);
    try {
      const page = await context.newPage();
      await page.goto(KOFFIE);
      await expect(page.getByTestId("prijs")).toContainText(`Jouw prijs € ${KLANT_B.prijs}`);
      await page.getByRole("button", { name: "In winkelwagen" }).click();
      // Zonder JavaScript stuurt de browser het formulier op en toont de server de uitkomst.
      await expect(page.getByRole("status")).toContainText("Ligt in je winkelwagen");

      await page.goto("/bestellingen");
      const voor = await page.getByTestId("bestelling").count();

      await page.goto("/wagen");
      await expect(page.getByText(`€ ${KLANT_B.prijs} per stuk`)).toBeVisible();
      const sleutel = await page.locator('input[name="sleutel"]').inputValue();
      const verwacht = await page.locator('input[name="verwacht"]').inputValue();
      const origin = new URL(page.url()).origin;
      // Twee keer hetzelfde formulier, zoals bij dubbel klikken.
      const versturen = () =>
        context.request.post("/wagen", {
          headers: { Origin: origin },
          form: { doe: "bestellen", sleutel, verwacht },
          maxRedirects: 0,
        });
      const [een, twee] = await Promise.all([versturen(), versturen()]);
      expect(een.status()).toBe(302);
      expect(twee.status()).toBe(302);
      expect(een.headers().location).toBe(twee.headers().location);

      await page.goto(een.headers().location ?? "/bestellingen");
      await expect(page.getByText("Bedankt, je bestelling is geplaatst.")).toBeVisible();
      await expect(page.getByTestId("bestelling")).toHaveCount(voor + 1);
      await expect(page.getByTestId("bestelling").first()).toContainText(`€ ${KLANT_B.prijs}`);
    } finally {
      await context.close();
    }
  });

  test("een bestelling van een andere site wordt geweigerd", async ({ browser }) => {
    const context = await zonderJavaScript(browser, KLANT_A);
    try {
      const antwoord = await context.request.post("/wagen", {
        headers: { Origin: "https://nep-winkel.example" },
        form: { doe: "bestellen", sleutel: crypto.randomUUID(), verwacht: "0" },
        maxRedirects: 0,
      });
      expect(antwoord.status()).toBe(403);
    } finally {
      await context.close();
    }
  });
});
