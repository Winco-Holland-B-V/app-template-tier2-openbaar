import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { inloggen } from "./inloggen";
import { databaseModus } from "./stack-config";

// Alleen met een eigen database valt er in te loggen en een tweede gebruiker te maken.
test.skip(databaseModus() !== "eigen", "deze app heeft geen eigen database");
// Eén reeks, in één browser-werker: de gebruikers en het product hieronder zijn van deze file.
test.describe.configure({ mode: "serial" });

/**
 * De sessie op de server, met de echte keten: de gebouwde Worker in de Workers-omgeving, de
 * lokale Supabase, echte inlog (de code uit de mail, zie e2e/inloggen.ts), en de pagina's van de voorbeeldshop: `/` (de productlijst),
 * een productpagina en `/wagen`, met hun gegevensverzoeken (`.data`). Twee aanvallen:
 *
 *   b. een pagina van een ingelogde klant te zien krijgen als anonieme bezoeker;
 *   g. op de server gegevens lezen met meer rechten dan de klant zelf heeft.
 *
 * Elke klant heeft een eigen prijs voor het product (klantprijzen): op dezelfde pagina ziet de
 * ene klant dus iets anders dan de andere en dan een anonieme bezoeker. Dat maakt een
 * verwisseling zichtbaar. De klanten, het product en de prijzen maakt deze test zelf, en ruimt
 * hij na afloop op.
 *
 * Wat dit bewijst: de server leest met de sessie uit het cookie en met niets anders, de
 * regels in de database bepalen wat er terugkomt, en de antwoorden van twee bezoekers lopen
 * niet door elkaar, ook niet als ze tegelijk komen. Wat het niet bewijst: het gedrag van de
 * cache van Cloudflare zelf; die bewaart een antwoord van een Worker niet zonder dat de
 * servercode erom vraagt, en guard:server weigert dat (zie tests/unit/server-cache.test.ts).
 *
 * Deze test is van het project: hij leunt op de tabellen van de voorbeeldshop (producten,
 * klantprijzen) en de routes `/`, `/producten/:slug` en `/wagen`, en gaat met de winkel weg. De
 * algemene test van de template, die in elke app werkt, staat in e2e/server-sessie.spec.ts.
 */
const STEMPEL = Date.now();
const A = {
  email: "e2e-server-a@voorbeeld.nl",
  password: "e2e-server-a-wachtwoord-1",
  centen: 987654,
  prijs: "9.876,54",
};
const B = {
  email: "e2e-server-b@voorbeeld.nl",
  password: "e2e-server-b-wachtwoord-2",
  centen: 876543,
  prijs: "8.765,43",
};
const PRODUCT = { slug: `e2e-serverproef-${STEMPEL}`, naam: `Serverproef ${STEMPEL}` };
const PAD = `/producten/${PRODUCT.slug}`;

function admin() {
  const url = process.env.SUPABASE_URL;
  const sleutel = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !sleutel)
    throw new Error("SUPABASE_URL of SUPABASE_SERVICE_ROLE_KEY ontbreekt (pnpm env:local).");
  // Alleen hier, in de test op de eigen computer of in CI: gebruikers en een product aanmaken.
  return createClient(url, sleutel, { auth: { autoRefreshToken: false, persistSession: false } });
}

let productId = "";

test.beforeAll(async () => {
  const db = admin();
  const { data } = await db.auth.admin.listUsers();
  const ids: Record<string, string> = {};
  for (const wie of [A, B]) {
    const bestaand = data?.users.find((u) => u.email === wie.email);
    if (bestaand) await db.auth.admin.deleteUser(bestaand.id);
    const { data: nieuw, error } = await db.auth.admin.createUser({
      email: wie.email,
      password: wie.password,
      email_confirm: true,
    });
    if (error || !nieuw.user) throw new Error(`Kon ${wie.email} niet aanmaken: ${error?.message}`);
    ids[wie.email] = nieuw.user.id;
  }
  // De winkel is een klantportaal: zonder goedkeuring heeft een account geen prijs en geen wagen.
  const klanten = await db.from("klanten").upsert(
    [A, B].map((wie) => ({
      user_id: ids[wie.email] ?? "",
      e_mail: wie.email,
      goedgekeurd: true,
    })),
  );
  if (klanten.error) throw new Error(`Kon de klanten niet goedkeuren: ${klanten.error.message}`);
  const { data: product, error } = await db
    .from("producten")
    .insert({ ...PRODUCT, basisprijs_centen: 1000, voorraad: 50, zichtbaar: true })
    .select("id")
    .single();
  if (error) throw new Error(`Kon het testproduct niet aanmaken: ${error.message}`);
  productId = product.id;
  const prijzen = await db.from("klantprijzen").insert([
    { klant_id: ids[A.email] ?? "", product_id: productId, prijs_centen: A.centen },
    { klant_id: ids[B.email] ?? "", product_id: productId, prijs_centen: B.centen },
  ]);
  if (prijzen.error) throw new Error(`Kon de klantprijzen niet zetten: ${prijzen.error.message}`);
});

