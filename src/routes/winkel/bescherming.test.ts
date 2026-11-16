// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessieCookie, vraag } from "../../../tests/unit/server-hulp";
import * as bestellingen from "./bestellingen";
import * as klanten from "./klanten";
import * as product from "./product";
import * as wagen from "./wagen";

/**
 * Bescherming in de routes van de winkel die je kon weghalen zonder dat een test rood werd
 * (de mutaties van de aanval van ronde 2): `vereisGebruiker` in de actions van de wagen en de
 * klantenpagina, het filter op de eigen bestellingen, en de klantprijs alleen voor een
 * goedgekeurde klant. Supabase is nagebootst op het niveau van `fetch`; de test ziet welke vraag
 * de server stelt. Wat de database zelf weigert, bewijzen de RLS-tests.
 */
const APP = "https://shop.klant.nl";
const KLANT = "klant-1";
const Cookie = sessieCookie({ sub: KLANT, email: "klant@klant.nl" });

afterEach(() => {
  vi.unstubAllGlobals();
});

type Gevraagd = { adres: URL; methode: string };

/** De database: wie is goedgekeurd of medewerker, en een paar lege antwoorden. */
function database(o: { goedgekeurd: boolean; medewerker: boolean }) {
  const gevraagd: Gevraagd[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (invoer: RequestInfo | URL, init?: RequestInit) => {
      const request = invoer instanceof Request ? invoer : new Request(String(invoer), init);
      const adres = new URL(request.url);
      gevraagd.push({ adres, methode: request.method });
      const pad = adres.pathname;
      if (pad === "/auth/v1/user")
        return Response.json({ id: KLANT, aud: "authenticated", role: "authenticated" });
      if (pad === "/rest/v1/rpc/is_goedgekeurde_klant") return Response.json(o.goedgekeurd);
      if (pad === "/rest/v1/rpc/is_medewerker") return Response.json(o.medewerker);
      if (pad === "/rest/v1/rpc/openbare_producten")
        return Response.json([
          {
            id: "11111111-1111-4111-8111-111111111111",
            slug: "koffie",
            naam: "Koffie",
            omschrijving: "",
            afbeelding: null,
            basisprijs_centen: 1495,
            op_voorraad: true,
            bijgewerkt_op: "2026-11-13T00:00:00Z",
          },
        ]);
      return Response.json([]);
    }),
  );
  return gevraagd;
}

/** Een loader of action van een route, door de Worker van de template heen. */
function draai(
  pad: string,
  doe: (args: {
    request: Request;
    context: Parameters<Parameters<typeof vraag>[1]>[1];
    url: URL;
    pattern: string;
  }) => Promise<unknown>,
  o: { methode?: "GET" | "POST"; velden?: Record<string, string>; metCookie?: boolean } = {},
) {
  return vraag(
    `${APP}${pad}`,
    async (request, context) => {
      try {
        const uit = await doe({ request, context, url: new URL(request.url), pattern: pad });
        return uit instanceof Response ? uit : Response.json(uit ?? null);
      } catch (gegooid) {
        if (gegooid instanceof Response) return gegooid;
        throw gegooid;
      }
    },
    {
      init: {
        method: o.methode ?? "GET",
        ...(o.velden ? { body: new URLSearchParams(o.velden) } : {}),
        headers: {
          ...(o.metCookie === false ? {} : { Cookie }),
          ...(o.methode === "POST"
            ? { Origin: APP, "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
        },
      },
    },
  );
}

const naarRest = (gevraagd: Gevraagd[]) =>
  gevraagd.filter((v) => v.adres.pathname.startsWith("/rest/"));

describe("een action van de winkel zonder inlog doet niets in de database (vereisGebruiker)", () => {
  it("de wagen: bestellen zonder inlog gaat naar het inloggen, zonder bestelling_plaatsen", async () => {
    const gevraagd = database({ goedgekeurd: true, medewerker: false });
    const antwoord = await draai("/wagen", (a) => wagen.action({ ...a, params: {} }), {
      methode: "POST",
      velden: { doe: "bestellen", sleutel: crypto.randomUUID() },
      metCookie: false,
    });
    expect(antwoord.status).toBe(302);
    expect(antwoord.headers.get("Location")).toMatch(/^\/login\?volgende=%2Fwagen/);
    expect(naarRest(gevraagd)).toEqual([]);
  });

  it("de klantenpagina: goedkeuren zonder inlog gaat naar het inloggen, zonder wijziging", async () => {
    const gevraagd = database({ goedgekeurd: false, medewerker: true });
    const antwoord = await draai("/klanten", (a) => klanten.action({ ...a, params: {} }), {
      methode: "POST",
      velden: { doe: "goedkeuren", user_id: crypto.randomUUID() },
      metCookie: false,
    });
    expect(antwoord.status).toBe(302);
    expect(antwoord.headers.get("Location")).toMatch(/^\/login\?volgende=%2Fklanten/);
    expect(naarRest(gevraagd)).toEqual([]);
  });
});

describe("de eigen bestellingen, ook voor wie medewerker én klant is", () => {
  it("de vraag aan de database filtert op de eigen klant_id (de database geeft een medewerker alles)", async () => {
    const gevraagd = database({ goedgekeurd: true, medewerker: true });
    const antwoord = await draai("/bestellingen", (a) => bestellingen.loader({ ...a, params: {} }));
    expect(antwoord.status).toBe(200);
    const vraag = gevraagd.find((v) => v.adres.pathname === "/rest/v1/bestellingen");
    expect(vraag?.adres.searchParams.get("klant_id")).toBe(`eq.${KLANT}`);
  });
});

describe("een klantprijs alleen voor een goedgekeurde klant", () => {
  it("ingelogd maar niet goedgekeurd: de server vraagt geen klantprijzen op", async () => {
    const gevraagd = database({ goedgekeurd: false, medewerker: false });
    const antwoord = await draai("/producten/koffie", (a) =>
      product.loader({ ...a, params: { slug: "koffie" } }),
    );
    expect(antwoord.status).toBe(200);
    expect(gevraagd.some((v) => v.adres.pathname === "/rest/v1/klantprijzen")).toBe(false);
  });

  it("goedgekeurd: wel", async () => {
    const gevraagd = database({ goedgekeurd: true, medewerker: false });
    await draai("/producten/koffie", (a) => product.loader({ ...a, params: { slug: "koffie" } }));
    expect(gevraagd.some((v) => v.adres.pathname === "/rest/v1/klantprijzen")).toBe(true);
  });
});
