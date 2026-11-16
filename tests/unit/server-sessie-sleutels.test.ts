// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { gebruiker } from "../../src/lib/server/sessie.server";
import { INSTELLINGEN, nepJwt, vraag } from "./server-hulp";

/**
 * Wie bepaalt of de server een token zelf controleert: het PROJECT, niet het token
 * (src/lib/server/sessie.server.ts). De aanvallen van ronde 3 omgekeerd:
 *
 *   B1/B2  een verzonnen cookie met `alg: HS256` in de kop, bij een project met openbare
 *          sleutels: geweigerd zonder Supabase iets te vragen;
 *   B3     een eigen, verlopen token met een verzonnen verversing: niet te sluiten zonder
 *          geheim in de Worker; wat wel kan en wat blijft, staat hieronder;
 *   B4     een sleutel die nog niet in de bewaarde lijst staat (een wissel bij Supabase): nu
 *          niet ingelogd, maar het cookie blijft tot een verse lijst zegt dat hij onbekend is;
 *   en de sleutellijst zelf is niet door een stroom cookies uit te lokken.
 *
 * Elke test heeft een eigen project (adres), zodat de bewaarde lijst van de ene test de andere
 * niet raakt.
 */
const APP = "https://shop.klant.nl";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

let teller = 0;
function project() {
  teller += 1;
  const ref = `sltl${String(teller).padStart(4, "0")}sleutelssleutels`.slice(0, 20);
  return {
    instellingen: { ...INSTELLINGEN, supabaseUrl: `https://${ref}.supabase.co` },
    naam: `__Host-sb-${ref}-auth-token`,
  };
}

const b64 = (tekst: string | Uint8Array) => Buffer.from(tekst).toString("base64url");

async function sleutelpaar(kid: string) {
  const paar = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const openbaar = await crypto.subtle.exportKey("jwk", paar.publicKey);
  return {
    jwk: { ...openbaar, kid, alg: "ES256", use: "sig", key_ops: ["verify"] },
    teken: async (inhoud: Record<string, unknown>) => {
      const deel = `${b64(JSON.stringify({ alg: "ES256", kid, typ: "JWT" }))}.${b64(JSON.stringify(inhoud))}`;
      const handtekening = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        paar.privateKey,
        new TextEncoder().encode(deel),
      );
      return `${deel}.${b64(new Uint8Array(handtekening))}`;
    },
  };
}

function sessiecookie(naam: string, token: string, verversing: string, verloopt: number) {
  const sessie = {
    access_token: token,
    refresh_token: verversing,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: verloopt,
    user: { id: "klant-1" },
  };
  return `${naam}=base64-${b64(JSON.stringify(sessie))}`;
}

const nu = () => Math.floor(Date.now() / 1000);
const inhoud = (exp: number, sub = "klant-1") => ({
  sub,
  exp,
  aud: "authenticated",
  role: "authenticated",
  session_id: "sessie-1",
});

/**
 * Supabase nagebootst: de sleutellijst (of een storing), en een afwijzing voor elk token en
 * elke verversing, behalve wat `user` zegt.
 */
function supabase(jwks: () => Response, user: () => Response = () => afgewezen(403)) {
  const adressen: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (invoer: RequestInfo | URL) => {
      const adres = new URL(invoer instanceof Request ? invoer.url : String(invoer));
      adressen.push(adres);
      if (adres.pathname.endsWith("/.well-known/jwks.json")) return jwks();
      if (adres.pathname.endsWith("/auth/v1/token")) {
        return Response.json({ code: 400, error_code: "refresh_token_not_found" }, { status: 400 });
      }
      if (adres.pathname.endsWith("/auth/v1/user")) return user();
      return Response.json({});
    }),
  );
  return { naar: (pad: string) => adressen.filter((a) => a.pathname.endsWith(pad)).length };
}
const afgewezen = (status: number) =>
  Response.json({ code: status, error_code: "bad_jwt" }, { status });
const lijst =
  (...keys: unknown[]) =>
  () =>
    Response.json({ keys });

async function wieIsEr(instellingen: typeof INSTELLINGEN, Cookie: string) {
  const antwoord = await vraag(
    `${APP}/`,
    async (_request, context) => Response.json((await gebruiker(context))?.id ?? null),
    { init: { headers: { Cookie } }, instellingen },
  );
  return { id: await antwoord.json(), cookies: antwoord.headers.getSetCookie() };
}

const gewist = (cookies: string[], naam: string) =>
  cookies.some((c) => c.startsWith(`${naam}=`) && /Max-Age=0/i.test(c));

