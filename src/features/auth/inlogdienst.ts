import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Welke inlogdienst deze app gebruikt, komt uit `VITE_INLOGDIENST` (zie lib/env.ts).
 * Het is een instelling, geen code. De beheer-repo richt alleen `cloudflare` in: in
 * productie loopt inloggen altijd via Cloudflare Access. azure, google en mailcode
 * vragen eigen instellingen in Supabase die de inrichting niet zet.
 *
 *   cloudflare  Cloudflare Access is de inlogdienst van Supabase (custom OIDC-provider
 *               `custom:cloudflare`). De standaard in productie: één login, en wie niet
 *               door de deur mag, krijgt ook geen Supabase-account.
 *   azure       Supabase logt zelf in bij Microsoft.
 *   google      Supabase logt zelf in bij Google.
 *   mailcode    Supabase stuurt een mail met een code van tien cijfers en een link.
 *   wachtwoord  e-mail en wachtwoord. Alleen: lokaal en in CI, voor de tests. Naast
 *               `cloudflare`: de klanten van een klantportaal met accounts, met een account
 *               dat een medewerker aanmaakt (Edge Function klant-uitnodigen). Naast
 *               `cloudflare` en `mailcode`: de stand `vooraf` (hieronder).
 *
 * Een klantportaal kent drie standen (`"klantportaal_inloggen"` in toegang.json van de
 * beheer-repo). Medewerkers loggen in alle drie in via Cloudflare.
 *
 *   code     `VITE_INLOGDIENST=cloudflare,mailcode`: een klant meldt zich zelf aan met een
 *            code per mail; een medewerker keurt hem goed.
 *   account  `VITE_INLOGDIENST=cloudflare,wachtwoord`: niemand maakt zelf een account. Een
 *            medewerker nodigt een klant uit, de klant kiest een wachtwoord.
 *   vooraf   `VITE_INLOGDIENST=cloudflare,mailcode,wachtwoord`, of met Google
 *            `cloudflare,mailcode,google,wachtwoord`: de accounts bestaan vooraf (een
 *            medewerker maakt ze; niemand meldt zich zelf aan). Een klant logt in met een
 *            link van een medewerker of met een code die hij zelf aanvraagt, en kan op
 *            /account een wachtwoord instellen. Met `google` ook met "Doorgaan met Google".
 *
 * Zie docs/WERKWIJZE.md ("Klantaccounts"). Welke rechten iemand daarna heeft, bepaalt de
 * database en nooit deze pagina: zie `sessie_via_cloudflare()` in supabase/migrations.
 */
export const INLOGDIENSTEN = ["cloudflare", "azure", "google", "mailcode", "wachtwoord"] as const;
export type Inlogdienst = (typeof INLOGDIENSTEN)[number];

/**
 * Leest `VITE_INLOGDIENST`: één dienst (`cloudflare`) of een lijst met komma's
 * (`cloudflare,mailcode`). Geeft de diensten in de opgegeven volgorde, of een fout in
 * gewone taal. Eén dienst geeft precies wat het altijd gaf: een lijst met die ene dienst.
 *
 * `wachtwoord` staat alleen, naast `cloudflare` (stand `account`), of naast `cloudflare` en
 * `mailcode`, eventueel met `google` (stand `vooraf`). In elke andere combinatie niet: twee
 * manieren voor klanten op één pagina waarbij iedereen zelf een account kan maken (een code per
 * mail en een wachtwoord, of Google en een wachtwoord) maken twee accounts op één adres. In de
 * stand `vooraf` speelt dat niet: niemand maakt daar zelf een account (de aanmeld-hook weigert),
 * code en wachtwoord horen bij dezelfde identiteit `email`, en Google koppelt Supabase aan het
 * account met hetzelfde adres.
 */