test.afterAll(async () => {
  const db = admin();
  if (productId) await db.from("producten").delete().eq("id", productId);
  const { data } = await db.auth.admin.listUsers();
  for (const u of data?.users ?? [])
    if (u.email === A.email || u.email === B.email) await db.auth.admin.deleteUser(u.id);
});

async function inloggenAls(page: Page, wie: { email: string; password: string }) {
  await inloggen(page, { email: wie.email, wachtwoord: wie.password });
}

/** De tekst van een antwoord, met gewone spaties en zonder de lege commentaren van React. */
async function tekstVan(antwoord: { text(): Promise<string> }) {
  return (await antwoord.text()).replaceAll(" ", " ").replaceAll("<!-- -->", "");
}

/** Staat de prijs van deze klant erin: als bedrag (HTML) of in centen (`.data`)? */
function heeftPrijsVan(tekst: string, wie: { centen: number; prijs: string }) {
  return tekst.includes(wie.prijs) || tekst.includes(String(wie.centen));
}

async function inWagen(page: Page) {
  await page.goto(PAD);
  await page.getByRole("button", { name: "In winkelwagen" }).click();
  await expect(page.getByRole("status")).toContainText("Ligt in je winkelwagen");
}

async function sessieCookies(context: BrowserContext) {
  return (await context.cookies()).filter((c) => /^(?:__Host-)?sb-.*-auth-token/.test(c.name));
}

