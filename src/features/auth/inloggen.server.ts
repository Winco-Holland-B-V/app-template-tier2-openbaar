import type { Provider, SupabaseClient } from "@supabase/supabase-js";
import { data, redirect as omleiding, type RouterContextProvider } from "react-router";
import { type Inlogopslag, inlogOpslag } from "@/features/auth/inlogcookie.server";
import type { Inlogdienst } from "@/features/auth/inlogdienst";
import { isKnopdienst, type Knopdienst } from "@/features/auth/inlogknoppen";
import {
  BEGIN,
  bewaar,
  CODE_LENGTE,
  controleerCode,
  controleerLink,
  type Fout,
  type FoutSoort,
  fout,
  foutUitAdres,
  herstel,
  isDienstInlogBegonnen,
  isHierAangevraagd,
  leesAdres,
  leesLink,
  merkAangevraagd,
  merkDienstInlog,
  vraagCode,
  wachtNog,
  wisDienstInlog,
} from "@/features/auth/mailcode";
import { isBewijsVorm } from "@/features/auth/robotcontrole";
import { env, inlogdiensten, testloginVoorDev } from "@/lib/env";
import { gebruiker, heeftServerDatabase, supabaseVoorVerzoek } from "@/lib/server/sessie.server";
import { cookieOverHttps, sessieCookieNaam } from "@/lib/server/sessie-cookie";
import { veiligPad, volgendePad } from "@/lib/server/veilig-pad";
import { verzoekUit } from "@/lib/server/verzoek.server";
import { credentialsSchema } from "@/lib/validation";
import stackConfig from "../../../stack.config.json";

/**
 * Inloggen op de server: wat de inlogpagina (`/login`) laat zien en wat haar formulieren
 * doen. De stappen en de teksten komen uit mailcode.ts, dezelfde als in de gewone tier
 * 2-template; hier staat alleen wat anders is omdat de server het werk doet: de sessie komt
 * in het cookie van de serverlaag, en wat de pagina tussen twee verzoeken onthoudt in het
 * cookie uit inlogcookie.server.ts.
 *
 * De regels die hier bewaakt worden:
 *
 *   1. Een GET logt nooit in. De link uit de mail toont een knop; pas het formulier (een POST,
 *      die de Worker alleen van de eigen site aanneemt) wisselt de link om. Zo verbruikt een
 *      virusscanner die links vooraf opent hem niet, en kan een andere site niemand laten
 *      inloggen. De enige uitzondering is de terugkeer van de inlogdienst (`/login/terug`):
 *      die is alleen iets waard met de geheime helft die in deze browser staat.
 *   2. Na het inloggen gaat de bezoeker alleen naar een pad binnen de app (`veiligPad`).
 *   3. Tekst uit het adres komt nooit op het scherm: alleen de vaste teksten uit mailcode.ts.
 *   4. Hetzelfde antwoord bij een bekend en een onbekend adres (dat regelt `vraagCode`).
 *   5. Deze pagina geeft niemand rechten. Wat iemand mag, bepaalt de database; of iemand
 *      medewerker is, vraagt de server aan `is_medewerker()` en besluit hij nooit zelf.
 */
type Context = Readonly<RouterContextProvider>;

/** Wat elke stand van de pagina nodig heeft. */
type Basis = {
  metMail: boolean;
  knoppen: Knopdienst[];
  /** De sitekey van Turnstile, alleen als er per mail wordt ingelogd; anders null. */
  robotSleutel: string | null;
  /** Waar het na het inloggen heen gaat; al nagekeken, altijd een pad binnen de app. */
  volgende: string;
};

export type Inlogstand = Basis &
  (
    | { stap: "ingelogd"; adres: string | null; medewerkersknop: boolean }
    | { stap: "link"; hierAangevraagd: boolean }
    | {
        stap: "code";
        email: string;
        verstuurdOp: number;
        wachtNog: number;
        fout: Fout | null;
        melding: string | null;
      }
    | { stap: "adres"; email: string; fout: Fout | null }
    | { stap: "wachtwoord"; testlogin: string | null }
  );

/** Wat een formulier teruggeeft als het niet met een omleiding eindigt. */
export type Inloguitkomst =
  | { soort: "naar-dienst"; naar: string }
  | { soort: "adres"; email: string; fout: Fout }
  | { soort: "code"; email: string; verstuurdOp: number | null; fout: Fout }
  | { soort: "dienst"; fout: Fout }
  | { soort: "wachtwoord"; melding: string };

