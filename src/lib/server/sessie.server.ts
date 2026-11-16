import {
  combineChunks,
  createServerClient,
  isChunkLike,
  parseCookieHeader,
  serializeCookieHeader,
  stringFromBase64URL,
} from "@supabase/ssr";
import type { JWK } from "@supabase/supabase-js";
import { type RouterContextProvider, redirect } from "react-router";
import type { Database } from "@/lib/database.types";
import { isOpenbareSleutel } from "./instellingen.server";
import { cookieOverHttps, sessieCookieNaam, sessieCookieOpties } from "./sessie-cookie";
import { veiligPad } from "./veilig-pad";
import { type Gebruiker, type ServerSupabase, type Verzoek, verzoekUit } from "./verzoek.server";

/**
 * Supabase op de server, voor loaders en actions.
 *
 * De regels, in gewone taal (zie ook docs/WERKWIJZE.md):
 *
 *   - De server leest met de sessie van de bezoeker, of als anonieme bezoeker. Nooit met
 *     meer rechten: de regels in de database (RLS) blijven de enige grens, ook hier.
 *   - Eén client per verzoek. `supabaseVoorVerzoek(context)` maakt hem bij de eerste vraag
 *     en geeft daarna steeds dezelfde terug. Maak nergens zelf een client aan, en bewaar
 *     er nooit een bovenin een bestand: die zou van alle bezoekers tegelijk zijn.
 *   - Wie de bezoeker is, vraag je met `gebruiker(context)`. Die controleert de
 *     handtekening van het token. Vertrouw nooit op `auth.getSession()`: die leest alleen
 *     wat er in het cookie staat, en een cookie kan iedereen zelf schrijven.
 *
 * Dit bestand is van de template en komt met elke versie mee.
 */
type Context = Readonly<RouterContextProvider>;

/** Heeft deze app een database? Zonder de Supabase-waarden niet. */
export function heeftServerDatabase(context: Context): boolean {
  const { instellingen } = verzoekUit(context);
  return Boolean(instellingen.supabaseUrl && instellingen.supabaseAnonKey);
}

/** Zo lang mag een begonnen inlog via een inlogdienst duren. */
const VERIFIER_SECONDEN = 15 * 60;

/**
 * De geheime helft van een inlog via een inlogdienst (PKCE, de cookies die op
 * `-code-verifier` eindigen). De server zet hem bij het begin van de inlog en leest hem bij
 * de terugkeer; de browser heeft hem nooit nodig. Daarom, anders dan het sessiecookie:
 * `HttpOnly` (geen script kan erbij) en een kwartier geldig in plaats van ruim een jaar, zodat
 * een inlog die niemand afmaakt geen cookie achterlaat.
 */
function metKorteVerifier<T extends { maxAge?: number }>(
  naam: string,
  waarde: string,
  opties: T,
): T & { httpOnly?: boolean } {
  if (!naam.endsWith("-code-verifier") || waarde === "") return opties;
  return { ...opties, httpOnly: true, maxAge: VERIFIER_SECONDEN };
}

