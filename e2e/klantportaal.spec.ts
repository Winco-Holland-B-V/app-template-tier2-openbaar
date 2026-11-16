import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { wachtOpInlogmail } from "../tests/lib/mailvanger";
import { type NepInlogdienst, startNepInlogdienst } from "../tests/rls/lib/inlogdienst-nep";
import { inloggen, vraagCode, vulCodeIn } from "./inloggen";
import { noemIdentiteitCloudflare, speelInlogdienst, zetSessiesTerug } from "./medewerker";
import { databaseModus } from "./stack-config";

// Alleen met een eigen database valt er in te loggen.
test.skip(databaseModus() !== "eigen", "deze app heeft geen eigen database");
// Na elkaar: de tests bouwen op elkaar voort (aanmelden, goedkeuren, bestellen), en Supabase
// stuurt per adres niet vaker dan eens per seconde.
test.describe.configure({ mode: "serial" });
// Op het formaat van een telefoon: zo logt een klant meestal in.
test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

/**
 * Het klantportaal in een echte browser, met de hele keten: de gebouwde Worker, de lokale
 * Supabase, de mail in de lokale mailvanger. Een klant logt echt in met de code of de link uit
 * de mail, met en zonder JavaScript; een medewerker via een nagebootste inlogdienst (zie
 * e2e/medewerker.ts voor wat daar echt is en wat niet). Er is geen omweg: geen wachtwoord,
 * geen sessie die de test zelf klaarzet.
 *
 * De reis: een nieuwe klant logt in en wacht op goedkeuring, een medewerker keurt goed, de
 * klant bestelt. Daaromheen de aanvallen op het inloggen zelf: een link van een ander, een
 * scanner, tekst in het adres, een omleiding naar een vreemde site, een formulier van een
 * andere site, en medewerkerrechten zonder dat de database ze geeft.
 */
const mailUrl = process.env.SUPABASE_MAIL_URL;
const STEMPEL = Date.now();
const adres = (label: string) => `e2e-${label}-${STEMPEL}@voorbeeld.nl`;
const nieuweKlant = adres("klant");
const zonderJs = adres("zonderjs");
const klantMetLink = adres("link");
const tikfout = adres("tikfout");
const vreemde = adres("vreemde");
const metScanner = adres("scanner");
const medewerker = {
  sub: `dienst-e2e-${STEMPEL}`,
  email: adres("medewerker"),
  email_verified: true,
};
const alleAdressen = [
  nieuweKlant,
  zonderJs,
  klantMetLink,
  tikfout,
  vreemde,
  metScanner,
  medewerker.email,
];
const KOFFIE = "/producten/koffiebonen-huismelange";

