import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { admin } from "./lib/afscherming";
import {
  bezoeker,
  inloggenMetCode,
  inloggenMetMailcode,
  nieuwAdres,
  pauze,
  verwijderAccount,
  vraagCodeAan,
  wachtOpElkeMail,
  wachtOpMail,
} from "./lib/sessies";

/**
 * De inlogmail van een klantportaal, tegen de lokale Supabase Auth: waar de link heen wijst,
 * hoe vaak de code en de link werken, en wat het antwoord op een aanvraag verraadt. Dit gaat
 * over wat Supabase doet met supabase/config.toml en supabase/templates/inlogcode.html; de
 * pagina zelf testen src/features/auth en e2e/klantportaal.spec.ts.
 */
const url = String(import.meta.env.SUPABASE_URL);
const anonKey = String(import.meta.env.SUPABASE_ANON_KEY);
const serviceRoleKey = String(import.meta.env.SUPABASE_SERVICE_ROLE_KEY);
/** Waar de link in de mail altijd heen gaat: het adres van de app zelf (`site_url`). */
const siteUrl =
  /^site_url = "([^"]+)"$/m.exec(readFileSync("supabase/config.toml", "utf8"))?.[1] ?? "";
const adressen = new Set<string>();

function adres(label: string): string {
  const nieuw = nieuwAdres(label);
  adressen.add(nieuw);
  return nieuw;
}

function tokenHashUit(link: string): string {
  return new URL(link).searchParams.get("token_hash") ?? "";
}

afterAll(async () => {
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  for (const user of data?.users ?? []) {
    if (adressen.has(user.email ?? "")) await verwijderAccount(user.id);
  }
});

