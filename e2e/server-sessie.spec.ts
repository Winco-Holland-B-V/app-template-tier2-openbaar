import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { inloggen } from "./inloggen";
import { browsertestPaginas, databaseModus } from "./stack-config";

// Alleen met een eigen database valt er in te loggen en een tweede gebruiker te maken.
test.skip(databaseModus() !== "eigen", "deze app heeft geen eigen database");
// Eén reeks, in één browser-werker: de gebruikers hieronder zijn van deze file.
test.describe.configure({ mode: "serial" });

/**
 * De sessie op de server, met de echte keten: de gebouwde Worker in de Workers-omgeving, de
 * lokale Supabase en echte inlog (de code uit de mail, zie e2e/inloggen.ts). Twee aanvallen:
 *
 *   b. de pagina van een ingelogde gebruiker te zien krijgen als anonieme bezoeker;
 *   g. op de server de sessie van een ander gebruiken.
 *
 * De pagina die het verschil zichtbaar maakt, is van de template zelf: `/login` toont aan wie
 * ingelogd is "Je bent ingelogd als <adres>", met het adres dat de server uit de sessie haalt
 * en de database laat bevestigen. Twee gebruikers en een anonieme bezoeker vragen die pagina
 * tegelijk en door elkaar op: ieder hoort alleen zichzelf te zien. Noemt de app in
 * stack.config.json een openbare pagina en een pagina met inlog (`browsertest`, zie
 * e2e/stack-config.ts), dan doen die mee.
 *
 * Wat dit bewijst: de server leest de sessie uit het cookie van dit verzoek en van niets
 * anders, en de antwoorden van bezoekers lopen niet door elkaar, ook niet als ze tegelijk komen.
 * Dat de regels in de database bepalen wat een gebruiker op de server te zien krijgt, toetst
 * tests/unit/server-sessie.test.ts (met het token van de gebruiker, nooit meer) en in de template
 * e2e/voorbeeldshop-sessie.spec.ts (een prijs per klant).
 *
 * Deze test is van de template en komt met elke versie mee.
 */
const STEMPEL = Date.now();
const A = { email: `e2e-sessie-a-${STEMPEL}@voorbeeld.nl`, password: "e2e-sessie-a-wachtwoord-1" };
const B = { email: `e2e-sessie-b-${STEMPEL}@voorbeeld.nl`, password: "e2e-sessie-b-wachtwoord-2" };
const { openbarePagina, paginaMetInlog } = browsertestPaginas();

const gegevens = (pad: string) => (pad === "/" ? "/_.data" : `${pad.replace(/\/$/, "")}.data`);

function admin() {
  const url = process.env.SUPABASE_URL;
  const sleutel = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !sleutel)
    throw new Error("SUPABASE_URL of SUPABASE_SERVICE_ROLE_KEY ontbreekt (pnpm env:local).");
  // Alleen hier, in de test op de eigen computer of in CI: gebruikers aanmaken en opruimen.
  return createClient(url, sleutel, { auth: { autoRefreshToken: false, persistSession: false } });
}

test.beforeAll(async () => {
  const db = admin();
  for (const wie of [A, B]) {
    const { error } = await db.auth.admin.createUser({
      email: wie.email,
      password: wie.password,
      email_confirm: true,
    });
    if (error) throw new Error(`Kon ${wie.email} niet aanmaken: ${error.message}`);
  }
});

test.afterAll(async () => {
  const db = admin();
  const { data } = await db.auth.admin.listUsers();
  for (const u of data?.users ?? [])
    if (u.email === A.email || u.email === B.email) await db.auth.admin.deleteUser(u.id);
});

async function inloggenAls(page: Page, wie: { email: string; password: string }) {
  await inloggen(page, { email: wie.email, wachtwoord: wie.password });
}

async function sessieCookies(context: BrowserContext) {
  return (await context.cookies()).filter((c) => /^(?:__Host-)?sb-.*-auth-token/.test(c.name));
}

