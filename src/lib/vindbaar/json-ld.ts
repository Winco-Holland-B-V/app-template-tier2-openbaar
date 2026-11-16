/**
 * Gegevens voor zoekmachines in de taal van schema.org (JSON-LD): wat een pagina is (een
 * product, een lijst, een winkel), zodat Google er een prijs, voorraad of kruimelpad bij kan
 * tonen. Elke functie geeft een gewoon object; `paginaMeta({ jsonLd: [...] })` zet ze veilig
 * in de pagina.
 *
 * Eén regel staat hier vast: de prijs in `productLd` is de prijs die iedereen ziet. Een
 * klantprijs hoort nooit in JSON-LD, want die pagina kan in een cache of bij Google belanden.
 *
 * Dit bestand is van de template en komt met elke versie mee.
 */
export type JsonLd = { [sleutel: string]: JsonWaarde };
type JsonWaarde = string | number | boolean | null | JsonLd | JsonWaarde[];

const CONTEXT = "https://schema.org";

/** 1495 cent wordt "14.95": schema.org wil een punt en geen valutateken. */
export function bedragUitCenten(centen: number): string {
  if (!Number.isInteger(centen) || centen < 0) {
    throw new Error(`Een bedrag in centen is een heel getal van 0 of meer, niet ${centen}.`);
  }
  return `${Math.floor(centen / 100)}.${String(centen % 100).padStart(2, "0")}`;
}

export function productLd(p: {
  naam: string;
  omschrijving: string;
  adres: string;
  afbeelding?: string | null;
  /** Code van het product (de slug, of een artikelnummer). */
  sku?: string;
  /** De openbare prijs (basisprijs), in centen. Nooit een klantprijs. */
  prijsCenten: number;
  valuta?: string;
  opVoorraad: boolean;
}): JsonLd {
  return {
    "@context": CONTEXT,
    "@type": "Product",
    name: p.naam,
    description: p.omschrijving,
    url: p.adres,
    ...(p.afbeelding ? { image: [p.afbeelding] } : {}),
    ...(p.sku ? { sku: p.sku } : {}),
    offers: {
      "@type": "Offer",
      url: p.adres,
      price: bedragUitCenten(p.prijsCenten),
      priceCurrency: p.valuta ?? "EUR",
      availability: p.opVoorraad ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      itemCondition: "https://schema.org/NewCondition",
    },
  };
}

/** Een lijst van pagina's, zoals een categorie of alle producten. */
export function itemListLd(items: { naam: string; adres: string }[]): JsonLd {
  return {
    "@context": CONTEXT,
    "@type": "ItemList",
    numberOfItems: items.length,
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.naam,
      url: item.adres,
    })),
  };
}

/** Het kruimelpad boven een pagina: Home › Producten › Koffiebonen. */
export function kruimelpadLd(stappen: { naam: string; adres: string }[]): JsonLd {
  return {
    "@context": CONTEXT,
    "@type": "BreadcrumbList",
    itemListElement: stappen.map((stap, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: stap.naam,
      item: stap.adres,
    })),
  };
}

/** Wie de winkel is: voor de startpagina. */
export function organisatieLd(o: { naam: string; adres: string; logo?: string | null }): JsonLd {
  return {
    "@context": CONTEXT,
    "@type": "Organization",
    name: o.naam,
    url: o.adres,
    ...(o.logo ? { logo: o.logo } : {}),
  };
}

/** De site zelf: voor de startpagina. */
export function websiteLd(o: { naam: string; adres: string; taal?: string }): JsonLd {
  return {
    "@context": CONTEXT,
    "@type": "WebSite",
    name: o.naam,
    url: o.adres,
    inLanguage: o.taal ?? "nl-NL",
  };
}