describe("de link in de inlogmail", () => {
  it("wijst altijd naar de inlogpagina van de app, wat de aanvrager ook opgeeft", async () => {
    expect(siteUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // Iedereen kan voor elk adres een code aanvragen en daarbij zelf een adres opgeven waar
    // de link heen moet. Ook een adres dat Supabase toestaat (een andere poort op deze
    // computer, in productie een preview) komt niet in de mail.
    const pogingen = [
      "http://127.0.0.1:6666/van-een-ander",
      "http://127.0.0.1:5173/login",
      "https://ander.example/login",
      undefined,
    ];
    for (const emailRedirectTo of pogingen) {
      const klant = adres("link-doel");
      const leesMail = await wachtOpMail(klant);
      const aanvraag = await vraagCodeAan(klant, emailRedirectTo ? { emailRedirectTo } : {});
      expect(aanvraag.error).toBeNull();
      const { link } = await leesMail();
      expect(link.startsWith(`${siteUrl}/login?token_hash=`), String(emailRedirectTo)).toBe(true);
      expect(new URL(link).searchParams.get("type")).toBe("email");
    }
  });

  it("gaat niet naar Supabase zelf: wie de link alleen opvraagt (een scanner), verbruikt hem niet", async () => {
    const klant = adres("scanner");
    const leesMail = await wachtOpMail(klant);
    await vraagCodeAan(klant);
    const { link } = await leesMail();
    expect(new URL(link).origin).not.toBe(new URL(url).origin);
    expect(new URL(link).pathname).toBe("/login");
    // De pagina van de app verzilvert pas na een klik (inlog-met-code.tsx). Tot die tijd werkt
    // de link nog.
    const inlog = await bezoeker().auth.verifyOtp({
      token_hash: tokenHashUit(link),
      type: "email",
    });
    expect(inlog.error).toBeNull();
    expect(inlog.data.session?.user.email).toBe(klant);
  });

  it("na gebruik werkt de link niet nog een keer, en de code uit dezelfde mail ook niet", async () => {
    const klant = adres("na-gebruik");
    const leesMail = await wachtOpMail(klant);
    await vraagCodeAan(klant);
    const { link, code } = await leesMail();
    const eerste = await bezoeker().auth.verifyOtp({
      token_hash: tokenHashUit(link),
      type: "email",
    });
    expect(eerste.error).toBeNull();
    const nogEens = await bezoeker().auth.verifyOtp({
      token_hash: tokenHashUit(link),
      type: "email",
    });
    expect(nogEens.data.session).toBeNull();
    const metCode = await bezoeker().auth.verifyOtp({ email: klant, token: code, type: "email" });
    expect(metCode.data.session).toBeNull();
  });

  it("geeft een gewone mailsessie: niets in de link maakt iemand medewerker of goedgekeurde klant", async () => {
    const klant = adres("alleen-mail");
    const leesMail = await wachtOpMail(klant);
    await vraagCodeAan(klant);
    const { link } = await leesMail();
    const client = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const inlog = await client.auth.verifyOtp({ token_hash: tokenHashUit(link), type: "email" });
    expect(inlog.error).toBeNull();
    expect((await client.rpc("is_medewerker")).data).toBe(false);
    expect((await client.rpc("is_goedgekeurde_klant")).data).toBe(false);
  });
});

describe("wat een aanvraag verraadt", () => {
  it("een aanvraag zoals de inlogpagina die doet, krijgt bij een bekend en een onbekend adres hetzelfde antwoord", async () => {
    const bekend = adres("bekend");
    await inloggenMetMailcode(bekend);
    await pauze(1200);
    const vraag = async (email: string) => {
      const antwoord = await fetch(`${url}/auth/v1/otp`, {
        method: "POST",
        headers: { apikey: anonKey, "content-type": "application/json" },
        body: JSON.stringify({ email, create_user: true }),
      });
      return `${antwoord.status} ${await antwoord.text()}`;
    };
    expect(await vraag(bekend)).toBe(await vraag(adres("onbekend")));
  });
});

/**
 * De stand vooraf (accounts bestaan vooraf; src/features/auth/inlogdienst.ts): de inlogpagina
 * vraagt een code aan met "maak geen account" (`shouldCreateUser: false`), en de Edge Function
 * klant-uitnodigen laat Supabase Auth met de service role een inlogmail sturen naar een bestaand
 * klantaccount (supabase/functions/klant-uitnodigen/kern.ts). Lokaal staat de controle tegen robots
 * uit; of Supabase die bij de service role overslaat, zegt deze test dus niet.
 */
describe("de stand vooraf", () => {
  const bestaatAccount = async (email: string) => {
    const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    return (data?.users ?? []).some((user) => user.email === email);
  };

  it("een code aanvragen voor een adres zonder account: geen account en geen mail", async () => {
    const onbekend = adres("vooraf-onbekend");
    const leesMail = await wachtOpElkeMail(onbekend);
    await vraagCodeAan(onbekend, { shouldCreateUser: false });
    expect(await leesMail(3000)).toBeNull();
    expect(await bestaatAccount(onbekend)).toBe(false);
  });

  it("een bestaand account krijgt met `shouldCreateUser: false` gewoon een code die werkt", async () => {
    const klant = adres("vooraf-bekend");
    await inloggenMetMailcode(klant);
    await pauze(1200);
    const leesMail = await wachtOpMail(klant);
    const aanvraag = await vraagCodeAan(klant, { shouldCreateUser: false });
    expect(aanvraag.error).toBeNull();
    const { code } = await leesMail();
    const sessie = await inloggenMetCode(klant, code);
    expect((await sessie.client.auth.getUser()).data.user?.email).toBe(klant);
  });

  it("de service role vraagt voor een bestaand account een inlogmail aan, zoals klant-uitnodigen doet; nooit een nieuw account", async () => {
    const klant = adres("vooraf-van-medewerker");
    await inloggenMetMailcode(klant);
    await pauze(1200);
    const vraag = (email: string) =>
      fetch(`${url}/auth/v1/otp`, {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ email, create_user: false }),
      });
    const leesMail = await wachtOpMail(klant);
    const antwoord = await vraag(klant);
    expect(antwoord.status).toBe(200);
    // Het antwoord bevat geen link of code: die staan alleen in de mail.
    const tekst = await antwoord.text();
    const { code, link } = await leesMail();
    expect(tekst).not.toContain(code);
    expect(tekst).not.toContain(tokenHashUit(link));
    expect(new URL(link).pathname).toBe("/login");
    const inlog = await bezoeker().auth.verifyOtp({
      token_hash: tokenHashUit(link),
      type: "email",
    });
    expect(inlog.data.session?.user.email).toBe(klant);

    const onbekend = adres("vooraf-van-medewerker-onbekend");
    expect((await vraag(onbekend)).ok).toBe(false);
    expect(await bestaatAccount(onbekend)).toBe(false);
  });

  it("de link uit een uitnodiging werkt op de inlogpagina met type=invite", async () => {
    const nieuw = adres("vooraf-uitnodiging");
    const { data, error } = await admin.auth.admin.generateLink({ type: "invite", email: nieuw });
    expect(error).toBeNull();
    const tokenHash = data.properties?.hashed_token ?? "";
    expect(tokenHash).not.toBe("");
    const inlog = await bezoeker().auth.verifyOtp({ token_hash: tokenHash, type: "invite" });
    expect(inlog.error).toBeNull();
    expect(inlog.data.session?.user.email).toBe(nieuw);
  });
});
