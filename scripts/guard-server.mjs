import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { browserRegels } from "./lib/browser-regels.mjs";
import { fail, pass } from "./lib/changed-files.mjs";
import { stackConfig } from "./lib/stack-config.mjs";

/**
 * De regels voor code die op de server draait (de Worker). Een Worker deelt zijn modules
 * tussen alle verzoeken en alle bezoekers, en hij staat tussen de bezoeker en de database.
 * Zes dingen mogen daarom niet, en deze guard zoekt ze op:
 *
 *   1. Zelf een Supabase-client maken. Er zijn er precies twee: die van de browser
 *      (src/lib/supabase.ts) en die van de server, één per verzoek
 *      (`supabaseVoorVerzoek(context)` uit src/lib/server/sessie.server.ts). Een eigen client
 *      bovenin een bestand zou van alle bezoekers tegelijk zijn.
 *   2. Op de server vertrouwen op `auth.getSession()`. Die leest alleen wat er in het cookie
 *      staat, en een cookie kan iedereen zelf schrijven. `gebruiker(context)` controleert het.
 *   3. Bij de bindingen van Cloudflare komen (`cloudflare:workers`, `cloudflare:sockets`).
 *      Er horen er geen te zijn; gegevens en geheimen staan in Supabase.
 *   4. De Worker of de ingang van de server vervangen door iets eigens: `workers/app.ts`
 *      roept de Worker van de template aan, en `src/entry.server.tsx` geeft die van de
 *      template door. Zo geldt de beveiliging van de template voor elk verzoek.
 *   5. Zelf antwoorden bewaren: de Cache API van Cloudflare (`caches.default`,
 *      `caches.open`) of `fetch` met `cf: { cacheEverything, cacheTtl }`. De cacheregel van
 *      de Worker zet de juiste header op elk antwoord, maar een route die zelf een kopie
 *      bewaart, kan de pagina van een ingelogde klant aan de volgende bezoeker geven. Een
 *      pagina die voor iedereen gelijk is, vraagt om een cache met `openbaarCache(context, ...)`.
 *   6. Iets wijzigen in een `loader` (een route-bestand in src/routes/). Een loader draait bij
 *      elk GET-verzoek, en een GET mag ook van een andere site komen (een link, een
 *      afbeelding), mét het cookie van de bezoeker. De Worker weigert alleen een schrijvend
 *      verzoek van een andere site; wijzigen hoort dus in een `action`. Een `.rpc(` mag in een
 *      loader alleen met de markering `// alleen lezen: <reden>` op die regel of erboven.
 *
 * Bij de zesde hoort: een browser-scherm (src/lib/browser-scherm.tsx) importeert zijn scherm
 * uit een bestand dat op `.client` eindigt, zodat de code ervan niet in de Worker komt.
 *
 * En een zevende: de eigen aanvullingen op de Content-Security-Policy (`browser` in
 * stack.config.json) moeten kloppen: alleen kale https-oorsprongen met een reden, en voor
 * scripts niets behalve WebAssembly (zie scripts/lib/browser-regels.mjs).
 *
 * Wat deze guard niet kan: zien of een route zelf iets van een bezoeker bovenin een bestand
 * bewaart (een `let` of een `Map` op moduleniveau). Dat staat als regel in
 * docs/WERKWIJZE.md. Het doel is de agent die improviseert, niet iemand die er moeite voor doet.
 */
const WORTELS = ["src", "workers"];
const TEST = /\.test\.(ts|tsx)$/;

const CLIENT_MAKEN = /\b(createClient|createServerClient|createBrowserClient)\b/;
const MAG_CLIENT_MAKEN = new Set([
  "src/lib/supabase.ts",
  "src/lib/server/sessie.server.ts",
  // Alleen het type van de client.
  "src/lib/server/verzoek.server.ts",
]);