/** Een uitkomst met een eigen status (400, 429, 502): de pagina toont hem gewoon. */
type Inlogantwoord = Inloguitkomst | ReturnType<typeof data<Inloguitkomst>>;

function weiger(uitkomst: Inloguitkomst, code: number): Inlogantwoord {
  return data(uitkomst, { status: code });
}

const FOUTEN: readonly FoutSoort[] = [
  "adres",
  "code",
  "verlopen",
  "link",
  "te-vaak",
  "verbinding",
  "uit",
  "robot",
  "dienst",
  "bevestig-adres",
  "adres-bezet",
];
const NIEUWE_CODE = "Er is een nieuwe code verstuurd.";

function basis(volgende: string): Basis {
  const metMail = inlogdiensten.includes("mailcode");
  return {
    metMail,
    knoppen: inlogdiensten.filter((dienst: Inlogdienst): dienst is Knopdienst =>
      isKnopdienst(dienst),
    ),
    robotSleutel: metMail ? (env.VITE_TURNSTILE_SITEKEY ?? null) : null,
    volgende,
  };
}

/**
 * Elke omleiding rond het inloggen zegt zoekmachines weg te blijven, ook op het echte domein
 * (op elk ander adres doet de Worker dat al).
 */
const NIET_IN_GOOGLE = { "X-Robots-Tag": "noindex, nofollow" };

function redirect(naar: string): Response {
  return omleiding(naar, { headers: NIET_IN_GOOGLE });
}

/** Het adres van de inlogpagina, met het pad waar de bezoeker heen wilde erbij. */
export function loginAdres(volgende: string): string {
  return volgende === "/" ? "/login" : `/login?volgende=${encodeURIComponent(volgende)}`;
}

