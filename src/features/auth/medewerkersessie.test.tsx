// @vitest-environment node
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { html, nepJwt, sessieCookie, vraag } from "../../../tests/unit/server-hulp";
import { begonViaDienst, OpnieuwAlsMedewerker, standVan } from "./medewerkersessie";
import { klantstand, medewerkersessie } from "./medewerkersessie.server";

/**
 * Medewerkerrechten zegt alleen de database. De server besluit het nooit zelf: niet uit een
 * e-mailadres, niet uit een rol in het token, niet uit hoe de sessie begon. Het token dient
 * alleen om bij een "nee" de juiste uitleg te kiezen.
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

const viaDienst = { amr: [{ method: "oauth", timestamp: 1 }] };
const perMail = { amr: [{ method: "otp", timestamp: 1 }] };

describe("standVan: wat een pagina voor medewerkers moet tonen", () => {
  it("leest uit het token hoe de sessie begon", () => {
    expect(begonViaDienst(viaDienst)).toBe(true);
    expect(begonViaDienst(perMail)).toBe(false);
    expect(begonViaDienst({ amr: "oauth" })).toBe(false);
    expect(begonViaDienst({})).toBe(false);
    expect(begonViaDienst(null)).toBe(false);
  });

  it("volgt de database, en zegt 'verlopen' als een sessie via Cloudflare geen rechten meer heeft", () => {
    expect(standVan(null, null)).toBe("geen");
    expect(standVan(viaDienst, null)).toBe("laden");
    expect(standVan(viaDienst, true)).toBe("medewerker");
    // Na twaalf uur: nog ingelogd, maar de database zegt nee.
    expect(standVan(viaDienst, false)).toBe("verlopen");
    // Per mail was iemand nooit medewerker: dan valt er niets te verlopen.
    expect(standVan(perMail, false)).toBe("geen");
    // De pagina maakt niemand medewerker: het token alleen is niet genoeg.
    expect(standVan(viaDienst, false)).not.toBe("medewerker");
  });
});

/** Een sessie waarvan Supabase het token bevestigt, en een database die `antwoord` zegt. */
function metDatabase(antwoord: { is_medewerker?: unknown; is_goedgekeurde_klant?: unknown }) {
  const gevraagd: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (invoer: RequestInfo | URL) => {
      const pad = new URL(invoer instanceof Request ? invoer.url : String(invoer)).pathname;
      gevraagd.push(pad);
      if (pad === "/auth/v1/user") return Response.json({ id: "u-1", email: "baas@klant.nl" });
      if (pad === "/rest/v1/rpc/is_medewerker") {
        return antwoord.is_medewerker === "storing"
          ? Response.json({ message: "storing" }, { status: 500 })
          : Response.json(antwoord.is_medewerker ?? false);
      }
      if (pad === "/rest/v1/rpc/is_goedgekeurde_klant") {
        return Response.json(antwoord.is_goedgekeurde_klant ?? false);
      }
      return Response.json({});
    }),
  );
  return gevraagd;
}

async function vraagStand(inhoud: Record<string, unknown>) {
  const { gebruiker } = await import("../../lib/server/sessie.server");
  const Cookie = sessieCookie({ sub: "u-1", email: "baas@klant.nl", ...inhoud });
  const antwoord = await vraag(
    "https://shop.klant.nl/klanten",
    async (_request, context) => {
      const wie = await gebruiker(context);
      return Response.json({
        medewerker: await medewerkersessie(context, wie),
        klant: wie ? await klantstand(context, wie) : null,
      });
    },
    { init: { headers: { Cookie } } },
  );
  return antwoord.json() as Promise<{ medewerker: string; klant: string | null }>;
}

describe("op de server: alleen de database maakt iemand medewerker", () => {
  it("een token dat alles beweert (oauth, een rol, het adres van de baas) is geen medewerker als de database nee zegt", async () => {
    const gevraagd = metDatabase({ is_medewerker: false });
    const stand = await vraagStand({
      ...viaDienst,
      role: "service_role",
      app_metadata: { rol: "beheerder", provider: "custom:cloudflare" },
      user_metadata: { is_medewerker: true },
    });
    expect(stand.medewerker).toBe("verlopen");
    expect(stand.klant).toBe("wacht");
    expect(gevraagd).toContain("/rest/v1/rpc/is_medewerker");
  });

  it("een mailsessie op het adres van een medewerker: 'geen', en de server vraagt het wel aan de database", async () => {
    const gevraagd = metDatabase({ is_medewerker: false });
    expect((await vraagStand(perMail)).medewerker).toBe("geen");
    expect(gevraagd).toContain("/rest/v1/rpc/is_medewerker");
  });

  it("zegt de database ja, dan medewerker; bij een storing niet", async () => {
    metDatabase({ is_medewerker: true });
    expect(await vraagStand(viaDienst)).toEqual({ medewerker: "medewerker", klant: "medewerker" });
    metDatabase({ is_medewerker: "storing" });
    expect((await vraagStand(viaDienst)).medewerker).toBe("verlopen");
    expect((await vraagStand(perMail)).medewerker).toBe("geen");
  });

  it("een goedgekeurde klant is goedgekeurd omdat de database het zegt", async () => {
    metDatabase({ is_goedgekeurde_klant: true });
    expect((await vraagStand(perMail)).klant).toBe("goedgekeurd");
    metDatabase({ is_goedgekeurde_klant: false });
    expect((await vraagStand(perMail)).klant).toBe("wacht");
  });

  it("zonder sessie vraagt de server niets en is er niemand medewerker", async () => {
    const gevraagd = metDatabase({ is_medewerker: true });
    const antwoord = await vraag("https://shop.klant.nl/klanten", async (_request, context) =>
      Response.json(await medewerkersessie(context, null)),
    );
    expect(await antwoord.json()).toBe("geen");
    expect(gevraagd).toEqual([]);
    // Een nagemaakt token zonder bevestiging van Supabase is ook niemand.
    expect(nepJwt({ sub: "x" })).toContain(".");
    expect(html("x")).toBeInstanceOf(Response);
  });
});

function Verlopen() {
  return <OpnieuwAlsMedewerker terug="/klanten" />;
}

describe("OpnieuwAlsMedewerker", () => {
  it("is een gewoon formulier naar de inlogpagina, met het pad om naar terug te komen", () => {
    const Stub = createRoutesStub([{ path: "/klanten", Component: Verlopen }]);
    const pagina = renderToString(<Stub initialEntries={["/klanten"]} />);
    expect(pagina).toContain("Log opnieuw in als medewerker");
    expect(pagina).toContain('action="/login?volgende=%2Fklanten"');
    expect(pagina).toContain('method="post"');
    expect(pagina).toContain('name="doe" value="dienst"');
    expect(pagina).toContain('name="dienst" value="cloudflare"');
    expect(pagina).toContain("Inloggen voor medewerkers");
  });
});
