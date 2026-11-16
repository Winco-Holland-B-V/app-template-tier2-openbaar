// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { gebruiker } from "../../src/lib/server/sessie.server";
import {
  cookieOverHttps,
  sessieCookieNaam,
  sessieCookieOpties,
} from "../../src/lib/server/sessie-cookie";
import { INSTELLINGEN, type Route, sessieCookie, vraag } from "./server-hulp";

/**
 * Het sessiecookie (aanval uit uitgave 43: sessie vastzetten vanaf een zusterdomein).
 *
 * Het cookie is bewust niet HttpOnly: de schermen in de browser praten zelf met Supabase en
 * hebben de sessie nodig (de Content-Security-Policy beschermt hem tegen vreemde scripts).
 * Zonder voorvoegsel kon een ander adres onder hetzelfde domein (een gekaapt
 * `blog.klant.nl`) een cookie voor `.klant.nl` zetten dat de app dan meekreeg. Over https
 * heet het cookie nu `__Host-...`: dat neemt de browser alleen aan van precies dit adres, en
 * een cookie zonder voorvoegsel leest de app niet.
 *
 * Deze test is van de template.
 */
const APP = "https://shop.klant.nl";
const KLANT = { sub: "klant-1", email: "klant@voorbeeld.nl" };

afterEach(() => vi.unstubAllGlobals());

/** Supabase bevestigt elk token als dat van de klant: alleen de naam van het cookie telt dan. */
function supabaseKentDeKlant() {
  const vragen = vi.fn(async () =>
    Response.json({
      id: "klant-1",
      email: "klant@voorbeeld.nl",
      aud: "authenticated",
      role: "authenticated",
    }),
  );
  vi.stubGlobal("fetch", vragen);
  return vragen;
}

const wieBenIk: Route = async (_request, context) => Response.json(await gebruiker(context));

describe("het sessiecookie", () => {
  it("over https: __Host-, Secure, Path=/ en geen Domain; niet HttpOnly (bewust)", () => {
    const opties = sessieCookieOpties(true, INSTELLINGEN.supabaseUrl ?? "");
    expect(opties.name).toBe("__Host-sb-abcdefghijklmnopqrst-auth-token");
    expect(opties).toMatchObject({ path: "/", secure: true, sameSite: "lax", httpOnly: false });
    expect(opties).not.toHaveProperty("domain");
  });

  it("over http op de eigen computer: zonder voorvoegsel, want __Host- eist https", () => {
    const lokaal = cookieOverHttps(new URL("http://127.0.0.1:4173/"));
    expect(lokaal).toBe(false);
    expect(sessieCookieNaam("http://127.0.0.1:54321", lokaal)).toBe("sb-127-auth-token");
    expect(sessieCookieOpties(lokaal, "http://127.0.0.1:54321")).toMatchObject({
      name: "sb-127-auth-token",
      secure: false,
    });
  });

  it("de aanval: een cookie zonder voorvoegsel (zoals een zusterdomein het zet) maakt niemand ingelogd", async () => {
    supabaseKentDeKlant();
    const zonderVoorvoegsel = sessieCookie(KLANT, "HS256", "sb-abcdefghijklmnopqrst-auth-token");
    const antwoord = await vraag(`${APP}/wie`, wieBenIk, {
      init: { headers: { Cookie: zonderVoorvoegsel } },
    });
    expect(await antwoord.json()).toBeNull();
  });

  it("ter vergelijking: hetzelfde cookie met __Host- is de ingelogde klant", async () => {
    supabaseKentDeKlant();
    const antwoord = await vraag(`${APP}/wie`, wieBenIk, {
      init: { headers: { Cookie: sessieCookie(KLANT) } },
    });
    expect(await antwoord.json()).toMatchObject({ id: "klant-1" });
  });

  it("op de eigen computer (http) werkt het cookie zonder voorvoegsel gewoon", async () => {
    supabaseKentDeKlant();
    const antwoord = await vraag("http://localhost:4173/wie", wieBenIk, {
      init: {
        headers: { Cookie: sessieCookie(KLANT, "HS256", "sb-abcdefghijklmnopqrst-auth-token") },
      },
    });
    expect(await antwoord.json()).toMatchObject({ id: "klant-1" });
  });

  it("een nagemaakt cookie (Supabase wijst het token af) geeft geen ingelogde gebruiker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "invalid token" }, { status: 401 })),
    );
    const antwoord = await vraag(`${APP}/wie`, wieBenIk, {
      init: { headers: { Cookie: sessieCookie({ sub: "indringer", email: "x@x.nl" }) } },
    });
    expect(await antwoord.json()).toBeNull();
  });
});

describe("de geheime helft van een inlog via een inlogdienst (PKCE)", () => {
  it("staat in een cookie dat geen script kan lezen en dat een kwartier leeft; het sessiecookie blijft zoals het was", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({})),
    );
    const { supabaseVoorVerzoek } = await import("../../src/lib/server/sessie.server");
    const antwoord = await vraag(`${APP}/login`, async (_request, context) => {
      const { data } = await supabaseVoorVerzoek(context).auth.signInWithOAuth({
        provider: "github",
        options: { redirectTo: `${APP}/login/terug`, skipBrowserRedirect: true },
      });
      return Response.json(data.url);
    });
    const cookies = antwoord.headers.getSetCookie();
    const geheim = cookies.filter((c) => (c.split("=")[0] ?? "").endsWith("-code-verifier"));
    expect(geheim.length).toBeGreaterThan(0);
    expect(geheim).toHaveLength(cookies.length);
    for (const cookie of geheim) {
      expect(cookie.startsWith("__Host-sb-abcdefghijklmnopqrst-auth-token")).toBe(true);
      expect(cookie).toMatch(/; HttpOnly/i);
      expect(cookie).toMatch(/Max-Age=900(;|$)/i);
      expect(cookie).toMatch(/; Secure/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).not.toMatch(/Domain=/i);
    }
    // Een antwoord dat zo'n cookie zet, komt nooit in een cache.
    expect(antwoord.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("weghalen blijft weghalen: een leeg cookie krijgt geen nieuwe levensduur", async () => {
    const sessie = {
      access_token: "kop.inhoud.handtekening",
      refresh_token: "verversing",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: "klant-1", email: "klant@voorbeeld.nl" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(sessie)),
    );
    const { supabaseVoorVerzoek } = await import("../../src/lib/server/sessie.server");
    const naam = "__Host-sb-abcdefghijklmnopqrst-auth-token-code-verifier";
    const waarde = `base64-${Buffer.from(JSON.stringify("geheime-helft")).toString("base64url")}`;
    const antwoord = await vraag(
      `${APP}/login/terug`,
      async (_request, context) => {
        const { error } =
          await supabaseVoorVerzoek(context).auth.exchangeCodeForSession("code-1234");
        return Response.json(error?.message ?? null);
      },
      { init: { headers: { Cookie: `${naam}=${waarde}` } } },
    );
    expect(await antwoord.json()).toBeNull();
    const cookies = antwoord.headers.getSetCookie();
    expect(cookies.find((c) => c.startsWith(`${naam}=`))).toMatch(/Max-Age=0/i);
    // Het sessiecookie zelf is niet HttpOnly (de schermen in de browser hebben het nodig).
    const sessiecookie = cookies.find((c) =>
      c.startsWith("__Host-sb-abcdefghijklmnopqrst-auth-token="),
    );
    expect(sessiecookie).toBeDefined();
    expect(sessiecookie).not.toMatch(/HttpOnly/i);
  });
});
