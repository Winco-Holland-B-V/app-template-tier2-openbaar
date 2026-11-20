import { data, redirect as omleiding, type RouterContextProvider } from "react-router";
import { CODE_FOUT, CODE_ONGELDIG, leesCode, tweedeStapNodig } from "@/features/auth/tweede-stap";
import { inlogdiensten } from "@/lib/env";
import {
  heeftServerDatabase,
  supabaseVoorVerzoek,
  vereisGebruiker,
} from "@/lib/server/sessie.server";
import { volgendePad } from "@/lib/server/veilig-pad";

/**
 * `/tweede-stap` (de code na het wachtwoord) en `/account` (de tweede stap aan- of uitzetten),
 * op de server, met de sessie van de bezoeker. Alleen bij een klantportaal met accounts
 * (`wachtwoord` in VITE_INLOGDIENST); anders bestaan deze pagina's niet.
 *
 * De regels: een GET wijzigt niets; elke wijziging is een formulier (POST). Supabase Auth
 * remt zelf het raden van codes (per factor en per IP-adres), en eist voor het uitzetten van
 * een bevestigde factor een sessie die de tweede stap al deed.
 */
type Context = Readonly<RouterContextProvider>;

const NIET_IN_GOOGLE = { "X-Robots-Tag": "noindex, nofollow" };
const redirect = (naar: string) => omleiding(naar, { headers: NIET_IN_GOOGLE });

function aan(context: Context): void {
  if (!heeftServerDatabase(context) || !inlogdiensten.includes("wachtwoord")) {
    throw data("Deze pagina staat voor deze app niet aan.", { status: 404 });
  }
}

function veld(form: FormData, naam: string): string {
  const waarde = form.get(naam);
  return typeof waarde === "string" ? waarde : "";
}

/** De bevestigde authenticator-app van deze gebruiker, als hij er een heeft. */
async function bevestigdeFactor(supabase: ReturnType<typeof supabaseVoorVerzoek>) {
  const { data: lijst } = await supabase.auth.mfa.listFactors();
  return lijst?.totp.find((f) => f.status === "verified") ?? null;
}

export type TweedeStapAntwoord = { melding: string };

/** Wat /tweede-stap laat zien. Is de stap niet (meer) nodig, dan meteen door. */
export async function tweedeStapStand(context: Context, request: Request) {
  aan(context);
  await vereisGebruiker(context);
  const volgende = volgendePad(request.url);
  if (!(await tweedeStapNodig(supabaseVoorVerzoek(context)))) throw redirect(volgende);
  return { volgende };
}

/** De code uit de app controleren. Klopt hij, dan heeft de sessie de tweede stap gedaan (aal2). */
export async function tweedeStapDoen(context: Context, request: Request) {
  aan(context);
  await vereisGebruiker(context);
  const volgende = volgendePad(request.url);
  const form = await request.formData();
  const code = leesCode(veld(form, "code"));
  if (!code) return data<TweedeStapAntwoord>({ melding: CODE_ONGELDIG }, { status: 400 });
  const supabase = supabaseVoorVerzoek(context);
  const factor = await bevestigdeFactor(supabase);
  if (!factor) throw redirect(volgende);
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
  if (error) {
    const status = error.status === 429 ? 429 : 400;
    const melding =
      status === 429
        ? "Te veel pogingen. Wacht een paar minuten en probeer het opnieuw."
        : CODE_FOUT;
    return data<TweedeStapAntwoord>({ melding }, { status });
  }
  throw redirect(volgende);
}

export type Accountstand = {
  adres: string | null;
  /** Staat de tweede stap aan (een bevestigde authenticator-app)? */
  aan: boolean;
  /** Heeft deze sessie de tweede stap gedaan? Nodig om hem uit te zetten. */
  gedaan: boolean;
};

export type Accountantwoord =
  | { soort: "inschrijven"; factorId: string; qr: string; geheim: string; melding: string | null }
  | { soort: "melding"; melding: string };

/** Wat /account laat zien. */
export async function accountStand(context: Context): Promise<Accountstand> {
  aan(context);
  const wie = await vereisGebruiker(context);
  const supabase = supabaseVoorVerzoek(context);
  const factor = await bevestigdeFactor(supabase);
  const { data: niveau } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  return {
    adres: wie.email ?? null,
    aan: factor !== null,
    gedaan: niveau?.currentLevel === "aal2",
  };
}

/** De formulieren van /account: aanzetten (twee stappen) en uitzetten. */
export async function accountWijzigen(context: Context, request: Request) {
  aan(context);
  await vereisGebruiker(context);
  const supabase = supabaseVoorVerzoek(context);
  const form = await request.formData();
  const doe = veld(form, "doe");

  if (doe === "aanzetten") {
    // Een eerdere poging die niet is afgemaakt, eerst weg: Supabase staat er maar een paar toe.
    const { data: lijst } = await supabase.auth.mfa.listFactors();
    if (lijst?.totp.some((f) => f.status === "verified")) throw redirect("/account");
    for (const oud of lijst?.all.filter((f) => f.status !== "verified") ?? []) {
      await supabase.auth.mfa.unenroll({ factorId: oud.id });
    }
    const { data: nieuw, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
    if (error || !nieuw || nieuw.type !== "totp") {
      return data<Accountantwoord>(
        { soort: "melding", melding: "Aanzetten lukte niet. Probeer het later opnieuw." },
        { status: 502 },
      );
    }
    return {
      soort: "inschrijven",
      factorId: nieuw.id,
      qr: nieuw.totp.qr_code,
      geheim: nieuw.totp.secret,
      melding: null,
    } satisfies Accountantwoord;
  }

  if (doe === "bevestigen") {
    const factorId = veld(form, "factor");
    const code = leesCode(veld(form, "code"));
    const { data: lijst } = await supabase.auth.mfa.listFactors();
    const factor = lijst?.all.find((f) => f.id === factorId && f.status !== "verified");
    if (!factor) throw redirect("/account");
    const verder = (melding: string) =>
      data<Accountantwoord>({ soort: "melding", melding }, { status: 400 });
    if (!code) return verder(`${CODE_ONGELDIG} Begin daarna opnieuw met aanzetten.`);
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
    if (error) return verder(`${CODE_FOUT} Begin daarna opnieuw met aanzetten.`);
    throw redirect("/account");
  }

  if (doe === "uitzetten") {
    const factor = await bevestigdeFactor(supabase);
    if (!factor) throw redirect("/account");
    const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
    if (error) {
      return data<Accountantwoord>(
        {
          soort: "melding",
          melding:
            "Uitzetten kan alleen direct na inloggen met de code uit je app. Log uit, log opnieuw in en probeer het dan.",
        },
        { status: 400 },
      );
    }
    throw redirect("/account");
  }

  throw data("Dit formulier kent deze pagina niet.", { status: 400 });
}