export function leesInlogdiensten(
  tekst: string,
): { ok: true; diensten: Inlogdienst[] } | { ok: false; fout: string } {
  const namen = tekst.split(",").map((naam) => naam.trim());
  const diensten: Inlogdienst[] = [];
  for (const naam of namen) {
    const dienst = INLOGDIENSTEN.find((bekend) => bekend === naam);
    if (!dienst) {
      return {
        ok: false,
        fout: `VITE_INLOGDIENST kent "${naam}" niet. Kies uit: ${INLOGDIENSTEN.join(", ")}; meer dan één mag, met een komma ertussen.`,
      };
    }
    if (diensten.includes(dienst)) {
      return { ok: false, fout: `VITE_INLOGDIENST noemt "${dienst}" twee keer.` };
    }
    diensten.push(dienst);
  }
  if (
    diensten.includes("wachtwoord") &&
    !isVooraf(diensten) &&
    diensten.some((dienst) => dienst !== "wachtwoord" && dienst !== "cloudflare")
  ) {
    return {
      ok: false,
      fout: "VITE_INLOGDIENST: `wachtwoord` staat alleen, naast `cloudflare` (medewerkers via Cloudflare, klanten met een wachtwoord), of naast `cloudflare` en `mailcode`, eventueel met `google` (accounts vooraf).",
    };
  }
  return { ok: true, diensten };
}

/**
 * De stand `vooraf` van een klantportaal: `cloudflare`, `mailcode` en `wachtwoord`, eventueel
 * met `google`, en niets anders. De accounts bestaan vooraf; een code per mail maakt dan nooit
 * een account (`shouldCreateUser: false`), en de link uit de mail logt meteen in.
 */
export function isVooraf(diensten: readonly Inlogdienst[]): boolean {
  return (
    diensten.includes("cloudflare") &&
    diensten.includes("mailcode") &&
    diensten.includes("wachtwoord") &&
    diensten.every((dienst) => dienst !== "azure")
  );
}

/** Het deel van de Supabase-auth dat hier nodig is; zo is het los te testen. */
export type InlogAuth = Pick<SupabaseClient["auth"], "signInWithOAuth" | "signInWithOtp">;

/** Hoe de loginpagina eruitziet bij een dienst. */
export function inlogVorm(dienst: Inlogdienst): "doorsturen" | "knop" | "mailcode" | "wachtwoord" {
  switch (dienst) {
    case "cloudflare":
      return "doorsturen";
    case "azure":
    case "google":
      return "knop";
    case "mailcode":
      return "mailcode";
    case "wachtwoord":
      return "wachtwoord";
  }
}

type Opties = { terugNaar: string; email?: string };

/**
 * Start het inloggen bij de gekozen dienst. Bij een OAuth-dienst stuurt Supabase de
 * browser daarna door; bij mailcode komt er een mail met een code en een link. Gooit bij
 * een fout. De inlogpagina met de code gebruikt voor mailcode de stappen uit mailcode.ts,
 * die ook de antwoorden van Supabase vertalen.
 */
export async function startInloggen(
  dienst: Inlogdienst,
  auth: InlogAuth,
  { terugNaar, email }: Opties,
): Promise<void> {
  if (dienst === "wachtwoord") {
    throw new Error("Inloggen met een wachtwoord gaat via het formulier, niet via startInloggen.");
  }

  if (dienst === "mailcode") {
    if (!email) throw new Error("Vul eerst je e-mailadres in.");
    // shouldCreateUser mag aan: wie een account mag krijgen, bewaakt de server met de
    // before-user-created-hook uit de inrichting. Een instelling in de browser beschermt
    // niets, want die kan iedereen omzeilen.
    const { error } = await auth.signInWithOtp({
      email,
      options: { emailRedirectTo: terugNaar, shouldCreateUser: true },
    });
    if (error) throw new Error(error.message);
    return;
  }

  const provider = dienst === "cloudflare" ? "custom:cloudflare" : dienst;
  const { error } = await auth.signInWithOAuth({ provider, options: { redirectTo: terugNaar } });
  if (error) throw new Error(error.message);
}