/** Bestanden die (ook) op de server draaien: routes, de Worker, en alles met `.server`. */
function isServercode(pad) {
  return (
    pad.startsWith("workers/") ||
    pad.startsWith("src/routes/") ||
    pad.startsWith("src/lib/server/") ||
    /\.server\.(ts|tsx)$/.test(pad) ||
    pad === "src/root.tsx" ||
    pad === "src/entry.server.tsx"
  );
}

/**
 * `getSession` in elke vorm: `.getSession(`, maar ook een losse verwijzing
 * (`const { getSession } = auth`, `auth["getSession"]`, `const haal = auth.getSession`).
 */
const GET_SESSION = /\bgetSession\b/;
const CLOUDFLARE_MODULE = /["']cloudflare:[a-z-]+["']/;
/** De Cache API van Cloudflare, en fetch-opties waarmee Cloudflare een antwoord bewaart. */
const EIGEN_CACHE = /\bcaches\b(?!\s*:)|\bcacheEverything\b|\bcacheTtl(?:ByStatus)?\b/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full.split("\\").join("/"));
  }
  return out;
}

/** Een regel zonder de toelichting erin: commentaar mag de woorden gewoon noemen. */
function zonderCommentaar(regel) {
  const kaal = regel.trim();
  if (kaal.startsWith("//") || kaal.startsWith("*") || kaal.startsWith("/*")) return "";
  return regel;
}

const problemen = [];

for (const pad of WORTELS.filter((w) => existsSync(w)).flatMap((w) => walk(w))) {
  if (!/\.(ts|tsx|js|jsx|mjs)$/.test(pad) || TEST.test(pad)) continue;
  const regels = readFileSync(pad, "utf8").split("\n");
  for (const [index, ruw] of regels.entries()) {
    const regel = zonderCommentaar(ruw);
    const waar = `${pad}:${index + 1}`;
    if (CLIENT_MAKEN.test(regel) && !MAG_CLIENT_MAKEN.has(pad)) {
      problemen.push(
        `${waar}: maakt zelf een Supabase-client. Gebruik op de server \`supabaseVoorVerzoek(context)\` (één per verzoek) en in de browser \`supabase\` uit @/lib/supabase.`,
      );
    }
    if (isServercode(pad) && GET_SESSION.test(regel)) {
      problemen.push(
        `${waar}: \`getSession()\` in servercode. Die vertrouwt het cookie zonder controle; gebruik \`gebruiker(context)\` of \`vereisGebruiker(context)\`.`,
      );
    }
    if (EIGEN_CACHE.test(regel)) {
      problemen.push(
        `${waar}: bewaart zelf antwoorden (Cache API of \`cf: { cacheEverything, cacheTtl }\`). Zo kan de pagina van een ingelogde klant bij een ander uitkomen, wat de Worker ook aan headers zet. Vraag voor een pagina die voor iedereen gelijk is om een cache met \`openbaarCache(context, { seconden })\`.`,
      );
    }
    if (CLOUDFLARE_MODULE.test(regel)) {
      problemen.push(
        `${waar}: laadt een module van Cloudflare zelf (bindingen). Gegevens en geheimen staan in Supabase; de Worker heeft geen bindingen.`,
      );
    }
  }
}

// Regel 6: een loader (en een middleware, die ook bij elke GET draait) wijzigt niets.
const LEESFUNCTIES = leesfuncties();
for (const pad of existsSync("src/routes") ? walk("src/routes") : []) {
  if (!/\.(ts|tsx|js|jsx)$/.test(pad) || TEST.test(pad)) continue;
  for (const fout of loaderSchrijft(readFileSync(pad, "utf8"))) {
    problemen.push(
      `${pad}:${fout.regel}: de ${fout.waar} ${fout.wat}. Een ${fout.waar} draait bij elk GET-verzoek, ook vanaf een andere site; wijzigen hoort in een \`action\`.${fout.wat.includes("databasefunctie") ? " Leest de functie alleen? Zet haar dan met een reden in `leesfuncties` in stack.config.json (en zet in de migratie `stable`)." : ""}`,
    );
  }
}

