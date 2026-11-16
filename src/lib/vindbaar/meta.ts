import type { MetaDescriptor } from "react-router";
import type { JsonLd } from "./json-ld";

/**
 * Alles wat een zoekmachine en een gedeelde link (WhatsApp, LinkedIn, Slack) van een pagina
 * lezen, in één aanroep. Gebruik in een route:
 *
 *   export const meta: Route.MetaFunction = ({ loaderData }) =>
 *     paginaMeta({ site: SITE, titel: "Producten", omschrijving: "...", adres: loaderData?.adres });
 *
 * `adres` is het volledige adres van de pagina op het echte domein; de loader haalt het met
 * `vindbaarAdres(context)` uit adres.server.ts. Zonder adres (een foutpagina) blijven de
 * canonical en `og:url` weg in plaats van fout.
 *
 * De `meta` van een route vervangt die van `src/root.tsx` helemaal; daarom zet deze functie
 * steeds de hele set.
 *
 * Dit bestand is van de template en komt met elke versie mee.
 */
export type PaginaMetaOpties = {
  /** De naam van de site of winkel; komt achter de titel en in `og:site_name`. */
  site?: { naam: string };
  /** De titel van de pagina zelf, zonder de naam van de site. */
  titel: string;
  /** Eén of twee zinnen; zoekmachines tonen er ongeveer 155 tekens van. */
  omschrijving: string;
  /** Het volledige adres van deze pagina (https://...), zonder zoekvraag. */
  adres?: string | null;
  /** Een volledig adres van een afbeelding (https://...); liefst 1200 bij 630 of vierkant. */
  afbeelding?: string | null;
  /** `website` voor gewone pagina's, `product` voor een productpagina. */
  type?: "website" | "product" | "article";
  /** `false` voor pagina's die niet in Google horen: de wagen, een account, een bestelling. */
  zoekmachines?: boolean;
  /** Gegevens voor zoekmachines (schema.org), zie json-ld.ts. */
  jsonLd?: JsonLd | JsonLd[];
};

/** Hoogstens zoveel tekens in de omschrijving; langer kapt Google zelf af, midden in een woord. */
const MAX_OMSCHRIJVING = 160;

export function inkorten(tekst: string, max = MAX_OMSCHRIJVING): string {
  const enkel = tekst.replace(/\s+/g, " ").trim();
  if (enkel.length <= max) return enkel;
  const stuk = enkel.slice(0, max - 1);
  const spatie = stuk.lastIndexOf(" ");
  return `${(spatie > max / 2 ? stuk.slice(0, spatie) : stuk).replace(/[\s.,;:]+$/, "")}…`;
}

export function paginaMeta(o: PaginaMetaOpties): MetaDescriptor[] {
  const volledigeTitel = o.site ? `${o.titel} · ${o.site.naam}` : o.titel;
  const omschrijving = inkorten(o.omschrijving);
  const lijst: MetaDescriptor[] = [
    { title: volledigeTitel },
    { name: "description", content: omschrijving },
    { property: "og:title", content: o.titel },
    { property: "og:description", content: omschrijving },
    { property: "og:type", content: o.type ?? "website" },
    { name: "twitter:card", content: o.afbeelding ? "summary_large_image" : "summary" },
  ];
  if (o.site) lijst.push({ property: "og:site_name", content: o.site.naam });
  if (o.adres) {
    lijst.push({ tagName: "link", rel: "canonical", href: o.adres });
    lijst.push({ property: "og:url", content: o.adres });
  }
  if (o.afbeelding) lijst.push({ property: "og:image", content: o.afbeelding });
  if (o.zoekmachines === false) lijst.push({ name: "robots", content: "noindex, nofollow" });
  if (o.jsonLd !== undefined) {
    // React Router zet dit in <script type="application/ld+json"> en maakt `<`, `>` en `&`
    // onschadelijk, zodat een productnaam met `</script>` de pagina niet kan openbreken
    // (zie json-ld.test.tsx).
    lijst.push({ "script:ld+json": o.jsonLd });
  }
  return lijst;
}