describe("het project bepaalt of de server zelf controleert, niet het token", () => {
  it("B1 omgekeerd: project op ES256, 25 verzonnen cookies met 'alg: HS256' en een verlopen token: nul verversingen, de lijst één keer opgehaald, het cookie gaat weg", async () => {
    const { instellingen, naam } = project();
    const echt = await sleutelpaar("echte-sleutel");
    const telling = supabase(lijst(echt.jwk));
    for (let i = 0; i < 25; i++) {
      const uit = await wieIsEr(
        instellingen,
        sessiecookie(naam, nepJwt(inhoud(nu() - 60)), `verzonnen${i}`, nu() - 60),
      );
      expect(uit.id).toBeNull();
      expect(gewist(uit.cookies, naam)).toBe(true);
    }
    expect(telling.naar("/auth/v1/token")).toBe(0);
    expect(telling.naar("/auth/v1/user")).toBe(0);
    expect(telling.naar("/.well-known/jwks.json")).toBe(1);
  });

  it("B2 omgekeerd: hetzelfde met een token dat nog niet verlopen lijkt: nul keer 'wie is dit' bij Supabase", async () => {
    const { instellingen, naam } = project();
    const echt = await sleutelpaar("echte-sleutel");
    const telling = supabase(lijst(echt.jwk));
    for (let i = 0; i < 25; i++) {
      const uit = await wieIsEr(
        instellingen,
        sessiecookie(naam, nepJwt(inhoud(nu() + 3600)), `verzonnen${i}`, nu() + 3600),
      );
      expect(uit.id).toBeNull();
    }
    expect(telling.naar("/auth/v1/user")).toBe(0);
    expect(telling.naar("/auth/v1/token")).toBe(0);
  });

  it("ook een ander algoritme dan HS256 (PS256, of ES256 zonder kid) is bij zo'n project geen reden om Supabase te vragen", async () => {
    const { instellingen, naam } = project();
    const echt = await sleutelpaar("echte-sleutel");
    const telling = supabase(lijst(echt.jwk));
    for (const token of [
      nepJwt(inhoud(nu() + 3600), "PS256"),
      nepJwt(inhoud(nu() + 3600), "ES256"),
    ]) {
      const uit = await wieIsEr(instellingen, sessiecookie(naam, token, "verzonnen", nu() + 3600));
      expect(uit.id).toBeNull();
    }
    expect(telling.naar("/auth/v1/user") + telling.naar("/auth/v1/token")).toBe(0);
  });

  it("project zonder openbare sleutels (lege lijst: tekent nog met het gedeelde geheim): de oude weg, Supabase controleert het token; dat is het beschreven restrisico", async () => {
    const { instellingen, naam } = project();
    const telling = supabase(lijst(), () =>
      Response.json({ id: "klant-1", aud: "authenticated", role: "authenticated" }),
    );
    const echt = await wieIsEr(
      instellingen,
      sessiecookie(naam, nepJwt(inhoud(nu() + 3600)), "echteverversing", nu() + 3600),
    );
    expect(echt.id).toBe("klant-1");
    expect(telling.naar("/auth/v1/user")).toBe(1);
    // De lege lijst is bewaard: nog tien cookies vragen hem niet opnieuw op.
    for (let i = 0; i < 10; i++) {
      await wieIsEr(
        instellingen,
        sessiecookie(naam, nepJwt(inhoud(nu() + 3600)), `verzonnen${i}`, nu() + 3600),
      );
    }
    expect(telling.naar("/.well-known/jwks.json")).toBe(1);
    expect(telling.naar("/auth/v1/user")).toBe(11);
  });
});

describe("de sleutellijst is niet uit te lokken", () => {
  it("25 cookies tegelijk: één keer opgehaald", async () => {
    const { instellingen, naam } = project();
    const echt = await sleutelpaar("echte-sleutel");
    const telling = supabase(lijst(echt.jwk));
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        wieIsEr(
          instellingen,
          sessiecookie(naam, nepJwt(inhoud(nu() - 60)), `verzonnen${i}`, nu() - 60),
        ),
      ),
    );
    expect(telling.naar("/.well-known/jwks.json")).toBe(1);
    expect(telling.naar("/auth/v1/token")).toBe(0);
  });

  it("een mislukte poging wordt een halve minuut bewaard: 25 cookies, één poging, niemand ingelogd, geen cookie gewist; daarna opnieuw", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { instellingen, naam } = project();
    const echt = await sleutelpaar("echte-sleutel");
    let storing = true;
    const telling = supabase(() =>
      storing ? new Response("weg", { status: 503 }) : Response.json({ keys: [echt.jwk] }),
    );
    const cookie = async () =>
      sessiecookie(naam, await echt.teken(inhoud(nu() + 3600)), "echt", nu() + 3600);
    for (let i = 0; i < 25; i++) {
      const uit = await wieIsEr(instellingen, await cookie());
      expect(uit.id).toBeNull();
      expect(gewist(uit.cookies, naam)).toBe(false);
    }
    expect(telling.naar("/.well-known/jwks.json")).toBe(1);
    expect(telling.naar("/auth/v1/token") + telling.naar("/auth/v1/user")).toBe(0);

    storing = false;
    vi.setSystemTime(Date.now() + 31_000);
    const daarna = await wieIsEr(instellingen, await cookie());
    expect(daarna.id).toBe("klant-1");
    expect(telling.naar("/.well-known/jwks.json")).toBe(2);
  });
});

