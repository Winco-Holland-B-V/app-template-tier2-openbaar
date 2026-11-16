import { renderToString } from "react-dom/server";
import { createRoutesStub, Meta, Outlet } from "react-router";
import { describe, expect, it } from "vitest";
import {
  bedragUitCenten,
  itemListLd,
  kruimelpadLd,
  organisatieLd,
  productLd,
  websiteLd,
} from "./json-ld";
import { inkorten, paginaMeta } from "./meta";
import { robotsTxt, sitemapXml } from "./sitemap";

/**
 * De hulpfuncties voor vindbaarheid. Deze test is van de template en komt met elke versie mee.
 */
const ADRES = "https://winkel.voorbeeld.nl/producten/koffie";

/** Een pagina met alleen de `<Meta />` van React Router, zoals in src/root.tsx. */
function MetSjabloon() {
  return (
    <>
      <Meta />
      <Outlet />
    </>
  );
}

describe("paginaMeta", () => {
  it("zet titel, omschrijving, canonical, og- en twitter-tags in één keer", () => {
    const meta = paginaMeta({
      site: { naam: "Winkel" },
      titel: "Koffie",
      omschrijving: "Hele bonen.",
      adres: ADRES,
      afbeelding: "https://winkel.voorbeeld.nl/koffie.png",
      type: "product",
    });
    expect(meta).toEqual(
      expect.arrayContaining([
        { title: "Koffie · Winkel" },
        { name: "description", content: "Hele bonen." },
        { tagName: "link", rel: "canonical", href: ADRES },
        { property: "og:title", content: "Koffie" },
        { property: "og:description", content: "Hele bonen." },
        { property: "og:url", content: ADRES },
        { property: "og:type", content: "product" },
        { property: "og:image", content: "https://winkel.voorbeeld.nl/koffie.png" },
        { property: "og:site_name", content: "Winkel" },
        { name: "twitter:card", content: "summary_large_image" },
      ]),
    );
    expect(meta.some((m) => "name" in m && m.name === "robots")).toBe(false);
  });

  it("zonder adres geen canonical en geen og:url, in plaats van een verkeerd adres", () => {
    const meta = paginaMeta({ titel: "Niet gevonden", omschrijving: "Weg." });
    expect(JSON.stringify(meta)).not.toContain("canonical");
    expect(JSON.stringify(meta)).not.toContain("og:url");
    expect(meta).toContainEqual({ name: "twitter:card", content: "summary" });
  });

  it("zoekmachines: false geeft noindex", () => {
    const meta = paginaMeta({ titel: "Wagen", omschrijving: "Je wagen.", zoekmachines: false });
    expect(meta).toContainEqual({ name: "robots", content: "noindex, nofollow" });
  });

  it("kort een lange omschrijving af op een woordgrens", () => {
    const lang = "woord ".repeat(60);
    const kort = inkorten(lang);
    expect(kort.length).toBeLessThanOrEqual(160);
    expect(kort.endsWith("woord…")).toBe(true);
    expect(inkorten("  twee\n regels ")).toBe("twee regels");
  });
});

