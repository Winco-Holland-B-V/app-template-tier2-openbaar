import type { Verzoek } from "./verzoek.server";

/**
 * De cacheregel van de stack, op één plek afgedwongen voor elk antwoord van de Worker:
 * pagina's, de gegevensverzoeken van React Router (`.data`), omleidingen en fouten.
 *
 *   Een antwoord is `private, no-store`, tenzij alles hieronder klopt. Dan, en alleen
 *   dan, mag het een openbare cache in.
 *
 *   1. de route heeft er uitdrukkelijk om gevraagd (`openbaarCache(context, ...)`);
 *   2. het is een GET of HEAD met status 200;
 *   3. het verzoek had geen cookie, geen `Authorization` en geen inlog van Cloudflare
 *      Access: er is dus geen sessie, van Supabase niet en van iets anders niet;
 *   4. het antwoord zet geen cookie;
 *   5. er is in dit verzoek geen ingelogde gebruiker gevonden.
 *
 * Wat een route zelf in `Cache-Control` zet, telt niet: deze functie overschrijft het. Zo
 * kan een pagina die voor een ingelogde klant is gemaakt (met zijn prijs erop) nooit bij
 * een ander uit een cache komen, ook niet als een route de regel vergeet.
 *
 * Dit bestand is van de template en komt met elke versie mee.
 */
export const NIET_BEWAREN = "private, no-store";

/** Headers waarmee een verzoek zegt wie het is. Staat er één in, dan is er een sessie. */
const WIE_BEN_IK = ["Cookie", "Authorization", "Cf-Access-Jwt-Assertion"];

export function magOpenbaar(request: Request, response: Response, verzoek: Verzoek): boolean {
  if (verzoek.openbaarCache === null) return false;
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (response.status !== 200) return false;
  if (WIE_BEN_IK.some((naam) => request.headers.has(naam))) return false;
  if (response.headers.has("Set-Cookie") || verzoek.cookiesUit.length > 0) return false;
  if (verzoek.ingelogd) return false;
  return true;
}

/** Voegt namen toe aan `Vary`, zonder dubbelen en zonder een bestaande waarde te verliezen. */
function metVary(headers: Headers, namen: string[]): void {
  const huidig = (headers.get("Vary") ?? "")
    .split(",")
    .map((naam) => naam.trim())
    .filter(Boolean);
  if (huidig.includes("*")) return;
  const klein = new Set(huidig.map((naam) => naam.toLowerCase()));
  for (const naam of namen) if (!klein.has(naam.toLowerCase())) huidig.push(naam);
  headers.set("Vary", huidig.join(", "));
}

/** Zet de cacheregel op de headers van een antwoord. */
export function zetCache(
  headers: Headers,
  request: Request,
  response: Response,
  verzoek: Verzoek,
): void {
  // Oude en afwijkende cache-headers weg: er geldt er precies één.
  for (const naam of [
    "Expires",
    "Pragma",
    "CDN-Cache-Control",
    "Cloudflare-CDN-Cache-Control",
    "Surrogate-Control",
  ]) {
    headers.delete(naam);
  }
  // Een cache die toch bewaart, moet weten dat het antwoord van het cookie afhangt.
  metVary(headers, WIE_BEN_IK);
  if (magOpenbaar(request, response, verzoek) && verzoek.openbaarCache !== null) {
    headers.set("Cache-Control", `public, max-age=${verzoek.openbaarCache}`);
  } else {
    headers.set("Cache-Control", NIET_BEWAREN);
  }
}
