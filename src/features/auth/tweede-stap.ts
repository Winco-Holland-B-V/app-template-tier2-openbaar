import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * De tweede stap (2FA) bij een klantportaal met accounts: een code van zes cijfers uit een
 * authenticator-app (TOTP), standaard in Supabase Auth. De klant zet hem zelf aan op
 * `/account`; daarna vraagt de app na het wachtwoord om de code (`/tweede-stap`).
 *
 * Het scherm is niet de grens. De database geeft klantrechten pas in een sessie die de tweede
 * stap deed (`aal2`), als de klant een bevestigde factor heeft: zie is_goedgekeurde_klant() in
 * supabase/migrations/20261120100000_klantaccounts.sql. Wie alleen het wachtwoord kent, ziet
 * dus niets, ook niet rechtstreeks bij Supabase.
 *
 * Telefoon kwijt: de owner van de app haalt de factor weg in Supabase (Authentication, Users).
 */

type Mfa = { auth: Pick<SupabaseClient["auth"], "mfa"> };

/** Moet deze sessie nog de tweede stap doen? Alleen als de klant hem heeft aangezet. */
export async function tweedeStapNodig(supabase: Mfa): Promise<boolean> {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || !data) return false;
  return data.nextLevel === "aal2" && data.currentLevel !== "aal2";
}

/** Het adres van de tweede stap, met waar het daarna heen gaat (al een veilig pad). */
export function tweedeStapAdres(volgende: string): string {
  return volgende && volgende !== "/"
    ? `/tweede-stap?volgende=${encodeURIComponent(volgende)}`
    : "/tweede-stap";
}

/** Een code uit een authenticator-app: zes cijfers. Spaties mogen (sommige apps tonen 123 456). */
export function leesCode(invoer: string): string | null {
  const code = invoer.replace(/\s+/g, "");
  return /^\d{6}$/.test(code) ? code : null;
}

export const CODE_ONGELDIG = "Vul de zes cijfers uit je authenticator-app in.";
export const CODE_FOUT =
  "Deze code klopt niet. Kijk of de tijd op je telefoon goed staat en probeer de code die nu in de app staat.";