describe("JSON-LD", () => {
  it("bedragen gaan van centen naar een punt, zonder afrondfout", () => {
    expect(bedragUitCenten(1495)).toBe("14.95");
    expect(bedragUitCenten(5)).toBe("0.05");
    expect(bedragUitCenten(0)).toBe("0.00");
    expect(() => bedragUitCenten(14.95)).toThrow();
    expect(() => bedragUitCenten(-1)).toThrow();
  });

  it("Product met Offer: prijs, valuta, voorraad, adres", () => {
    const ld = productLd({
      naam: "Koffie",
      omschrijving: "Hele bonen.",
      adres: ADRES,
      afbeelding: "https://winkel.voorbeeld.nl/koffie.png",
      sku: "koffie",
      prijsCenten: 1495,
      opVoorraad: false,
    });
    expect(ld).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Koffie",
      sku: "koffie",
      image: ["https://winkel.voorbeeld.nl/koffie.png"],
      offers: {
        "@type": "Offer",
        price: "14.95",
        priceCurrency: "EUR",
        availability: "https://schema.org/OutOfStock",
        url: ADRES,
      },
    });
  });

  it("ItemList, BreadcrumbList, Organization en WebSite tellen vanaf 1", () => {
    const lijst = itemListLd([
      { naam: "A", adres: "https://x.nl/a" },
      { naam: "B", adres: "https://x.nl/b" },
    ]);
    expect(lijst).toMatchObject({
      "@type": "ItemList",
      numberOfItems: 2,
      itemListElement: [
        { "@type": "ListItem", position: 1, url: "https://x.nl/a" },
        { position: 2, name: "B" },
      ],
    });
    expect(kruimelpadLd([{ naam: "Producten", adres: "https://x.nl/p" }])).toMatchObject({
      "@type": "BreadcrumbList",
      itemListElement: [{ position: 1, name: "Producten", item: "https://x.nl/p" }],
    });
    expect(organisatieLd({ naam: "W", adres: "https://x.nl/" })).toEqual({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "W",
      url: "https://x.nl/",
    });
    expect(websiteLd({ naam: "W", adres: "https://x.nl/" })).toMatchObject({
      "@type": "WebSite",
      inLanguage: "nl-NL",
    });
  });

  it("een productnaam met </script> breekt niet uit de pagina", () => {
    const kwaad = 'Koffie </script><script>alert("hoi")</script> & <!-- "';
    const Stub = createRoutesStub([
      {
        path: "/",
        meta: () =>
          paginaMeta({
            titel: kwaad,
            omschrijving: kwaad,
            jsonLd: productLd({
              naam: kwaad,
              omschrijving: kwaad,
              adres: ADRES,
              prijsCenten: 100,
              opVoorraad: true,
            }),
          }),
        Component: MetSjabloon,
      },
    ]);
    const html = renderToString(<Stub initialEntries={["/"]} />);
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
    // Precies één script: het JSON-LD. Geen tweede dat uit de productnaam is ontstaan.
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.[0]).toContain('type="application/ld+json"');
    expect(html).not.toContain("<script>alert");
    const inhoud = JSON.parse(scripts[0]?.[1] ?? "{}") as { name?: string };
    expect(inhoud.name).toBe(kwaad);
  });
});

describe("sitemap en robots.txt", () => {
  it("absolute adressen met lastmod, en tekens die XML zouden breken worden veilig", () => {
    const xml = sitemapXml([
      { adres: "https://x.nl/producten", gewijzigd: "2026-11-13T10:00:00Z" },
      { adres: "https://x.nl/producten/a&b<c>", gewijzigd: new Date("2026-01-02T00:00:00Z") },
      { adres: "https://x.nl/zonder-datum" },
    ]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain("<loc>https://x.nl/producten</loc>\n    <lastmod>2026-11-13</lastmod>");
    expect(xml).toContain("<loc>https://x.nl/producten/a&amp;b&lt;c&gt;</loc>");
    expect(xml).toContain("<lastmod>2026-01-02</lastmod>");
    expect(xml.match(/<url>/g)).toHaveLength(3);
  });

  it("een relatief adres of een kapotte datum komt er niet in", () => {
    const xml = sitemapXml([
      { adres: "/producten" },
      { adres: "https://x.nl/a", gewijzigd: "geen datum" },
    ]);
    expect(xml).not.toContain("<loc>/producten</loc>");
    expect(xml).toContain("<loc>https://x.nl/a</loc>");
    expect(xml).not.toContain("lastmod");
  });

  it("robots.txt verwijst naar de sitemap en sluit privé-paden uit", () => {
    expect(robotsTxt({ sitemap: "https://x.nl/sitemap.xml", verboden: ["/wagen"] })).toBe(
      "User-agent: *\nDisallow: /wagen\n\nSitemap: https://x.nl/sitemap.xml\n",
    );
    expect(robotsTxt({ sitemap: "https://x.nl/sitemap.xml" })).toContain("Allow: /");
  });
});
