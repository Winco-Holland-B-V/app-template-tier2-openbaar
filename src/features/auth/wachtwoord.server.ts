import { data, redirect as omleiding, type RouterContextProvider } from "react-router";
import { inlogOpslag } from "@/features/auth/inlogcookie.server";
import { leesAdres } from "@/features/auth/mailcode";
import { isBewijsVorm } from "@/features/auth/robotcontrole";
import { controleerWachtwoord, leesWachtwoordlink } from "@/features/auth/wachtwoord";
import { env, inlogdiensten } from "@/lib/env";
import { gebruiker, heeftServerDatabase, supabaseVoorVerzoek } from "@/lib/server/sessie.server";

/**
 * Een wachtwoord instellen (`/wachtwoord-instellen`, de link uit de uitnodiging of uit
 * "wachtwoord vergeten") en een nieuw wachtwoord aanvragen (`/wachtwoord-vergeten`), op de
 * server. De regels, dezelfde als die van de inlogpagina (inloggen.server.ts):
 *
 *   1. Een GET wisselt nooit een link om. De link uit de mail toont een knop; pas het formulier
 *      (een POST, die de Worker alleen van de eigen site aanneemt) wisselt hem om. Zo verbruikt
 *      een virusscanner die links vooraf opent hem niet.
 *   2. Een wachtwoord kiezen kan alleen met een sessie (uit die link, of al ingelogd), en het
 *      moet minstens tien tekens zijn.
 *   3. Wachtwoord vergeten geeft altijd hetzelfde antwoord, of het adres een account heeft of
 *      niet. Er ontstaat nooit een account: dat doet alleen een uitnodiging van een medewerker.
 *   4. Niets van deze pagina's geeft rechten: dat doet de database.
 */
type Context = Readonly<RouterContextProvider>;

const NIET_IN_GOOGLE = { "X-Robots-Tag": "noindex, nofollow" };
const redirect = (naar: string) => omleiding(naar, { headers: NIET_IN_GOOGLE });

/** Staan wachtwoorden voor deze build aan? Anders bestaan deze pagina's niet. */
function wachtwoordAan(context: Context): void {
  if (!heeftServerDatabase(context) || !inlogdiensten.includes("wachtwoord")) {
    throw data("Inloggen met een wachtwoord staat voor deze app niet aan.", { status: 404 });
  }
}

function veld(form: FormData, naam: string): string {
  const waarde = form.get(naam);
  return typeof waarde === "string" ? waarde : "";
}

export const LINK_VERLOPEN =
  "Deze link is verlopen of al gebruikt. Vraag hieronder een nieuwe aan, of vraag om een nieuwe uitnodiging.";

export type Instelstand =
  | { stap: "link"; soort: "invite" | "recovery" }
  | { stap: "kiezen"; adres: string | null }
  | { stap: "geen" };

export type Instelantwoord =
  | { soort: "link"; melding: string }
  | { soort: "kiezen"; melding: string };

/** Wat /wachtwoord-instellen laat zien. Wijzigt niets. */
export async function instelstand(context: Context, request: Request): Promise<Instelstand> {
  wachtwoordAan(context);
  const link = leesWachtwoordlink(new URL(request.url).search);
  if (link) return { stap: "link", soort: link.type };
  const wie = await gebruiker(context);
  if (wie) return { stap: "kiezen", adres: wie.email ?? null };
  return { stap: "geen" };
}

/** De twee formulieren van /wachtwoord-instellen: de link omwisselen, en het wachtwoord opslaan. */
export async function instellen(context: Context, request: Request) {
  wachtwoordAan(context);
  const form = await request.formData();
  const doe = veld(form, "doe");
  const supabase = supabaseVoorVerzoek(context);

  if (doe === "link") {
    const link = leesWachtwoordlink(new URL(request.url).search);
    if (!link)
      return data<Instelantwoord>({ soort: "link", melding: LINK_VERLOPEN }, { status: 400 });
    const { error } = await supabase.auth.verifyOtp({
      token_hash: link.tokenHash,
      type: link.type,
    });
    if (error)
      return data<Instelantwoord>({ soort: "link", melding: LINK_VERLOPEN }, { status: 400 });
    // De link staat daarna niet meer in de adresbalk.
    throw redirect("/wachtwoord-instellen");
  }

  if (doe === "opslaan") {
    if (!(await gebruiker(context))) throw redirect("/wachtwoord-instellen");
    const melding = controleerWachtwoord(veld(form, "wachtwoord"), veld(form, "herhaling"));
    if (melding) return data<Instelantwoord>({ soort: "kiezen", melding }, { status: 400 });
    const { error } = await supabase.auth.updateUser({ password: veld(form, "wachtwoord") });
    if (error) {
      const tekst =
        error.code === "same_password"
          ? "Dit is je huidige wachtwoord. Kies een ander."
          : error.code === "weak_password"
            ? "Dit wachtwoord is te zwak. Kies een langer wachtwoord."
            : "Opslaan is niet gelukt. Probeer het opnieuw.";
      return data<Instelantwoord>({ soort: "kiezen", melding: tekst }, { status: 400 });
    }
    inlogOpslag(context).setItem("net", "1");
    throw redirect("/");
  }

  throw data("Dit formulier kent deze pagina niet.", { status: 400 });
}

export type Vergetenstand = { robotSleutel: string | null; verstuurd: boolean };
export type Vergetenantwoord = { melding: string; email: string };

const ROBOT =
  "De controle of je geen robot bent is niet gelukt. Wacht even tot de controle klaar is en probeer het opnieuw.";

/** Wat /wachtwoord-vergeten laat zien. Alleen het eenmalige "verstuurd" wordt opgeruimd. */
export function vergetenstand(context: Context): Vergetenstand {
  wachtwoordAan(context);
  const verstuurd = inlogOpslag(context).neem("melding") === "wachtwoord-verstuurd";
  return { robotSleutel: env.VITE_TURNSTILE_SITEKEY ?? null, verstuurd };
}

/** Een nieuw wachtwoord aanvragen. Altijd hetzelfde antwoord, bekend adres of niet. */
export async function vergeten(context: Context, request: Request) {
  wachtwoordAan(context);
  const form = await request.formData();
  const invoer = veld(form, "email").slice(0, 320);
  const email = leesAdres(invoer);
  if (!email) {
    return data<Vergetenantwoord>(
      { melding: "Dit lijkt geen geldig e-mailadres.", email: invoer },
      { status: 400 },
    );
  }
  const ruwBewijs = veld(form, "captcha") || veld(form, "cf-turnstile-response");
  const captcha = isBewijsVorm(ruwBewijs) ? ruwBewijs : "";
  if (env.VITE_TURNSTILE_SITEKEY && !captcha) {
    return data<Vergetenantwoord>({ melding: ROBOT, email: invoer }, { status: 400 });
  }
  // Waar de link heen gaat, staat in het sjabloon (SiteURL), niet in deze aanvraag.
  const { error } = await supabaseVoorVerzoek(context).auth.resetPasswordForEmail(
    email,
    captcha ? { captchaToken: captcha } : {},
  );
  // Alleen een mislukte controle tegen robots zegt de pagina; die zegt niets over het adres.
  if (error?.code === "captcha_failed") {
    return data<Vergetenantwoord>({ melding: ROBOT, email: invoer }, { status: 400 });
  }
  inlogOpslag(context).setItem("melding", "wachtwoord-verstuurd");
  throw redirect("/wachtwoord-vergeten");
}
