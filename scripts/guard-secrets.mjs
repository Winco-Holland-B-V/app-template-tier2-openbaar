import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fail, pass } from "./lib/changed-files.mjs";

/**
 * Drie vragen tegelijk:
 *   1. Staat er een geheime sleutel in de repo (ook in de servercode)?
 *   2. Staat er een geheime sleutel in de gebouwde bundel, dus in het bestand dat
 *      iedere bezoeker downloadt (dist/client)?
 *   3. Staat er een geheime sleutel in de gebouwde Worker (dist/server): de servercode,
 *      de bronkaarten (`.map`) en de config met variabelen die naar Cloudflare gaat?
 *
 * De tweede is de gevaarlijkste van de hele stack. Eén `VITE_`-variabele te veel
 * en de service role key van je klant staat op straat, terwijl de app er van
 * buiten volstrekt normaal uitziet. De derde is even erg op een andere manier: een Worker
 * met een service role-sleutel leest langs alle regels in de database heen, voor elke
 * bezoeker. De servercode krijgt daarom geen enkel geheim; ook geen `.dev.vars`.
 *
 * Een regel in git bewust vrijgeven kan met de markering `guard-secrets:allow` op die regel.
 * In de gebouwde bestanden werkt die markering niet.
 *
 * Ook in bestanden die geen tekst zijn (pdf, zip, lettertype, afbeelding, video): een sleutel
 * in public/brochure.pdf staat na de build in dist/client en wordt aan elke bezoeker
 * geserveerd. Zo'n bestand lezen we byte voor byte en zoeken we alleen naar de vorm van een
 * sleutel (de patronen hieronder). Wat de guard niet ziet: een sleutel die ingepakt is
 * (een gecomprimeerde stroom in een pdf of zip); zie docs/WERKWIJZE.md.
 */
const JWT = /\beyJ[\w-]{10,}\.(eyJ[\w-]{10,})\.[\w-]{5,}/g;

/**
 * De anon key is óók een JWT en hoort wél in de bundel: hij is expres publiek en
 * wordt door RLS beschermd. Elke andere rol, en met name service_role, is een
 * datalek. Daarom kijken we naar de inhoud van het token in plaats van naar de vorm.
 */
function jwtRole(match) {
  try {
    const payload = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
    return typeof payload.role === "string" ? payload.role : "onbekend";
  } catch {
    return "onleesbaar";
  }
}