function maakClient(verzoek: Verzoek): ServerSupabase {
  const { supabaseUrl, supabaseAnonKey, schema } = verzoek.instellingen;
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Deze app heeft geen database (VITE_SUPABASE_URL en VITE_SUPABASE_ANON_KEY ontbreken). Vraag eerst `heeftServerDatabase(context)`.",
    );
  }
  if (!isOpenbareSleutel(supabaseAnonKey)) {
    throw new Error(
      "VITE_SUPABASE_ANON_KEY is geen anon-sleutel. De server praat alleen als anonieme bezoeker of met de sessie van de gebruiker; een service role-sleutel of geheime sleutel hoort nooit in de Worker.",
    );
  }
  const adres = new URL(verzoek.request.url);
  const sessieNaam = sessieCookieNaam(supabaseUrl, cookieOverHttps(adres));
  // Haperde het verversen van de sessie bij Supabase (te veel verzoeken, een storing, geen
  // verbinding)? Dan laat supabase-js het sessiecookie wissen alsof de sessie dood is. Dat is
  // hij niet: de bezoeker is voor dit ene verzoek niet ingelogd, maar niet uitgelogd. Zie
  // setAll hieronder.
  let verversenHaperde = false;
  return createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    // `database.types.ts` is voor precies dit ene schema gemaakt; zie src/lib/supabase.ts.
    db: { schema: schema as never },
    global: {
      fetch: async (invoer, init) => {
        if (!isVerversen(invoer)) return fetch(invoer, init);
        // Bij een storing of zonder verbinding probeert supabase-js het tot dertig seconden
        // lang opnieuw. Een pagina wacht daar niet op: één poging per verzoek, en de uitkomst
        // gaat terug als "probeer het straks opnieuw" (429), waar supabase-js niet op wacht.
        const storing = () =>
          Response.json({ code: 429, msg: "Supabase is even niet bereikbaar." }, { status: 429 });
        try {
          const antwoord = await fetch(invoer, init);
          if (antwoord.status === 429 || antwoord.status >= 500) verversenHaperde = true;
          return antwoord.status >= 500 ? storing() : antwoord;
        } catch {
          verversenHaperde = true;
          return storing();
        }
      },
    },
    cookieOptions: sessieCookieOpties(cookieOverHttps(adres), supabaseUrl),
    cookies: {
      getAll() {
        return parseCookieHeader(verzoek.request.headers.get("Cookie") ?? "").map(
          ({ name, value }) => ({ name, value: value ?? "" }),
        );
      },
      setAll(cookies) {
        if (verzoek.antwoordKlaar) {
          console.warn(
            "Supabase wilde de sessie verversen nadat het antwoord al onderweg was; het nieuwe cookie is niet gezet. Vraag `gebruiker(context)` met `await` in de loader, niet in een uitgestelde belofte.",
          );
          return;
        }
        for (const { name, value, options } of cookies) {
          // Het sessiecookie wissen omdat het verversen haperde: niet doen (zie hierboven).
          if (verversenHaperde && value === "" && isChunkLike(name, sessieNaam)) continue;
          verzoek.cookiesUit.push(
            serializeCookieHeader(name, value, metKorteVerifier(name, value, options)),
          );
        }
      },
    },
  });
}

/**
 * De Supabase-client van dit verzoek: met de sessie van de bezoeker als die is ingelogd,
 * anders als anonieme bezoeker. Wat hij mag lezen, bepalen de regels in de database.
 */
export function supabaseVoorVerzoek(context: Context): ServerSupabase {
  const verzoek = verzoekUit(context);
  verzoek.supabase ??= maakClient(verzoek);
  return verzoek.supabase;
}

/** Is dit het verzoek waarmee supabase-js een sessie ververst? */
function isVerversen(invoer: RequestInfo | URL): boolean {
  const adres = new URL(invoer instanceof Request ? invoer.url : String(invoer));
  return (
    adres.pathname.endsWith("/auth/v1/token") &&
    adres.searchParams.get("grant_type") === "refresh_token"
  );
}

type Sleutel = JWK;

/**
 * De sleutellijst van het Supabase-project (`/.well-known/jwks.json`): de openbare sleutels
 * waarmee de server een token zelf controleert, zonder Supabase iets te vragen. Ze staan op
 * moduleniveau: het zijn openbare gegevens van het project, niets van een bezoeker.
 *
 * Bewaren, zodat een stroom verzonnen cookies Supabase niet bij elk verzoek laat vragen:
 *   - een gelukte lijst tien minuten, net als supabase-js doet, ook als hij leeg is (een
 *     project dat nog met het gedeelde geheim tekent);
 *   - een onbekende `kid` haalt hem hoogstens één keer per minuut opnieuw op (een nieuwe
 *     sleutel na een wissel);
 *   - een mislukte poging (storing, geen verbinding) een halve minuut: zolang is niemand
 *     ingelogd, maar elk cookie blijft staan;
 *   - verzoeken die tegelijk komen, wachten op één en dezelfde ophaalbeurt.
 */
