import type { Instellingen } from "./instellingen.server";

/**
 * De beveiliging die op elk verzoek en elk antwoord van de Worker komt, wat een route ook
 * doet: verzoeken van een andere site weigeren, en de beveiligingsheaders zetten.
 *
 * Dit bestand is van de template en komt met elke versie mee.
 */

/** Methodes die niets wijzigen. Al het andere is een schrijvend verzoek. */
const ALLEEN_LEZEN = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Komt een schrijvend verzoek (een formulier, een action, een POST naar een eigen adres)
 * van deze app zelf? Een formulier op een andere site kan de browser van een ingelogde
 * bezoeker hierheen laten posten, met zijn cookie erbij. Elke browser zegt bij zo'n
 * verzoek waar het vandaan komt (`Origin`); klopt dat niet met ons eigen adres, of
 * ontbreekt het, dan weigeren we.
 *
 * React Router doet zelf een lichtere controle, alleen voor pagina's en alleen als er een
 * `Origin` is. Deze geldt voor alles, ook voor routes zonder scherm en `.data`-verzoeken.
 *
 * Een ander systeem dat iets komt afleveren (een webhook) hoort niet hier maar in een
 * Supabase Edge Function.
 */
export function vanEigenSite(request: Request): boolean {
  if (ALLEEN_LEZEN.has(request.method.toUpperCase())) return true;
  const eigen = new URL(request.url).origin;
  const origin = request.headers.get("Origin");
  if (origin !== null) return origin === eigen;
  // Zonder Origin: alleen als de browser zelf zegt dat het van dezelfde site komt.
  return request.headers.get("Sec-Fetch-Site") === "same-origin";
}

/** Een eenmalige code per antwoord; alleen scripts met deze code mogen draaien. */
export function nieuweNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let tekst = "";
  for (const byte of bytes) tekst += String.fromCharCode(byte);
  return btoa(tekst);
}

function oorsprong(adres: string | null): string | null {
  if (!adres) return null;
  try {
    const url = new URL(adres);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * De Content-Security-Policy: wat de pagina in de browser mag laden en waar hij mee mag
 * praten. Scripts alleen van de app zelf en met de eenmalige code van dit antwoord (React
 * Router zet die op zijn eigen scripts); geen script van elders, geen script uit een
 * tekstveld. Verbinden alleen met de app, met Supabase (ook live bijwerken, `wss:`) en met
 * Sentry als die aan staat.
 *
 * Eén uitzondering, en alleen als `VITE_TURNSTILE_SITEKEY` gezet is: de controle tegen robots
 * op het inlogformulier (Cloudflare Turnstile) laadt een script van
 * `challenges.cloudflare.com` en toont zijn vakje in een frame van datzelfde adres. Zonder
 * sleutel staat dat adres nergens in de regels.
 *
 * De app kan afbeeldingen, verbindingen, media, lettertypen en frames van andere domeinen
 * toestaan, en WebAssembly (`browser` in stack.config.json, zie
 * scripts/lib/browser-regels.mjs). Scripts van elders nooit: bij scripts komt hooguit
 * `'wasm-unsafe-eval'` erbij, dat alleen WebAssembly toestaat en geen JavaScript uit tekst.
 */
export const TURNSTILE = "https://challenges.cloudflare.com";

export function contentSecurityPolicy(
  nonce: string,
  instellingen: Instellingen,
  https: boolean,
): string {
  const supabase = oorsprong(instellingen.supabaseUrl);
  const supabaseLive = supabase?.replace(/^http/, "ws") ?? null;
  const sentry = oorsprong(instellingen.sentryDsn);
  const turnstile = instellingen.turnstileSitekey ? TURNSTILE : null;
  const eigen = instellingen.browser;
  const wasm = eigen.wasm ? "'wasm-unsafe-eval'" : null;
  const bronnen = (...lijst: (string | null | string[])[]) =>
    [...new Set(lijst.flat().filter((b): b is string => Boolean(b)))].join(" ");
  const regels = [
    "default-src 'self'",
    `script-src ${bronnen("'self'", `'nonce-${nonce}'`, turnstile, wasm)}`,
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    `img-src ${bronnen("'self'", "data:", "blob:", supabase, eigen.img)}`,
    `font-src ${bronnen("'self'", "data:", eigen.font)}`,
    `connect-src ${bronnen("'self'", supabase, supabaseLive, sentry, eigen.connect)}`,
    `media-src ${bronnen("'self'", "blob:", supabase, eigen.media)}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    `frame-src ${bronnen("'self'", turnstile, eigen.frame)}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (https) regels.push("upgrade-insecure-requests");
  return regels.join("; ");
}

/** Zet de beveiligingsheaders op een antwoord. De CSP alleen op een HTML-pagina. */
export function zetBeveiliging(
  headers: Headers,
  { adres, nonce, instellingen }: { adres: URL; nonce: string; instellingen: Instellingen },
): void {
  const https = adres.protocol === "https:";
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Frame-Options", "DENY");
  if (https) headers.set("Strict-Transport-Security", "max-age=31536000");
  headers.delete("Content-Security-Policy");
  headers.delete("Content-Security-Policy-Report-Only");
  if ((headers.get("Content-Type") ?? "").toLowerCase().includes("text/html")) {
    // In de dev-server zet Vite eigen stijl en scripts in de pagina; daar meldt de browser
    // een overtreding alleen, zodat je hem ziet zonder dat het ontwikkelen stokt.
    const naam =
      instellingen.mode === "development"
        ? "Content-Security-Policy-Report-Only"
        : "Content-Security-Policy";
    headers.set(naam, contentSecurityPolicy(nonce, instellingen, https));
  }
}

/** Voor elk adres dat niet het echte domein is: zoekmachines blijven weg. */
export const NIET_INDEXEREN = "noindex, nofollow";
export const ROBOTS_DICHT = "User-agent: *\nDisallow: /\n";
export const ROBOTS_OPEN = "User-agent: *\nAllow: /\n";