/** De adressen waar een ingelogde gebruiker iets van zichzelf ziet (of zou kunnen zien). */
const MET_SESSIE = [
  ...new Set([
    "/login",
    "/login.data",
    ...(openbarePagina ? [openbarePagina, gegevens(openbarePagina)] : []),
    ...(paginaMetInlog ? [paginaMetInlog, gegevens(paginaMetInlog)] : []),
  ]),
];

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

test("de server maakt de pagina met de sessie: zonder JavaScript staat het eigen adres erin", async ({
  page,
}) => {
  await inloggenAls(page, A);
  const antwoord = await page.request.get("/login");
  expect(antwoord.status()).toBe(200);
  expect(await antwoord.text()).toContain(A.email);
  expect(antwoord.headers()["cache-control"]).toBe("private, no-store");
});

test("aanval b en g: twee gebruikers en een anonieme bezoeker tegelijk en door elkaar, ieder ziet alleen zichzelf", async ({
  page,
  browser,
  playwright,
  baseURL,
}) => {
  await inloggenAls(page, A);
  const anderContext = await browser.newContext();
  const anoniem = await playwright.request.newContext({ baseURL });
  try {
    const vanB = await anderContext.newPage();
    await inloggenAls(vanB, B);
    for (const pad of MET_SESSIE) {
      const rondes = await Promise.all(
        Array.from({ length: 20 }, async () => {
          const [a, b, zonder] = await Promise.all([
            page.request.get(pad, { maxRedirects: 0 }),
            vanB.request.get(pad, { maxRedirects: 0 }),
            anoniem.get(pad, { maxRedirects: 0 }),
          ]);
          return {
            a,
            aTekst: await a.text(),
            bTekst: await b.text(),
            zonder,
            zTekst: await zonder.text(),
          };
        }),
      );
      for (const { a, aTekst, bTekst, zonder, zTekst } of rondes) {
        expect(aTekst, `${pad}: A ziet B`).not.toContain(B.email);
        expect(bTekst, `${pad}: B ziet A`).not.toContain(A.email);
        expect(zTekst, `${pad}: anoniem ziet A`).not.toContain(A.email);
        expect(zTekst, `${pad}: anoniem ziet B`).not.toContain(B.email);
        expect(a.headers()["cache-control"], pad).toBe("private, no-store");
        expect(zonder.headers()["set-cookie"], pad).toBeUndefined();
        if (pad.startsWith("/login")) {
          expect(aTekst, `${pad}: A ziet zichzelf`).toContain(A.email);
          expect(bTekst, `${pad}: B ziet zichzelf`).toContain(B.email);
        }
      }
    }
  } finally {
    await anderContext.close();
    await anoniem.dispose();
  }
});

test("na uitloggen ziet de server dezelfde browser weer als anonieme bezoeker", async ({
  page,
}) => {
  await inloggenAls(page, A);
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Je bent al ingelogd" })).toBeVisible();
  // Uitloggen staat op de inlogpagina, voor wie al is ingelogd; het is een formulier (POST).
  await page.getByRole("button", { name: "Uitloggen" }).click();
  await expect(page.getByRole("heading", { name: "Je bent al ingelogd" })).toBeHidden();
  expect(await sessieCookies(page.context())).toEqual([]);
  for (const pad of MET_SESSIE) {
    expect(await (await page.request.get(pad, { maxRedirects: 0 })).text(), pad).not.toContain(
      A.email,
    );
  }
  if (paginaMetInlog) {
    expect((await page.request.get(paginaMetInlog, { maxRedirects: 0 })).status()).toBe(302);
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
    // Het id van de gebruiker, uit zijn eigen sessie: dat is geen geheim.
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
    for (const pad of MET_SESSIE) {
      const antwoord = await aanvaller.get(pad, { maxRedirects: 0 });
      expect(await antwoord.text(), pad).not.toContain("Je bent ingelogd als");
    }
    if (paginaMetInlog) {
      expect((await aanvaller.get(paginaMetInlog, { maxRedirects: 0 })).status()).toBe(302);
    }
  } finally {
    await aanvaller.dispose();
  }
});
