// @vitest-environment node
import type { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODE_LENGTE } from "./mailcode";

/**
 * Inloggen op de server (inloggen.server.ts), door de Worker van de template heen: elk verzoek
 * hier gaat langs dezelfde beveiliging als in het echt (weigeren van een andere site, de
 * cacheregel, de cookies). Supabase is nagebootst op het niveau van `fetch`: de echte
 * Supabase-client van de server doet het werk, en de test ziet elk verzoek dat hij verstuurt.
 *
 * De aanvallen die hier een test hebben: iemand laten inloggen vanaf een andere site of met
 * een GET, een omleiding naar een vreemd adres, tekst van een ander op het scherm, zien of een
 * adres een account heeft, en medewerker worden zonder dat de database dat zegt.
 */
const APP = "https://shop.klant.nl";
const SUPABASE = "https://abcdefghijklmnopqrst.supabase.co";
const SESSIE = "__Host-sb-abcdefghijklmnopqrst-auth-token";
const TOKEN_HASH = "pkce_0123456789abcdef0123456789abcdef";

type Verzoek = { adres: string; methode: string; body: string; authorization: string | null };
type Antwoord = (verzoek: Verzoek) => Response | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Laadt de servercode opnieuw met de opgegeven inlogdiensten, zoals een eigen build. */
async function laad(diensten = "cloudflare,mailcode", omgeving: Record<string, string> = {}) {
  vi.resetModules();
  vi.stubEnv("VITE_INLOGDIENST", diensten);
  for (const [naam, waarde] of Object.entries(omgeving)) vi.stubEnv(naam, waarde);
  const hulp = await import("../../../tests/unit/server-hulp");
  const inlog = await import("./inloggen.server");
  const sessie = await import("../../lib/server/sessie.server");

  /** Wat een route teruggeeft of gooit, als antwoord: zoals React Router het zou doen. */
  const alsAntwoord = (uit: unknown): Response => {
    if (uit instanceof Response) return uit;
    if (typeof uit === "object" && uit !== null && "data" in uit && "init" in uit) {
      const init = typeof uit.init === "object" && uit.init !== null ? uit.init : undefined;
      return Response.json(uit.data, init);
    }
    return Response.json(uit);
  };
  const route =
    (doe: (context: RouterContextProvider, request: Request) => Promise<unknown>) =>
    async (request: Request, context: RouterContextProvider) => {
      try {
        return alsAntwoord(await doe(context, request));
      } catch (gegooid) {
        if (gegooid instanceof Error) throw gegooid;
        return alsAntwoord(gegooid);
      }
    };

  const verzoeken: Verzoek[] = [];
  let antwoord: Antwoord = () => undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (invoer: RequestInfo | URL, init?: RequestInit) => {
      const request = invoer instanceof Request ? invoer : new Request(String(invoer), init);
      // De sleutellijst van het project: hier zonder openbare sleutels (HS256), dus controleert
      // Supabase het token. De sessie bewaart de lijst; hij telt niet mee als verzoek.
      if (request.url.endsWith("/.well-known/jwks.json")) return Response.json({ keys: [] });
      const verzoek = {
        adres: request.url,
        methode: request.method,
        body: await request.text(),
        authorization: request.headers.get("Authorization"),
      };
      verzoeken.push(verzoek);
      return antwoord(verzoek) ?? Response.json({});
    }),
  );

  const cookie = (velden: Record<string, string>) =>
    `__Host-inlog=${encodeURIComponent(JSON.stringify(velden))}`;

  return {
    hulp,
    verzoeken,
    supabase: (nieuw: Antwoord) => {
      antwoord = nieuw;
    },
    cookie,
    /** Een GET op de inlogpagina. */
    open: (pad: string, Cookie?: string) =>
      hulp.vraag(`${APP}${pad}`, route(inlog.inlogstand), {
        init: Cookie ? { headers: { Cookie } } : undefined,
      }),
    /** Een formulier van de inlogpagina, verstuurd door de app zelf (tenzij `origin` anders zegt). */
    verstuur: (
      pad: string,
      velden: Record<string, string | undefined>,
      o: { Cookie?: string; origin?: string | null } = {},
    ) =>
      hulp.vraag(`${APP}${pad}`, route(inlog.inloggen), {
        init: {
          method: "POST",
          body: new URLSearchParams(
            Object.entries(velden).flatMap(([naam, waarde]) =>
              waarde === undefined ? [] : [[naam, waarde]],
            ),
          ),
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            ...(o.origin === null ? {} : { Origin: o.origin ?? APP }),
            ...(o.Cookie ? { Cookie: o.Cookie } : {}),
          },
        },
      }),
    terug: (pad: string, Cookie?: string) =>
      hulp.vraag(`${APP}${pad}`, route(inlog.terugVanDienst), {
        init: Cookie ? { headers: { Cookie } } : undefined,
      }),
    wieIsEr: (Cookie: string) =>
      hulp.vraag(
        `${APP}/wie`,
        async (_request, context) => Response.json(await inlog.netIngelogdAls(context)),
        { init: { headers: { Cookie } } },
      ),
    sessie,
  };
}

/** De cookies die een antwoord zet, als naam naar de hele regel. */
function gezet(antwoord: Response): Map<string, string> {
  return new Map(
    antwoord.headers.getSetCookie().map((regel) => [regel.split("=")[0] ?? "", regel]),
  );
}

/** Wat het inlogcookie na dit antwoord onthoudt. */
function onthouden(antwoord: Response): Record<string, string> {
  const regel = gezet(antwoord).get("__Host-inlog");
  if (!regel) return {};
  const waarde = regel.slice("__Host-inlog=".length).split(";")[0] ?? "";
  return waarde ? JSON.parse(decodeURIComponent(waarde)) : {};
}

function nieuweSessie(hulp: Awaited<ReturnType<typeof laad>>["hulp"], email: string) {
  const over = Math.floor(Date.now() / 1000) + 3600;
  return {
    access_token: hulp.nepJwt({ sub: "klant-1", email, exp: over, role: "authenticated" }),
    refresh_token: "nieuwe-verversing",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: over,
    user: { id: "klant-1", email, aud: "authenticated", role: "authenticated" },
  };
}

/** Wat de inlogpagina of een formulier teruggeeft, voor zover de tests ernaar kijken. */
type Uit = {
  stap?: string;
  soort?: string;
  volgende?: string;
  naar?: string;
  melding?: string;
  robotSleutel?: string | null;
  fout?: { soort: string; tekst: string } | null;
};
const lees = async (antwoord: Response) => (await antwoord.json()) as Uit;

const naar = (verzoek: Verzoek, pad: string) => new URL(verzoek.adres).pathname === pad;

