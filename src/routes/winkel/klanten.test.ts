// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessieCookie, vraag } from "../../../tests/unit/server-hulp";
import { action, loader } from "./klanten";

/**
 * De pagina /klanten voor medewerkers (src/routes/winkel/klanten.tsx): zoeken, filteren en
 * bladeren doet de database, en goedkeuren, afwijzen en intrekken gaan met de sessie van de
 * medewerker (RLS). Supabase is nagebootst op het niveau van `fetch`; de test ziet welke vraag
 * de pagina stelt. Dat de database een niet-medewerker niets laat zien of wijzigen, bewijzen
 * de RLS-tests en e2e/klantportaal.spec.ts.
 */
const APP = "https://shop.klant.nl";
const Cookie = sessieCookie({ sub: "medewerker-1", amr: [{ method: "oauth", timestamp: 1 }] });

afterEach(() => {
  vi.unstubAllGlobals();
});

type Gevraagd = { adres: URL; methode: string; body: string };

function database(o: { medewerker?: boolean; geweigerd?: boolean } = {}) {
  const gevraagd: Gevraagd[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (invoer: RequestInfo | URL, init?: RequestInit) => {
      const request = invoer instanceof Request ? invoer : new Request(String(invoer), init);
      const adres = new URL(request.url);
      gevraagd.push({ adres, methode: request.method, body: await request.text() });
      if (adres.pathname === "/auth/v1/user") {
        return Response.json({ id: "medewerker-1", aud: "authenticated", role: "authenticated" });
      }
      if (adres.pathname === "/rest/v1/rpc/is_medewerker")
        return Response.json(o.medewerker ?? true);
      if (adres.pathname === "/rest/v1/rpc/klant_beoordelen") {
        return o.geweigerd
          ? Response.json(
              { code: "42501", message: "Alleen een medewerker beoordeelt een klant." },
              { status: 403 },
            )
          : new Response(null, { status: 204 });
      }
      if (adres.pathname === "/rest/v1/klanten_overzicht") {
        return Response.json([], { headers: { "Content-Range": "0-0/321" } });
      }
      return Response.json({});
    }),
  );
  return gevraagd;
}

const laad = (pad: string) =>
  vraag(
    `${APP}${pad}`,
    async (request, context) =>
      Response.json(
        await loader({
          request,
          context,
          params: {},
          url: new URL(request.url),
          pattern: "/klanten",
        }),
      ),
    { init: { headers: { Cookie } } },
  );

const verstuur = (velden: Record<string, string>) =>
  vraag(
    `${APP}/klanten`,
    async (request, context) => {
      const uit = await action({
        request,
        context,
        params: {},
        url: new URL(request.url),
        pattern: "/klanten",
      });
      return uit instanceof Response
        ? uit
        : "data" in uit && "init" in uit
          ? Response.json(uit.data, uit.init ?? undefined)
          : Response.json(uit);
    },
    {
      init: {
        method: "POST",
        body: new URLSearchParams(velden),
        headers: {
          Cookie,
          Origin: APP,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    },
  );

const klantenVraag = (gevraagd: Gevraagd[]) =>
  gevraagd.find((v) => v.adres.pathname === "/rest/v1/klanten_overzicht" && v.methode === "GET");

describe("zoeken, filteren en bladeren: de database doet het werk", () => {
  it("zonder zoekvraag: de eerste vijftig, en het totaal", async () => {
    const gevraagd = database();
    const uit = (await (await laad("/klanten")).json()) as { totaal: number };
    expect(uit.totaal).toBe(321);
    const vraag = klantenVraag(gevraagd);
    expect(vraag?.adres.searchParams.get("offset")).toBe("0");
    expect(vraag?.adres.searchParams.get("limit")).toBe("50");
    expect(vraag?.adres.searchParams.get("e_mail")).toBeNull();
  });

  it("zoeken op e-mailadres, op een stand en een pagina verder", async () => {
    const gevraagd = database();
    await laad("/klanten?q=Jan%40Bakker&stand=wacht&pagina=3");
    const vraag = klantenVraag(gevraagd);
    expect(vraag?.adres.searchParams.get("e_mail")).toBe("ilike.%jan@bakker%");
    expect(vraag?.adres.searchParams.get("goedgekeurd")).toBe("eq.false");
    expect(vraag?.adres.searchParams.get("afgewezen")).toBe("eq.false");
    expect(vraag?.adres.searchParams.get("offset")).toBe("100");
  });

  it("een % of _ in de zoekvraag is gewoon dat teken, geen jokerteken; rommel in het adres valt terug op de standaard", async () => {
    const gevraagd = database();
    await laad("/klanten?q=100%25_x&stand=iets&pagina=-4");
    const vraag = klantenVraag(gevraagd);
    expect(vraag?.adres.searchParams.get("e_mail")).toBe("ilike.%100\\%\\_x%");
    expect(vraag?.adres.searchParams.get("goedgekeurd")).toBeNull();
    expect(vraag?.adres.searchParams.get("offset")).toBe("0");
  });

  it("geen medewerker volgens de database: de tabel wordt niet eens gevraagd", async () => {
    const gevraagd = database({ medewerker: false });
    const uit = (await (await laad("/klanten?q=x")).json()) as { klanten: unknown[] };
    expect(uit.klanten).toEqual([]);
    expect(klantenVraag(gevraagd)).toBeUndefined();
  });
});

describe("goedkeuren, afwijzen en intrekken", () => {
  for (const doe of ["goedkeuren", "afwijzen", "intrekken"] as const) {
    it(`${doe}: één aanroep van klant_beoordelen, met de sessie van de medewerker`, async () => {
      const gevraagd = database();
      const id = crypto.randomUUID();
      const antwoord = await verstuur({ doe, user_id: id });
      expect(antwoord.status).toBe(200);
      const wijziging = gevraagd.find((v) => v.adres.pathname === "/rest/v1/rpc/klant_beoordelen");
      expect(wijziging?.methode).toBe("POST");
      expect(JSON.parse(wijziging?.body ?? "{}")).toEqual({ p_klant: id, p_doe: doe });
      // De tabel zelf wijzigt de pagina niet: dat doet de database in één transactie.
      expect(gevraagd.some((v) => v.methode === "PATCH")).toBe(false);
    });
  }

  it("weigert de database (geen medewerker), dan zegt de pagina dat", async () => {
    database({ geweigerd: true });
    const antwoord = await verstuur({ doe: "afwijzen", user_id: crypto.randomUUID() });
    expect(antwoord.status).toBe(403);
  });

  it("een onbekende opdracht of een kapotte id: niets naar de database", async () => {
    const gevraagd = database();
    for (const velden of [
      { doe: "verwijderen", user_id: crypto.randomUUID() },
      { doe: "afwijzen", user_id: "geen-id" },
    ]) {
      expect((await verstuur(velden)).status).toBe(400);
    }
    expect(gevraagd.some((v) => v.adres.pathname.startsWith("/rest/v1/rpc/klant_"))).toBe(false);
  });
});
