// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { gebruiker } from "../../src/lib/server/sessie.server";
import { INSTELLINGEN, nepJwt, vraag } from "./server-hulp";

/**
 * Het verversen van een sessie (src/lib/server/sessie.server.ts). Supabase ziet alleen de
 * Worker, dus alle bezoekers delen bij Supabase één emmer voor het verversen. Twee aanvallen:
 *
 *   - een vreemde zonder account stuurt verzonnen cookies; elk cookie dat de server laat
 *     verversen, kost een plek in die emmer. De server kijkt daarom eerst zelf (vorm en
 *     handtekening) en vraagt Supabase pas daarna iets;
 *   - is de emmer leeg (429) of is Supabase even weg, dan mag een echte klant niet worden
 *     uitgelogd: hij is voor dit verzoek niet ingelogd, maar het cookie blijft staan.
 *
 * Elke test heeft een eigen project (adres), zodat de bewaarde openbare sleutels van de ene
 * test de andere niet raken.
 */
const APP = "https://shop.klant.nl";

afterEach(() => {
  vi.unstubAllGlobals();
});

let teller = 0;
function project() {
  teller += 1;
  const ref = `proj${String(teller).padStart(4, "0")}verversen`.slice(0, 20);
  const supabaseUrl = `https://${ref}.supabase.co`;
  return {
    instellingen: { ...INSTELLINGEN, supabaseUrl },
    naam: `__Host-sb-${ref}-auth-token`,
  };
}

const b64 = (tekst: string | Uint8Array) => Buffer.from(tekst).toString("base64url");

/** Een sleutelpaar zoals Supabase het met de nieuwe JWT-sleutels gebruikt (ES256). */
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

function sessiecookie(naam: string, token: string, verversing = "echte-verversing") {
  const toen = Math.floor(Date.now() / 1000) - 60;
  const sessie = {
    access_token: token,
    refresh_token: verversing,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: toen,
    user: { id: "klant-1" },
  };
  return `${naam}=base64-${b64(JSON.stringify(sessie))}`;
}

const verlopen = () => ({
  sub: "klant-1",
  exp: Math.floor(Date.now() / 1000) - 60,
  aud: "authenticated",
  role: "authenticated",
  session_id: "sessie-1",
});

type Antwoord = (adres: URL) => Response | undefined;

/** Elk verzoek naar Supabase, met een antwoord per pad. */
function supabase(antwoord: Antwoord, jwks: unknown = { keys: [] }) {
  const adressen: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (invoer: RequestInfo | URL) => {
      const adres = new URL(invoer instanceof Request ? invoer.url : String(invoer));
      adressen.push(adres);
      if (adres.pathname.endsWith("/.well-known/jwks.json")) return Response.json(jwks);
      return antwoord(adres) ?? Response.json({});
    }),
  );
  return {
    naar: (pad: string) => adressen.filter((a) => a.pathname.endsWith(pad)).length,
    alles: () => adressen.length,
  };
}

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

const nieuweSessie = (token: string) =>
  Response.json({
    access_token: token,
    refresh_token: "nieuwe-verversing",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: "klant-1", aud: "authenticated", role: "authenticated" },
  });

