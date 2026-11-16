/**
 * Hoe de sessie van Supabase in een cookie staat. De server (src/lib/server/) en de browser
 * (src/lib/supabase.ts) gebruiken dezelfde instellingen; anders zien ze elkaars sessie niet.
 *
 *   - `Secure`: alleen over https. Uitzondering: je eigen computer (http://localhost), waar
 *     geen https is.
 *   - `SameSite=Lax`: een formulier of verzoek vanaf een andere site krijgt het cookie niet mee.
 *   - over https heet het `__Host-sb-<project>-auth-token`: alleen dit adres kan het zetten
 *     (zie `sessieCookieNaam`).
 *   - niet `HttpOnly`: de schermen in de browser praten nog rechtstreeks met Supabase (lijsten,
 *     opslaan, live bijwerken) en hebben de sessie daarvoor nodig. De Supabase-gids doet het
 *     ook zo. Wat de sessie beschermt tegen meelezende scripts is de strenge
 *     Content-Security-Policy (zie beveiliging.server.ts), en wat de gegevens beschermt zijn de
 *     regels in de database.
 *
 * Dit bestand is van de template en komt met elke versie mee.
 */
export function sessieCookieOpties(https: boolean, supabaseUrl?: string) {
  return {
    ...(supabaseUrl ? { name: sessieCookieNaam(supabaseUrl, https) } : {}),
    path: "/",
    sameSite: "lax" as const,
    secure: https,
    httpOnly: false,
  };
}

/**
 * De naam van het sessiecookie. Over https met het voorvoegsel `__Host-`: zo'n cookie neemt de
 * browser alleen aan van precies dit adres (met `Secure`, `Path=/` en zonder `Domain`). Een
 * ander adres onder hetzelfde domein (een gekaapt `blog.klant.nl`) kan dan geen sessie voor de
 * app neerzetten; een cookie zonder voorvoegsel leest de app niet. Over http op je eigen
 * computer kan `__Host-` niet (het eist https), en daar is het ook niet nodig.
 *
 * De rest van de naam is wat Supabase zelf zou kiezen: `sb-<project>-auth-token`.
 */
export function sessieCookieNaam(supabaseUrl: string, https: boolean): string {
  const project = new URL(supabaseUrl).hostname.split(".")[0] ?? "";
  const naam = `sb-${project}-auth-token`;
  return https ? `__Host-${naam}` : naam;
}

/** Is dit adres de eigen computer? Alleen daar mag het cookie zonder `Secure`. */
export function isLokaal(hostname: string): boolean {
  const naam = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return naam === "localhost" || naam === "127.0.0.1" || naam === "::1";
}

/** `Secure` altijd, behalve op http op de eigen computer. */
export function cookieOverHttps(adres: { protocol: string; hostname: string }): boolean {
  return !(adres.protocol === "http:" && isLokaal(adres.hostname));
}