/**
 * De functies in de database die alleen lezen, uit `leesfuncties` in stack.config.json: per
 * functie een reden. Alleen die mag een loader met `.rpc(` aanroepen. Een markering in de code
 * (`// alleen lezen: ...`) is niet genoeg: die kan iedereen erbij zetten. Staat de functie in
 * een migratie, dan moet ze daar ook `stable` of `immutable` zijn: zo zegt de database zelf
 * dat ze niets wijzigt.
 */
function leesfuncties() {
  const lijst = stackConfig().leesfuncties ?? {};
  const namen = new Set();
  if (typeof lijst !== "object" || lijst === null || Array.isArray(lijst)) {
    problemen.push("stack.config.json: `leesfuncties` hoort een lijst van naam en reden te zijn.");
    return namen;
  }
  const migraties = existsSync("supabase/migrations")
    ? readdirSync("supabase/migrations")
        .filter((naam) => naam.endsWith(".sql"))
        .sort()
        .map((naam) => readFileSync(join("supabase/migrations", naam), "utf8"))
        .join("\n")
    : "";
  for (const [naam, reden] of Object.entries(lijst)) {
    if (typeof reden !== "string" || reden.trim().length < 10) {
      problemen.push(`stack.config.json: leesfunctie ${naam} heeft geen reden.`);
      continue;
    }
    // De laatste definitie in de migraties telt.
    const definities = [
      ...migraties.matchAll(
        new RegExp(
          `create\\s+(?:or\\s+replace\\s+)?function\\s+(?:public\\.)?"?${naam}"?\\s*\\(([\\s\\S]*?)\\bas\\s+\\$`,
          "gi",
        ),
      ),
    ];
    const laatste = definities.at(-1)?.[1];
    if (laatste !== undefined && !/\b(?:stable|immutable)\b/i.test(laatste)) {
      problemen.push(
        `stack.config.json: leesfunctie ${naam} is in de migraties niet \`stable\` of \`immutable\`; dan kan ze schrijven.`,
      );
      continue;
    }
    namen.add(naam);
  }
  return namen;
}

/**
 * De schrijvende aanroepen in de loader(s) en de middleware van een route-bestand, met hun
 * regelnummer. Bewust eenvoudig: alleen wat letterlijk in de loader of middleware staat,
 * niet in functies die hij aanroept.
 */