const SLEUTELS_GELDIG_MS = 10 * 60 * 1000;
const SLEUTELS_OPNIEUW_MS = 60 * 1000;
const SLEUTELS_MISLUKT_MS = 30 * 1000;
type Sleutellijst = { keys: Sleutel[] | null; opgehaald: number };
const sleutelsPerProject = new Map<string, Sleutellijst>();
const sleutelsOnderweg = new Map<string, Promise<Sleutellijst>>();

async function haalSleutels(supabaseUrl: string, anonKey: string): Promise<Sleutellijst> {
  try {
    const antwoord = await fetch(`${supabaseUrl}/auth/v1/.well-known/jwks.json`, {
      headers: { apikey: anonKey },
    });
    if (!antwoord.ok) return { keys: null, opgehaald: Date.now() };
    const inhoud: unknown = await antwoord.json();
    const lijst: unknown[] =
      typeof inhoud === "object" &&
      inhoud !== null &&
      "keys" in inhoud &&
      Array.isArray(inhoud.keys)
        ? inhoud.keys
        : [];
    const keys = lijst.filter(
      (k): k is Sleutel =>
        typeof k === "object" &&
        k !== null &&
        "kty" in k &&
        typeof k.kty === "string" &&
        "kid" in k &&
        typeof k.kid === "string",
    );
    return { keys, opgehaald: Date.now() };
  } catch {
    return { keys: null, opgehaald: Date.now() };
  }
}

/**
 * De sleutellijst, bewaard of vers. `keys` is null als Supabase niet te bereiken was; `vers`
 * zegt of de lijst bij dit verzoek is opgehaald (pas dan is een onbekende `kid` echt onbekend).
 */
async function sleutellijst(
  supabaseUrl: string,
  anonKey: string,
  kid: string | null,
): Promise<{ keys: Sleutel[] | null; vers: boolean }> {
  const bewaard = sleutelsPerProject.get(supabaseUrl);
  if (bewaard) {
    const leeftijd = Date.now() - bewaard.opgehaald;
    if (bewaard.keys === null) {
      if (leeftijd < SLEUTELS_MISLUKT_MS) return { keys: null, vers: false };
    } else if (leeftijd < SLEUTELS_GELDIG_MS) {
      const kent = kid === null || bewaard.keys.some((k) => k.kid === kid);
      if (kent || leeftijd < SLEUTELS_OPNIEUW_MS) return { keys: bewaard.keys, vers: false };
    }
  }
  let onderweg = sleutelsOnderweg.get(supabaseUrl);
  if (!onderweg) {
    onderweg = haalSleutels(supabaseUrl, anonKey).then((lijst) => {
      sleutelsPerProject.set(supabaseUrl, lijst);
      sleutelsOnderweg.delete(supabaseUrl);
      return lijst;
    });
    sleutelsOnderweg.set(supabaseUrl, onderweg);
  }
  const lijst = await onderweg;
  return { keys: lijst.keys, vers: lijst.keys !== null };
}

/** Een sleutel waarmee Supabase met een openbare sleutel tekent (EC of RSA), geen geheim. */
function isOpenbareJwk(sleutel: Sleutel): boolean {
  return sleutel.kty === "EC" || sleutel.kty === "RSA";
}