describe("B4 omgekeerd: een nieuwe sleutel bij Supabase logt niemand uit", () => {
  it("een onbekende kid binnen een minuut na het ophalen: nu niet ingelogd, het cookie blijft; na de minuut een verse lijst en weer ingelogd", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { instellingen, naam } = project();
    const oud = await sleutelpaar("oude-sleutel");
    const nieuw = await sleutelpaar("nieuwe-sleutel");
    let sleutels: unknown[] = [oud.jwk];
    const telling = supabase(() => Response.json({ keys: sleutels }));
    await wieIsEr(
      instellingen,
      sessiecookie(naam, await oud.teken(inhoud(nu() + 3600)), "echt", nu() + 3600),
    );
    expect(telling.naar("/.well-known/jwks.json")).toBe(1);

    sleutels = [oud.jwk, nieuw.jwk];
    const metNieuw = async () =>
      sessiecookie(naam, await nieuw.teken(inhoud(nu() + 3600)), "echt", nu() + 3600);
    const klant = await wieIsEr(instellingen, await metNieuw());
    expect(klant.id).toBeNull();
    expect(gewist(klant.cookies, naam)).toBe(false);
    expect(telling.naar("/.well-known/jwks.json")).toBe(1);

    vi.setSystemTime(Date.now() + 61_000);
    const later = await wieIsEr(instellingen, await metNieuw());
    expect(later.id).toBe("klant-1");
    expect(telling.naar("/.well-known/jwks.json")).toBe(2);
  });

  it("een kid die ook in een verse lijst niet staat: het cookie gaat weg", async () => {
    const { instellingen, naam } = project();
    const echt = await sleutelpaar("echte-sleutel");
    const vals = await sleutelpaar("verzonnen-sleutel");
    supabase(lijst(echt.jwk));
    const uit = await wieIsEr(
      instellingen,
      sessiecookie(naam, await vals.teken(inhoud(nu() + 3600)), "echt", nu() + 3600),
    );
    expect(uit.id).toBeNull();
    expect(gewist(uit.cookies, naam)).toBe(true);
  });
});

describe("B3: het eigen verlopen token met een verzonnen verversing", () => {
  it("een verversing die geen verversingstoken kan zijn (spaties, aanhalingstekens, te lang): geweigerd zonder Supabase, cookie weg", async () => {
    const { instellingen, naam } = project();
    const echt = await sleutelpaar("echte-sleutel");
    const telling = supabase(lijst(echt.jwk));
    const eigenOudToken = await echt.teken(inhoud(nu() - 86_400, "aanvaller"));
    for (const verversing of ["met spatie", 'met"aanhalingsteken', "x".repeat(513), "{}"]) {
      const uit = await wieIsEr(
        instellingen,
        sessiecookie(naam, eigenOudToken, verversing, nu() - 86_400),
      );
      expect(uit.id).toBeNull();
      expect(gewist(uit.cookies, naam)).toBe(true);
    }
    expect(telling.naar("/auth/v1/token")).toBe(0);
  });

  it("een afgewezen verversing wist het cookie: een browser stuurt hetzelfde cookie niet nog eens", async () => {
    const { instellingen, naam } = project();
    const echt = await sleutelpaar("echte-sleutel");
    supabase(lijst(echt.jwk));
    const uit = await wieIsEr(
      instellingen,
      sessiecookie(
        naam,
        await echt.teken(inhoud(nu() - 86_400, "aanvaller")),
        "verzonnen",
        nu() - 86_400,
      ),
    );
    expect(uit.id).toBeNull();
    expect(gewist(uit.cookies, naam)).toBe(true);
  });

  it("restrisico (beschreven in docs/WERKWIJZE.md): een script dat het cookie zelf blijft sturen, met een verversing in de goede vorm, kost per verzoek één verversing; de rem is de tweede regel bij Cloudflare", async () => {
    const { instellingen, naam } = project();
    const echt = await sleutelpaar("echte-sleutel");
    const telling = supabase(lijst(echt.jwk));
    const eigenOudToken = await echt.teken(inhoud(nu() - 86_400, "aanvaller"));
    for (let i = 0; i < 5; i++) {
      await wieIsEr(
        instellingen,
        sessiecookie(naam, eigenOudToken, `verzonnen${i}`, nu() - 86_400),
      );
    }
    expect(telling.naar("/auth/v1/token")).toBe(5);
  });
});
