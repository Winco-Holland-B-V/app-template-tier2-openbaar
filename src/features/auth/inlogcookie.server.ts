import type { RouterContextProvider } from "react-router";
import { cookieOverHttps } from "@/lib/server/sessie-cookie";
import { verzoekUit } from "@/lib/server/verzoek.server";

/**
 * Wat de inlogpagina tussen twee verzoeken onthoudt, in één cookie. In de gewone tier
 * 2-template staat dit in de opslag van de browser (sessionStorage en localStorage); hier
 * maakt de server de pagina, dus moet de server het kunnen lezen, ook zonder JavaScript.
 *
 * Wat erin staat (nooit een code, een token of een sessie):
 *
 *   inlogcode               naar welk adres de code ging en wanneer (vijf minuten bruikbaar)
 *   inlogcode-aangevraagd   deze browser vroeg zelf een code aan (alleen het tijdstip)
 *   inlog-via-dienst        deze browser ging zelf naar de inlogdienst (alleen het tijdstip)
 *   volgende                waar de bezoeker na het inloggen heen wilde
 *   fout, melding, adres    één keer te tonen na een omleiding
 *   net                     er is zojuist ingelogd: toon kort op welk adres
 *
 * Het cookie is `HttpOnly` (geen script kan het lezen), `SameSite=Lax` (een formulier op een
 * andere site krijgt het niet mee, een link uit de mail wel), over https `Secure` en met het
 * voorvoegsel `__Host-` (een ander adres onder hetzelfde domein kan het niet neerzetten), en
 * het leeft een kwartier. Er hangt geen recht aan: wie het zelf aanpast, verandert alleen wat
 * zijn eigen inlogscherm toont.
 *
 * De eerste drie namen zijn die van mailcode.ts: dit bestand geeft dezelfde `getItem`,
 * `setItem` en `removeItem` als de opslag van de browser, zodat de functies daar ongewijzigd
 * werken.
 */
type Context = Readonly<RouterContextProvider>;

/** Zo lang leeft het cookie: zo lang als een code geldig is. */
export const INLOGCOOKIE_SECONDEN = 15 * 60;
const MAX_LENGTE = 2000;
const MAX_VELDEN = 12;

export function inlogCookieNaam(https: boolean): string {
  return https ? "__Host-inlog" : "inlog";
}

function uitTekst(waarde: string | undefined): Record<string, string> {
  if (!waarde || waarde.length > MAX_LENGTE) return {};
  try {
    const gelezen: unknown = JSON.parse(decodeURIComponent(waarde));
    if (typeof gelezen !== "object" || gelezen === null || Array.isArray(gelezen)) return {};
    const velden = Object.entries(gelezen).filter(
      (veld): veld is [string, string] => typeof veld[1] === "string",
    );
    return Object.fromEntries(velden.slice(0, MAX_VELDEN));
  } catch {
    return {};
  }
}

function uitVerzoek(cookieHeader: string | null, naam: string): string | undefined {
  for (const deel of (cookieHeader ?? "").split(";")) {
    const is = deel.indexOf("=");
    if (is > 0 && deel.slice(0, is).trim() === naam) return deel.slice(is + 1).trim();
  }
  return undefined;
}

export type Inlogopslag = {
  getItem: (sleutel: string) => string | null;
  setItem: (sleutel: string, waarde: string) => void;
  removeItem: (sleutel: string) => void;
  /** Leest een veld en haalt het meteen weg: voor wat één keer getoond wordt. */
  neem: (sleutel: string) => string | null;
  /** Alles weg, bijvoorbeeld na het inloggen of het uitloggen. */
  wisAlles: () => void;
};

export function inlogOpslag(context: Context): Inlogopslag {
  const verzoek = verzoekUit(context);
  const https = cookieOverHttps(new URL(verzoek.request.url));
  const naam = inlogCookieNaam(https);
  const begin = `${naam}=`;
  const stond = uitVerzoek(verzoek.request.headers.get("Cookie"), naam);

  /** Wat er nu geldt: wat dit verzoek zelf al schreef, anders wat de browser meestuurde. */
  function huidig(): Record<string, string> {
    const geschreven = verzoek.cookiesUit.findLast((cookie) => cookie.startsWith(begin));
    if (geschreven !== undefined) return uitTekst(geschreven.slice(begin.length).split(";")[0]);
    return uitTekst(stond);
  }

  function schrijf(velden: Record<string, string>): void {
    const leeg = Object.keys(velden).length === 0;
    for (let i = verzoek.cookiesUit.length - 1; i >= 0; i--) {
      if (verzoek.cookiesUit[i]?.startsWith(begin)) verzoek.cookiesUit.splice(i, 1);
    }
    // Niets te onthouden en de browser had ook niets: dan komt er geen cookie.
    if (leeg && stond === undefined) return;
    const waarde = leeg ? "" : encodeURIComponent(JSON.stringify(velden));
    const delen = [
      `${begin}${waarde}`,
      "Path=/",
      `Max-Age=${leeg ? 0 : INLOGCOOKIE_SECONDEN}`,
      "HttpOnly",
      "SameSite=Lax",
    ];
    if (https) delen.push("Secure");
    verzoek.cookiesUit.push(delen.join("; "));
  }

  const opslag: Inlogopslag = {
    getItem: (sleutel) => huidig()[sleutel] ?? null,
    setItem(sleutel, waarde) {
      schrijf({ ...huidig(), [sleutel]: waarde });
    },
    removeItem(sleutel) {
      const velden = huidig();
      if (!(sleutel in velden)) return;
      delete velden[sleutel];
      schrijf(velden);
    },
    neem(sleutel) {
      const waarde = opslag.getItem(sleutel);
      if (waarde !== null) opslag.removeItem(sleutel);
      return waarde;
    },
    wisAlles: () => schrijf({}),
  };
  return opslag;
}