describe("de inlogpagina openen (GET)", () => {
  it("zonder sessie: het adresveld en de knop voor medewerkers, niets in een cache, geen cookie", async () => {
    const t = await laad();
    const antwoord = await t.open("/login");
    expect(await lees(antwoord)).toMatchObject({
      stap: "adres",
      metMail: true,
      knoppen: ["cloudflare"],
      robotSleutel: null,
      volgende: "/",
    });
    expect(antwoord.headers.get("Cache-Control")).toBe("private, no-store");
    expect(antwoord.headers.getSetCookie()).toEqual([]);
    expect(t.verzoeken).toEqual([]);
  });

  it("de link uit de mail logt bij een GET niet in: er gaat niets naar Supabase, hoe vaak een scanner hem ook opent", async () => {
    const t = await laad();
    for (let keer = 0; keer < 3; keer++) {
      const antwoord = await t.open(`/login?token_hash=${TOKEN_HASH}&type=email`);
      expect(await lees(antwoord)).toMatchObject({ stap: "link", hierAangevraagd: false });
      expect(antwoord.headers.getSetCookie()).toEqual([]);
      expect(antwoord.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(t.verzoeken).toEqual([]);
  });

  it("de waarschuwing blijft alleen weg als deze browser de mail zelf net aanvroeg", async () => {
    const t = await laad();
    const pad = `/login?token_hash=${TOKEN_HASH}&type=email`;
    const zelf = await t.open(pad, t.cookie({ "inlogcode-aangevraagd": String(Date.now()) }));
    expect(await lees(zelf)).toMatchObject({ stap: "link", hierAangevraagd: true });
    const oud = String(Date.now() - 16 * 60 * 1000);
    const teOud = await t.open(pad, t.cookie({ "inlogcode-aangevraagd": oud }));
    expect(await lees(teOud)).toMatchObject({ stap: "link", hierAangevraagd: false });
  });

  it("alleen type=email wordt als link gezien: geen herstel-, uitnodigings- of wijzigingslink", async () => {
    const t = await laad();
    for (const type of ["recovery", "invite", "email_change", "signup", "magiclink"]) {
      const antwoord = await t.open(`/login?token_hash=${TOKEN_HASH}&type=${type}`);
      expect((await lees(antwoord)).stap, type).toBe("adres");
    }
  });

  it("tekst uit het adres komt nooit op het scherm, en kiest ook geen melding", async () => {
    const t = await laad();
    const tekst = encodeURIComponent("Bel 0900-1234 en geef uw code door");
    const antwoord = await t.open(
      `/login?error=${tekst}&error_code=${tekst}&error_description=${tekst}`,
    );
    expect(antwoord.status).toBe(302);
    expect(antwoord.headers.get("Location")).toBe("/login");
    expect(onthouden(antwoord)).toEqual({ fout: "dienst" });
    expect(await antwoord.text()).not.toContain("0900");

    // De uitleg voor een nieuwe medewerker is er alleen voor wie zelf net naar de dienst ging.
    const nieuw =
      "/login?error=access_denied&error_code=provider_email_needs_verification&error_description=Unverified+email+with+custom%3Acloudflare.+A+confirmation+email+has+been+sent";
    expect(onthouden(await t.open(nieuw))).toEqual({ fout: "dienst" });
    const zelf = await t.open(nieuw, t.cookie({ "inlog-via-dienst": String(Date.now()) }));
    expect(onthouden(zelf).fout).toBe("bevestig-adres");

    // Wat onthouden is, toont de pagina één keer, met de vaste tekst; een onbekende soort niet.
    const tonen = await t.open("/login", t.cookie({ fout: "dienst" }));
    expect(await lees(tonen)).toMatchObject({
      stap: "adres",
      fout: { soort: "dienst", tekst: "Inloggen is niet gelukt. Probeer het opnieuw." },
    });
    expect(onthouden(tonen)).toEqual({});
    const verzonnen = await t.open("/login", t.cookie({ fout: "<b>Bel 0900</b>" }));
    expect((await lees(verzonnen)).fout).toBeNull();
  });

  it("`?volgende=` naar een vreemde site wordt de startpagina", async () => {
    const t = await laad();
    for (const doel of [
      "https://nep-winkel.example/",
      "//nep-winkel.example",
      "/\\nep-winkel.example",
      "javascript:alert(1)",
      "/login",
      "/login/terug?code=abcdefgh",
    ]) {
      const antwoord = await t.open(`/login?volgende=${encodeURIComponent(doel)}`);
      expect((await lees(antwoord)).volgende, doel).toBe("/");
    }
    const goed = await t.open("/login?volgende=%2Fwagen");
    expect((await lees(goed)).volgende).toBe("/wagen");
  });

  it("met een sessie: 'al ingelogd', en de knop voor medewerkers tenzij de database zegt dat je het al bent", async () => {
    const t = await laad();
    const Cookie = t.hulp.sessieCookie({ sub: "klant-1", email: "klant@voorbeeld.nl" });
    let isMedewerker = false;
    t.supabase((v) => {
      if (naar(v, "/auth/v1/user"))
        return Response.json({ id: "klant-1", email: "klant@voorbeeld.nl" });
      if (naar(v, "/rest/v1/rpc/is_medewerker")) return Response.json(isMedewerker);
      return undefined;
    });
    const klant = await (await t.open("/login", Cookie)).json();
    expect(klant).toMatchObject({
      stap: "ingelogd",
      adres: "klant@voorbeeld.nl",
      medewerkersknop: true,
    });
    isMedewerker = true;
    const medewerker = await (await t.open("/login", Cookie)).json();
    expect(medewerker).toMatchObject({ stap: "ingelogd", medewerkersknop: false });
    // Ook met de link uit de mail in het adres: wie al binnen is, logt niet nog eens in.
    const metLink = await t.open(`/login?token_hash=${TOKEN_HASH}&type=email`, Cookie);
    expect((await lees(metLink)).stap).toBe("ingelogd");
  });
});

describe("een code aanvragen", () => {
  it("hetzelfde antwoord bij een bekend en een onbekend adres, ook als Supabase het adres weigert", async () => {
    const t = await laad();
    const antwoorden: { status: number; locatie: string | null; cookie: string[] }[] = [];
    for (const vanSupabase of [
      () => Response.json({}),
      () => Response.json({ code: "signup_disabled", msg: "Signups not allowed" }, { status: 422 }),
      () => Response.json({ code: "user_not_found", msg: "User not found" }, { status: 400 }),
      () => Response.json({ code: "unexpected_failure", msg: "hook zegt nee" }, { status: 500 }),
    ]) {
      t.supabase((v) => (naar(v, "/auth/v1/otp") ? vanSupabase() : undefined));
      const antwoord = await t.verstuur("/login", { doe: "vraag", email: " Klant@Voorbeeld.nl " });
      const bewaard = onthouden(antwoord);
      expect(JSON.parse(bewaard.inlogcode ?? "{}").email).toBe("klant@voorbeeld.nl");
      expect(Number(bewaard["inlogcode-aangevraagd"])).toBeGreaterThan(0);
      antwoorden.push({
        status: antwoord.status,
        locatie: antwoord.headers.get("Location"),
        cookie: [...gezet(antwoord).keys()].filter((naam) => !naam.endsWith("-code-verifier")),
      });
      expect(await antwoord.text()).toBe("");
    }
    expect(new Set(antwoorden.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(antwoorden[0]).toEqual({ status: 302, locatie: "/login", cookie: ["__Host-inlog"] });
    // Er is echt een code aangevraagd, met "maak zo nodig een account" aan.
    const aanvraag = t.verzoeken.find((v) => naar(v, "/auth/v1/otp"));
    expect(JSON.parse(aanvraag?.body ?? "{}")).toMatchObject({
      email: "klant@voorbeeld.nl",
      create_user: true,
    });
  });

  it("een ongeldig adres en te veel pogingen zeggen niets over het adres en blijven op de pagina", async () => {
    const t = await laad();
    const ongeldig = await t.verstuur("/login", { doe: "vraag", email: "geen adres" });
    expect(ongeldig.status).toBe(400);
    expect(await lees(ongeldig)).toMatchObject({ soort: "adres", fout: { soort: "adres" } });
    expect(t.verzoeken).toEqual([]);

    t.supabase(() => Response.json({ code: "over_email_send_rate_limit" }, { status: 429 }));
    const teVaak = await t.verstuur("/login", { doe: "vraag", email: "klant@voorbeeld.nl" });
    expect(teVaak.status).toBe(429);
    expect((await lees(teVaak)).fout?.soort).toBe("te-vaak");
    expect(gezet(teVaak).has("__Host-inlog")).toBe(false);
    expect(gezet(teVaak).has(SESSIE)).toBe(false);
  });

  it("het pad waar de bezoeker heen wilde gaat mee, een vreemd adres niet", async () => {
    const t = await laad();
    const goed = await t.verstuur("/login?volgende=%2Fwagen", { doe: "vraag", email: "a@b.nl" });
    expect(goed.headers.get("Location")).toBe("/login?volgende=%2Fwagen");
    expect(onthouden(goed).volgende).toBe("/wagen");
    const vreemd = await t.verstuur("/login?volgende=https%3A%2F%2Fnep.example", {
      doe: "vraag",
      email: "a@b.nl",
    });
    expect(vreemd.headers.get("Location")).toBe("/login");
    expect(onthouden(vreemd).volgende).toBe("/");
  });

  it("met de controle tegen robots: zonder bewijs gaat er niets naar Supabase, met bewijs gaat het mee", async () => {
    const t = await laad("cloudflare,mailcode", {
      VITE_TURNSTILE_SITEKEY: "1x00000000000000000000AA",
    });
    expect((await lees(await t.open("/login"))).robotSleutel).toBe("1x00000000000000000000AA");
    const zonder = await t.verstuur("/login", { doe: "vraag", email: "klant@voorbeeld.nl" });
    expect((await lees(zonder)).fout?.soort).toBe("robot");
    expect(t.verzoeken).toEqual([]);
    const met = await t.verstuur("/login", {
      doe: "vraag",
      email: "klant@voorbeeld.nl",
      captcha: "bewijs-van-turnstile",
    });
    expect(met.status).toBe(302);
    expect(JSON.parse(t.verzoeken[0]?.body ?? "{}").gotrue_meta_security).toEqual({
      captcha_token: "bewijs-van-turnstile",
    });
  });

  it("opnieuw sturen: niet binnen de wachttijd, daarna wel; een ander adres haalt het oude weg", async () => {
    const t = await laad();
    const net = t.cookie({
      inlogcode: JSON.stringify({ email: "klant@voorbeeld.nl", verstuurdOp: Date.now() - 5_000 }),
    });
    const teVroeg = await t.verstuur("/login", { doe: "opnieuw" }, { Cookie: net });
    expect(teVroeg.status).toBe(302);
    expect(t.verzoeken).toEqual([]);

    const eerder = t.cookie({
      inlogcode: JSON.stringify({ email: "klant@voorbeeld.nl", verstuurdOp: Date.now() - 61_000 }),
    });
    const opnieuw = await t.verstuur("/login", { doe: "opnieuw" }, { Cookie: eerder });
    expect(t.verzoeken.filter((v) => naar(v, "/auth/v1/otp"))).toHaveLength(1);
    expect(onthouden(opnieuw).melding).toBe("nieuwe-code");
    const pagina = await t.open("/login", t.cookie(onthouden(opnieuw)));
    expect(await lees(pagina)).toMatchObject({
      stap: "code",
      email: "klant@voorbeeld.nl",
      melding: "Er is een nieuwe code verstuurd.",
    });

    const ander = await t.verstuur("/login", { doe: "ander-adres" }, { Cookie: eerder });
    expect(onthouden(ander)).toEqual({ adres: "klant@voorbeeld.nl" });
    const terug = await t.open("/login", t.cookie(onthouden(ander)));
    expect(await lees(terug)).toMatchObject({ stap: "adres", email: "klant@voorbeeld.nl" });
  });

  it("na vijf minuten staat het adres van de vorige niet meer op het scherm", async () => {
    const t = await laad();
    const oud = t.cookie({
      inlogcode: JSON.stringify({
        email: "vorige@voorbeeld.nl",
        verstuurdOp: Date.now() - 6 * 60_000,
      }),
    });
    const antwoord = await t.open("/login", oud);
    expect(await lees(antwoord)).toMatchObject({ stap: "adres", email: "" });
  });
});

describe("de code invullen", () => {
  const formulier = { doe: "code", email: "klant@voorbeeld.nl", code: "12345 67890" };

  it("een goede code: de sessie komt in het cookie, de klant wordt aangemeld, en hij gaat naar waar hij heen wilde", async () => {
    const t = await laad();
    const sessie = nieuweSessie(t.hulp, "klant@voorbeeld.nl");
    t.supabase((v) => (naar(v, "/auth/v1/verify") ? Response.json(sessie) : undefined));
    const antwoord = await t.verstuur("/login?volgende=%2Fwagen", formulier);
    expect(antwoord.status).toBe(302);
    expect(antwoord.headers.get("Location")).toBe("/wagen");
    expect(antwoord.headers.get("Cache-Control")).toBe("private, no-store");

    const controle = t.verzoeken.find((v) => naar(v, "/auth/v1/verify"));
    expect(JSON.parse(controle?.body ?? "{}")).toMatchObject({
      email: "klant@voorbeeld.nl",
      token: "1234567890",
      type: "email",
    });
    const cookies = gezet(antwoord);
    expect(cookies.get(SESSIE)).toMatch(/; Path=\/; .*SameSite=Lax/i);
    expect(cookies.get(SESSIE)).toMatch(/; Secure/i);
    // Aangemeld als klant, met de sessie van de klant zelf en nooit met meer.
    const aanmelden = t.verzoeken.find((v) => naar(v, "/rest/v1/rpc/klant_aanmelden"));
    expect(aanmelden?.authorization).toBe(`Bearer ${sessie.access_token}`);
    // Het geheugen van de inlogpagina is leeg, op "zojuist ingelogd" na.
    expect(onthouden(antwoord)).toEqual({ net: "1" });
    // De code staat nergens in het antwoord.
    expect(JSON.stringify([...antwoord.headers])).not.toContain("1234567890");
  });

  it("na het inloggen blijft de klant op de app, wat er ook in het adres of het cookie stond", async () => {
    const t = await laad();
    t.supabase((v) =>
      naar(v, "/auth/v1/verify")
        ? Response.json(nieuweSessie(t.hulp, "klant@voorbeeld.nl"))
        : undefined,
    );
    for (const pad of [
      "/login?volgende=https%3A%2F%2Fnep-winkel.example%2F",
      "/login?volgende=%2F%2Fnep-winkel.example",
      "/login?redirect_to=https://nep-winkel.example/&next=//nep-winkel.example",
    ]) {
      const antwoord = await t.verstuur(pad, formulier, {
        Cookie: t.cookie({ volgende: "https://nep-winkel.example/" }),
      });
      expect(antwoord.headers.get("Location"), pad).toBe("/");
    }
  });

  it("een foute of verlopen code: een nette melding, geen sessie, en de pagina blijft op de code", async () => {
    const t = await laad();
    t.supabase((v) =>
      naar(v, "/auth/v1/verify")
        ? Response.json(
            { code: 403, error_code: "otp_expired", msg: "Token has expired or is invalid" },
            { status: 403 },
          )
        : undefined,
    );
    const fout = await t.verstuur("/login", { ...formulier, verstuurd_op: String(Date.now()) });
    expect(fout.status).toBe(400);
    expect(await lees(fout)).toMatchObject({
      soort: "code",
      email: "klant@voorbeeld.nl",
      fout: { soort: "code" },
    });
    expect(gezet(fout).has(SESSIE)).toBe(false);
    expect(t.verzoeken.some((v) => naar(v, "/rest/v1/rpc/klant_aanmelden"))).toBe(false);

    const verlopen = await t.verstuur("/login", {
      ...formulier,
      verstuurd_op: String(Date.now() - 16 * 60_000),
    });
    expect((await lees(verlopen)).fout?.soort).toBe("verlopen");

    // Geen tien cijfers: er gaat niets naar Supabase.
    const voor = t.verzoeken.length;
    const kort = await t.verstuur("/login", { ...formulier, code: "1234" });
    expect((await lees(kort)).fout?.soort).toBe("code");
    expect(t.verzoeken).toHaveLength(voor);
  });

  it("wie al is ingelogd, logt niet nog eens in via een formulier", async () => {
    const t = await laad();
    t.supabase((v) =>
      naar(v, "/auth/v1/user")
        ? Response.json({ id: "klant-1", email: "klant@voorbeeld.nl" })
        : undefined,
    );
    const Cookie = t.hulp.sessieCookie({ sub: "klant-1", email: "klant@voorbeeld.nl" });
    for (const velden of [
      formulier,
      { doe: "link" },
      { doe: "vraag", email: "ander@voorbeeld.nl" },
    ]) {
      const antwoord = await t.verstuur(`/login?token_hash=${TOKEN_HASH}&type=email`, velden, {
        Cookie,
      });
      expect(antwoord.status).toBe(302);
      expect(antwoord.headers.get("Location")).toBe("/login");
    }
    expect(t.verzoeken.some((v) => naar(v, "/auth/v1/verify") || naar(v, "/auth/v1/otp"))).toBe(
      false,
    );
  });
});

describe("de link uit de mail (alleen met het formulier)", () => {
  const pad = `/login?token_hash=${TOKEN_HASH}&type=email`;

  it("het formulier wisselt de link om; daarna staat hij niet meer in het adres", async () => {
    const t = await laad();
    t.supabase((v) =>
      naar(v, "/auth/v1/verify")
        ? Response.json(nieuweSessie(t.hulp, "klant@voorbeeld.nl"))
        : undefined,
    );
    const antwoord = await t.verstuur(pad, { doe: "link" });
    expect(antwoord.status).toBe(302);
    expect(antwoord.headers.get("Location")).toBe("/");
    expect(gezet(antwoord).has(SESSIE)).toBe(true);
    expect(onthouden(antwoord)).toEqual({ net: "1" });
    const controle = t.verzoeken.find((v) => naar(v, "/auth/v1/verify"));
    expect(JSON.parse(controle?.body ?? "{}")).toMatchObject({
      token_hash: TOKEN_HASH,
      type: "email",
    });
  });

  it("alleen de browser die de mail zelf aanvroeg, gaat door naar waar hij heen wilde; `?volgende=` in de link telt niet", async () => {
    const t = await laad();
    t.supabase((v) =>
      naar(v, "/auth/v1/verify")
        ? Response.json(nieuweSessie(t.hulp, "klant@voorbeeld.nl"))
        : undefined,
    );
    const zelf = await t.verstuur(
      pad,
      { doe: "link" },
      { Cookie: t.cookie({ volgende: "/wagen" }) },
    );
    expect(zelf.headers.get("Location")).toBe("/wagen");
    const vanAnder = await t.verstuur(`${pad}&volgende=https%3A%2F%2Fnep.example`, { doe: "link" });
    expect(vanAnder.headers.get("Location")).toBe("/");
  });

  it("een verlopen of gebruikte link: terug naar de kale inlogpagina met de vaste melding", async () => {
    const t = await laad();
    t.supabase((v) =>
      naar(v, "/auth/v1/verify")
        ? Response.json(
            { error_code: "otp_expired", msg: "Email link is invalid or has expired" },
            { status: 403 },
          )
        : undefined,
    );
    const antwoord = await t.verstuur(pad, { doe: "link" });
    expect(antwoord.status).toBe(302);
    expect(antwoord.headers.get("Location")).toBe("/login");
    expect(onthouden(antwoord)).toEqual({ fout: "link" });
    expect(gezet(antwoord).has(SESSIE)).toBe(false);
  });

  it("aanval: iemand laten inloggen in het account van een ander vanaf een andere site lukt niet", async () => {
    const t = await laad();
    t.supabase((v) =>
      naar(v, "/auth/v1/verify")
        ? Response.json(nieuweSessie(t.hulp, "aanvaller@nep.example"))
        : undefined,
    );
    for (const origin of [
      "https://nep-winkel.example",
      "null",
      "https://shop.klant.nl.nep.example",
      null,
    ]) {
      for (const velden of [
        { doe: "link" },
        { doe: "code", email: "aanvaller@nep.example", code: "1234567890" },
        { doe: "uitloggen" },
        { doe: "dienst", dienst: "cloudflare" },
      ]) {
        const antwoord = await t.verstuur(pad, velden, { origin });
        expect(antwoord.status, `${origin} ${velden.doe}`).toBe(403);
        expect(antwoord.headers.getSetCookie()).toEqual([]);
      }
    }
    // De Worker weigert vóór de inlogpagina iets doet: er is niets naar Supabase gegaan.
    expect(t.verzoeken).toEqual([]);
  });
});

describe("inloggen voor medewerkers (via de inlogdienst)", () => {
  it("de server begint de inlog: het adres van Supabase komt terug als gegeven, niet als omleiding", async () => {
    const t = await laad();
    const antwoord = await t.verstuur("/login?volgende=%2Fklanten", {
      doe: "dienst",
      dienst: "cloudflare",
    });
    // Geen omleiding naar een ander adres: dat houdt `form-action 'self'` tegen.
    expect(antwoord.status).toBe(200);
    expect(antwoord.headers.get("Location")).toBeNull();
    const { soort, naar: adres = "" } = await lees(antwoord);
    expect(soort).toBe("naar-dienst");
    const doel = new URL(adres);
    expect(doel.origin).toBe(SUPABASE);
    expect(doel.pathname).toBe("/auth/v1/authorize");
    expect(doel.searchParams.get("provider")).toBe("custom:cloudflare");
    expect(doel.searchParams.get("redirect_to")).toBe(`${APP}/login/terug`);
    expect(doel.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(doel.searchParams.get("code_challenge_method")).toBe("s256");

    // De geheime helft staat in een cookie dat geen script kan lezen en dat kort leeft.
    const verifier = [...gezet(antwoord)].filter(([naam]) => naam.endsWith("-code-verifier"));
    expect(verifier.length).toBeGreaterThan(0);
    for (const [naam, regel] of verifier) {
      expect(naam.startsWith("__Host-")).toBe(true);
      expect(regel).toMatch(/HttpOnly/i);
      expect(regel).toMatch(/Max-Age=900(;|$)/i);
      expect(regel).toMatch(/Secure/i);
      expect(regel).toMatch(/SameSite=Lax/i);
      // En de geheime helft zelf staat niet in het adres naar Supabase.
      expect(adres).not.toContain(regel.split("=")[1]?.split(";")[0] ?? "x");
    }
    const bewaard = onthouden(antwoord);
    expect(Number(bewaard["inlog-via-dienst"])).toBeGreaterThan(0);
    expect(bewaard.volgende).toBe("/klanten");
    expect(gezet(antwoord).get("__Host-inlog")).toMatch(/HttpOnly; SameSite=Lax; Secure$/);
  });

  it("alleen een dienst die voor deze app aan staat", async () => {
    const t = await laad();
    for (const dienst of ["google", "azure", "wachtwoord", "mailcode", "keycloak", ""]) {
      const antwoord = await t.verstuur("/login", { doe: "dienst", dienst });
      expect(antwoord.status, dienst).toBe(400);
      expect(antwoord.headers.getSetCookie()).toEqual([]);
    }
  });

  describe("de terugkeer op /login/terug", () => {
    const CODE = "11111111-2222-3333-4444-555555555555";
    const verifier = `${SESSIE}-code-verifier=base64-${Buffer.from(JSON.stringify("geheime-helft")).toString("base64url")}`;

    it("wisselt de code om met de geheime helft uit het cookie en gaat naar waar de bezoeker heen wilde", async () => {
      const t = await laad();
      t.supabase((v) =>
        naar(v, "/auth/v1/token")
          ? Response.json(nieuweSessie(t.hulp, "medewerker@klant.nl"))
          : undefined,
      );
      const merk = t.cookie({ "inlog-via-dienst": String(Date.now()), volgende: "/klanten" });
      // Ook de helft van een eerdere poging die niemand afmaakte staat nog in de browser.
      const oud = `${SESSIE}-flow-oud-code-verifier=base64-IngiCg; ${SESSIE}-flows-code-verifier=base64-WyJvdWQiXQ`;
      const antwoord = await t.terug(`/login/terug?code=${CODE}`, `${merk}; ${verifier}; ${oud}`);
      expect(antwoord.status).toBe(302);
      expect(antwoord.headers.get("Location")).toBe("/klanten");
      expect(antwoord.headers.get("Cache-Control")).toBe("private, no-store");
      expect(antwoord.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      const wissel = t.verzoeken.find((v) => naar(v, "/auth/v1/token"));
      expect(new URL(wissel?.adres ?? APP).searchParams.get("grant_type")).toBe("pkce");
      expect(JSON.parse(wissel?.body ?? "{}")).toEqual({
        auth_code: CODE,
        code_verifier: "geheime-helft",
      });
      const cookies = gezet(antwoord);
      expect(cookies.has(SESSIE)).toBe(true);
      // De geheime helft is verbruikt en weg; het geheugen van de inlogpagina ook.
      expect(cookies.get(`${SESSIE}-code-verifier`)).toMatch(/Max-Age=0/i);
      expect(cookies.get(`${SESSIE}-flow-oud-code-verifier`)).toMatch(/Max-Age=0; HttpOnly/i);
      expect(cookies.get(`${SESSIE}-flows-code-verifier`)).toMatch(/Max-Age=0; HttpOnly/i);
      expect(onthouden(antwoord)).toEqual({ net: "1" });
      // Een medewerker wordt niet als klant aangemeld.
      expect(t.verzoeken.some((v) => naar(v, "/rest/v1/rpc/klant_aanmelden"))).toBe(false);
    });

    it("aanval: de code van een ander in een link. Zonder eigen begin in deze browser wordt er niets omgewisseld", async () => {
      const t = await laad();
      t.supabase((v) =>
        naar(v, "/auth/v1/token")
          ? Response.json(nieuweSessie(t.hulp, "aanvaller@nep.example"))
          : undefined,
      );
      const zonderMerk = await t.terug(`/login/terug?code=${CODE}`, verifier);
      const zonderAlles = await t.terug(`/login/terug?code=${CODE}`);
      const teOud = await t.terug(
        `/login/terug?code=${CODE}`,
        `${t.cookie({ "inlog-via-dienst": String(Date.now() - 16 * 60_000) })}; ${verifier}`,
      );
      for (const antwoord of [zonderMerk, zonderAlles, teOud]) {
        expect(antwoord.status).toBe(302);
        expect(antwoord.headers.get("Location")).toBe("/login");
        expect(gezet(antwoord).has(SESSIE)).toBe(false);
        expect(onthouden(antwoord).fout).toBe("dienst");
      }
      expect(t.verzoeken).toEqual([]);
    });

    it("weigert Supabase de code (de geheime helft past niet), dan is er geen sessie", async () => {
      const t = await laad();
      t.supabase((v) =>
        naar(v, "/auth/v1/token")
          ? Response.json(
              { error_code: "bad_code_verifier", msg: "code challenge does not match" },
              { status: 400 },
            )
          : undefined,
      );
      const merk = t.cookie({ "inlog-via-dienst": String(Date.now()) });
      const antwoord = await t.terug(`/login/terug?code=${CODE}`, `${merk}; ${verifier}`);
      expect(antwoord.headers.get("Location")).toBe("/login");
      expect(gezet(antwoord).has(SESSIE)).toBe(false);
    });

    it("de omleiding gaat nooit naar een vreemd adres, en de code of een fout staat er niet meer in", async () => {
      const t = await laad();
      t.supabase((v) =>
        naar(v, "/auth/v1/token")
          ? Response.json(nieuweSessie(t.hulp, "medewerker@klant.nl"))
          : undefined,
      );
      for (const volgende of [
        "https://nep.example/",
        "//nep.example",
        "/login/terug?code=x",
        "/\\nep",
      ]) {
        const merk = t.cookie({ "inlog-via-dienst": String(Date.now()), volgende });
        const antwoord = await t.terug(
          `/login/terug?code=${CODE}&volgende=https%3A%2F%2Fnep.example`,
          `${merk}; ${verifier}`,
        );
        expect(antwoord.headers.get("Location"), volgende).toBe("/");
      }
      const tekst = encodeURIComponent("Bel 0900-1234");
      const fout = await t.terug(`/login/terug?error=access_denied&error_description=${tekst}`);
      expect(fout.headers.get("Location")).toBe("/login");
      expect(onthouden(fout)).toEqual({ fout: "dienst" });
      const rommel = await t.terug(
        "/login/terug?code=%3Cscript%3E",
        t.cookie({ "inlog-via-dienst": String(Date.now()) }),
      );
      expect(rommel.headers.get("Location")).toBe("/login");
    });
  });
});

describe("uitloggen", () => {
  it("is een formulier: de sessie eindigt bij Supabase en de cookies gaan weg", async () => {
    const t = await laad();
    const Cookie = `${t.hulp.sessieCookie({ sub: "klant-1", email: "klant@voorbeeld.nl" })}; ${t.cookie({ volgende: "/wagen" })}`;
    t.supabase((v) =>
      naar(v, "/auth/v1/logout") ? new Response(null, { status: 204 }) : undefined,
    );
    const antwoord = await t.verstuur("/login", { doe: "uitloggen" }, { Cookie });
    expect(antwoord.status).toBe(302);
    expect(antwoord.headers.get("Location")).toBe("/");
    expect(t.verzoeken.some((v) => naar(v, "/auth/v1/logout") && v.methode === "POST")).toBe(true);
    expect(gezet(antwoord).get(SESSIE)).toMatch(/Max-Age=0/i);
    expect(gezet(antwoord).get("__Host-inlog")).toMatch(/Max-Age=0/i);
  });

  it("ook als Supabase niet antwoordt, is deze browser zijn sessie kwijt", async () => {
    const t = await laad();
    const Cookie = t.hulp.sessieCookie({ sub: "klant-1", email: "klant@voorbeeld.nl" });
    t.supabase(() => Response.json({ msg: "storing" }, { status: 500 }));
    const antwoord = await t.verstuur("/login", { doe: "uitloggen" }, { Cookie });
    expect(antwoord.status).toBe(302);
    expect(gezet(antwoord).get(SESSIE)).toMatch(/Max-Age=0/i);
  });
});

describe("welke manieren van inloggen aan staan", () => {
  it("een klantportaal kent geen wachtwoord, ook niet als iemand het formulier zelf verstuurt", async () => {
    const t = await laad("cloudflare,mailcode");
    for (const doe of ["wachtwoord", "testlogin"]) {
      const antwoord = await t.verstuur("/login", {
        doe,
        email: "klant@voorbeeld.nl",
        password: "een-wachtwoord-123",
      });
      expect(antwoord.status).toBe(400);
    }
    expect(t.verzoeken).toEqual([]);
  });

  it("zonder mailcode is er geen code aan te vragen of in te vullen", async () => {
    const t = await laad("cloudflare");
    expect(await lees(await t.open("/login"))).toMatchObject({
      stap: "adres",
      metMail: false,
      knoppen: ["cloudflare"],
    });
    for (const velden of [
      { doe: "vraag", email: "klant@voorbeeld.nl" },
      { doe: "code", email: "klant@voorbeeld.nl", code: "1234567890" },
      { doe: "link" },
    ]) {
      const antwoord = await t.verstuur(`/login?token_hash=${TOKEN_HASH}&type=email`, velden);
      expect(antwoord.status).toBe(400);
    }
    expect(t.verzoeken).toEqual([]);
  });

  it("lokaal en in de tests (`wachtwoord`): het formulier logt in op de server", async () => {
    const t = await laad("wachtwoord");
    expect((await lees(await t.open("/login"))).stap).toBe("wachtwoord");
    t.supabase((v) =>
      naar(v, "/auth/v1/token")
        ? Response.json(nieuweSessie(t.hulp, "klant-a@voorbeeld.nl"))
        : undefined,
    );
    const goed = await t.verstuur("/login?volgende=%2Fwagen", {
      doe: "wachtwoord",
      email: "klant-a@voorbeeld.nl",
      password: "voorbeeldshop-klant-a",
    });
    expect(goed.status).toBe(302);
    expect(goed.headers.get("Location")).toBe("/wagen");
    expect(gezet(goed).has(SESSIE)).toBe(true);

    t.supabase(() => Response.json({ error_code: "invalid_credentials" }, { status: 400 }));
    const fout = await t.verstuur("/login", {
      doe: "wachtwoord",
      email: "klant-a@voorbeeld.nl",
      password: "dit-is-het-niet",
    });
    expect(fout.status).toBe(400);
    expect((await lees(fout)).melding).toContain("Inloggen is niet gelukt");
    // Een gebouwde versie kent geen testlogin.
    const testlogin = await t.verstuur("/login", { doe: "testlogin" });
    expect(testlogin.status).toBe(400);
  });

  it("een formulier dat de pagina niet kent, doet niets", async () => {
    const t = await laad();
    const antwoord = await t.verstuur("/login", { doe: "word-beheerder" });
    expect(antwoord.status).toBe(400);
    expect(t.verzoeken).toEqual([]);
  });
});

describe("niets rond het inloggen hoort in een cache of in Google, ook niet op het echte domein", () => {
  it("de omleidingen van de formulieren, de terugkeer van de dienst en een fout in het adres", async () => {
    const t = await laad();
    const antwoorden = [
      await t.verstuur("/login", { doe: "vraag", email: "klant@voorbeeld.nl" }),
      await t.verstuur(`/login?token_hash=${TOKEN_HASH}&type=email`, { doe: "link" }),
      await t.verstuur("/login", { doe: "uitloggen" }),
      await t.verstuur("/login", { doe: "ander-adres" }),
      await t.terug("/login/terug?code=11111111-2222"),
      await t.terug("/login/terug?error=access_denied"),
      await t.open("/login?error=access_denied"),
    ];
    for (const antwoord of antwoorden) {
      expect(antwoord.status).toBe(302);
      expect(antwoord.headers.get("Cache-Control")).toBe("private, no-store");
      expect(antwoord.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    }
  });
});

describe("'Je bent ingelogd als': één keer, met het adres van de gecontroleerde sessie", () => {
  it("zonder het merkteken kost het niets; met merkteken één keer het adres dat Supabase bevestigt", async () => {
    const t = await laad();
    const sessie = t.hulp.sessieCookie({ sub: "klant-1", email: "klant@voorbeeld.nl" });
    t.supabase((v) =>
      naar(v, "/auth/v1/user")
        ? Response.json({ id: "klant-1", email: "klant@voorbeeld.nl" })
        : undefined,
    );
    const zonder = await t.wieIsEr(sessie);
    expect(await lees(zonder)).toBeNull();
    expect(t.verzoeken).toEqual([]);
    // Een nagemaakt sessiecookie dat Supabase afkeurt, levert geen adres op.
    t.supabase(() => Response.json({ message: "invalid JWT" }, { status: 401 }));
    const nep = await t.wieIsEr(`${sessie}; ${t.cookie({ net: "1" })}`);
    expect(await lees(nep)).toBeNull();
    t.supabase((v) =>
      naar(v, "/auth/v1/user")
        ? Response.json({ id: "klant-1", email: "klant@voorbeeld.nl" })
        : undefined,
    );

    const met = await t.wieIsEr(`${sessie}; ${t.cookie({ net: "1" })}`);
    expect(await lees(met)).toBe("klant@voorbeeld.nl");
    expect(gezet(met).get("__Host-inlog")).toMatch(/Max-Age=0/i);
  });
});

describe("de aanmeldfunctie na het inloggen (klantportaal_aanmelden in stack.config.json)", () => {
  it("standaard klant_aanmelden; een app met een eigen aanmelding zet haar eigen functie", async () => {
    const { aanmeldfunctie } = await import("./inloggen.server");
    expect(aanmeldfunctie({})).toBe("klant_aanmelden");
    expect(aanmeldfunctie({ klantportaal_aanmelden: "relatie_aanmelden" })).toBe(
      "relatie_aanmelden",
    );
  });
  it("een naam die geen functienaam is, weigert", async () => {
    const { aanmeldfunctie } = await import("./inloggen.server");
    for (const naam of ["", "public.x", "x()", "X", 3, "x; drop table y"]) {
      expect(() => aanmeldfunctie({ klantportaal_aanmelden: naam }), String(naam)).toThrow(
        /klantportaal_aanmelden/,
      );
    }
  });
});

/**
 * De server vraagt de codes namens iedereen aan, dus de grenzen per adres van Supabase zijn één
 * emmer voor alle bezoekers samen. De echte rem per bezoeker hoort bij Cloudflare (een regel
 * voor rate limiting, docs/WERKWIJZE.md). Wat de template zelf tegenhoudt, vóór er iets naar
 * Supabase gaat: een code die geen code kan zijn, een verzonnen bewijs van de controle tegen
 * robots, en in een browser die zijn cookie houdt een tweede mail binnen de minuut en een
 * zesde foute code.
 */
describe("de rem vóór Supabase", () => {
  const naar = (v: Verzoek, pad: string) => new URL(v.adres).pathname === pad;
  const heleCode = (i: number) => String(i).padStart(CODE_LENGTE, "7");

  it("een code die geen code kan zijn (te kort, te lang, letters) gaat niet naar Supabase", async () => {
    const t = await laad();
    for (const code of [
      "1234",
      "1".repeat(CODE_LENGTE - 1),
      "1".repeat(CODE_LENGTE + 3),
      "abcdefghij",
      "",
    ]) {
      const antwoord = await t.verstuur("/login", { doe: "code", email: "klant@klant.nl", code });
      expect(antwoord.status, code).toBe(400);
    }
    expect(t.verzoeken.filter((v) => naar(v, "/auth/v1/verify"))).toEqual([]);
  });

  it("in een browser die zijn cookie houdt: na vijf foute codes gaat de volgende een minuut niet naar Supabase", async () => {
    const t = await laad();
    t.supabase((v) =>
      naar(v, "/auth/v1/verify")
        ? Response.json({ code: 403, error_code: "otp_expired", msg: "x" }, { status: 403 })
        : undefined,
    );
    let Cookie = "";
    for (let i = 0; i < 12; i++) {
      const antwoord = await t.verstuur(
        "/login",
        { doe: "code", email: "klant@klant.nl", code: heleCode(i) },
        { Cookie },
      );
      const velden = onthouden(antwoord);
      if (Object.keys(velden).length > 0) Cookie = t.cookie(velden);
      if (i >= 5) expect(antwoord.status, `poging ${i + 1}`).toBe(429);
    }
    expect(t.verzoeken.filter((v) => naar(v, "/auth/v1/verify"))).toHaveLength(5);
  });

  it("met Turnstile aan: een leeg of verzonnen bewijs gaat niet naar Supabase, een bewijs met de juiste vorm wel", async () => {
    const t = await laad("cloudflare,mailcode", { VITE_TURNSTILE_SITEKEY: "0x4AAAA-test" });
    for (const captcha of [
      "",
      "verzonnen",
      "a b c d e f g h i j k l m n o",
      "<script>".repeat(4),
    ]) {
      const antwoord = await t.verstuur("/login", {
        doe: "vraag",
        email: "x@voorbeeld.nl",
        captcha,
      });
      expect(antwoord.status, captcha).toBe(400);
    }
    expect(t.verzoeken.filter((v) => naar(v, "/auth/v1/otp"))).toEqual([]);

    const echt = `0.${"Ab1_-".repeat(40)}`;
    await t.verstuur("/login", { doe: "vraag", email: "x@voorbeeld.nl", captcha: echt });
    const otp = t.verzoeken.filter((v) => naar(v, "/auth/v1/otp"));
    expect(otp).toHaveLength(1);
    expect(otp[0]?.body).toContain(echt);
  });

  it("dezelfde browser vraagt binnen de minuut geen tweede mail voor hetzelfde adres aan", async () => {
    const t = await laad();
    const eerste = await t.verstuur("/login", { doe: "vraag", email: "doelwit@klant.nl" });
    const Cookie = t.cookie(onthouden(eerste));
    for (let i = 0; i < 5; i++) {
      await t.verstuur("/login", { doe: "vraag", email: "doelwit@klant.nl" }, { Cookie });
    }
    expect(t.verzoeken.filter((v) => naar(v, "/auth/v1/otp"))).toHaveLength(1);
  });
});

/**
 * Bescherming rond het inloggen die je kon weghalen zonder dat een test rood werd (de mutaties
 * van de aanval van ronde 2). Elk een gerichte test.
 */
describe("bescherming die niet stil mag verdwijnen", () => {
  const verifier = `${SESSIE}-code-verifier=base64-${Buffer.from(JSON.stringify("geheime-helft")).toString("base64url")}`;

  it("code-vorm: met het merkteken, maar een code die geen code van de dienst kan zijn: niets omgewisseld", async () => {
    const t = await laad();
    for (const code of [
      "kort",
      "code met spaties-1234",
      "<script>alert(1)</script>",
      "x".repeat(201),
    ]) {
      const merk = t.cookie({ "inlog-via-dienst": String(Date.now()) });
      const antwoord = await t.terug(
        `/login/terug?code=${encodeURIComponent(code)}`,
        `${merk}; ${verifier}`,
      );
      expect(antwoord.headers.get("Location"), code).toBe("/login");
      expect(onthouden(antwoord).fout, code).toBe("dienst");
    }
    expect(t.verzoeken.filter((v) => naar(v, "/auth/v1/token"))).toEqual([]);
  });

  it("alleen-supabase: geeft supabase-js voor de inlogdienst een adres buiten Supabase, dan gaat de pagina er niet heen", async () => {
    const t = await laad();
    const { AuthClient } = await import("@supabase/supabase-js");
    const spion = vi.spyOn(AuthClient.prototype, "signInWithOAuth").mockResolvedValue({
      data: { provider: "custom:cloudflare", url: "https://nep-inlog.example/authorize" },
      error: null,
    } as Awaited<ReturnType<InstanceType<typeof AuthClient>["signInWithOAuth"]>>);
    try {
      const antwoord = await t.verstuur("/login", { doe: "dienst", dienst: "cloudflare" });
      expect(antwoord.status).toBe(502);
      expect(JSON.stringify(await antwoord.json())).not.toContain("nep-inlog.example");
      expect(onthouden(antwoord)["inlog-via-dienst"]).toBeUndefined();
    } finally {
      spion.mockRestore();
    }
  });

  it("wis-dienst: na de terugkeer is het merkteken weg; dezelfde cookies nog eens wisselen niets om", async () => {
    const t = await laad();
    t.supabase((v) =>
      naar(v, "/auth/v1/token")
        ? Response.json(nieuweSessie(t.hulp, "medewerker@klant.nl"))
        : undefined,
    );
    const merk = t.cookie({ "inlog-via-dienst": String(Date.now()) });
    const eerste = await t.terug("/login/terug?code=code-van-de-dienst-1", `${merk}; ${verifier}`);
    expect(eerste.headers.get("Location")).toBe("/");
    expect(onthouden(eerste)["inlog-via-dienst"]).toBeUndefined();
    // De browser stuurt daarna het inlogcookie uit het antwoord mee, niet het oude.
    const tweede = await t.terug(
      "/login/terug?code=code-van-de-dienst-2",
      `${t.cookie(onthouden(eerste))}; ${verifier}`,
    );
    expect(tweede.headers.get("Location")).toBe("/login");
    expect(t.verzoeken.filter((v) => naar(v, "/auth/v1/token"))).toHaveLength(1);
  });

  it("uitloggen-wist-sessie: een verlopen sessie terwijl Supabase onbereikbaar is: supabase-js wist niets, de server wel", async () => {
    const t = await laad();
    const toen = Math.floor(Date.now() / 1000) - 60;
    const sessie = {
      access_token: t.hulp.nepJwt({ sub: "klant-1", exp: toen, role: "authenticated" }),
      refresh_token: "verversing-van-de-klant",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: toen,
      user: { id: "klant-1" },
    };
    const Cookie = `${SESSIE}=base64-${Buffer.from(JSON.stringify(sessie)).toString("base64url")}`;
    t.supabase(() => {
      throw new TypeError("fetch failed");
    });
    const antwoord = await t.verstuur("/login", { doe: "uitloggen" }, { Cookie });
    expect(antwoord.status).toBe(302);
    expect(gezet(antwoord).get(SESSIE)).toMatch(/Max-Age=0/i);
  });

  it("robot-opnieuw: met Turnstile aan vraagt 'stuur een nieuwe code' zonder bewijs niets aan bij Supabase", async () => {
    const t = await laad("cloudflare,mailcode", { VITE_TURNSTILE_SITEKEY: "0x4AAAA-test" });
    const eerder = t.cookie({
      inlogcode: JSON.stringify({
        email: "klant@voorbeeld.nl",
        verstuurdOp: Date.now() - 2 * 60_000,
      }),
    });
    for (const captcha of [undefined, "", "verzonnen"]) {
      const antwoord = await t.verstuur("/login", { doe: "opnieuw", captcha }, { Cookie: eerder });
      expect(antwoord.status).toBe(302);
      expect(onthouden(antwoord).fout).toBe("robot");
    }
    expect(t.verzoeken.filter((v) => naar(v, "/auth/v1/otp"))).toEqual([]);
  });
});