const PATTERNS = [
  { name: "Supabase secret key", re: /\bsb_secret_[A-Za-z0-9_-]{10,}/ },
  {
    name: "privésleutel",
    re: /-{5}BEGIN (?:[A-Z]+ )?PRIVATE KEY-{5}/,
    // In de bundel is de kale header niet genoeg: cryptobibliotheken (zoals de
    // sleutel-parser in @vercel/blob) bevatten die tekst in hun eigen code. Een
    // gelekte sleutel herken je aan wat erna komt: de base64-inhoud, eventueel
    // met letterlijke "\n"-tekens omdat de bundel geminificeerd is.
    reBundel: /-{5}BEGIN (?:[A-Z]+ )?PRIVATE KEY-{5}(?:\\r?\\?n|\s)*[A-Za-z0-9+/]{40}/,
  },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Stripe live key", re: /\b[rs]k_live_[A-Za-z0-9]{10,}/ },
  { name: "GitHub token", re: /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { name: "OpenAI/Anthropic-achtige key", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/ },
  { name: "service role key met waarde", re: /SERVICE_ROLE_KEY\s*[:=]\s*["']?\S{10,}/ },
  // Een Cloudflare-API-sleutel heeft geen herkenbaar voorvoegsel; hij valt op aan de
  // naam waaronder hij wordt toegekend. Een verwijzing als ${{ secrets.X }} is prima.
  {
    name: "Cloudflare-API-sleutel met waarde",
    re: /CLOUDFLARE_[A-Z_]*TOKEN\s*[:=]\s*["']?[A-Za-z0-9_-]{30,}/,
  },
  // Resend: re_, minstens zes tekens, een liggend streepje en een lange staart, met ergens een
  // cijfer. Een naam als re_render_pagina of re_GeheimeSleutelVanResend123 past niet.
  { name: "Resend-sleutel", re: /\bre_(?=[A-Za-z0-9_]*\d)[A-Za-z0-9]{6,}_[A-Za-z0-9]{16,}/ },
  // Een Postgres-adres met een wachtwoord erin. Een voorbeeld of een verwijzing mag
  // (`${WW}`, `<wachtwoord>`, `[YOUR-PASSWORD]`, `postgres` voor de lokale database), en een
  // adres op de eigen computer ook; zie `isPostgresGeheim`.
  { name: "Postgres-adres met wachtwoord", test: isPostgresGeheim },
];

/** Wachtwoorden die een voorbeeld zijn, geen geheim. */
const VOORBEELD_WACHTWOORD =
  /^(?:\$\{[^}]*\}|\$[A-Za-z_]\w*|<[^>]*>|\[[^\]]*\]|\{\{[^}]*\}\}|[*x.]+|postgres|password|passwd|pass|wachtwoord|ww|geheim|secret|changeme|test)$/i;
const POSTGRES_ADRES = /\bpostgres(?:ql)?:\/\/([^\s:/@'"`]+):([^\s@'"`]+)@([^\s/:'"`?]+)/gi;

function isPostgresGeheim(regel) {
  for (const [, , wachtwoord = "", host = ""] of regel.matchAll(POSTGRES_ADRES)) {
    if (VOORBEELD_WACHTWOORD.test(wachtwoord)) continue;
    if (/^(?:localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)$/i.test(host)) continue;
    return true;
  }
  return false;
}

/** Past dit patroon op deze tekst? Een patroon is een reguliere expressie of een functie. */
function past(pattern, tekst, bundel) {
  if (pattern.test) return pattern.test(tekst);
  return (bundel && pattern.reBundel ? pattern.reBundel : pattern.re).test(tekst);
}

const SKIP_FILES = new Set(["pnpm-lock.yaml", "scripts/guard-secrets.mjs"]);
/** Geen tekst: deze lezen we als losse bytes in plaats van als regels (zie `scanBytes`). */
const BINAIR =
  /\.(png|jpe?g|gif|ico|webp|avif|bmp|tiff?|woff2?|ttf|otf|eot|pdf|zip|gz|br|tar|7z|rar|mp[34]|m4a|webm|ogg|wav|mov|wasm)$/i;
const ENV_FILE = /^\.env(\..+)?$/;
/** Geheimen voor de servercode van een Worker. Die krijgt er geen; zie boven. */
const DEV_VARS = /^\.dev\.vars(\..+)?$/;

const problems = [];

/**
 * Een bestand dat geen tekst is: de bytes één op één als tekens (latin1), zodat een sleutel
 * die er als gewone tekst in staat gewoon te vinden is, en de rest geen leesfouten geeft. Elk
 * token telt, ook in de bundel (in een afbeelding of pdf hoort zelfs de anon key niet), en
 * de patronen van de bundel gelden: die zijn het strengst tegen vals alarm.
 */
function scanBytes(file, bytes, origin) {
  const tekst = `${bytes.toString("latin1")}\n${zonderNulbytes(bytes) ?? ""}`;
  for (const token of tekst.matchAll(JWT)) {
    problems.push(
      `${origin} ${file}: JSON Web Token met rol "${jwtRole(token)}" (in een bestand dat geen tekst is)`,
    );
  }
  for (const pattern of PATTERNS) {
    if (past(pattern, tekst, true)) {
      problems.push(`${origin} ${file}: ${pattern.name} (in een bestand dat geen tekst is)`);
    }
  }
}

/**
 * Een sleutel kan ook in UTF-16 in een bestand staan (een .txt uit Windows-Kladblok, een
 * export): dan staat er na elk teken een nulbyte, en ziet een zoektocht in UTF-8 of latin1
 * niets. Heeft een bestand nulbytes, dan zoeken we ook in de tekst zonder die nulbytes. De
 * sleutels zelf bestaan alleen uit gewone tekens, dus zo staan ze er weer aaneen.
 */
function zonderNulbytes(bytes) {
  return bytes.includes(0) ? bytes.toString("latin1").replace(/\0/g, "") : null;
}

function scan(file, content, origin) {
  const isBundle = origin === "[bundel]";
  const lines = content.split("\n");
  for (const [index, line] of lines.entries()) {
    // De markering geldt alleen in git, waar iemand hem in de diff ziet. In een gebouwd
    // bestand (vaak één lange regel) zou hij alles op die regel vrijgeven.
    if (!isBundle && line.includes("guard-secrets:allow")) continue;

    // Elk token op de regel, niet alleen het eerste: een gebouwd bestand is vaak één lange
    // regel, en daar staat de anon key (die mag) dan vóór een sleutel die niet mag.
    for (const token of line.matchAll(JWT)) {
      const role = jwtRole(token);
      // In de bundel is alleen de anon key acceptabel; in git hoort geen enkel token.
      if (!isBundle || role !== "anon") {
        problems.push(`${origin} ${file}:${index + 1}: JSON Web Token met rol "${role}"`);
      }
    }

    for (const pattern of PATTERNS) {
      if (past(pattern, line, isBundle)) {
        problems.push(`${origin} ${file}:${index + 1}: ${pattern.name}`);
      }
    }
  }
}

// 1. Alles wat in git zit.
const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);

for (const file of tracked) {
  const base = file.split("/").at(-1) ?? file;
  if (ENV_FILE.test(base) && base !== ".env.example") {
    problems.push(`[git] ${file}: een .env-bestand hoort nooit in git`);
    continue;
  }
  if (DEV_VARS.test(base)) {
    problems.push(`[git] ${file}: een .dev.vars-bestand hoort nooit in git`);
    continue;
  }
  if (SKIP_FILES.has(file)) continue;
  if (BINAIR.test(file)) {
    try {
      scanBytes(file, readFileSync(file), "[git]");
    } catch {
      // weg of onleesbaar: overslaan
    }
    continue;
  }
  try {
    const bytes = readFileSync(file);
    const utf16 = zonderNulbytes(bytes);
    scan(file, utf16 ?? bytes.toString("utf8"), "[git]");
  } catch {
    // onleesbaar of binair: overslaan
  }
}

// 2. De gebouwde bundel, als die er is.
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// Geheimen voor de Worker op deze computer: de build kopieert ze naar dist/server, en de
// servercode hoort er geen te hebben.
for (const naam of readdirSync(".")) {
  if (DEV_VARS.test(naam)) {
    problems.push(
      `[server] ${naam}: de servercode krijgt geen geheimen. Haal dit bestand weg; een geheime sleutel hoort in een Supabase Edge Function`,
    );
  }
}

if (existsSync("dist")) {
  for (const file of walk("dist")) {
    const base = file.split(/[\\/]/).at(-1) ?? file;
    if (DEV_VARS.test(base) || ENV_FILE.test(base)) {
      problems.push(
        `[bundel] ${file}: een bestand met variabelen in de gebouwde app. De servercode krijgt geen geheimen`,
      );
      continue;
    }
    if (BINAIR.test(file)) {
      scanBytes(file, readFileSync(file), "[bundel]");
      continue;
    }
    let content;
    try {
      const bytes = readFileSync(file);
      content = zonderNulbytes(bytes) ?? bytes.toString("utf8");
    } catch {
      continue;
    }
    scan(file, content, "[bundel]");
    // De tekst "service_role" zelf: alleen in wat de bezoeker downloadt. In de gebouwde
    // Worker staat dat woord ook in de toelichting van de Supabase-bibliotheek; daar telt
    // alleen een echte sleutel (de patronen hierboven).
    const voorDeBrowser = !file.split(/[\\/]/).join("/").startsWith("dist/server/");
    if (voorDeBrowser && /service_role/.test(content)) {
      problems.push(`[bundel] ${file}: de tekst "service_role" staat in de bundel`);
    }
  }
} else {
  console.log(
    "i dist/ bestaat niet, alleen de repo gecontroleerd (draai `pnpm build` voor de bundelcheck)",
  );
}

if (problems.length === 0) pass("geen geheimen gevonden in de repo of de bundel");

fail("Er staat mogelijk een geheime sleutel in de repo of in de bundel.", [
  ...problems.map((problem) => `- ${problem}`),
  "",
  "Wat nu:",
  "  - Staat het in de bundel? Dan hoort die sleutel niet in een VITE_-variabele.",
  "    Verplaats de aanroep naar een Supabase Edge Function.",
  "  - Staat het in de servercode of in dist/server? De Worker krijgt geen geheimen: hij",
  "    leest met de sessie van de bezoeker of als anonieme bezoeker. Ook dan: een Edge Function.",
  "  - Staat het in git? Verwijder hem én draai de sleutel om. Wat één keer",
  "    gepusht is, is gelekt, ook na een revert.",
  "  - Vals alarm? Zet `guard-secrets:allow` als commentaar op die regel.",
]);
