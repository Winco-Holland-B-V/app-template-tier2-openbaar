/**
 * Waar iemand na het inloggen naartoe mag: alleen een pad binnen deze app.
 *
 * Een adres als `/login?volgende=/bestellingen` is handig, maar wie de waarde van `volgende`
 * zomaar volgt, stuurt een bezoeker ook naar `https://nep-winkel.example` als een oplichter
 * dat in een link zet. Het adres begint dan met het echte domein, en daar vertrouwt de
 * bezoeker op. Deze functie laat alleen een pad door dat zeker binnen de app blijft en
 * geeft in elk ander geval de terugval (standaard de startpagina).
 *
 * Gebruik hem op elke plek waar een adres uit het verzoek komt (een parameter, een
 * formulierveld, een cookie) en daarna in een omleiding belandt. Hij werkt op de server en
 * in de browser.
 *
 * Dit bestand is van de template en komt met elke versie mee.
 */
const BASIS = "https://app.invalid";
const MAX_LENGTE = 2000;

export function veiligPad(waarde: unknown, terugval = "/"): string {
  if (typeof waarde !== "string" || waarde.length === 0 || waarde.length > MAX_LENGTE) {
    return terugval;
  }
  // Eén schuine streep aan het begin: een pad. Twee (`//host`) is een ander domein.
  if (!waarde.startsWith("/") || waarde.startsWith("//")) return terugval;
  // Een backslash leest een browser als schuine streep (`/\host` wordt `//host`), en een
  // tab of regeleinde haalt hij weg voordat hij het adres leest (`/<tab>/host` ook).
  for (const teken of waarde) {
    const code = teken.codePointAt(0) ?? 0;
    if (teken === "\\" || code <= 0x20 || code === 0x7f) return terugval;
  }
  let adres: URL;
  try {
    adres = new URL(waarde, BASIS);
  } catch {
    return terugval;
  }
  // De browser moet het precies zo lezen als wij: zelfde domein, en nog steeds een pad.
  if (adres.origin !== BASIS || adres.username !== "" || adres.password !== "") return terugval;
  if (!adres.pathname.startsWith("/") || adres.pathname.startsWith("//")) return terugval;
  return `${adres.pathname}${adres.search}${adres.hash}`;
}

/** Het veilige pad uit `?volgende=` van een adres; zonder (geldige) waarde de terugval. */
export function volgendePad(adres: string | URL, terugval = "/"): string {
  let url: URL;
  try {
    url = new URL(adres, BASIS);
  } catch {
    return terugval;
  }
  return veiligPad(url.searchParams.get("volgende"), terugval);
}
