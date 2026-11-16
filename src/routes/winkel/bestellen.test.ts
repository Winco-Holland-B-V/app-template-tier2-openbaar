// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessieCookie, vraag } from "../../../tests/unit/server-hulp";
import * as bestellingen from "./bestellingen";
import * as wagen from "./wagen";

/**
 * Bestellen vanaf de wagenpagina en de bevestiging daarna, met Supabase nagebootst op het niveau
 * van `fetch`. Wat de database zelf doet (de prijs vergelijken, niets plaatsen), bewijzen de
 * RLS-tests in tests/rls/voorbeeldshop.test.ts.
 */
const APP = "https://shop.klant.nl";
const KLANT = "klant-1";
const Cookie = sessieCookie({ sub: KLANT, email: "klant@klant.nl" });
const SLEUTEL = "22222222-2222-4222-8222-222222222222";
const BESTELLING = "33333333-3333-4333-8333-333333333333";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Antwoord = { status: number; body: unknown };

/** De database: per aanroep van bestelling_plaatsen() het volgende antwoord uit de rij. */
function database(o: { bestellen?: Antwoord[]; wagen?: number } = {}) {
  const bestelVragen: unknown[] = [];
  const rij = [...(o.bestellen ?? [])];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (invoer: RequestInfo | URL, init?: RequestInit) => {
      const request = invoer instanceof Request ? invoer : new Request(String(invoer), init);
      const pad = new URL(request.url).pathname;
      if (pad.endsWith("/.well-known/jwks.json")) return Response.json({ keys: [] });
      if (pad === "/auth/v1/user")
        return Response.json({ id: KLANT, aud: "authenticated", role: "authenticated" });
      if (pad === "/rest/v1/rpc/is_goedgekeurde_klant") return Response.json(true);
      if (pad === "/rest/v1/rpc/bestelling_plaatsen") {
        bestelVragen.push(await request.json());
        const volgende = rij.shift() ?? { status: 200, body: BESTELLING };
        return Response.json(volgende.body, { status: volgende.status });
      }
      if (pad === "/rest/v1/wagen_overzicht") {
        const aantal = o.wagen ?? 0;
        return new Response(null, {
          status: 200,
          headers: { "Content-Range": aantal === 0 ? "*/0" : `0-${aantal - 1}/${aantal}` },
        });
      }
      if (pad === "/rest/v1/bestellingen")
        return Response.json([
          {
            id: BESTELLING,
            geplaatst_op: "2026-11-13T09:30:00Z",
            totaal_centen: 2990,
            bestelregels: [{ id: "r1", naam: "Koffiebonen", aantal: 2, stukprijs_centen: 1495 }],
          },
        ]);
      return Response.json([]);
    }),
  );
  return bestelVragen;
}

const fout = (code: string, message: string, details: string | null = null): Antwoord => ({
  status: code === "40P01" ? 500 : 400,
  body: { code, message, details, hint: null },
});

async function bestel(velden: Record<string, string>) {
  return vraag(
    `${APP}/wagen`,
    async (request, context) => {
      try {
        const uit = await wagen.action({
          request,
          context,
          params: {},
          url: new URL(request.url),
          pattern: "/wagen",
        });
        return Response.json(uit ?? null);
      } catch (gegooid) {
        if (gegooid instanceof Response) return gegooid;
        throw gegooid;
      }
    },
    {
      init: {
        method: "POST",
        body: new URLSearchParams(velden),
        headers: { Cookie, Origin: APP, "Content-Type": "application/x-www-form-urlencoded" },
      },
    },
  );
}

/** De melding uit wat de action teruggaf (`data({ melding }, { status })`). */
async function melding(antwoord: Response): Promise<string | null> {
  const uit = (await antwoord.json()) as { data?: { melding?: string } } | null;
  return uit?.data?.melding ?? null;
}

