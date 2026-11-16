// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { gebruiker, openbaarCache } from "../../src/lib/server/sessie.server";
import { verzoekContext } from "../../src/lib/server/verzoek.server";
import { html, type Route, sessieCookie, vraag } from "./server-hulp";

/**
 * Aanval: een pagina die voor een ingelogde klant is gemaakt (met zijn prijs erop) bij een
 * anonieme bezoeker laten uitkomen, via een cache.
 *
 * De regel (src/lib/server/cache.server.ts): een antwoord is `private, no-store`, tenzij de
 * route om een openbare cache vroeg én het verzoek geen cookie of inlog had én het antwoord
 * geen cookie zet. De Worker dwingt dat af, wat de route zelf ook in de headers zet.
 *
 * Wat dit bewijst en wat niet. Deze tests draaien de echte Worker-laag van de template met
 * een nagebootste route, en een kleine cache die zich aan de standaard houdt (bewaart niets
 * met `private` of `no-store`, en houdt `Vary` aan). Dat bewijst dat geen enkele cache die
 * de standaard volgt de pagina van de klant aan een ander geeft. Cloudflare zelf bewaart
 * een antwoord van een Worker niet, tenzij de servercode daar uitdrukkelijk om vraagt (de
 * Cache API), en de template doet dat nergens. De echte Worker in de echte Workers-omgeving
 * staat in e2e/server-sessie.spec.ts.
 */
const APP = "https://shop.klant.nl";
const KLANT = sessieCookie({ sub: "klant-1", email: "klant@voorbeeld.nl" });

/** Supabase zegt bij elk token: klopt, dit is klant-1. */
function supabaseKentDeKlant() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        id: "klant-1",
        email: "klant@voorbeeld.nl",
        aud: "authenticated",
        role: "authenticated",
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Een productpagina: openbaar, maar een ingelogde klant ziet zijn eigen prijs. */
const productpagina: Route = async (_request, context) => {
  openbaarCache(context, { seconden: 300 });
  const wie = await gebruiker(context);
  return html(
    wie ? `Tuinstoel. Jouw prijs: 41,50 (${wie.email})` : "Tuinstoel. Log in voor je prijs.",
    {
      // De route vraagt zelf ook nog om een lange openbare cache.
      headers: {
        "Cache-Control": "public, max-age=31536000, s-maxage=31536000",
        Expires: "Thu, 01 Jan 2099 00:00:00 GMT",
      },
    },
  );
};

/**
 * Een cache tussen bezoeker en server die zich aan de standaard houdt: bewaart alleen wat
 * `public` is en geen `no-store` of `private` heeft, en geeft een bewaard antwoord alleen
 * terug als de headers uit `Vary` gelijk zijn.
 */
function gedeeldeCache() {
  const bewaard = new Map<
    string,
    { vary: Record<string, string | null>; body: string; headers: Headers }
  >();
  return async (adres: string, headers: Record<string, string>, route: Route) => {
    const hit = bewaard.get(adres);
    if (
      hit &&
      Object.entries(hit.vary).every(([naam, waarde]) => (headers[naam] ?? null) === waarde)
    ) {
      return { body: hit.body, uitCache: true };
    }
    const antwoord = await vraag(adres, route, { init: { headers } });
    const body = await antwoord.text();
    const cc = (antwoord.headers.get("Cache-Control") ?? "").toLowerCase();
    if (
      /\bpublic\b/.test(cc) &&
      !/no-store|private|no-cache/.test(cc) &&
      !antwoord.headers.has("Set-Cookie")
    ) {
      const vary = Object.fromEntries(
        (antwoord.headers.get("Vary") ?? "")
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean)
          .map((naam) => [naam, headers[naam] ?? null]),
      );
      bewaard.set(adres, { vary, body, headers: antwoord.headers });
    }
    return { body, uitCache: false };
  };
}