/** Na het inloggen nooit terug naar de inlogpagina zelf: dan naar de startpagina. */
function doel(pad: string): string {
  const veilig = veiligPad(pad);
  return /^\/login(?:[/?#]|$)/.test(veilig) ? "/" : veilig;
}

function neemFout(opslag: Inlogopslag): Fout | null {
  const soort = opslag.neem("fout");
  const bekend = FOUTEN.find((naam) => naam === soort);
  return bekend ? fout(bekend) : null;
}

/** Wat de inlogpagina laat zien. Wijzigt niets, behalve het opruimen van wat één keer getoond is. */
export async function inlogstand(context: Context, request: Request): Promise<Inlogstand> {
  if (!heeftServerDatabase(context)) throw redirect("/");
  const adres = new URL(request.url);
  const opslag = inlogOpslag(context);
  const nu = Date.now();
  const gemeen = basis(doel(volgendePad(adres)));

  // Een fout van de inlogdienst in het adres: de vaste tekst onthouden en het adres schoon.
  const uitAdres = foutUitAdres(adres.search, "", isDienstInlogBegonnen(opslag, nu));
  if (uitAdres) {
    opslag.setItem("fout", uitAdres.soort);
    throw redirect(loginAdres(gemeen.volgende));
  }

  const wie = await gebruiker(context);
  if (wie) {
    opslag.neem("fout");
    let isMedewerker = false;
    if (gemeen.knoppen.includes("cloudflare")) {
      // alleen lezen: de database zegt of deze sessie nu medewerkerrechten heeft.
      const antwoord = await supabaseVoorVerzoek(context).rpc("is_medewerker");
      isMedewerker = antwoord.data === true;
    }
    return {
      ...gemeen,
      stap: "ingelogd",
      adres: wie.email,
      medewerkersknop: gemeen.knoppen.includes("cloudflare") && !isMedewerker,
    };
  }

  const eenmalig = neemFout(opslag);
  const melding = opslag.neem("melding") === "nieuwe-code" ? NIEUWE_CODE : null;
  const ingevuld = leesAdres(opslag.neem("adres") ?? "") ?? "";

  if (!gemeen.metMail) {
    if (inlogdiensten.includes("wachtwoord")) {
      return { ...gemeen, stap: "wachtwoord", testlogin: testloginVoorDev()?.email ?? null };
    }
    return { ...gemeen, stap: "adres", email: "", fout: eenmalig };
  }

  if (leesLink(adres.search)) {
    return { ...gemeen, stap: "link", hierAangevraagd: isHierAangevraagd(opslag, nu) };
  }

  const bewaard = herstel(opslag, nu);
  if (bewaard.stap === "code" && bewaard.verstuurdOp !== null) {
    return {
      ...gemeen,
      stap: "code",
      email: bewaard.email,
      verstuurdOp: bewaard.verstuurdOp,
      wachtNog: wachtNog(bewaard.verstuurdOp, nu),
      fout: eenmalig,
      melding,
    };
  }
  return { ...gemeen, stap: "adres", email: ingevuld, fout: eenmalig };
}

function veld(form: FormData, naam: string): string {
  const waarde = form.get(naam);
  return typeof waarde === "string" ? waarde : "";
}

function status(soort: FoutSoort): number {
  if (soort === "te-vaak") return 429;
  if (soort === "verbinding" || soort === "dienst") return 502;
  return 400;
}

/**
 * De functie in de database die een nieuwe klant op de lijst zet: `klantportaal_aanmelden` in
 * stack.config.json, standaard `klant_aanmelden` (de migratie van het klantportaal). Een
 * bestaande app met een eigen aanmelding zet daar haar eigen functie; zie
 * docs/routes/omzetten-naar-openbaar.md. Een naam die geen functienaam is, weigert hier al.
 */
export function aanmeldfunctie(config: unknown): string {
  const naam =
    config !== null && typeof config === "object" && "klantportaal_aanmelden" in config
      ? config.klantportaal_aanmelden
      : "klant_aanmelden";
  if (typeof naam !== "string" || !/^[a-z_][a-z0-9_]*$/.test(naam)) {
    throw new Error(
      'stack.config.json: "klantportaal_aanmelden" is geen naam van een functie in het schema public.',
    );
  }
  return naam;
}
const AANMELDEN = aanmeldfunctie(stackConfig);

/**
 * Ingelogd. Een nieuwe klant komt op de lijst van klanten (niet goedgekeurd; een medewerker
 * keurt goed), het geheugen van de inlogpagina gaat leeg, en de volgende pagina toont kort op
 * welk adres er is ingelogd.
 */
async function naInloggen(context: Context, opslag: Inlogopslag, aanmelden: boolean) {
  if (aanmelden) {
    // Lukt het aanmelden niet, dan is de klant toch ingelogd; hij staat dan nog niet op de lijst.
    // Ongetypeerd: de naam komt uit stack.config.json, niet uit de types van de database.
    const db: SupabaseClient = supabaseVoorVerzoek(context);
    await db.rpc(AANMELDEN);
  }
  wisGeheimeHelften(context);
  opslag.wisAlles();
  opslag.setItem("net", "1");
}

/** De cookies van Supabase in dit verzoek waarvan de naam (na de naam van de sessie) past. */
function wisCookies(context: Context, past: (rest: string) => boolean, httpOnly: boolean): void {
  const verzoek = verzoekUit(context);
  const { supabaseUrl } = verzoek.instellingen;
  if (!supabaseUrl) return;
  const https = cookieOverHttps(new URL(verzoek.request.url));
  const naam = sessieCookieNaam(supabaseUrl, https);
  for (const deel of (verzoek.request.headers.get("Cookie") ?? "").split(";")) {
    const eigen = deel.split("=")[0]?.trim() ?? "";
    if (!eigen.startsWith(naam) || !past(eigen.slice(naam.length))) continue;
    // Wat Supabase in dit antwoord zelf nog over dit cookie schreef, vervalt: het gaat weg.
    for (let i = verzoek.cookiesUit.length - 1; i >= 0; i--) {
      if (verzoek.cookiesUit[i]?.startsWith(`${eigen}=`)) verzoek.cookiesUit.splice(i, 1);
    }
    verzoek.cookiesUit.push(
      `${eigen}=; Path=/; Max-Age=0${httpOnly ? "; HttpOnly" : ""}; SameSite=Lax${https ? "; Secure" : ""}`,
    );
  }
}

/** Haalt het sessiecookie ook weg als Supabase het uitloggen niet kon bevestigen. */
function wisSessieCookies(context: Context): void {
  wisCookies(context, (rest) => rest === "" || /^\.\d+$/.test(rest), false);
}

/**
 * Ingelogd of uitgelogd: de geheime helften van elke begonnen inlog (PKCE) gaan weg, ook die
 * van een poging die niemand afmaakte. Supabase ruimt alleen de helft op die het net gebruikte.
 */
function wisGeheimeHelften(context: Context): void {
  wisCookies(context, (rest) => rest.endsWith("-code-verifier"), true);
}

/** Na zoveel foute codes in één browser wacht de volgende poging even. */
export const CODE_FOUTEN_VRIJ = 5;
export const CODE_FOUTEN_WACHT_MS = 60 * 1000;
const CODE_FOUTEN = "code-fouten";

/** Hoeveel foute codes deze browser gaf, en hoe lang de volgende poging nog wacht. */
function codeFouten(opslag: Inlogopslag, nu: number): { aantal: number; wachtNog: number } {
  const [aantal, op] = (opslag.getItem(CODE_FOUTEN) ?? "").split(":").map(Number);
  if (
    !Number.isInteger(aantal) ||
    !Number.isFinite(op) ||
    aantal === undefined ||
    op === undefined
  ) {
    return { aantal: 0, wachtNog: 0 };
  }
  const rest = op + CODE_FOUTEN_WACHT_MS - nu;
  return { aantal, wachtNog: aantal >= CODE_FOUTEN_VRIJ && rest > 0 ? rest : 0 };
}

/** Wat de formulieren van de inlogpagina doen. Elk formulier stuurt `doe` mee. */
export async function inloggen(context: Context, request: Request): Promise<Inlogantwoord> {
  if (!heeftServerDatabase(context)) throw redirect("/");
  const adres = new URL(request.url);
  const form = await request.formData();
  const doe = veld(form, "doe");
  const opslag = inlogOpslag(context);
  const nu = Date.now();
  const supabase = supabaseVoorVerzoek(context);
  const gemeen = basis(doel(volgendePad(adres)));
  const terug = loginAdres(gemeen.volgende);

  if (doe === "uitloggen") {
    await supabase.auth.signOut();
    wisSessieCookies(context);
    wisGeheimeHelften(context);
    opslag.wisAlles();
    throw redirect("/");
  }

  // De knop van een inlogdienst, ook voor wie al is ingelogd (een klant die medewerker is, of
  // een medewerker wiens twaalf uur om zijn). De server begint de inlog: de geheime helft
  // (PKCE) komt in een cookie van deze browser, en het adres van de dienst gaat terug naar de
  // pagina, die erheen gaat. Geen omleiding: een formulier dat naar een ander adres wordt
  // omgeleid, houdt de Content-Security-Policy (`form-action 'self'`) tegen.
  if (doe === "dienst") {
    const dienst = veld(form, "dienst");
    if (!isKnopdienst(dienst) || !gemeen.knoppen.includes(dienst)) {
      throw data("Deze manier van inloggen staat voor deze app niet aan.", { status: 400 });
    }
    const provider = (dienst === "cloudflare" ? "custom:cloudflare" : dienst) as Provider;
    const begin = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${adres.origin}/login/terug`, skipBrowserRedirect: true },
    });
    const naar = begin.data?.url ?? "";
    const { supabaseUrl } = verzoekUit(context).instellingen;
    // Alleen naar Supabase zelf, nergens anders heen.
    if (begin.error || !supabaseUrl || !naar.startsWith(`${new URL(supabaseUrl).origin}/`)) {
      return weiger({ soort: "dienst", fout: fout("dienst") }, 502);
    }
    merkDienstInlog(opslag, nu);
    opslag.setItem("volgende", gemeen.volgende);
    return { soort: "naar-dienst", naar };
  }

  // Wie al is ingelogd, logt niet nog een keer in; de pagina toont "Je bent al ingelogd".
  if (await gebruiker(context)) throw redirect(terug);

  if (doe === "wachtwoord" || doe === "testlogin") {
    if (!inlogdiensten.includes("wachtwoord")) {
      throw data("Deze manier van inloggen staat voor deze app niet aan.", { status: 400 });
    }
    const testlogin = doe === "testlogin" ? testloginVoorDev() : null;
    const invoer = testlogin
      ? { success: true as const, data: { email: testlogin.email, password: testlogin.wachtwoord } }
      : credentialsSchema.safeParse({
          email: veld(form, "email"),
          password: veld(form, "password"),
        });
    const antwoord = invoer.success ? await supabase.auth.signInWithPassword(invoer.data) : null;
    if (!antwoord || antwoord.error) {
      const melding =
        doe === "testlogin"
          ? "Inloggen als testgebruiker is niet gelukt. Haal een nieuwe testlogin op met `pnpm testlogin`."
          : "Inloggen is niet gelukt. Controleer je e-mailadres en wachtwoord.";
      return weiger({ soort: "wachtwoord", melding }, 400);
    }
    await naInloggen(context, opslag, true);
    throw redirect(gemeen.volgende);
  }

  if (!gemeen.metMail) {
    throw data("Inloggen per mail staat voor deze app niet aan.", { status: 400 });
  }
  const bewaard = herstel(opslag, nu);
  const ruwBewijs = veld(form, "captcha") || veld(form, "cf-turnstile-response");
  // Een leeg of duidelijk verzonnen bewijs gaat niet naar Supabase: daar telt de aanvraag al
  // mee in de grens per adres (die alle bezoekers samen delen) vóór de controle zelf.
  const captcha = isBewijsVorm(ruwBewijs) ? ruwBewijs : "";

  if (doe === "vraag") {
    const invoer = veld(form, "email").slice(0, 320);
    const email = leesAdres(invoer);
    // Deze browser vroeg net een code aan voor dit adres: geen tweede mail binnen de minuut.
    if (email && bewaard.stap === "code" && bewaard.email === email) {
      if (wachtNog(bewaard.verstuurdOp, nu) > 0) throw redirect(terug);
    }
    // Staat de controle tegen robots aan, dan weigert Supabase een aanvraag zonder bewijs.
    const uitkomst =
      gemeen.robotSleutel && email && !captcha
        ? ({ ok: false, fout: fout("robot") } as const)
        : await vraagCode(supabase.auth, invoer, `${adres.origin}/login`, captcha || undefined);
    if (!uitkomst.ok) {
      return weiger(
        { soort: "adres", email: invoer, fout: uitkomst.fout },
        status(uitkomst.fout.soort),
      );
    }
    bewaar(opslag, { ...BEGIN, stap: "code", email: leesAdres(invoer) ?? invoer, verstuurdOp: nu });
    merkAangevraagd(opslag, nu);
    opslag.setItem("volgende", gemeen.volgende);
    throw redirect(terug);
  }

  if (doe === "opnieuw") {
    if (bewaard.stap !== "code") throw redirect(terug);
    // Te vroeg: de pagina toont hoe lang het nog duurt. Supabase bewaakt de echte grens.
    if (wachtNog(bewaard.verstuurdOp, nu) > 0) throw redirect(terug);
    const uitkomst =
      gemeen.robotSleutel && !captcha
        ? ({ ok: false, fout: fout("robot") } as const)
        : await vraagCode(
            supabase.auth,
            bewaard.email,
            `${adres.origin}/login`,
            captcha || undefined,
          );
    if (uitkomst.ok) {
      bewaar(opslag, { ...bewaard, verstuurdOp: nu });
      merkAangevraagd(opslag, nu);
      opslag.setItem("melding", "nieuwe-code");
    } else {
      opslag.setItem("fout", uitkomst.fout.soort);
    }
    throw redirect(terug);
  }

  if (doe === "ander-adres") {
    bewaar(opslag, BEGIN);
    if (bewaard.email) opslag.setItem("adres", bewaard.email);
    throw redirect(terug);
  }

  if (doe === "code") {
    // Het adres en het tijdstip staan ook in het formulier: wie de mail pas na vijf minuten
    // vindt, kan de code nog invullen op de pagina die openstond.
    const email = leesAdres(veld(form, "email")) ?? bewaard.email;
    const opgegeven = Number(veld(form, "verstuurd_op"));
    const verstuurdOp =
      bewaard.verstuurdOp ?? (Number.isFinite(opgegeven) && opgegeven > 0 ? opgegeven : null);
    // Te veel foute codes in deze browser: eerst even wachten, zonder Supabase te vragen.
    // Een script dat dit cookie weggooit, merkt hier niets van; dat remt Cloudflare (zie
    // docs/WERKWIJZE.md, "De rem per bezoeker hoort bij Cloudflare").
    const fouten = codeFouten(opslag, nu);
    if (fouten.wachtNog > 0) {
      return weiger({ soort: "code", email, verstuurdOp, fout: fout("te-vaak") }, 429);
    }
    // Precies het aantal cijfers van een code, anders gaat er niets naar Supabase.
    const ingevuld = veld(form, "code");
    if (ingevuld.replace(/\D/g, "").length !== CODE_LENGTE) {
      return weiger({ soort: "code", email, verstuurdOp, fout: fout("code") }, 400);
    }
    const uitkomst = await controleerCode(supabase.auth, email, ingevuld, { verstuurdOp, nu });
    if (!uitkomst.ok && (uitkomst.fout.soort === "code" || uitkomst.fout.soort === "verlopen")) {
      opslag.setItem(CODE_FOUTEN, `${fouten.aantal + 1}:${nu}`);
    }
    if (!uitkomst.ok) {
      return weiger(
        { soort: "code", email, verstuurdOp, fout: uitkomst.fout },
        status(uitkomst.fout.soort),
      );
    }
    const naar = adres.searchParams.has("volgende")
      ? gemeen.volgende
      : doel(opslag.getItem("volgende") ?? "/");
    await naInloggen(context, opslag, true);
    throw redirect(naar);
  }

  if (doe === "link") {
    const link = leesLink(adres.search);
    const uitkomst = link
      ? await controleerLink(supabase.auth, link.tokenHash)
      : ({ ok: false, fout: fout("link") } as const);
    if (!uitkomst.ok) {
      // Naar de kale inlogpagina: de link staat daarna niet meer in de adresbalk.
      opslag.setItem("fout", uitkomst.fout.soort);
      throw redirect("/login");
    }
    // Alleen als deze browser de mail zelf aanvroeg, weet hij waar de bezoeker heen wilde.
    const naar = doel(opslag.getItem("volgende") ?? "/");
    await naInloggen(context, opslag, true);
    throw redirect(naar);
  }

  throw data("Dit formulier kent de inlogpagina niet.", { status: 400 });
}

/**
 * De terugkeer van de inlogdienst (`/login/terug?code=...`). De code is alleen iets waard met
 * de geheime helft die bij het begin in een cookie van deze browser is gezet (PKCE); een
 * ander kan iemand dus niet met zijn eigen code laten inloggen. Daarbovenop: zonder het
 * merkteken dat deze browser zelf naar de dienst ging, wordt er niets omgewisseld.
 *
 * Eindigt altijd in een omleiding: de code en een fout van de dienst staan daarna niet meer
 * in de adresbalk.
 */
export async function terugVanDienst(context: Context, request: Request): Promise<never> {
  if (!heeftServerDatabase(context)) throw redirect("/");
  const adres = new URL(request.url);
  const opslag = inlogOpslag(context);
  const nu = Date.now();
  const zelfBegonnen = isDienstInlogBegonnen(opslag, nu);
  const code = adres.searchParams.get("code") ?? "";

  const mislukt = (reden: Fout): never => {
    opslag.setItem("fout", reden.soort);
    throw redirect("/login");
  };

  const uitAdres = foutUitAdres(adres.search, "", zelfBegonnen);
  if (uitAdres) return mislukt(uitAdres);
  if (!zelfBegonnen || !/^[A-Za-z0-9_-]{8,200}$/.test(code)) return mislukt(fout("dienst"));

  const { error } = await supabaseVoorVerzoek(context).auth.exchangeCodeForSession(code);
  if (error) return mislukt(fout("dienst"));

  const naar = doel(opslag.getItem("volgende") ?? "/");
  wisDienstInlog(opslag);
  // Geen aanmelding als klant: wie via de dienst binnenkomt, is medewerker of niets.
  await naInloggen(context, opslag, false);
  throw redirect(naar);
}

/**
 * Voor de balk "Je bent ingelogd als ...": is er zojuist ingelogd, dan het adres van de
 * gecontroleerde sessie, één keer. Zonder het merkteken kost dit niets.
 */
export async function netIngelogdAls(context: Context): Promise<string | null> {
  const verzoek = verzoekUit(context);
  if (!verzoek.request.headers.get("Cookie")) return null;
  const opslag = inlogOpslag(context);
  if (opslag.getItem("net") === null) return null;
  opslag.removeItem("net");
  return (await gebruiker(context))?.email ?? null;
}
