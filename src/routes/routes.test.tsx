// @vitest-environment node
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * De buitenkant van de app, met en zonder database (`heeftDatabase` in lib/env.ts, dus met en
 * zonder de Supabase-waarden), en wat er gebeurt als de omgeving niet klopt. De server maakt
 * de pagina: deze tests renderen zoals de server dat doet, zonder browser.
 */
async function laad(omgeving: Record<string, string> = {}) {
  vi.resetModules();
  for (const [naam, waarde] of Object.entries(omgeving)) vi.stubEnv(naam, waarde);
  const hulp = await import("../../tests/unit/server-hulp");
  const env = await import("@/lib/env");
  const root = await import("../root");
  const winkel = await import("./winkel/layout");
  const inlog = await import("@/features/auth/inloggen.server");
  return { hulp, env, root, Winkel: winkel.default, inlog };
}

/** De winkel op `/`, met een lege pagina erin: alleen de buitenkant telt hier. */
function opStart(Winkel: () => React.ReactNode) {
  const Stub = createRoutesStub([
    { Component: Winkel, children: [{ index: true, Component: () => <p>de producten</p> }] },
  ]);
  return renderToString(<Stub initialEntries={["/"]} />);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("zonder database", () => {
  const ZONDER = { VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "" };

  it("/ is de startpagina, kant-en-klaar van de server", async () => {
    const { Winkel } = await laad(ZONDER);
    const html = opStart(Winkel);
    expect(html).toContain("Welkom");
    expect(html).not.toContain("de producten");
  });

  it("/login en /login/terug sturen op de server door naar /: er valt niets in te loggen", async () => {
    const { hulp, inlog } = await laad(ZONDER);
    const instellingen = { ...hulp.INSTELLINGEN, supabaseUrl: null, supabaseAnonKey: null };
    for (const [pad, doe] of [
      ["/login", inlog.inlogstand],
      ["/login/terug?code=abcdefgh", inlog.terugVanDienst],
    ] as const) {
      const antwoord = await hulp.vraag(
        `https://shop.klant.nl${pad}`,
        async (request, context) => {
          try {
            return Response.json(await doe(context, request));
          } catch (gegooid) {
            if (gegooid instanceof Response) return gegooid;
            throw gegooid;
          }
        },
        { instellingen },
      );
      expect(antwoord.status, pad).toBe(302);
      expect(antwoord.headers.get("Location"), pad).toBe("/");
    }
  });
});

describe("met database", () => {
  it("/ is de winkel, met de kop, de pagina erin en de link naar het account", async () => {
    const { Winkel } = await laad();
    const html = opStart(Winkel);
    expect(html).toContain("de producten");
    expect(html).toContain('aria-label="Winkel"');
    expect(html).toContain('href="/login"');
    expect(html).not.toContain("Welkom");
  });
});

describe("een fout in de omgeving", () => {
  it("geeft op elk adres het scherm 'Deze app kan niet starten', met wat er mis is en zonder details van de server", async () => {
    const { env, root } = await laad({ VITE_INLOGDIENST: "cloudflare,okta" });
    expect(env.envFout).toContain('VITE_INLOGDIENST kent "okta" niet');
    // De app laadt wel (anders gaf elke pagina een kale serverfout), zonder database.
    expect(env.heeftDatabase).toBe(false);
    expect(env.inlogdiensten).toEqual(["wachtwoord"]);

    // De loader van de buitenkant stopt elk verzoek, met status 500.
    let gegooid: unknown;
    try {
      await root.loader({} as Parameters<typeof root.loader>[0]);
    } catch (fout) {
      gegooid = fout;
    }
    expect(gegooid).toMatchObject({ init: { status: 500 } });

    const scherm = renderToString(
      <root.ErrorBoundary error={gegooid} params={{}} loaderData={undefined} />,
    );
    expect(scherm).toContain("Deze app kan niet starten");
    expect(scherm).toContain("VITE_INLOGDIENST kent &quot;okta&quot; niet");
    expect(scherm).not.toContain("    at ");
    expect(root.meta({ error: gegooid } as Parameters<typeof root.meta>[0])).toContainEqual({
      title: "Deze app kan niet starten",
    });
  });

  it("zonder fout is er geen startscherm, en een gewone fout blijft 'Er ging iets mis'", async () => {
    const { env, root } = await laad();
    expect(env.envFout).toBeNull();
    const scherm = renderToString(
      <root.ErrorBoundary error={new Error("geheim detail")} params={{}} loaderData={undefined} />,
    );
    expect(scherm).toContain("Er ging iets mis");
    expect(scherm).not.toContain("Deze app kan niet starten");
  });
});