function admin() {
  return createClient(
    process.env.SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", // guard-secrets:allow
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/** Supabase buiten de app om, zoals iemand met een eigen script. */
function buitenom() {
  return createClient(process.env.SUPABASE_URL ?? "", process.env.SUPABASE_ANON_KEY ?? "", {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function accountVan(email: string): Promise<string> {
  const { data } = await admin().auth.admin.listUsers({ page: 1, perPage: 1000 });
  const id = data?.users.find((user) => user.email === email)?.id;
  if (!id) throw new Error(`Geen account voor ${email}.`);
  return id;
}

async function isGoedgekeurd(email: string): Promise<boolean | null> {
  const { data } = await admin().from("klanten").select("goedgekeurd").eq("e_mail", email);
  return data?.[0]?.goedgekeurd ?? null;
}

async function sessieCookies(context: BrowserContext) {
  return (await context.cookies()).filter((c) =>
    /^(?:__Host-)?sb-.*-auth-token(?:\.\d+)?$/.test(c.name),
  );
}

let dienst: NepInlogdienst;

test.beforeAll(async () => {
  dienst = await startNepInlogdienst();
});

test.afterAll(async () => {
  await dienst?.stop();
  const db = admin();
  const { data } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  for (const user of data?.users ?? []) {
    if (alleAdressen.includes(user.email ?? "")) await db.auth.admin.deleteUser(user.id);
  }
});

test("een nieuwe klant logt in met de code uit de mail en ziet dat zijn account op goedkeuring wacht", async ({
  page,
  context,
}) => {
  await page.goto("/wagen");
  await expect(page.getByRole("heading", { name: "Inloggen" })).toBeVisible();
  await expect(page.getByTestId("merknaam")).toHaveText("Voorbeeldwinkel");
  await expect(page.getByRole("button", { name: "Inloggen voor medewerkers" })).toBeVisible();

  const leesMail = await wachtOpInlogmail({ email: nieuweKlant, mailUrl });
  await page.getByLabel("E-mailadres").fill(nieuweKlant);
  await page.getByRole("button", { name: "Doorgaan" }).click();

  await expect(page.getByRole("heading", { name: "Vul de code in" })).toBeVisible();
  await expect(page.getByText(nieuweKlant)).toBeVisible();
  const codevak = page.getByLabel("Code van tien cijfers");
  await expect(codevak).toBeFocused();
  await expect(codevak).toHaveAttribute("autocomplete", "one-time-code");
  await expect(codevak).toHaveAttribute("inputmode", "numeric");
  // Het adres staat niet in de adresbalk, en wat de pagina onthoudt kan geen script lezen.
  expect(page.url()).not.toContain("voorbeeld.nl");
  const onthouden = (await context.cookies()).find((c) => c.name === "inlog");
  expect(onthouden?.httpOnly).toBe(true);
  expect(onthouden?.sameSite).toBe("Lax");
  expect(await page.evaluate(() => document.cookie)).not.toContain("inlog=");

  const { code } = await leesMail();
  expect(code).toMatch(/^\d{10}$/);
  // Tien cijfers typen is genoeg: de pagina verstuurt de code dan zelf.
  await codevak.pressSequentially(code);

  // Door naar waar de klant heen wilde, met kort bovenin op welk adres hij binnen is.
  await expect(page.getByRole("heading", { name: "Winkelwagen" })).toBeVisible();
  await expect(page).toHaveURL(/\/wagen$/);
  await expect(page.getByTestId("ingelogd-als")).toContainText(nieuweKlant);
  // Een account alleen geeft niets: eerst keurt een medewerker goed.
  await expect(page.getByTestId("wacht")).toContainText("Je account wacht op goedkeuring");
  expect(await isGoedgekeurd(nieuweKlant)).toBe(false);

  // De sessie staat in het cookie van de serverlaag; de code staat nergens meer.
  expect((await sessieCookies(context)).length).toBeGreaterThan(0);
  expect(JSON.stringify(await context.cookies())).not.toContain(code);
  const opslag = await page.evaluate(() => [
    ...Object.keys(localStorage),
    ...Object.keys(sessionStorage),
  ]);
  expect(opslag.filter((sleutel) => /inlog|auth-token/.test(sleutel))).toEqual([]);

  // Na verversen nog steeds binnen (een echte sessie), en de regel bovenin is weg.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Winkelwagen" })).toBeVisible();
  await expect(page.getByTestId("ingelogd-als")).toBeHidden();

  // Ook op de productpagina: de gewone prijs, geen knop om te bestellen, wel de uitleg.
  await page.goto(KOFFIE);
  await expect(page.getByTestId("prijs")).toContainText("14,95");
  await expect(page.getByTestId("wacht")).toBeVisible();
  await expect(page.getByRole("button", { name: "In winkelwagen" })).toHaveCount(0);

  // Wie al binnen is en naar /login gaat, komt bij de knop voor medewerkers zonder eerst uit
  // te loggen.
  await page.goto("/login?volgende=%2Fbestellingen");
  await expect(page.getByRole("heading", { name: "Je bent al ingelogd" })).toBeVisible();
  await expect(page.getByText(nieuweKlant)).toBeVisible();
  await expect(page.getByRole("button", { name: "Inloggen voor medewerkers" })).toBeVisible();
  await page.getByRole("link", { name: "Verder naar de app" }).click();
  await expect(page.getByRole("heading", { name: "Bestellingen" })).toBeVisible();
});

test("zonder JavaScript: dezelfde weg met gewone formulieren, tot en met uitloggen", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await inloggen(page, { email: zonderJs, javascript: false });
    await expect(page.getByRole("heading", { name: "Producten" })).toBeVisible();
    await expect(page.getByTestId("ingelogd-als")).toContainText(zonderJs);
    await expect(page.getByTestId("wacht")).toBeVisible();
    expect((await sessieCookies(context)).length).toBeGreaterThan(0);

    // Een verkeerde code blijft op de code staan, met een nette melding; daarna uitloggen.
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Je bent al ingelogd" })).toBeVisible();
    await page.getByRole("button", { name: "Uitloggen" }).click();
    await expect(page.getByRole("heading", { name: "Producten" })).toBeVisible();
    expect(await sessieCookies(context)).toEqual([]);
    expect((await page.request.get("/wagen", { maxRedirects: 0 })).status()).toBe(302);

    await page.goto("/login");
    const code = await vraagCode(page, zonderJs);
    await vulCodeIn(page, code === "0000000000" ? "0000000001" : "0000000000", false);
    await expect(page.getByRole("alert")).toContainText("Deze code klopt niet");
    await expect(page.getByRole("heading", { name: "Vul de code in" })).toBeVisible();
    // "1234 5678", zoals een mailprogramma het plakt, werkt ook zonder JavaScript.
    await vulCodeIn(page, `${code.slice(0, 4)} ${code.slice(4)}`, false);
    await expect(page.getByRole("heading", { name: "Producten" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("een verkeerd adres is aan te passen, en een nieuwe code kan pas na een minuut", async ({
  page,
}) => {
  await page.goto("/login");
  await vraagCode(page, tikfout);
  await expect(page.getByRole("button", { name: /Nieuwe code kan over \d+ s/ })).toBeDisabled();
  await page.getByRole("button", { name: "Ander e-mailadres" }).click();
  await expect(page.getByLabel("E-mailadres")).toHaveValue(tikfout);
  await expect(page.getByRole("button", { name: "Inloggen voor medewerkers" })).toBeVisible();
  await expect(
    page.getByText("Werk je hier? Gebruik de knop Inloggen voor medewerkers."),
  ).toBeVisible();
});

test("de link uit de mail: een GET logt niet in, in een andere browser eerst de waarschuwing, en na gebruik werkt hij niet nog een keer", async ({
  page,
  browser,
  context,
  baseURL,
}) => {
  await page.goto("/login?volgende=%2Fbestellingen");
  const leesMail = await wachtOpInlogmail({ email: klantMetLink, mailUrl });
  await page.getByLabel("E-mailadres").fill(klantMetLink);
  await page.getByRole("button", { name: "Doorgaan" }).click();
  await expect(page.getByRole("heading", { name: "Vul de code in" })).toBeVisible();
  const { link } = await leesMail();
  // De link gaat naar de inlogpagina van de app zelf.
  expect(link.startsWith(`${baseURL}/login?token_hash=`)).toBe(true);

  // In een nieuw tabblad van dezelfde browser: de mail is hier aangevraagd, dus geen
  // waarschuwing. Openen alleen logt niet in, hoe vaak ook.
  const nieuwTabblad = await context.newPage();
  await nieuwTabblad.goto(link);
  await expect(nieuwTabblad.getByText("Je bent er bijna.")).toBeVisible();
  await expect(nieuwTabblad.getByTestId("link-waarschuwing")).toBeHidden();
  await nieuwTabblad.reload();
  expect(await sessieCookies(context)).toEqual([]);
  expect((await context.request.get("/wagen", { maxRedirects: 0 })).status()).toBe(302);
  await nieuwTabblad.close();

  // Een link uit WhatsApp of Gmail opent vaak in een andere browser: een verse context.
  const andere = await browser.newContext();
  const derde = await browser.newContext();
  try {
    const tab = await andere.newPage();
    await tab.goto(link);
    await expect(tab.getByRole("heading", { name: "Inloggen" })).toBeVisible();
    await expect(tab.getByTestId("link-waarschuwing")).toContainText(
      "Heb je deze mail zelf aangevraagd?",
    );
    await tab.getByRole("button", { name: "Inloggen" }).click();
    await expect(tab.getByRole("heading", { name: "Producten" })).toBeVisible();
    await expect(tab.getByTestId("ingelogd-als")).toContainText(klantMetLink);
    // De link staat na het inloggen niet meer in de adresbalk.
    expect(new URL(tab.url()).search).toBe("");
    expect(new URL(tab.url()).pathname).toBe("/");

    // Na gebruik werkt de link niet nog een keer, en hij staat daarna niet meer in het adres.
    const opnieuw = await derde.newPage();
    await opnieuw.goto(link);
    await opnieuw.getByRole("button", { name: "Inloggen" }).click();
    await expect(opnieuw.getByRole("alert")).toContainText("verlopen of al gebruikt");
    expect(opnieuw.url()).toBe(`${baseURL}/login`);
    expect(await sessieCookies(derde)).toEqual([]);
  } finally {
    await andere.close();
    await derde.close();
  }
});

test("een link uit de mail van een ander: de pagina waarschuwt eerst en zegt daarna in wiens account je zit", async ({
  page,
}) => {
  // Iemand vraagt buiten de app om een code aan op zijn eigen adres en stuurt de link uit zijn
  // eigen mail naar een klant. Die klant zou ongemerkt in het account van de ander inloggen.
  const leesMail = await wachtOpInlogmail({ email: vreemde, mailUrl });
  const { error } = await buitenom().auth.signInWithOtp({ email: vreemde });
  expect(error).toBeNull();
  const { link } = await leesMail();

  await page.goto(`${link}&volgende=${encodeURIComponent("https://nep-winkel.example/")}`);
  await expect(page.getByTestId("link-waarschuwing")).toContainText(
    "dan kom je in het account van die ander",
  );
  // Wie toch doorklikt, ziet meteen op welk adres hij binnen is, en blijft op de app.
  await page.getByRole("button", { name: "Inloggen" }).click();
  await expect(page.getByTestId("ingelogd-als")).toContainText(vreemde);
  expect(new URL(page.url()).hostname).toBe("127.0.0.1");
  expect(new URL(page.url()).pathname).toBe("/");
});

test("een scanner die de link opent, of een andere site die het formulier verstuurt, verbruikt de link niet", async ({
  page,
  browser,
  request,
}) => {
  const leesMail = await wachtOpInlogmail({ email: metScanner, mailUrl });
  await buitenom().auth.signInWithOtp({ email: metScanner });
  const { link } = await leesMail();
  // Een virusscanner of mailprogramma opent de link vooraf, met JavaScript aan, en ververst.
  const scanner = await browser.newContext();
  try {
    const tab = await scanner.newPage();
    await tab.goto(link);
    await expect(tab.getByRole("button", { name: "Inloggen" })).toBeVisible();
    await tab.reload();
    await expect(tab.getByRole("button", { name: "Inloggen" })).toBeVisible();
    expect(await sessieCookies(scanner)).toEqual([]);
  } finally {
    await scanner.close();
  }
  // Een scanner die ook formulieren verstuurt, of een andere site: de Worker weigert de POST.
  for (const headers of [{ Origin: "https://nep-winkel.example" }, { Origin: "null" }]) {
    const poging = await request.post(link, { headers, form: { doe: "link" }, maxRedirects: 0 });
    expect(poging.status()).toBe(403);
    expect(poging.headers()["set-cookie"]).toBeUndefined();
  }
  // Daarna de klant zelf: de link werkt nog.
  await page.goto(link);
  await page.getByRole("button", { name: "Inloggen" }).click();
  await expect(page.getByTestId("ingelogd-als")).toContainText(metScanner);
});

test("tekst uit het adres komt niet op het inlogscherm, en kiest ook geen melding", async ({
  page,
  baseURL,
}) => {
  const tekst = "Bel 0900-1234 en geef uw code door";
  const q = encodeURIComponent(`<img src=x onerror="document.title='gekaapt'"><b>${tekst}</b>`);
  for (const pad of ["/login", "/login/terug"]) {
    await page.goto(
      `${pad}?error=${q}&error_code=${q}&error_description=${q}&code=${q}#error_description=${q}`,
    );
    await expect(page.getByRole("heading", { name: "Inloggen" })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveText(
      "Inloggen is niet gelukt. Probeer het opnieuw.",
    );
    await expect(page.locator("body")).not.toContainText("0900");
    expect(await page.title()).not.toContain("gekaapt");
    // De fout staat daarna niet meer in het adres.
    expect(page.url().split("#")[0]).toBe(`${baseURL}/login`);
  }

  // De uitleg voor een nieuwe medewerker ("klik op de link in die mail") is er alleen voor wie
  // zelf net op de knop voor medewerkers klikte, niet voor wie een link kreeg.
  await page.goto(
    "/login/terug?error=access_denied&error_code=provider_email_needs_verification&error_description=Unverified+email+with+custom%3Acloudflare.+A+confirmation+email+has+been+sent",
  );
  await expect(page.getByRole("alert")).toHaveText("Inloggen is niet gelukt. Probeer het opnieuw.");
});

test("na het inloggen blijft de klant op de app, wat er ook in het adres stond", async ({
  page,
}) => {
  await page.goto(
    "/login?volgende=https%3A%2F%2Fander.example%2F&redirect_to=https://ander.example/&next=//ander.example/",
  );
  const code = await vraagCode(page, tikfout);
  await vulCodeIn(page, code);
  await expect(page.getByRole("heading", { name: "Producten" })).toBeVisible();
  expect(new URL(page.url()).hostname).toBe("127.0.0.1");
  expect(new URL(page.url()).pathname).toBe("/");
});

test("de inlogpagina, de terugkeer en hun omleidingen: nooit in een cache, nooit in Google, en geen formulier van een andere site", async ({
  request,
  baseURL,
}) => {
  for (const pad of [
    "/login",
    "/login.data",
    "/login?token_hash=pkce_0123456789abcdef0123&type=email",
    "/login/terug?code=11111111-2222-3333-4444-555555555555",
    "/login/terug",
    "/klanten",
  ]) {
    const antwoord = await request.get(pad, { maxRedirects: 0 });
    expect(antwoord.headers()["cache-control"], pad).toBe("private, no-store");
    expect(antwoord.headers()["x-robots-tag"], pad).toBe("noindex, nofollow");
  }
  const pagina = await request.get("/login");
  expect(await pagina.text()).toContain('<meta name="robots" content="noindex, nofollow"/>');
  // De terugkeer zonder eigen begin in deze browser wisselt niets om.
  const terug = await request.get("/login/terug?code=11111111-2222-3333-4444-555555555555", {
    maxRedirects: 0,
  });
  expect(terug.status()).toBe(302);
  expect(terug.headers().location).toBe("/login");

  // Iemand laten inloggen (of uitloggen) vanaf een andere site: de Worker weigert elk formulier.
  const formulieren: Record<string, string>[] = [
    { doe: "code", email: "aanvaller@voorbeeld.nl", code: "1234567890" },
    { doe: "vraag", email: "aanvaller@voorbeeld.nl" },
    { doe: "uitloggen" },
    { doe: "dienst", dienst: "cloudflare" },
  ];
  for (const form of formulieren) {
    const poging = await request.post("/login", {
      headers: { Origin: "https://nep-winkel.example" },
      form,
      maxRedirects: 0,
    });
    expect(poging.status(), form.doe).toBe(403);
  }
  // Een wachtwoord kent een klantportaal niet, ook niet voor wie het formulier zelf verstuurt.
  const wachtwoord = await request.post("/login", {
    headers: { Origin: baseURL ?? "" },
    form: { doe: "wachtwoord", email: "klant-a@voorbeeld.nl", password: "voorbeeldshop-klant-a" },
    maxRedirects: 0,
  });
  expect(wachtwoord.status()).toBe(400);
  expect(wachtwoord.headers()["set-cookie"] ?? "").not.toContain("auth-token=");
});

test.describe("de knop voor medewerkers en de Content-Security-Policy", () => {
  for (const javascript of [true, false]) {
    test(`${javascript ? "met" : "zonder"} JavaScript: de pagina gaat naar Supabase, en de geheime helft staat in een cookie dat geen script kan lezen`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ javaScriptEnabled: javascript });
      try {
        const page = await context.newPage();
        const fouten: string[] = [];
        page.on("console", (m) => {
          if (m.type() === "error") fouten.push(m.text());
        });
        let gevraagd = "";
        await page.route("**/auth/v1/authorize?**", (route) => {
          gevraagd = route.request().url();
          return route.fulfill({ status: 200, contentType: "text/plain", body: "de inlogdienst" });
        });
        await page.goto("/login?volgende=%2Fklanten");
        await page.getByRole("button", { name: "Inloggen voor medewerkers" }).click();
        await expect.poll(() => gevraagd).toContain("provider=custom%3Acloudflare");
        const doel = new URL(gevraagd);
        expect(doel.origin).toBe(new URL(process.env.SUPABASE_URL ?? "").origin);
        expect(doel.searchParams.get("redirect_to")).toMatch(/\/login\/terug$/);
        expect(doel.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{40,}$/);
        // Geen overtreding van de Content-Security-Policy (form-action 'self').
        expect(fouten.filter((f) => /Content Security Policy|form-action/i.test(f))).toEqual([]);
        const cookies = await context.cookies();
        const geheim = cookies.filter((c) => c.name.endsWith("-code-verifier"));
        expect(geheim.length).toBeGreaterThan(0);
        for (const cookie of geheim) {
          expect(cookie.httpOnly, cookie.name).toBe(true);
          expect(cookie.expires - Date.now() / 1000).toBeLessThan(16 * 60);
          expect(gevraagd).not.toContain(cookie.value);
        }
      } finally {
        await context.close();
      }
    });
  }
});

test.describe("medewerker: goedkeuren, en alleen met rechten die de database geeft", () => {
  let vanMedewerker: BrowserContext;
  let scherm: Page;

  test.beforeAll(async ({ browser }) => {
    vanMedewerker = await browser.newContext();
    scherm = await vanMedewerker.newPage();
    await speelInlogdienst(scherm, medewerker);
  });

  test.afterAll(async () => {
    await vanMedewerker?.close();
  });

  test("de medewerker logt in via de inlogdienst en komt terug waar hij heen wilde; de server maakt hem daarmee nog geen medewerker", async () => {
    await scherm.goto("/klanten");
    await expect(scherm.getByRole("heading", { name: "Inloggen" })).toBeVisible();
    await scherm.getByRole("button", { name: "Inloggen voor medewerkers" }).click();

    // Terug van de dienst: ingelogd, op de pagina waar hij heen wilde, zonder code in het adres.
    await expect(scherm.getByRole("heading", { name: "Klanten" })).toBeVisible();
    expect(new URL(scherm.url()).pathname).toBe("/klanten");
    expect(new URL(scherm.url()).search).toBe("");
    await expect(scherm.getByTestId("ingelogd-als")).toContainText(medewerker.email);
    expect((await sessieCookies(vanMedewerker)).length).toBeGreaterThan(0);
    // De geheime helft is verbruikt en weg.
    const cookies = await vanMedewerker.cookies();
    expect(cookies.filter((c) => c.name.endsWith("-code-verifier") && c.value !== "")).toEqual([]);

    // De sessie begon via een inlogdienst, maar het account hangt (nog) niet aan Cloudflare:
    // de database zegt nee. De server gelooft het token dus niet op zijn woord en toont niets.
    await expect(scherm.getByText("Log opnieuw in als medewerker")).toBeVisible();
    await expect(scherm.getByTestId("klant")).toHaveCount(0);
  });

  test("met de koppeling aan Cloudflare ziet hij de aangemelde klanten en keurt hij er één goed", async () => {
    noemIdentiteitCloudflare(medewerker.email);
    await scherm.goto("/klanten");
    const rij = scherm.getByTestId("klant").filter({ hasText: nieuweKlant });
    await expect(rij).toBeVisible();
    await expect(scherm.getByTestId("klant").filter({ hasText: zonderJs })).toBeVisible();
    expect(await isGoedgekeurd(nieuweKlant)).toBe(false);
    await rij.getByRole("button", { name: "Goedkeuren" }).click();
    await expect(rij).toContainText("Goedgekeurd");
    expect(await isGoedgekeurd(nieuweKlant)).toBe(true);
    // Niet in Google, niet in een cache.
    const pagina = await scherm.request.get("/klanten");
    expect(pagina.headers()["cache-control"]).toBe("private, no-store");
    expect(await pagina.text()).toContain('<meta name="robots" content="noindex, nofollow"/>');
  });

  test("200 nep-aanmeldingen verdringen een echte klant niet: zoeken, bladeren, afwijzen en intrekken", async () => {
    test.setTimeout(240_000);
    const db = admin();
    const gemaakt: string[] = [];
    const maak = async (email: string) => {
      const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true });
      if (error || !data.user) throw new Error(error?.message ?? "geen account");
      gemaakt.push(data.user.id);
      const rij = await db.from("klanten").insert({ user_id: data.user.id, e_mail: email });
      if (rij.error) throw new Error(rij.error.message);
    };
    const echt = adres("echte-klant");
    try {
      // De echte klant meldt zich eerst aan; daarna komen er 200 van een aanvaller.
      await maak(echt);
      for (let blok = 0; blok < 10; blok++) {
        await Promise.all(Array.from({ length: 20 }, (_, i) => maak(adres(`nep-${blok}-${i}`))));
      }

      await scherm.goto("/klanten?stand=wacht");
      await expect(scherm.getByTestId("klant")).toHaveCount(50);
      await expect(scherm.getByTestId("klant").filter({ hasText: echt })).toHaveCount(0);
      await expect(scherm.getByRole("link", { name: "Volgende pagina" })).toBeVisible();

      // Zoeken op het adres: de echte klant staat er, en alleen hij.
      await scherm.getByLabel("E-mailadres").fill(echt);
      await scherm.getByRole("button", { name: "Zoeken" }).click();
      const rij = scherm.getByTestId("klant").filter({ hasText: echt });
      await expect(rij).toBeVisible();
      await expect(scherm.getByTestId("klant")).toHaveCount(1);
      await rij.getByRole("button", { name: "Goedkeuren" }).click();
      await expect(scherm.getByTestId("klant")).toHaveCount(0);
      expect(await isGoedgekeurd(echt)).toBe(true);

      // Intrekken: de goedkeuring gaat eraf.
      await scherm.goto(`/klanten?q=${encodeURIComponent(echt)}&stand=goedgekeurd`);
      await scherm.getByTestId("klant").getByRole("button", { name: "Intrekken" }).click();
      await expect(scherm.getByTestId("klant")).toHaveCount(0);
      expect(await isGoedgekeurd(echt)).toBe(false);

      // Afwijzen: de aanmelding staat bij de afgewezen, niet meer bij wie wacht.
      const nep = adres("nep-0-0");
      await scherm.goto(`/klanten?q=${encodeURIComponent(nep)}&stand=wacht`);
      await scherm.getByTestId("klant").getByRole("button", { name: "Afwijzen" }).click();
      await expect(scherm.getByTestId("klant")).toHaveCount(0);
      await scherm.goto(`/klanten?q=${encodeURIComponent(nep)}&stand=afgewezen`);
      await expect(scherm.getByTestId("klant").filter({ hasText: nep })).toContainText("Afgewezen");
      expect(await isGoedgekeurd(nep)).toBe(false);
    } finally {
      for (const id of gemaakt) await db.auth.admin.deleteUser(id);
    }
  });

  test("de goedgekeurde klant ziet nu zijn winkelwagen en bestelt", async ({ page }) => {
    await inloggen(page, { email: nieuweKlant });
    await page.goto(KOFFIE);
    await expect(page.getByTestId("wacht")).toHaveCount(0);
    await page.getByRole("button", { name: "In winkelwagen" }).click();
    await expect(page.getByRole("status")).toContainText("Ligt in je winkelwagen");
    await page.goto("/wagen");
    await page.getByRole("button", { name: "Bestellen" }).click();
    await expect(page.getByText("Bedankt, je bestelling is geplaatst.")).toBeVisible();
    await expect(page.getByTestId("bestelling").first()).toContainText("Koffiebonen huismelange");
    // Een klant komt niet op de pagina voor medewerkers, ook niet na goedkeuring.
    await page.goto("/klanten");
    await expect(page.getByText("Deze pagina is alleen voor medewerkers.")).toBeVisible();
    await expect(page.getByTestId("klant")).toHaveCount(0);
  });

  test("wie per mail inlogt op het adres van de medewerker, is geen medewerker: geen lijst, en goedkeuren doet niets", async ({
    browser,
    baseURL,
  }) => {
    const perMail = await browser.newContext();
    try {
      const page = await perMail.newPage();
      await inloggen(page, { email: medewerker.email });
      await expect(page.getByTestId("ingelogd-als")).toContainText(medewerker.email);
      await page.goto("/klanten");
      await expect(page.getByText("Deze pagina is alleen voor medewerkers.")).toBeVisible();
      await expect(page.getByTestId("klant")).toHaveCount(0);
      expect(await (await perMail.request.get("/klanten")).text()).not.toContain(zonderJs);
      // Het formulier zelf versturen, zoals de pagina van een medewerker dat doet.
      const poging = await perMail.request.post("/klanten", {
        headers: { Origin: baseURL ?? "" },
        form: { doe: "goedkeuren", user_id: await accountVan(zonderJs) },
        maxRedirects: 0,
      });
      expect(poging.status()).toBe(403);
      expect(await isGoedgekeurd(zonderJs)).toBe(false);
    } finally {
      await perMail.close();
    }
  });

  test("na twaalf uur: 'Log opnieuw in als medewerker' in plaats van een leeg scherm, en goedkeuren doet niets meer", async ({
    baseURL,
  }) => {
    zetSessiesTerug(medewerker.email, 13);
    await scherm.goto("/klanten");
    await expect(scherm.getByRole("alert")).toContainText("Log opnieuw in als medewerker");
    await expect(scherm.getByRole("button", { name: "Inloggen voor medewerkers" })).toBeVisible();
    await expect(scherm.getByTestId("klant")).toHaveCount(0);
    const poging = await vanMedewerker.request.post("/klanten", {
      headers: { Origin: baseURL ?? "" },
      form: { doe: "goedkeuren", user_id: await accountVan(zonderJs) },
      maxRedirects: 0,
    });
    expect(poging.status()).toBe(403);
    expect(await isGoedgekeurd(zonderJs)).toBe(false);
    // Hij is nog wel ingelogd, als klant: de inlogpagina biedt de knop voor medewerkers aan.
    await scherm.goto("/login");
    await expect(scherm.getByRole("heading", { name: "Je bent al ingelogd" })).toBeVisible();
    await expect(scherm.getByRole("button", { name: "Inloggen voor medewerkers" })).toBeVisible();
  });

  test("uitloggen is een formulier en haalt de sessie weg", async () => {
    await scherm.goto("/login");
    await scherm.getByRole("button", { name: "Uitloggen" }).click();
    await expect(scherm.getByRole("heading", { name: "Producten" })).toBeVisible();
    expect(await sessieCookies(vanMedewerker)).toEqual([]);
    expect((await vanMedewerker.request.get("/klanten", { maxRedirects: 0 })).status()).toBe(302);
  });
});
