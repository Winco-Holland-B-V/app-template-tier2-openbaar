/**
 * De instellingen van de servercode. Het zijn dezelfde openbare waarden die ook in de
 * schermen zitten (`VITE_...`), bij het bouwen vastgelegd. De server kent geen geheimen:
 * hij praat met Supabase met de anon-sleutel en de sessie van de bezoeker, meer niet.
 *
 * Dit bestand is van de template en komt met elke versie mee.
 */
export type Instellingen = {
  /** `production` voor een gebouwde app, `development` in de dev-server. */
  mode: string;
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
  schema: "public" | "api";
  sentryDsn: string | null;
  /** `test` op de preview en op de testdatabase; anders leeg. */
  omgeving: string | null;
  /**
   * Het eigen domein van de app (uit `routes` in wrangler.jsonc; scripts/bouwen.mjs geeft
   * het bij het bouwen mee). Null zolang er geen eigen domein is.
   */
  productiedomein: string | null;
  /**
   * De openbare sleutel van Cloudflare Turnstile (`VITE_TURNSTILE_SITEKEY`): de controle tegen
   * robots op het inlogformulier. Alleen als hij gezet is, mag de pagina het script van
   * Turnstile laden (zie beveiliging.server.ts). Null: de controle staat uit.
   */
  turnstileSitekey: string | null;
  /**
   * De eigen aanvullingen van de app op de Content-Security-Policy (`browser` in
   * stack.config.json; scripts/bouwen.mjs geeft ze bij het bouwen mee als
   * `VITE_BROWSER_REGELS`). Leeg als de app niets aanvult.
   */
  browser: BrowserRegels;
};

/** Zie scripts/lib/browser-regels.mjs voor de regels en de vorm in stack.config.json. */
export type BrowserRegels = {
  img: string[];
  connect: string[];
  media: string[];
  font: string[];
  frame: string[];
  wasm: boolean;
};

export const GEEN_BROWSER_REGELS: BrowserRegels = {
  img: [],
  connect: [],
  media: [],
  font: [],
  frame: [],
  wasm: false,
};

/** Een kale https-oorsprong, eventueel met een jokerteken vooraan en twee delen erna. */
const OORSPRONG =
  /^https:\/\/(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Leest `VITE_BROWSER_REGELS`. De build heeft de lijst al gecontroleerd; hier nog een keer de
 * vorm, zodat er nooit iets anders dan een kale https-oorsprong in de header komt (geen `;`,
 * geen aanhalingsteken, geen `*` alleen). Wat niet klopt, valt weg.
 */
export function leesBrowserRegels(waarde: unknown): BrowserRegels {
  if (typeof waarde !== "string" || waarde.trim() === "") return GEEN_BROWSER_REGELS;
  let ruw: unknown;
  try {
    ruw = JSON.parse(waarde);
  } catch {
    return GEEN_BROWSER_REGELS;
  }
  if (ruw === null || typeof ruw !== "object") return GEEN_BROWSER_REGELS;
  const blok = ruw as Record<string, unknown>;
  const lijst = (naam: keyof Omit<BrowserRegels, "wasm">): string[] => {
    const w = blok[naam];
    return Array.isArray(w)
      ? w.filter((b): b is string => typeof b === "string" && OORSPRONG.test(b))
      : [];
  };
  return {
    img: lijst("img"),
    connect: lijst("connect"),
    media: lijst("media"),
    font: lijst("font"),
    frame: lijst("frame"),
    wasm: blok.wasm === true,
  };
}

function tekst(waarde: unknown): string | null {
  return typeof waarde === "string" && waarde.trim() !== "" ? waarde.trim() : null;
}

/**
 * Een domein dat nooit productie kan zijn: workers.dev (hoofdadres en previews), de eigen
 * computer, een IP-adres, iets met een jokerteken of een pad.
 */
export function geldigProductiedomein(waarde: unknown): string | null {
  const domein = tekst(waarde)?.toLowerCase() ?? null;
  if (!domein) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domein))
    return null;
  if (domein === "workers.dev" || domein.endsWith(".workers.dev")) return null;
  if (domein === "localhost" || domein.endsWith(".localhost")) return null;
  if (/^[0-9.]+$/.test(domein)) return null;
  return domein;
}

/**
 * De rol in een sleutel in JWT-vorm, of null als het geen JWT is. Alleen om te weigeren:
 * de handtekening controleert Supabase zelf.
 */
function rolVanSleutel(sleutel: string): string | null {
  const delen = sleutel.split(".");
  if (delen.length !== 3 || !delen[1]) return null;
  try {
    const json = atob(delen[1].replace(/-/g, "+").replace(/_/g, "/"));
    const rol = (JSON.parse(json) as { role?: unknown }).role;
    return typeof rol === "string" ? rol : "onbekend";
  } catch {
    return null;
  }
}

/**
 * Is dit een sleutel waarmee de server als anonieme bezoeker praat? Een geheime sleutel
 * (`sb_secret_...`) of een JWT met een andere rol dan `anon` (zoals `service_role`) gaat
 * langs alle regels in de database heen en hoort nooit in de Worker.
 */
export function isOpenbareSleutel(sleutel: string): boolean {
  if (/^sb_secret_/i.test(sleutel)) return false;
  if (/^sb_publishable_/.test(sleutel)) return true;
  const rol = rolVanSleutel(sleutel);
  return rol === null || rol === "anon";
}

export function leesInstellingen(waarden: Record<string, unknown>, mode: string): Instellingen {
  return {
    mode,
    supabaseUrl: tekst(waarden.VITE_SUPABASE_URL),
    supabaseAnonKey: tekst(waarden.VITE_SUPABASE_ANON_KEY),
    schema: waarden.VITE_SUPABASE_SCHEMA === "api" ? "api" : "public",
    sentryDsn: tekst(waarden.VITE_SENTRY_DSN),
    omgeving: tekst(waarden.VITE_OMGEVING),
    productiedomein: geldigProductiedomein(waarden.VITE_PRODUCTIEDOMEIN),
    turnstileSitekey: tekst(waarden.VITE_TURNSTILE_SITEKEY),
    browser: leesBrowserRegels(waarden.VITE_BROWSER_REGELS),
  };
}

/**
 * Is dit verzoek voor het echte adres van de app? Alleen dan mag een zoekmachine de pagina
 * opnemen. Elk ander adres (workers.dev, een preview per pull request, het vaste
 * preview-adres, je eigen computer, de testomgeving) is geen productie.
 *
 * Het adres van het verzoek komt van Cloudflare zelf: een bezoeker kan met een eigen
 * `Host`-regel hooguit bij het echte domein uitkomen, niet een ander adres voor het echte
 * laten doorgaan.
 */
export function isProductie(adres: URL, instellingen: Instellingen): boolean {
  if (instellingen.mode !== "production") return false;
  if (instellingen.omgeving !== null) return false;
  if (instellingen.productiedomein === null) return false;
  return adres.hostname.toLowerCase() === instellingen.productiedomein;
}
