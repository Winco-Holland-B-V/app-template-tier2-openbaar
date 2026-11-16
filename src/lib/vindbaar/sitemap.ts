/**
 * `sitemap.xml` en `robots.txt`: de lijst met pagina's voor zoekmachines, en de regels welke
 * ze niet hoeven te bezoeken. De routes zelf (src/routes/sitemap.ts en
 * src/routes/robots.ts) zijn van de app: daar staat wat er in de lijst hoort.
 *
 * Buiten het echte domein (workers.dev, previews, je eigen computer) geeft de Worker zelf een
 * robots.txt die alles weigert, en zet hij `noindex` op elk antwoord. Een fout hier zet dus
 * nooit een preview in Google.
 *
 * Dit bestand is van de template en komt met elke versie mee.
 */
export type SitemapRegel = {
  /** Volledig adres op het echte domein. */
  adres: string;
  /** Wanneer de pagina voor het laatst inhoudelijk veranderde. */
  gewijzigd?: string | Date | null;
};

/** Een sitemap mag hoogstens 50.000 adressen hebben; daarboven is een index nodig. */
export const MAX_IN_SITEMAP = 50_000;

function xmlVeilig(tekst: string): string {
  return tekst
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** De datum als JJJJ-MM-DD (W3C), of niets als hij ontbreekt of niet klopt. */
function datum(waarde: string | Date | null | undefined): string | null {
  if (!waarde) return null;
  const d = waarde instanceof Date ? waarde : new Date(waarde);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function sitemapXml(regels: SitemapRegel[]): string {
  const adressen = regels.filter((r) => /^https?:\/\//.test(r.adres)).slice(0, MAX_IN_SITEMAP);
  const urls = adressen.map((r) => {
    const gewijzigd = datum(r.gewijzigd);
    return [
      "  <url>",
      `    <loc>${xmlVeilig(r.adres)}</loc>`,
      ...(gewijzigd ? [`    <lastmod>${gewijzigd}</lastmod>`] : []),
      "  </url>",
    ].join("\n");
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}

export function sitemapAntwoord(regels: SitemapRegel[]): Response {
  return new Response(sitemapXml(regels), {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}

/**
 * robots.txt voor het echte domein: alles mag, behalve de paden in `verboden` (de wagen, een
 * account, zoekresultaten), met de verwijzing naar de sitemap.
 */
export function robotsTxt(o: { sitemap: string; verboden?: string[] }): string {
  const regels = ["User-agent: *"];
  const verboden = o.verboden ?? [];
  if (verboden.length === 0) regels.push("Allow: /");
  for (const pad of verboden) regels.push(`Disallow: ${pad}`);
  regels.push("", `Sitemap: ${o.sitemap}`, "");
  return regels.join("\n");
}

export function robotsAntwoord(o: { sitemap: string; verboden?: string[] }): Response {
  return new Response(robotsTxt(o), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