describe("een verzonnen cookie kost Supabase niets", () => {
  it("25 verzonnen cookies met een verzonnen sleutel: nul keer verversen, nul keer vragen wie het is, de sleutels één keer opgehaald; het cookie gaat weg zodra de lijst vers is", async () => {
    const { instellingen, naam } = project();
    const echt = await sleutelpaar("echte-sleutel");
    const vals = await sleutelpaar("verzonnen-sleutel");
    const telling = supabase(() => undefined, { keys: [echt.jwk] });
    for (let i = 0; i < 25; i++) {
      const uit = await wieIsEr(
        instellingen,
        sessiecookie(naam, await vals.teken(verlopen()), `verzonnen-${i}`),
      );
      expect(uit.id).toBeNull();
      // Bij het eerste verzoek is de lijst net opgehaald: de sleutel is echt onbekend. Daarna
      // (binnen de minuut) is de lijst bewaard en kan de sleutel ook nieuw zijn; dan alleen
      // "nu niet ingelogd", zie server-sessie-sleutels.test.ts.
      expect(gewist(uit.cookies, naam), `verzoek ${i}`).toBe(i === 0);
    }
    expect(telling.naar("/auth/v1/token")).toBe(0);
    expect(telling.naar("/auth/v1/user")).toBe(0);
    expect(telling.naar("/.well-known/jwks.json")).toBe(1);
    expect(telling.alles()).toBe(1);
  });

  it("de bekende sleutel met een verkeerde handtekening: nul keer verversen", async () => {
    const { instellingen, naam } = project();
    const echt = await sleutelpaar("echte-sleutel");
    const nep = await sleutelpaar("echte-sleutel");
    const telling = supabase(() => undefined, { keys: [echt.jwk] });
    const uit = await wieIsEr(instellingen, sessiecookie(naam, await nep.teken(verlopen())));
    expect(uit.id).toBeNull();
    expect(gewist(uit.cookies, naam)).toBe(true);
    expect(telling.naar("/auth/v1/token")).toBe(0);
  });

  it("geen sessie van Supabase (vorm): geen enkel verzoek naar Supabase, en het cookie gaat weg", async () => {
    const { instellingen, naam } = project();
    const telling = supabase(() => undefined);
    for (const Cookie of [
      sessiecookie(naam, nepJwt(verlopen()), "geen verversing met spaties"),
      sessiecookie(naam, nepJwt(verlopen()), "x".repeat(513)),
      `${naam}=base64-${b64("geen json")}`,
      `${naam}=base64-${b64(JSON.stringify({ access_token: "a.b.c", refresh_token: "x" }))}`,
      sessiecookie(naam, nepJwt({ sub: "klant-1" }, "none")),
      sessiecookie(naam, nepJwt({ exp: 1 })),
      sessiecookie(naam, nepJwt(verlopen()), ""),
    ]) {
      const uit = await wieIsEr(instellingen, Cookie);
      expect(uit.id, Cookie.slice(0, 60)).toBeNull();
      expect(gewist(uit.cookies, naam), Cookie.slice(0, 60)).toBe(true);
    }
    expect(telling.alles()).toBe(0);
  });

  it("een echt, verlopen token wordt wel ververst, met één verzoek", async () => {
    const { instellingen, naam } = project();
    const echt = await sleutelpaar("echte-sleutel");
    const vers = await echt.teken({ ...verlopen(), exp: Math.floor(Date.now() / 1000) + 3600 });
    const telling = supabase(
      (adres) => (adres.pathname.endsWith("/auth/v1/token") ? nieuweSessie(vers) : undefined),
      { keys: [echt.jwk] },
    );
    const uit = await wieIsEr(instellingen, sessiecookie(naam, await echt.teken(verlopen())));
    expect(uit.id).toBe("klant-1");
    expect(telling.naar("/auth/v1/token")).toBe(1);
    expect(uit.cookies.some((c) => c.startsWith(`${naam}=base64-`))).toBe(true);
  });

  it("restrisico: een project dat nog met het gedeelde geheim tekent (HS256, geen openbare sleutels in de lijst), kan de server niet zelf controleren; zo'n cookie gaat na de vormcontrole naar Supabase", async () => {
    const { instellingen, naam } = project();
    const telling = supabase(
      (adres) =>
        adres.pathname.endsWith("/auth/v1/token")
          ? Response.json({ code: 400, error_code: "refresh_token_not_found" }, { status: 400 })
          : undefined,
      { keys: [] },
    );
    await wieIsEr(instellingen, sessiecookie(naam, nepJwt(verlopen())));
    expect(telling.naar("/auth/v1/token")).toBe(1);
  });
});

describe("haperen bij Supabase is niet uitloggen", () => {
  for (const [wat, antwoord] of [
    [
      "te veel verzoeken (429)",
      () =>
        Response.json(
          { code: 429, error_code: "over_request_rate_limit", msg: "Request rate limit reached" },
          { status: 429 },
        ),
    ],
    ["een storing (503)", () => new Response("weg", { status: 503 })],
    [
      "geen verbinding",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ] as const) {
    it(`${wat}: niet ingelogd voor dit verzoek, maar het cookie van de klant blijft staan`, async () => {
      for (const soort of ["ES256", "HS256"] as const) {
        const { instellingen, naam } = project();
        const echt = await sleutelpaar("echte-sleutel");
        // HS256 kan alleen in een project zonder openbare sleutels (anders weigert de server
        // het token zelf, zie server-sessie-sleutels.test.ts).
        supabase((adres) => (adres.pathname.endsWith("/auth/v1/token") ? antwoord() : undefined), {
          keys: soort === "ES256" ? [echt.jwk] : [],
        });
        const token = soort === "ES256" ? await echt.teken(verlopen()) : nepJwt(verlopen());
        const uit = await wieIsEr(instellingen, sessiecookie(naam, token));
        expect(uit.id, soort).toBeNull();
        expect(gewist(uit.cookies, naam), soort).toBe(false);
      }
    }, 20_000);
  }

  it("een afgewezen verversing (400: de sessie bestaat niet meer) wist het cookie wel", async () => {
    const { instellingen, naam } = project();
    const echt = await sleutelpaar("echte-sleutel");
    supabase(
      (adres) =>
        adres.pathname.endsWith("/auth/v1/token")
          ? Response.json({ code: 400, error_code: "refresh_token_not_found" }, { status: 400 })
          : undefined,
      { keys: [echt.jwk] },
    );
    const uit = await wieIsEr(instellingen, sessiecookie(naam, await echt.teken(verlopen())));
    expect(uit.id).toBeNull();
    expect(gewist(uit.cookies, naam)).toBe(true);
  });
});