describe("bestellen vanaf de wagenpagina", () => {
  it("stuurt het totaal mee dat de klant zag, als vergelijking", async () => {
    const vragen = database();
    const antwoord = await bestel({ doe: "bestellen", sleutel: SLEUTEL, verwacht: "2990" });
    expect(antwoord.status).toBe(302);
    expect(vragen).toEqual([{ p_sleutel: SLEUTEL, p_verwacht_totaal: 2990 }]);
  });

  it("zonder totaal (een oud formulier, of geknoeid) gaat er niets naar de database", async () => {
    const vragen = database();
    const antwoord = await bestel({ doe: "bestellen", sleutel: SLEUTEL });
    expect(await melding(antwoord)).toBe("Dat ging niet goed. Probeer het opnieuw.");
    expect(vragen).toEqual([]);
  });

  it("de prijs is gewijzigd (SP004): een gewone melding met het nieuwe totaal, geen bestelling", async () => {
    database({ bestellen: [fout("SP004", "De prijs is gewijzigd.", "90000")] });
    const antwoord = await bestel({ doe: "bestellen", sleutel: SLEUTEL, verwacht: "10000" });
    // euro() zet een vaste spatie tussen het teken en het bedrag.
    expect(await melding(antwoord)).toMatch(
      /^De prijs is gewijzigd\. Bekijk je wagen opnieuw\. Het totaal is nu €\s900,00\.$/,
    );
  });

  it("een deadlock (40P01) probeert de pagina één keer opnieuw, met dezelfde sleutel; dan lukt het", async () => {
    const vragen = database({ bestellen: [fout("40P01", "deadlock detected")] });
    const antwoord = await bestel({ doe: "bestellen", sleutel: SLEUTEL, verwacht: "2990" });
    expect(antwoord.status).toBe(302);
    expect(antwoord.headers.get("Location")).toBe(`/bestellingen?geplaatst=${BESTELLING}`);
    expect(vragen).toHaveLength(2);
    expect(vragen[0]).toEqual(vragen[1]);
  });

  it("strandt het twee keer (deadlock, slot of time-out), dan een gewone melding en geen kale fout", async () => {
    for (const code of ["40P01", "55P03", "57014"]) {
      const vragen = database({
        bestellen: [fout(code, "canceling statement"), fout(code, "canceling statement")],
      });
      const antwoord = await bestel({ doe: "bestellen", sleutel: SLEUTEL, verwacht: "2990" });
      expect(await melding(antwoord), code).toBe("Bestellen lukte even niet. Probeer het opnieuw.");
      expect(vragen, code).toHaveLength(2);
    }
  });

  it("te weinig voorraad (SP002): de tekst van de database, die alleen het product noemt", async () => {
    database({
      bestellen: [fout("SP002", "Van Koffiebonen is niet genoeg op voorraad; pas het aantal aan.")],
    });
    const antwoord = await bestel({ doe: "bestellen", sleutel: SLEUTEL, verwacht: "2990" });
    expect(await melding(antwoord)).toBe(
      "Van Koffiebonen is niet genoeg op voorraad; pas het aantal aan.",
    );
  });
});

describe("de bevestiging na het bestellen", () => {
  async function bevestiging() {
    const antwoord = await vraag(
      `${APP}/bestellingen?geplaatst=${BESTELLING}`,
      async (request, context) =>
        Response.json(
          await bestellingen.loader({
            request,
            context,
            params: {},
            url: new URL(request.url),
            pattern: "/bestellingen",
          }),
        ),
      { init: { headers: { Cookie } } },
    );
    return (await antwoord.json()) as { geplaatst: string | null; inWagen: number };
  }

  it("zegt hoeveel regels er nog in de wagen liggen: die zijn niet besteld (dezelfde sleutel met een andere wagen geeft de oude bestelling)", async () => {
    database({ wagen: 3 });
    const uit = await bevestiging();
    expect(uit.geplaatst).toBe(BESTELLING);
    expect(uit.inWagen).toBe(3);
  });

  it("een lege wagen: niets te melden", async () => {
    database({ wagen: 0 });
    expect((await bevestiging()).inWagen).toBe(0);
  });
});
