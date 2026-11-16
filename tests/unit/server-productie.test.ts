// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  geldigProductiedomein,
  isProductie,
  leesInstellingen,
} from "../../src/lib/server/instellingen.server";
import { html, INSTELLINGEN, vraag } from "./server-hulp";

/**
 * Aanval: een preview of een workers.dev-adres in een zoekmachine krijgen. Alleen het
 * echte domein van de app mag erin; elk ander adres krijgt `X-Robots-Tag: noindex, nofollow`
 * en een robots.txt die alles weigert, wat de app zelf ook zegt.
 */
const NIET_PRODUCTIE = [
  "https://cf-proef.stagetwo.workers.dev/",
  "https://pr-12-cf-proef.stagetwo.workers.dev/",
  "https://actueel-cf-proef.stagetwo.workers.dev/",
  "https://a1b2c3d4-cf-proef.stagetwo.workers.dev/",
  "http://localhost:5173/",
  "http://127.0.0.1:4173/",
  "https://shop.klant.nl.evil.example/",
  "https://evil-shop.klant.nl/",
  "https://www.shop.klant.nl/",
  "https://klant.nl/",
];

describe("aanval: een preview of workers.dev-adres indexeerbaar maken", () => {
  for (const adres of NIET_PRODUCTIE) {
    it(`${new URL(adres).host}: noindex op de pagina, en een robots.txt die alles weigert`, async () => {
      // De route doet zijn best om wél gevonden te worden.
      const pagina = await vraag(adres, () =>
        html('<meta name="robots" content="index, follow">', {
          headers: { "X-Robots-Tag": "index, follow, all" },
        }),
      );
      expect(pagina.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      const robots = await vraag(
        new URL("/robots.txt", adres).href,
        () => new Response("User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n"),
      );
      expect(robots.status).toBe(200);
      expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
      expect(robots.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    });
  }

  it("ook gegevens, omleidingen, fouten en een onbekend adres krijgen daar noindex", async () => {
    const adres = "https://pr-12-cf-proef.stagetwo.workers.dev";
    for (const route of [
      () => Response.json({}),
      () => new Response(null, { status: 302, headers: { Location: "/" } }),
      () => new Response("weg", { status: 404 }),
    ]) {
      expect((await vraag(`${adres}/x`, route)).headers.get("X-Robots-Tag")).toBe(
        "noindex, nofollow",
      );
    }
    const geweigerd = await vraag(`${adres}/x`, () => html("x"), { init: { method: "POST" } });
    expect(geweigerd.status).toBe(403);
    expect(geweigerd.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("op het echte domein beslist de app: geen noindex van de Worker, en een eigen robots.txt mag", async () => {
    const pagina = await vraag("https://shop.klant.nl/", () => html("hoi"));
    expect(pagina.headers.get("X-Robots-Tag")).toBeNull();
    const eigen = await vraag(
      "https://shop.klant.nl/robots.txt",
      () => new Response("User-agent: *\nDisallow: /mijn\n"),
    );
    expect(await eigen.text()).toContain("Disallow: /mijn");
    const zonder = await vraag(
      "https://shop.klant.nl/robots.txt",
      () => new Response("weg", { status: 404 }),
    );
    expect(zonder.status).toBe(200);
    expect(await zonder.text()).toBe("User-agent: *\nAllow: /\n");
  });

  it("een route op het echte domein mag zichzelf wel uit de zoekmachine houden", async () => {
    const pagina = await vraag("https://shop.klant.nl/mijn", () =>
      html("x", { headers: { "X-Robots-Tag": "noindex" } }),
    );
    expect(pagina.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("de testomgeving is nooit productie, ook niet op het echte domein", async () => {
    const instellingen = { ...INSTELLINGEN, omgeving: "test" };
    const pagina = await vraag("https://shop.klant.nl/", () => html("hoi"), { instellingen });
    expect(pagina.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("zonder eigen domein (de tijdelijke stand) is geen enkel adres productie", async () => {
    const instellingen = { ...INSTELLINGEN, productiedomein: null };
    for (const adres of ["https://shop.klant.nl/", ...NIET_PRODUCTIE]) {
      expect(isProductie(new URL(adres), instellingen)).toBe(false);
    }
  });

  it("de dev-server is nooit productie", () => {
    expect(
      isProductie(new URL("https://shop.klant.nl/"), { ...INSTELLINGEN, mode: "development" }),
    ).toBe(false);
  });

  it("een adres op workers.dev, de eigen computer of met een jokerteken kan nooit het productiedomein zijn", () => {
    for (const waarde of [
      "cf-proef.stagetwo.workers.dev",
      "pr-12-cf-proef.stagetwo.workers.dev",
      "workers.dev",
      "WORKERS.DEV",
      "x.Workers.Dev",
      "localhost",
      "app.localhost",
      "127.0.0.1",
      "*.klant.nl",
      "*",
      "klant.nl/*",
      "https://shop.klant.nl",
      "shop.klant.nl:443",
      "shop klant.nl",
      "",
      " ",
      null,
      undefined,
      12,
      ["shop.klant.nl"],
    ]) {
      expect(geldigProductiedomein(waarde), JSON.stringify(waarde)).toBeNull();
    }
    expect(geldigProductiedomein("Shop.Klant.NL")).toBe("shop.klant.nl");
  });

  it("zet een build een workers.dev-adres als productiedomein, dan blijft dat adres dicht", async () => {
    const instellingen = leesInstellingen(
      { VITE_PRODUCTIEDOMEIN: "pr-12-cf-proef.stagetwo.workers.dev" },
      "production",
    );
    expect(instellingen.productiedomein).toBeNull();
    const pagina = await vraag("https://pr-12-cf-proef.stagetwo.workers.dev/", () => html("x"), {
      instellingen,
    });
    expect(pagina.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("vergelijkt het adres van het verzoek, niet een header: Host en X-Forwarded-Host tellen niet", async () => {
    const pagina = await vraag("https://pr-12-cf-proef.stagetwo.workers.dev/", () => html("x"), {
      init: {
        headers: {
          "X-Forwarded-Host": "shop.klant.nl",
          Forwarded: "host=shop.klant.nl",
          "X-Original-Host": "shop.klant.nl",
        },
      },
    });
    expect(pagina.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });
});