test("na het inloggen staat de sessie in een cookie (SameSite=Lax), niet in de opslag van de browser", async ({
  page,
  context,
}) => {
  await inloggenAls(page, A);
  const cookies = await sessieCookies(context);
  expect(cookies.length).toBeGreaterThan(0);
  for (const cookie of cookies) {
    expect(cookie.sameSite).toBe("Lax");
    expect(cookie.path).toBe("/");
  }
  const inOpslag = await page.evaluate(() =>
    [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((sleutel) =>
      /auth-token/.test(sleutel),
    ),
  );
  expect(inOpslag).toEqual([]);
});

test("de server leest met de sessie van de klant: de wagen komt kant-en-klaar, zonder JavaScript", async ({
  page,
}) => {
  await inloggenAls(page, A);
  await inWagen(page);
  // Zonder browser-scripts: het HTML-document van de server bevat de regel al, met de eigen prijs.
  const antwoord = await page.request.get("/wagen");
  expect(antwoord.status()).toBe(200);
  const html = await tekstVan(antwoord);
  expect(html).toContain(PRODUCT.naam);
  expect(html).toContain(`€ ${A.prijs} per stuk`);
  expect(antwoord.headers()["cache-control"]).toBe("private, no-store");
});

test.describe("aanval b: de pagina van een ingelogde klant als anonieme bezoeker", () => {
  test("zelfde adres, tegelijk en door elkaar: de anonieme bezoeker krijgt nooit iets van de ingelogde", async ({
    page,
    playwright,
    baseURL,
  }) => {
    await inloggenAls(page, A);
    const anoniem = await playwright.request.newContext({ baseURL });
    try {
      for (const pad of ["/", "/_.data", PAD, `${PAD}.data`]) {
        const rondes = await Promise.all(
          Array.from({ length: 25 }, async () => {
            const [met, zonder] = await Promise.all([page.request.get(pad), anoniem.get(pad)]);
            return {
              met,
              metTekst: await tekstVan(met),
              zonder,
              zonderTekst: await tekstVan(zonder),
            };
          }),
        );
        for (const { met, metTekst, zonder, zonderTekst } of rondes) {
          expect(heeftPrijsVan(metTekst, A), `${pad}: de klant ziet zijn prijs`).toBe(true);
          expect(met.headers()["cache-control"], pad).toBe("private, no-store");
          expect(heeftPrijsVan(zonderTekst, A), `${pad}: anoniem ziet de prijs van de klant`).toBe(
            false,
          );
          expect(zonderTekst, pad).not.toContain("Jouw prijs");
          expect(zonder.headers()["cache-control"], pad).toMatch(/^public, max-age=\d+$/);
          expect(zonder.headers()["set-cookie"], pad).toBeUndefined();
        }
      }
      // De wagen en zijn gegevens: zonder sessie alleen een omleiding, nooit de inhoud.
      await inWagen(page);
      for (const pad of ["/wagen", "/wagen.data"]) {
        const antwoord = await anoniem.get(pad, { maxRedirects: 0 });
        const tekst = await tekstVan(antwoord);
        expect(tekst, pad).not.toContain(PRODUCT.naam);
        expect(heeftPrijsVan(tekst, A), pad).toBe(false);
        expect(antwoord.headers()["cache-control"], pad).toBe("private, no-store");
      }
    } finally {
      await anoniem.dispose();
    }
  });

  test("na uitloggen ziet de server dezelfde browser weer als anonieme bezoeker", async ({
    page,
  }) => {
    await inloggenAls(page, A);
    expect(heeftPrijsVan(await tekstVan(await page.request.get(PAD)), A)).toBe(true);
    // Uitloggen staat op de inlogpagina, voor wie al is ingelogd; het is een formulier (POST).
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Je bent al ingelogd" })).toBeVisible();
    await page.getByRole("button", { name: "Uitloggen" }).click();
    await expect(page.getByRole("heading", { name: "Producten" })).toBeVisible();
    expect(await sessieCookies(page.context())).toEqual([]);
    for (const pad of ["/", PAD, `${PAD}.data`]) {
      expect(heeftPrijsVan(await tekstVan(await page.request.get(pad)), A), pad).toBe(false);
    }
    expect((await page.request.get("/wagen", { maxRedirects: 0 })).status()).toBe(302);
  });
});

test.describe("aanval g: op de server meer lezen dan de klant zelf mag", () => {
  test("de ene klant ziet op de server niets van de andere, en een anonieme bezoeker niets", async ({
    page,
    browser,
    playwright,
    baseURL,
  }) => {
    await inloggenAls(page, A);
    await inWagen(page);

    const anderContext = await browser.newContext();
    const anoniem = await playwright.request.newContext({ baseURL });
    try {
      const vanB = await anderContext.newPage();
      await inloggenAls(vanB, B);
      for (const pad of ["/", "/_.data", PAD, `${PAD}.data`]) {
        const tekst = await tekstVan(await vanB.request.get(pad));
        expect(heeftPrijsVan(tekst, B), `${pad}: B ziet zijn eigen prijs`).toBe(true);
        expect(heeftPrijsVan(tekst, A), `${pad}: B ziet de prijs van A`).toBe(false);
      }
      // De wagen van B is leeg: de regel van A staat er niet in.
      for (const pad of ["/wagen", "/wagen.data"]) {
        const tekst = await tekstVan(await vanB.request.get(pad));
        expect(tekst, pad).not.toContain(PRODUCT.naam);
        expect(heeftPrijsVan(tekst, A), pad).toBe(false);
      }
      // Anoniem: de gewone prijs, geen van beide klantprijzen.
      const openbaar = await tekstVan(await anoniem.get(PAD));
      expect(openbaar).toContain("€ 10,00");
      expect(heeftPrijsVan(openbaar, A)).toBe(false);
      expect(heeftPrijsVan(openbaar, B)).toBe(false);
      // A zelf ziet zijn regel wel.
      expect(await tekstVan(await page.request.get("/wagen"))).toContain(PRODUCT.naam);
    } finally {
      await anderContext.close();
      await anoniem.dispose();
    }
  });

  test("een nagemaakt sessiecookie (het id van een ander, zelf ondertekend) maakt je niemand", async ({
    page,
    context,
    playwright,
    baseURL,
  }) => {
    await inloggenAls(page, A);
    const echt = await sessieCookies(context);
    const naam = (echt[0]?.name ?? "").replace(/\.\d+$/, "");
    const sessie = await page.evaluate(async () => {
      // Het id van de klant, uit zijn eigen sessie: dat is geen geheim.
      const ruw = document.cookie
        .split("; ")
        .filter((c) => /^(?:__Host-)?sb-.*-auth-token/.test(c))
        .map((c) => c.split("=").slice(1).join("="))
        .join("");
      return JSON.parse(
        atob(
          decodeURIComponent(ruw)
            .replace(/^base64-/, "")
            .replace(/-/g, "+")
            .replace(/_/g, "/"),
        ),
      );
    });
    const b64 = (tekst: string) => Buffer.from(tekst).toString("base64url");
    const over = Math.floor(Date.now() / 1000) + 3600;
    const inhoud = {
      sub: sessie.user.id,
      email: A.email,
      role: "service_role",
      aud: "authenticated",
      exp: over,
    };
    const vals = {
      ...sessie,
      access_token: [
        b64('{"alg":"HS256","typ":"JWT"}'),
        b64(JSON.stringify(inhoud)),
        b64("zelf-ondertekend"),
      ].join("."),
      expires_at: over,
    };
    const aanvaller = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { Cookie: `${naam}=base64-${b64(JSON.stringify(vals))}` },
    });
    try {
      const wagen = await aanvaller.get("/wagen", { maxRedirects: 0 });
      expect(wagen.status()).toBe(302);
      expect(await tekstVan(wagen)).not.toContain(PRODUCT.naam);
      for (const pad of [PAD, `${PAD}.data`, "/"]) {
        const tekst = await tekstVan(await aanvaller.get(pad));
        expect(tekst, pad).not.toContain("Jouw prijs");
        expect(heeftPrijsVan(tekst, A), pad).toBe(false);
      }
    } finally {
      await aanvaller.dispose();
    }
  });
});
