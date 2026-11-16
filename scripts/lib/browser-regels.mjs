/**
 * De eigen aanvullingen van een app op de Content-Security-Policy: wat de pagina in de browser
 * méér mag laden dan de app zelf en Supabase. Een app zet ze in `stack.config.json`, onder
 * `browser`, elk met een reden:
 *
 *   "browser": {
 *     "afbeeldingen_van": { "https://beeld.leverancier.nl": "productfoto's van de leverancier" },
 *     "verbindingen_met": { "https://api.kaart.nl": "de kaart op de contactpagina" },
 *     "media_van":        { "https://video.voorbeeld.nl": "de uitlegvideo" },
 *     "lettertypen_van":  { "https://fonts.voorbeeld.nl": "het lettertype van de huisstijl" },
 *     "frames_van":       { "https://www.youtube-nocookie.com": "de video op de startpagina" },
 *     "webassembly":      "de barcodescanner in het magazijn"
 *   }
 *
 * Wat nooit mag, en waarom:
 *
 *   - iets voor scripts. Een script van een ander domein kan alles in de pagina, ook het
 *     cookie van de sessie gebruiken. Er is geen lijst `scripts_van`, en `unsafe-inline` of
 *     `unsafe-eval` bestaan hier niet. De enige aanvulling bij scripts is `webassembly`: dat
 *     zet `'wasm-unsafe-eval'` aan, zodat een bibliotheek WebAssembly mag starten (een
 *     barcodescanner, een PDF-lezer). Gewone JavaScript uit een tekst draaien blijft verboden;
 *   - een bron die geen vaste https-oorsprong is: geen `*`, geen `https:`, geen `data:`, geen
 *     `http://`, geen pad, geen poort, geen IP-adres. Een jokerteken alleen vooraan en met
 *     minstens twee delen erna (`https://*.leverancier.nl`), en nooit op een adres waar
 *     iedereen een eigen site kan zetten (workers.dev, github.io en dergelijke);
 *   - een aanvulling zonder reden.
 *
 * scripts/bouwen.mjs zet de goedgekeurde lijst bij het bouwen in de Worker (als
 * `VITE_BROWSER_REGELS`; wat er al in de omgeving stond, wordt overschreven). guard:server
 * controleert de lijst in elke pull request. De Worker leest hem in
 * src/lib/server/instellingen.server.ts en controleert de vorm daar nog een keer.
 *
 * Dit bestand is van de template en komt met elke versie mee.
 */

/** De lijsten, met de regel van de Content-Security-Policy waar ze bij horen. */
export const LIJSTEN = {
  afbeeldingen_van: "img-src",
  verbindingen_met: "connect-src",
  media_van: "media-src",
  lettertypen_van: "font-src",
  frames_van: "frame-src",
};

/** Adressen waar iedereen een eigen site kan zetten: daar nooit een jokerteken op. */
const GEDEELD = [
  "workers.dev",
  "pages.dev",
  "github.io",
  "githubusercontent.com",
  "vercel.app",
  "netlify.app",
  "supabase.co",
  "supabase.in",
  "amazonaws.com",
  "cloudfront.net",
  "appspot.com",
  "herokuapp.com",
  "firebaseapp.com",
  "web.app",
  "azurewebsites.net",
  "windows.net",
  "googleusercontent.com",
  "r2.dev",
  "ngrok.io",
  "ngrok-free.app",
];

const OORSPRONG =
  /^https:\/\/(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Is dit een toegestane bron? Geeft null als het goed is, anders de reden van de weigering. */
export function weigerBron(bron) {
  if (typeof bron !== "string") return "is geen tekst";
  if (bron !== bron.trim()) return "heeft spaties eromheen";
  if (/^(\*|https?:|data:|blob:|'.*')$/i.test(bron))
    return "is geen vaste oorsprong maar een hele groep adressen";
  if (!bron.startsWith("https://")) return "begint niet met https://";
  if (!OORSPRONG.test(bron))
    return "is geen kale oorsprong (alleen https://naam.domein, zonder pad, poort, hoofdletters of iets erachter)";
  const host = bron.slice("https://".length);
  const zonderJoker = host.replace(/^\*\./, "");
  if (/^[0-9.]+$/.test(zonderJoker)) return "is een IP-adres";
  if (zonderJoker === "localhost" || zonderJoker.endsWith(".localhost")) return "is localhost";
  if (host.startsWith("*.")) {
    if (zonderJoker.split(".").length < 2) return "heeft een jokerteken op het hoogste niveau";
    if (GEDEELD.some((d) => zonderJoker === d || zonderJoker.endsWith(`.${d}`)))
      return `heeft een jokerteken op ${zonderJoker}, waar iedereen een eigen site kan zetten`;
  }
  return null;
}

function heeftReden(reden) {
  return typeof reden === "string" && reden.trim().length >= 5;
}

/**
 * Leest en controleert `browser` uit stack.config.json.
 *
 * @returns {{ regels: { img: string[], connect: string[], media: string[], font: string[], frame: string[], wasm: boolean }, fouten: string[] }}
 */
export function browserRegels(config) {
  const regels = { img: [], connect: [], media: [], font: [], frame: [], wasm: false };
  const fouten = [];
  const blok = config?.browser;
  if (blok === undefined) return { regels, fouten };
  if (blok === null || typeof blok !== "object" || Array.isArray(blok)) {
    return { regels, fouten: ["`browser` is geen blok met lijsten."] };
  }
  const doel = {
    afbeeldingen_van: regels.img,
    verbindingen_met: regels.connect,
    media_van: regels.media,
    lettertypen_van: regels.font,
    frames_van: regels.frame,
  };
  for (const [sleutel, waarde] of Object.entries(blok)) {
    if (sleutel === "webassembly") {
      if (waarde === false || waarde === undefined) continue;
      if (!heeftReden(waarde)) {
        fouten.push(
          '`browser.webassembly` moet een reden zijn (bijvoorbeeld "de barcodescanner in het magazijn"), geen true.',
        );
        continue;
      }
      regels.wasm = true;
      continue;
    }
    if (/script/i.test(sleutel)) {
      fouten.push(
        `\`browser.${sleutel}\`: scripts van een ander domein mogen nooit. Een script van elders kan alles in de pagina, ook met de sessie van de bezoeker. Zet de bibliotheek in de app (pnpm add).`,
      );
      continue;
    }
    if (!(sleutel in doel)) {
      fouten.push(
        `\`browser.${sleutel}\` bestaat niet. Kies uit: ${[...Object.keys(LIJSTEN), "webassembly"].join(", ")}.`,
      );
      continue;
    }
    if (waarde === null || typeof waarde !== "object" || Array.isArray(waarde)) {
      fouten.push(
        `\`browser.${sleutel}\` moet een blok zijn met per oorsprong een reden, bijvoorbeeld { "https://beeld.leverancier.nl": "productfoto's van de leverancier" }.`,
      );
      continue;
    }
    for (const [bron, reden] of Object.entries(waarde)) {
      const fout = weigerBron(bron);
      if (fout) {
        fouten.push(`\`browser.${sleutel}\`: "${bron}" ${fout}.`);
        continue;
      }
      if (!heeftReden(reden)) {
        fouten.push(`\`browser.${sleutel}\`: "${bron}" heeft geen reden.`);
        continue;
      }
      doel[sleutel].push(bron);
    }
  }
  return { regels, fouten };
}