function loaderSchrijft(bron) {
  const fouten = [];
  const koppen = [
    {
      waar: "loader",
      kop: /export\s+(?:async\s+)?function\s+loader\s*\(|export\s+const\s+loader\b[^=]*=/g,
      romp: rompNa,
    },
    {
      waar: "middleware",
      kop: /export\s+(?:async\s+)?function\s+(?:unstable_)?middleware\s*\(/g,
      romp: rompNa,
    },
    { waar: "middleware", kop: /export\s+const\s+(?:unstable_)?middleware\b[^=]*=/g, romp: blokNa },
  ];
  for (const { waar, kop, romp: zoekRomp } of koppen) {
    for (const treffer of bron.matchAll(kop)) {
      for (const fout of schrijftIn(
        bron,
        zoekRomp(bron, (treffer.index ?? 0) + treffer[0].length),
      )) {
        fouten.push({ ...fout, waar });
      }
    }
  }
  return fouten;
}

/** Wat er van `vanaf` tot het einde van de eerste haakjes, accolades of blokhaken staat. */
function blokNa(bron, vanaf) {
  const open = bron.slice(vanaf).search(/[[({]/);
  if (open === -1) return null;
  let diepte = 0;
  for (let j = vanaf + open; j < bron.length; j++) {
    if ("[({".includes(bron[j] ?? "")) diepte++;
    else if ("])}".includes(bron[j] ?? "") && --diepte === 0) {
      return { begin: vanaf + open + 1, eind: j };
    }
  }
  return { begin: vanaf + open + 1, eind: bron.length };
}

function schrijftIn(bron, romp) {
  const fouten = [];
  if (!romp) return fouten;
  {
    const tekst = bron.slice(romp.begin, romp.eind);
    const eersteRegel = bron.slice(0, romp.begin).split("\n").length;
    // Per opdracht (tot de volgende `;`): een keten als supabase.from("x").delete() loopt
    // vaak over meer regels.
    let begin = 0;
    for (const opdracht of tekst.split(";")) {
      const regel = eersteRegel + tekst.slice(0, begin).split("\n").length - 1;
      const code = opdracht
        .split("\n")
        .map((r) => (r.trim().startsWith("//") ? "" : r))
        .join("\n");
      const opDeDatabase = /\.from\s*\(|\.storage\b/.test(code);
      const wat = [];
      if (/\.(?:insert|upsert)\s*\(/.test(code)) wat.push("schrijft in de database");
      else if (opDeDatabase && /\.(?:update|delete)\s*\(/.test(code))
        wat.push("wijzigt of verwijdert rijen in de database");
      if (/\.storage\b/.test(code) && /\.(?:upload|remove|move|copy)\s*\(/.test(code))
        wat.push("wijzigt bestanden in de opslag");
      if (/\.auth\s*\.\s*(?:signOut|updateUser|signUp)\s*\(/.test(code))
        wat.push("wijzigt de inlog (uitloggen of de gebruiker aanpassen)");
      if (
        /\bfetch\s*\(/.test(code) &&
        /method\s*:\s*["'`](?:post|put|patch|delete)["'`]/i.test(code)
      )
        wat.push("stuurt een schrijvend verzoek (fetch met POST, PUT, PATCH of DELETE)");
      // Elke `.rpc(` in de loader: de naam moet letterlijk in `leesfuncties` staan.
      for (const rpc of code.matchAll(/\.rpc\s*\(\s*([^,)]*)/g)) {
        const naam = /^["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]$/.exec((rpc[1] ?? "").trim())?.[1];
        if (!naam) {
          wat.push("roept een databasefunctie aan (`.rpc`) met een naam die niet vaststaat");
        } else if (!LEESFUNCTIES.has(naam)) {
          wat.push(`roept de databasefunctie ${naam} aan, die niet in \`leesfuncties\` staat`);
        }
      }
      for (const w of wat) fouten.push({ regel, wat: w });
      begin += opdracht.length + 1;
    }
  }
  return fouten;
}

/** Het begin en einde van de romp van de functie waarvan de kop bij `vanaf` ophoudt. */
function rompNa(bron, vanaf) {
  let i = vanaf;
  if (bron[vanaf - 1] !== "(") {
    // `const loader = async ({ context }) => { ... }`: eerst naar de parameters.
    const haakje = bron.indexOf("(", vanaf);
    if (haakje === -1) return null;
    i = haakje + 1;
  }
  for (let diepte = 1; i < bron.length && diepte > 0; i++) {
    if (bron[i] === "(") diepte++;
    else if (bron[i] === ")") diepte--;
  }
  const pijl = /^\s*(?::[^={]*)?=>\s*/.exec(bron.slice(i));
  let open;
  if (pijl) {
    open = i + pijl[0].length;
    if (bron[open] !== "{") {
      // Een pijlfunctie zonder romp (`=> iets`): tot het einde van de opdracht.
      const eind = bron.indexOf(";", open);
      return { begin: open, eind: eind === -1 ? bron.length : eind };
    }
  } else {
    open = bron.indexOf("{", i);
    if (open === -1) return null;
  }
  for (let j = open, diepte = 0; j < bron.length; j++) {
    if (bron[j] === "{") diepte++;
    else if (bron[j] === "}" && --diepte === 0) return { begin: open + 1, eind: j };
  }
  return { begin: open + 1, eind: bron.length };
}

/** De twee ingangen van de server: ze geven alleen door naar de template. */
const INGANGEN = [
  {
    pad: "workers/app.ts",
    moet: /export default maakWorker\(\{/,
    bron: /from "\.\.\/src\/lib\/server\/worker\.server"/,
    uitleg: "hoort alleen `maakWorker` uit ../src/lib/server/worker.server aan te roepen",
  },
  {
    pad: "src/entry.server.tsx",
    moet: /export \{ default, handleError, streamTimeout \} from "\.\/lib\/server\/document\.server";/,
    bron: /from "\.\/lib\/server\/document\.server"/,
    uitleg: "hoort alleen door te geven wat in ./lib/server/document.server staat",
  },
];
for (const { pad, moet, bron, uitleg } of INGANGEN) {
  if (!existsSync(pad)) {
    problemen.push(`${pad}: ontbreekt. Dit bestand ${uitleg}.`);
    continue;
  }
  const code = readFileSync(pad, "utf8")
    .split("\n")
    .map(zonderCommentaar)
    .filter((regel) => regel.trim() !== "");
  const tekst = code.join("\n");
  const importRegels = code.filter((regel) => /^\s*(import|export)\b/.test(regel));
  if (
    !moet.test(tekst) ||
    !bron.test(tekst) ||
    importRegels.some((r) => /from/.test(r) && !bron.test(r))
  ) {
    problemen.push(
      `${pad}: ${uitleg}; er hoort geen eigen logica in. Zo gaat elk verzoek door de beveiliging van de template.`,
    );
  }
}

// Bij regel 6: een browser-scherm haalt zijn scherm uit een .client-bestand, anders komt alle
// code van het scherm (Excel, PDF, een scanner) in de Worker. De hulp weigert dat ook zelf bij
// het starten; hier zie je het al in de pull request.
for (const pad of existsSync("src/routes") ? walk("src/routes") : []) {
  if (!/\.(ts|tsx)$/.test(pad) || TEST.test(pad)) continue;
  const bron = readFileSync(pad, "utf8");
  if (!/\bbrowserScherm\s*\(/.test(bron)) continue;
  if (!/from\s+["'][^"']*\.client["']/.test(bron)) {
    problemen.push(
      `${pad}: een browser-scherm zonder import uit een bestand dat op .client eindigt. Zet het scherm in een bestand als \`scherm.client.tsx\` (met één regel die het scherm doorgeeft: \`export { default }\` uit het scherm) en importeer het daaruit; zie src/lib/browser-scherm.tsx.`,
    );
  }
}

// Regel 7: de eigen aanvullingen op de Content-Security-Policy.
for (const fout of browserRegels(stackConfig()).fouten) {
  problemen.push(`stack.config.json: ${fout} Zie docs/WERKWIJZE.md, "Server en browser".`);
}

// De gebouwde Worker, als die er is: ook daar geen modules van Cloudflare zelf.
if (existsSync("dist/server")) {
  for (const pad of walk("dist/server")) {
    if (!/\.(js|mjs)$/.test(pad)) continue;
    const tekst = readFileSync(pad, "utf8");
    if (/(?:from|import)\s*\(?\s*["']cloudflare:[a-z-]+["']/.test(tekst)) {
      problemen.push(
        `${pad}: de gebouwde Worker laadt een module van Cloudflare zelf (bindingen).`,
      );
    }
  }
}

if (problemen.length === 0)
  pass(
    "de servercode houdt zich aan de regels (één client per verzoek, geen bindingen, geen eigen cache, een loader wijzigt niets)",
  );

fail("De servercode doet iets wat op een Worker niet veilig is.", [
  ...problemen.map((p) => `- ${p}`),
  "",
  'Zie docs/WERKWIJZE.md, hoofdstuk 2 ("Code op de server"), voor de regels en het waarom.',
]);