describe("aanval: de pagina van een ingelogde klant bij een anonieme bezoeker (cache)", () => {
  it("met een sessie is het antwoord private, no-store, ook al vraagt de route om openbaar", async () => {
    supabaseKentDeKlant();
    const antwoord = await vraag(`${APP}/product/tuinstoel`, productpagina, {
      init: { headers: { Cookie: KLANT } },
    });
    expect(await antwoord.text()).toContain("Jouw prijs: 41,50");
    expect(antwoord.headers.get("Cache-Control")).toBe("private, no-store");
    expect(antwoord.headers.get("Expires")).toBeNull();
    expect(antwoord.headers.get("Vary")).toContain("Cookie");
  });

  it("zonder sessie krijgt dezelfde pagina de openbare cache waar de route om vroeg, met Vary", async () => {
    const antwoord = await vraag(`${APP}/product/tuinstoel`, productpagina);
    expect(await antwoord.text()).toContain("Log in voor je prijs");
    expect(antwoord.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(antwoord.headers.get("Vary")).toBe("Cookie, Authorization, Cf-Access-Jwt-Assertion");
  });

  it("eerst de klant, dan een anonieme bezoeker via een gedeelde cache: de prijs komt er nooit uit", async () => {
    supabaseKentDeKlant();
    const cache = gedeeldeCache();
    const adres = `${APP}/product/tuinstoel`;
    for (let ronde = 0; ronde < 5; ronde++) {
      const klant = await cache(adres, { Cookie: KLANT }, productpagina);
      expect(klant.body).toContain("Jouw prijs: 41,50");
      expect(klant.uitCache).toBe(false);
      const anoniem = await cache(adres, {}, productpagina);
      expect(anoniem.body).not.toContain("41,50");
      expect(anoniem.body).not.toContain("klant@voorbeeld.nl");
    }
    // En andersom werkt de cache wel: de tweede anonieme bezoeker krijgt de bewaarde pagina.
    expect((await cache(adres, {}, productpagina)).uitCache).toBe(true);
    // De klant krijgt die bewaarde anonieme pagina niet: zijn verzoek heeft een cookie.
    expect((await cache(adres, { Cookie: KLANT }, productpagina)).body).toContain("Jouw prijs");
  });

  it("geldt ook voor de gegevensverzoeken van React Router (.data)", async () => {
    supabaseKentDeKlant();
    const gegevens: Route = async (_request, context) => {
      openbaarCache(context, { seconden: 300 });
      const wie = await gebruiker(context);
      return new Response(JSON.stringify({ prijs: wie ? "41,50" : null }), {
        headers: { "Content-Type": "text/x-script", "Cache-Control": "public, max-age=600" },
      });
    };
    const cache = gedeeldeCache();
    const adres = `${APP}/product/tuinstoel.data?_routes=routes%2Fproduct`;
    expect((await cache(adres, { Cookie: KLANT }, gegevens)).body).toContain("41,50");
    expect((await cache(adres, {}, gegevens)).body).not.toContain("41,50");
    const metSessie = await vraag(adres, gegevens, { init: { headers: { Cookie: KLANT } } });
    expect(metSessie.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("elk cookie telt als een sessie, ook een dat niet van Supabase is of dat niet klopt", async () => {
    for (const Cookie of [
      "winkelwagen=abc",
      "CF_Authorization=xyz",
      "sb-abcdefghijklmnopqrst-auth-token=kapot",
      "a=1; b=2",
    ]) {
      const antwoord = await vraag(`${APP}/product/tuinstoel`, productpagina, {
        init: { headers: { Cookie } },
      });
      expect(antwoord.headers.get("Cache-Control"), Cookie).toBe("private, no-store");
    }
  });

  it("een Authorization-header of een inlog van Cloudflare Access telt als een sessie", async () => {
    for (const headers of [
      { Authorization: "Bearer iets" },
      { "Cf-Access-Jwt-Assertion": "iets" },
    ] as Record<string, string>[]) {
      const antwoord = await vraag(`${APP}/product/tuinstoel`, productpagina, {
        init: { headers },
      });
      expect(antwoord.headers.get("Cache-Control")).toBe("private, no-store");
    }
  });

  it("zonder uitdrukkelijke vraag van de route is elk antwoord private, no-store", async () => {
    for (const cc of [
      "public, max-age=600",
      "public, s-maxage=600",
      "max-age=600",
      "public, immutable, max-age=31536000",
      "",
    ]) {
      const antwoord = await vraag(`${APP}/`, () =>
        html("hoi", {
          headers: {
            "Cache-Control": cc,
            "CDN-Cache-Control": "max-age=600",
            "Cloudflare-CDN-Cache-Control": "max-age=600",
            "Surrogate-Control": "max-age=600",
          },
        }),
      );
      expect(antwoord.headers.get("Cache-Control"), cc).toBe("private, no-store");
      expect(antwoord.headers.get("CDN-Cache-Control")).toBeNull();
      expect(antwoord.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
      expect(antwoord.headers.get("Surrogate-Control")).toBeNull();
    }
  });

  it("een antwoord dat een cookie zet, is nooit openbaar: van de route zelf of van Supabase", async () => {
    const zelf = await vraag(`${APP}/`, (_request, context) => {
      openbaarCache(context, { seconden: 300 });
      return html("hoi", { headers: { "Set-Cookie": "winkelwagen=abc; Path=/" } });
    });
    expect(zelf.headers.get("Cache-Control")).toBe("private, no-store");
    const supabase = await vraag(`${APP}/`, (_request, context) => {
      openbaarCache(context, { seconden: 300 });
      context
        .get(verzoekContext)
        ?.cookiesUit.push("sb-x-auth-token=nieuw; Path=/; SameSite=Lax; Secure");
      return html("hoi");
    });
    expect(supabase.headers.get("Cache-Control")).toBe("private, no-store");
    expect(supabase.headers.get("Set-Cookie")).toContain("sb-x-auth-token=nieuw");
  });

  it("een omleiding, een fout, een 404 en een POST zijn nooit openbaar", async () => {
    const vraagt =
      (antwoord: Response): Route =>
      (_request, context) => {
        openbaarCache(context, { seconden: 300 });
        return antwoord;
      };
    for (const antwoord of [
      new Response(null, { status: 302, headers: { Location: "/login" } }),
      new Response("weg", { status: 404 }),
      new Response("stuk", { status: 500 }),
      new Response(null, { status: 204 }),
    ]) {
      expect((await vraag(`${APP}/x`, vraagt(antwoord))).headers.get("Cache-Control")).toBe(
        "private, no-store",
      );
    }
    const post = await vraag(`${APP}/x`, vraagt(html("ok")), {
      init: { method: "POST", headers: { Origin: APP } },
    });
    expect(post.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("Vary: * van een route blijft staan; een bestaande Vary wordt aangevuld, niet vervangen", async () => {
    const ster = await vraag(`${APP}/`, () => html("x", { headers: { Vary: "*" } }));
    expect(ster.headers.get("Vary")).toBe("*");
    const taal = await vraag(`${APP}/`, () =>
      html("x", { headers: { Vary: "Accept-Language, cookie" } }),
    );
    expect(taal.headers.get("Vary")).toBe(
      "Accept-Language, cookie, Authorization, Cf-Access-Jwt-Assertion",
    );
  });

  it("openbaarCache weigert onzin: geen negatieve of oneindige tijd, hoogstens een dag", async () => {
    for (const [seconden, verwacht] of [
      [-5, "private, no-store"],
      [0, "private, no-store"],
      [Number.NaN, "private, no-store"],
      [Number.POSITIVE_INFINITY, "private, no-store"],
      [10.9, "public, max-age=10"],
      [9_999_999, "public, max-age=86400"],
    ] as [number, string][]) {
      const antwoord = await vraag(`${APP}/`, (_request, context) => {
        openbaarCache(context, { seconden });
        return html("x");
      });
      expect(antwoord.headers.get("Cache-Control"), String(seconden)).toBe(verwacht);
    }
  });
});