/** Het midden van een JWT als object, of null als het geen JWT is. */
function jwtDeel(deel: string | undefined): Record<string, unknown> | null {
  if (!deel || !/^[A-Za-z0-9_-]+$/.test(deel)) return null;
  try {
    const inhoud: unknown = JSON.parse(stringFromBase64URL(deel));
    return typeof inhoud === "object" && inhoud !== null && !Array.isArray(inhoud)
      ? (inhoud as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Kan dit een verversingstoken van Supabase zijn? Supabase geeft een korte, willekeurige
 * reeks letters en cijfers. De vorm staat niet vast in een afspraak, dus deze controle is
 * ruim: hooguit 512 tekens, alleen letters, cijfers en de tekens van base64 en van een adres
 * (`. _ ~ - + / =`); geen spaties, aanhalingstekens of haakjes. Ze houdt rommel tegen, geen
 * aanvaller die de vorm nadoet.
 */
function isVerversingstoken(waarde: unknown): waarde is string {
  return typeof waarde === "string" && /^[A-Za-z0-9._~+/=-]{1,512}$/.test(waarde);
}

/**
 * Wat er in het sessiecookie staat, of null als het geen sessie van Supabase kan zijn. Leest
 * het cookie zoals @supabase/ssr het schrijft (in stukken, met `base64-` ervoor), met de
 * hulpfuncties van dat pakket zelf.
 */
async function sessieUitCookie(
  cookies: { name: string; value: string }[],
  naam: string,
): Promise<{ token: string; kop: Record<string, unknown> } | null> {
  const ruw = await combineChunks(naam, (n) => cookies.find((c) => c.name === n)?.value);
  if (!ruw) return null;
  try {
    const tekst = ruw.startsWith("base64-") ? stringFromBase64URL(ruw.slice(7)) : ruw;
    const sessie: unknown = JSON.parse(tekst);
    if (typeof sessie !== "object" || sessie === null) return null;
    const { access_token: token, refresh_token: verversing } = sessie as Record<string, unknown>;
    if (typeof token !== "string" || !isVerversingstoken(verversing)) return null;
    const [kopDeel, inhoudDeel, handtekening, ...rest] = token.split(".");
    const kop = jwtDeel(kopDeel);
    const inhoud = jwtDeel(inhoudDeel);
    if (!kop || !inhoud || !handtekening || rest.length > 0) return null;
    if (typeof kop.alg !== "string" || kop.alg === "none") return null;
    if (typeof inhoud.sub !== "string" || inhoud.sub === "") return null;
    if (typeof inhoud.exp !== "number") return null;
    return { token, kop };
  } catch {
    return null;
  }
}

/** De twee algoritmen waarmee Supabase met een openbare sleutel tekent (zoals supabase-js). */
const ALGORITMEN: Record<string, RsaHashedImportParams | EcKeyImportParams> = {
  RS256: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
  ES256: { name: "ECDSA", namedCurve: "P-256" },
};

/**
 * Klopt de handtekening van dit token met de openbare sleutel van het project? Hier, zonder
 * Supabase iets te vragen, en ook voor een verlopen token: of het verlopen is, beslist
 * supabase-js daarna zelf. Dezelfde controle als `getClaims` van supabase-js, maar zonder de
 * client van het verzoek, want die ververst een verlopen sessie al bij het opstarten.
 */
async function handtekeningKlopt(token: string, kid: string, sleutels: Sleutel[]) {
  const [kopDeel = "", inhoudDeel = "", handtekening = ""] = token.split(".");
  const alg = jwtDeel(kopDeel)?.alg;
  const sleutel = sleutels.find((k) => k.kid === kid);
  const algoritme = typeof alg === "string" ? ALGORITMEN[alg] : undefined;
  if (!sleutel || !algoritme) return false;
  try {
    const { kid: _kid, key_ops: _ops, ...jwk } = sleutel;
    const openbaar = await crypto.subtle.importKey("jwk", jwk, algoritme, false, ["verify"]);
    const ruw = atob(handtekening.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(ruw, (teken) => teken.charCodeAt(0));
    return await crypto.subtle.verify(
      algoritme.name === "ECDSA" ? { name: "ECDSA", hash: "SHA-256" } : algoritme,
      openbaar,
      bytes,
      new TextEncoder().encode(`${kopDeel}.${inhoudDeel}`),
    );
  } catch {
    return false;
  }
}

/** Haalt het sessiecookie (en zijn stukken) weg uit de browser. */
function wisSessiecookie(verzoek: Verzoek, cookies: { name: string }[], naam: string): void {
  const https = cookieOverHttps(new URL(verzoek.request.url));
  for (const { name } of cookies) {
    if (!isChunkLike(name, naam)) continue;
    verzoek.cookiesUit.push(
      serializeCookieHeader(name, "", { ...sessieCookieOpties(https), maxAge: 0 }),
    );
  }
}

/**
 * Eerst zelf kijken, dan pas Supabase vragen. Een cookie kan iedereen schrijven; elk
 * verzonnen cookie dat de server bij Supabase laat verversen, kost een plek in de emmer van
 * Supabase voor het verversen, en die emmer delen alle bezoekers (Supabase ziet alleen de
 * Worker). Dus:
 *
 *   1. Is het sessiecookie geen sessie van Supabase (vorm), dan is de bezoeker niet ingelogd
 *      en gaat het cookie weg, zonder dat Supabase iets hoort.
 *   2. Het PROJECT bepaalt of de server zelf controleert, niet het token. Staat er in de
 *      sleutellijst van het project een openbare sleutel (ES256, RS256: zo tekent Supabase met
 *      de nieuwe JWT-sleutels), dan moet elk token daarmee getekend zijn. Een token met een
 *      ander algoritme (HS256 in de kop), een onbekende sleutel of een verkeerde handtekening:
 *      zelfde als 1. Ook een verlopen token wordt zo gecontroleerd.
 *   3. Pas daarna vraagt supabase-js het token na en ververst het zo nodig.
 *
 * Alleen een project zonder openbare sleutels (dat nog met het oude gedeelde geheim tekent)
 * kan de server niet zelf controleren: daar gaat na de vormcontrole alles naar Supabase. Dat
 * is een bekend restrisico; zie docs/WERKWIJZE.md ("De rem per bezoeker hoort bij
 * Cloudflare"). Na de overstap op ES256 moet wie nog een oud HS256-token heeft, één keer
 * opnieuw inloggen.
 */
async function leesGebruiker(verzoek: Verzoek, context: Context): Promise<Gebruiker | null> {
  const { supabaseUrl, supabaseAnonKey } = verzoek.instellingen;
  if (!supabaseUrl || !supabaseAnonKey) return null;
  // Zonder cookie is er geen sessie; dan hoeft er ook geen client te komen.
  const header = verzoek.request.headers.get("Cookie");
  if (!header) return null;
  const cookies = parseCookieHeader(header).map(({ name, value }) => ({
    name,
    value: value ?? "",
  }));
  const naam = sessieCookieNaam(supabaseUrl, cookieOverHttps(new URL(verzoek.request.url)));
  if (!cookies.some((c) => isChunkLike(c.name, naam))) return null;

  const sessie = await sessieUitCookie(cookies, naam);
  if (!sessie) {
    wisSessiecookie(verzoek, cookies, naam);
    return null;
  }

  const alg = String(sessie.kop.alg);
  const kid = typeof sessie.kop.kid === "string" && sessie.kop.kid !== "" ? sessie.kop.kid : null;
  const metOpenbareSleutel = alg in ALGORITMEN && kid !== null;
  const lijst = await sleutellijst(supabaseUrl, supabaseAnonKey, metOpenbareSleutel ? kid : null);
  // Supabase niet bereikbaar: vandaag niet ingelogd, maar het cookie blijft staan.
  if (lijst.keys === null) return null;

  let sleutels: Sleutel[] | undefined;
  if (metOpenbareSleutel || lijst.keys.some(isOpenbareJwk)) {
    if (!metOpenbareSleutel || kid === null) {
      // Het project tekent met een openbare sleutel; dit token niet. Supabase hoort er niets van.
      wisSessiecookie(verzoek, cookies, naam);
      return null;
    }
    if (!lijst.keys.some((k) => k.kid === kid)) {
      // Onbekende sleutel. Met een lijst van zojuist is hij echt onbekend en gaat het cookie
      // weg; met een bewaarde lijst kan het een nieuwe sleutel zijn (een wissel bij Supabase),
      // dan alleen voor dit verzoek niet ingelogd.
      if (lijst.vers) wisSessiecookie(verzoek, cookies, naam);
      return null;
    }
    if (!(await handtekeningKlopt(sessie.token, kid, lijst.keys))) {
      wisSessiecookie(verzoek, cookies, naam);
      return null;
    }
    sleutels = lijst.keys;
  }

  try {
    const { data, error } = await supabaseVoorVerzoek(context).auth.getClaims(
      undefined,
      sleutels ? { jwks: { keys: sleutels } } : undefined,
    );
    const claims = data?.claims;
    if (error || !claims || typeof claims.sub !== "string" || claims.sub === "") return null;
    verzoek.ingelogd = true;
    return {
      id: claims.sub,
      email: typeof claims.email === "string" && claims.email !== "" ? claims.email : null,
      claims: { ...claims },
    };
  } catch {
    // Een kapot of nagemaakt cookie is hetzelfde als geen cookie: niet ingelogd.
    return null;
  }
}

/**
 * Wie is de bezoeker? De ingelogde gebruiker, of null. De handtekening van het token is
 * gecontroleerd (`getClaims`): met een zelfgeschreven cookie kom je hier niet doorheen.
 * Binnen één verzoek wordt dit één keer uitgezocht, hoe vaak je het ook vraagt.
 */
export function gebruiker(context: Context): Promise<Gebruiker | null> {
  const verzoek = verzoekUit(context);
  verzoek.gebruiker ??= leesGebruiker(verzoek, context);
  return verzoek.gebruiker;
}

/**
 * Het pad van de pagina bij een gegevensverzoek van React Router: `/wagen.data` hoort bij
 * `/wagen`, en `/_.data` bij `/` (zo noemt React Router 8 de gegevens van de startpagina).
 */
export function paginaPad(pathname: string): string {
  if (pathname.endsWith("/_.data")) return pathname.slice(0, -"_.data".length);
  return pathname.replace(/\.data$/, "");
}

/**
 * Voor een pagina die alleen met inlog mag: de gebruiker, of een omleiding naar de
 * inlogpagina met het pad waar de bezoeker heen wilde (`?volgende=`). De inlogpagina leest
 * dat pad met `volgendePad` uit veilig-pad.ts, nooit rechtstreeks.
 */
export async function vereisGebruiker(context: Context): Promise<Gebruiker> {
  const wie = await gebruiker(context);
  if (wie) return wie;
  const adres = new URL(verzoekUit(context).request.url);
  // Bij een gegevensverzoek van React Router (`/pad.data`, en `/_.data` voor `/`) hoort het pad
  // van de pagina.
  const pad = paginaPad(adres.pathname);
  const volgende = veiligPad(pad === "/login" ? "/" : pad);
  throw redirect(`/login?volgende=${encodeURIComponent(volgende)}`);
}

/**
 * Vraag om een openbare cache voor dit antwoord: browsers en tussenstations mogen het
 * `seconden` lang bewaren en aan anderen geven. Alleen voor een pagina die voor iedereen
 * gelijk is.
 *
 * Het is een verzoek, geen opdracht. De Worker (cache.server.ts) honoreert het alleen als
 * het verzoek zonder cookie en zonder inlog kwam en het antwoord geen cookie zet. In elk
 * ander geval blijft het antwoord `private, no-store`, wat de route ook vraagt.
 */
export function openbaarCache(context: Context, { seconden }: { seconden: number }): void {
  const verzoek = verzoekUit(context);
  if (!Number.isFinite(seconden) || seconden <= 0) return;
  verzoek.openbaarCache = Math.min(Math.floor(seconden), 24 * 60 * 60);
}
