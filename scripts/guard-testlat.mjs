import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fail, pass, skip } from "./lib/changed-files.mjs";
import { controleerResultaat } from "./lib/testlat-resultaat.mjs";

/**
 * De testlat van de template: draaien de tests van de template nog echt, en praat de app
 * nog met de servercode van de template?
 *
 * De configuratie van de tests en de build is van het project (vitest.config.ts,
 * vitest.rls.config.ts, playwright.config.ts, vite.config.ts, tsconfig.json): een app moet daar
 * eigen dingen in kunnen zetten. Maar dezelfde bestanden bepalen welke tests er draaien en
 * waar `@/lib/server/...` naartoe wijst. Wie daar `include` versmalt, `testIgnore` of `grep`
 * zet, of de afkorting `@` laat ombuigen, zet de beveiligingstests van de template uit
 * terwijl alles groen blijft. Deze guard vraagt het daarom aan Vitest, Vite en Playwright
 * zelf, met de config van de app:
 *
 *   1. Elk testbestand van de template (de lijst `vervangen` in .claude/stack-manifest.json)
 *      bestaat en wordt verzameld: unittests door vitest.config.ts, RLS-tests door
 *      vitest.rls.config.ts, browsertests door playwright.config.ts. Geen `testNamePattern`.
 *   2. Elke browsertest van de template staat in de lijst van Playwright, net als zonder de
 *      config van de app, en is niet uitgezet. Overslaan mag alleen met een reden die in
 *      het testbestand van de template zelf staat (zoals "deze app heeft geen database").
 *   3. In een testbestand van de template staat geen `.only`, `.todo`, `.fixme`, `.fail` en
 *      geen `.skip("titel", ...)`.
 *   4. De afkorting `@` wijst naar ./src, in vite.config.ts, in elke Vitest-config en in
 *      tsconfig.json, en geen andere afkorting buigt de servercode van de template (of een
 *      pakket waar die op leunt) om naar iets anders.
 *
 *   5. De waarheid uit de run: de Kwaliteitspoort laat Vitest bij de unittests (job Code) en
 *      de RLS-tests (databasejob) een resultaat schrijven (`--reporter=json
 *      --includeTaskLocation`), en geeft dat hier mee met `--unit-resultaat <pad>` of
 *      `--rls-resultaat <pad>`. Elke test van de template moet daarin echt gedraaid hebben;
 *      overslaan mag alleen met een `skipIf`/`runIf` uit het templatebestand zelf (zie
 *      scripts/lib/testlat-resultaat.mjs). Zo telt geen enkele vorm van uitzetten meer:
 *      `const t = it; t.skip()`, `it.skipIf(1)`, `describe.each([])`. Zonder resultaat (lokaal
 *      in `pnpm check`) kijkt de guard alleen naar de tekst, zoals hieronder bij 3.
 *      Voor de browsertests (Playwright) geldt alleen de lijst van punt 2: die draaien in een
 *      andere job dan deze guard.
 *
 * Deze guard is van de template. De Kwaliteitspoort roept hem rechtstreeks aan
 * (`node scripts/guard-testlat.mjs`), niet via package.json: zo kan een app hem niet
 * ombuigen. Wat hij niet kan: code die een test of een config van de app zelf uitvoert,
 * kan tijdens de run alles doen. Het doel is de improviserende agent; een opzettelijke
 * omweg staat in de diff van de pull request.
 */
const WORTEL = process.cwd();
const argument = (naam) => {
  const i = process.argv.indexOf(naam);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
};
const UNIT_RESULTAAT = argument("--unit-resultaat");
const RLS_RESULTAAT = argument("--rls-resultaat");
let manifest;
try {
  manifest = JSON.parse(readFileSync(".claude/stack-manifest.json", "utf8"));
} catch {
  skip("geen .claude/stack-manifest.json gevonden");
}
const vervangen = manifest.vanDeTemplate?.vervangen ?? [];
const TEST = /\.test\.tsx?$/;
const unit = vervangen.filter((p) => TEST.test(p) && !p.startsWith("tests/rls/"));
const rls = vervangen.filter((p) => TEST.test(p) && p.startsWith("tests/rls/"));
const e2e = vervangen.filter((p) => /^e2e\/.+\.spec\.tsx?$/.test(p));

const problemen = [];

// 5: de waarheid uit de run. Alleen het RLS-resultaat (in de databasejob): alleen dat.
if (RLS_RESULTAAT) {
  const fouten = controleerResultaat(RLS_RESULTAAT, rls, WORTEL);
  if (fouten.length === 0)
    pass(`de RLS-tests van de template draaiden allemaal (${rls.length} bestanden)`);
  fail(
    "Een RLS-test van de template draaide niet.",
    fouten.map((p) => `- ${p}`),
  );
}
if (UNIT_RESULTAAT) problemen.push(...controleerResultaat(UNIT_RESULTAAT, unit, WORTEL));
else
  console.log(
    "i geen resultaat van de unittests meegegeven (--unit-resultaat): alleen de tekst van de tests gecontroleerd; de Kwaliteitspoort geeft het resultaat mee",
  );

// 1 en 3: bestaat elk testbestand van de template, en is er niets in uitgezet? Met een
// resultaat van de run is de tekst van de unittests niet meer nodig (punt 5 is strenger).
const UITGEZET = [
  [/\b(?:it|test|describe|bench)\s*\.\s*only\b/, "`.only` (dan draait de rest niet)"],
  [/\b(?:it|test|describe)\s*\.\s*(?:todo|fixme|fail)\b/, "`.todo`, `.fixme` of `.fail`"],
  [/\b(?:it|test|describe)\s*\.\s*skip\s*\(\s*["'`]/, '`.skip("...")`'],
  [/\.skipIf\s*\(\s*true\b|\.runIf\s*\(\s*false\b/, "`.skipIf(true)` of `.runIf(false)`"],
];
for (const pad of [...unit, ...rls, ...e2e]) {
  if (!existsSync(pad)) {
    problemen.push(`${pad}: dit testbestand van de template ontbreekt.`);
    continue;
  }
  if (UNIT_RESULTAAT && unit.includes(pad)) continue;
  const regels = readFileSync(pad, "utf8").split("\n");
  for (const [index, regel] of regels.entries()) {
    if (regel.trim().startsWith("//") || regel.trim().startsWith("*")) continue;
    for (const [re, wat] of UITGEZET) {
      if (re.test(regel))
        problemen.push(`${pad}:${index + 1}: ${wat} in een test van de template.`);
    }
  }
}

// Een `.only` in welke browsertest ook: dan draait Playwright alleen die, en de tests van de
// template niet. (`--list` toont dat niet, dus hier op de tekst.)
const alleBrowsertests = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory()
          ? alleBrowsertests(join(dir, d.name))
          : /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(d.name)
            ? [join(dir, d.name).split("\\").join("/")]
            : [],
      )
    : [];
for (const pad of alleBrowsertests("e2e")) {
  if (e2e.includes(pad)) continue;
  for (const [index, regel] of readFileSync(pad, "utf8").split("\n").entries()) {
    if (/\b(?:test|describe)\s*\.\s*only\b/.test(regel) && !regel.trim().startsWith("//"))
      problemen.push(
        `${pad}:${index + 1}: \`.only\` in een browsertest. Dan draaien de browsertests van de template niet.`,
      );
  }
}

// 4: de afkorting @ en wat er niet omgebogen mag worden.
const SRC = resolve("src");
const serverBestanden = vervangen.filter((p) => /^src\/lib\/(server|vindbaar)\/.+\.tsx?$/.test(p));
const PROEVEN = new Set();
for (const p of serverBestanden) {
  const zonder = p.replace(/\.tsx?$/, "");
  const naam = zonder.split("/").at(-1);
  PROEVEN.add(`@/${zonder.slice(4)}`);
  PROEVEN.add(`./${naam}`);
  PROEVEN.add(`../src/${zonder.slice(4)}`);
  PROEVEN.add(`./${zonder.slice(4)}`);
}
// De pakketten waar de servercode van de template op leunt.
for (const p of [...serverBestanden, "workers/app.ts", "src/entry.server.tsx"]) {
  if (!existsSync(p)) continue;
  for (const m of readFileSync(p, "utf8").matchAll(
    /from\s+["']([^"'.@/][^"']*|@[^"'/]+\/[^"']+)["']/g,
  )) {
    if (m[1]) PROEVEN.add(m[1]);
  }
}

/** Welke afkorting Vite op `id` toepast: de eerste die past, zoals Vite het zelf doet. */
function eersteAfkorting(lijst, id) {
  return lijst.find(({ find }) =>
    typeof find === "string" ? id === find || id.startsWith(`${find}/`) : find.test(id),
  );
}

function afkortingFouten(alias, waar) {
  const lijst = Array.isArray(alias)
    ? alias
    : Object.entries(alias ?? {}).map(([find, replacement]) => ({ find, replacement }));
  const fouten = [];
  const at = lijst.find((a) => a.find === "@");
  if (!at) fouten.push(`${waar}: de afkorting \`@\` ontbreekt; hij hoort naar ./src te wijzen.`);
  else if (resolve(String(at.replacement)) !== SRC)
    fouten.push(`${waar}: de afkorting \`@\` wijst naar ${at.replacement}, niet naar ./src.`);
  for (const id of PROEVEN) {
    const treffer = eersteAfkorting(lijst, id);
    if (!treffer) continue;
    if (treffer.find === "@" && id.startsWith("@/") && treffer === at) continue;
    fouten.push(
      `${waar}: de afkorting ${String(treffer.find)} buigt \`${id}\` om naar ${treffer.replacement}. De servercode van de template en de pakketten waar die op leunt, worden niet vervangen.`,
    );
  }
  return fouten;
}

const vereis = createRequire(join(WORTEL, "package.json"));
async function laad(pakket) {
  return import(vereis.resolve(pakket));
}

// Vitest: wat verzamelt elke config, en zonder naamfilter?
async function vitestControle(config, verwacht) {
  if (!existsSync(config)) {
    if (verwacht.length)
      problemen.push(`${config} ontbreekt, dus ${verwacht.join(", ")} draaien niet.`);
    return;
  }
  const { createVitest } = await laad("vitest/node");
  const v = await createVitest("test", { config, watch: false, run: true }, {}, {});
  try {
    const gevonden = new Set(
      (await v.globTestSpecifications()).map((s) =>
        relative(WORTEL, s.moduleId).split("\\").join("/"),
      ),
    );
    for (const pad of verwacht) {
      if (existsSync(pad) && !gevonden.has(pad))
        problemen.push(
          `${config}: verzamelt ${pad} niet (include, exclude of projects). Dit is een test van de template.`,
        );
    }
    for (const project of v.projects) {
      const naam = project.name ? ` (project ${project.name})` : "";
      if (project.config.testNamePattern)
        problemen.push(
          `${config}${naam}: testNamePattern ${project.config.testNamePattern} slaat tests over.`,
        );
      problemen.push(...afkortingFouten(project.vite.config.resolve.alias, `${config}${naam}`));
      for (const setup of project.config.setupFiles ?? []) {
        const tekst = existsSync(setup) ? readFileSync(setup, "utf8") : "";
        if (/vi\.(?:do)?[mM]ock\s*\(\s*["'`][^"'`]*(?:lib\/server|scripts\/)/.test(tekst))
          problemen.push(
            `${relative(WORTEL, setup)}: bootst de servercode of de scripts van de template na voor alle tests.`,
          );
      }
    }
  } finally {
    await v.close();
  }
}

// Vite: de build van de app (de echte servercode).
async function viteControle() {
  if (!existsSync("vite.config.ts")) return problemen.push("vite.config.ts ontbreekt.");
  const { resolveConfig } = await laad("vite");
  const c = await resolveConfig({ configFile: "vite.config.ts", logLevel: "silent" }, "build");
  problemen.push(...afkortingFouten(c.resolve.alias, "vite.config.ts"));
  for (const [naam, omgeving] of Object.entries(c.environments ?? {})) {
    const alias = omgeving?.resolve?.alias;
    if (alias && alias !== c.resolve.alias)
      problemen.push(...afkortingFouten(alias, `vite.config.ts (omgeving ${naam})`));
  }
}

// tsconfig.json: de typecontrole kijkt naar dezelfde bestanden als de build.
function tsconfigControle() {
  if (!existsSync("tsconfig.json")) return problemen.push("tsconfig.json ontbreekt.");
  let config;
  try {
    config = JSON.parse(zonderJsonCommentaar(readFileSync("tsconfig.json", "utf8")));
  } catch {
    return problemen.push("tsconfig.json is niet te lezen.");
  }
  const paden = config.compilerOptions?.paths ?? {};
  const doel = (paden["@/*"] ?? []).map((p) => resolve(String(p).replace(/\/\*$/, "")));
  if (doel.length !== 1 || doel[0] !== SRC)
    problemen.push('tsconfig.json: "paths" hoort "@/*": ["./src/*"] te hebben.');
  for (const sleutel of Object.keys(paden)) {
    if (sleutel === "@/*") continue;
    const re = new RegExp(`^${sleutel.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace("*", ".*")}$`);
    for (const id of PROEVEN)
      if (re.test(id)) problemen.push(`tsconfig.json: "paths" "${sleutel}" buigt \`${id}\` om.`);
  }
}

function zonderJsonCommentaar(tekst) {
  let uit = "";
  for (let i = 0, inTekst = false; i < tekst.length; i++) {
    const t = tekst[i];
    if (inTekst) {
      uit += t;
      if (t === "\\") uit += tekst[++i] ?? "";
      else if (t === '"') inTekst = false;
    } else if (t === '"') {
      inTekst = true;
      uit += t;
    } else if (t === "/" && tekst[i + 1] === "/") {
      while (i < tekst.length && tekst[i] !== "\n") i++;
      uit += "\n";
    } else if (t === "/" && tekst[i + 1] === "*") {
      i = tekst.indexOf("*/", i + 2) + 1;
      if (i === 0) break;
    } else uit += t;
  }
  return uit.replace(/,(\s*[}\]])/g, "$1");
}

// Playwright: wat staat er in de lijst, met de config van de app en zonder.
function playwrightLijst(config) {
  const cli = vereis.resolve("@playwright/test/cli");
  const r = spawnSync(
    process.execPath,
    [cli, "test", "--list", "--reporter=json", ...(config ? ["--config", config] : [])],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  let rapport;
  try {
    rapport = JSON.parse(r.stdout);
  } catch {
    return { fout: `${r.stdout}${r.stderr}`.trim().split("\n").slice(-5).join(" ") };
  }
  const tests = [];
  const loop = (suite, titels) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        tests.push({
          bestand: relative(WORTEL, resolve(rapport.config.rootDir, spec.file))
            .split("\\")
            .join("/"),
          titel: [...titels, spec.title].join(" › "),
          status: t.expectedStatus,
          notities: t.annotations ?? [],
        });
      }
    }
    for (const kind of suite.suites ?? []) loop(kind, [...titels, kind.title]);
  };
  for (const suite of rapport.suites ?? []) loop(suite, []);
  const fouten = (rapport.errors ?? []).map((e) => e.message ?? String(e));
  return { tests, fout: fouten.length ? fouten.join(" ") : null };
}

function playwrightControle() {
  if (!e2e.length) return;
  if (!existsSync("playwright.config.ts")) return problemen.push("playwright.config.ts ontbreekt.");
  const map = mkdtempSync(join(tmpdir(), "testlat-"));
  try {
    // Dezelfde bestanden zonder de config van de app: wat de template zelf verwacht.
    const neutraal = join(map, "playwright.config.mjs");
    writeFileSync(
      neutraal,
      `export default ${JSON.stringify({
        testDir: resolve("e2e"),
        testMatch: e2e.filter((p) => existsSync(p)).map((p) => `**/${p.split("/").at(-1)}`),
        projects: [{ name: "template" }],
      })};\n`,
    );
    const zonder = playwrightLijst(neutraal);
    const met = playwrightLijst(null);
    if (zonder.fout && !zonder.tests?.length)
      return problemen.push(`De browsertests van de template laden niet: ${zonder.fout}`);
    if (met.fout)
      problemen.push(
        `playwright test --list geeft een fout (bijvoorbeeld een .only met forbidOnly): ${met.fout}`,
      );
    const aanwezig = new Map();
    for (const t of met.tests ?? []) {
      const sleutel = `${t.bestand}|${t.titel}`;
      aanwezig.set(sleutel, [...(aanwezig.get(sleutel) ?? []), t]);
    }
    for (const t of zonder.tests) {
      const eigen = aanwezig.get(`${t.bestand}|${t.titel}`);
      if (!eigen) {
        problemen.push(
          `playwright.config.ts: de browsertest "${t.titel}" (${t.bestand}) staat niet in de lijst (testIgnore, testMatch, grep, projects, of een .only in een ander bestand).`,
        );
        continue;
      }
      const bron = readFileSync(t.bestand, "utf8");
      for (const e of eigen) {
        const overgeslagen = e.status === "skipped";
        // Alleen de notities die een test uitzetten tellen (niet bijvoorbeeld "serial").
        const overslaan = e.notities.filter((n) => n.type === "skip");
        const redenVanTemplate =
          overslaan.length > 0 &&
          overslaan.every((n) => n.description && bron.includes(n.description));
        if (
          e.status === "failed" ||
          e.notities.some((n) => n.type === "fail" || n.type === "fixme")
        )
          problemen.push(`${t.bestand}: "${t.titel}" staat op fail of fixme.`);
        else if (overgeslagen && !redenVanTemplate)
          problemen.push(
            `${t.bestand}: "${t.titel}" wordt overgeslagen, niet door de template zelf.`,
          );
      }
    }
  } finally {
    rmSync(map, { recursive: true, force: true });
  }
}

const vitestUnit = vitestControle("vitest.config.ts", unit);
await vitestUnit;
await vitestControle("vitest.rls.config.ts", rls);
await viteControle();
tsconfigControle();
playwrightControle();

if (problemen.length === 0)
  pass(
    `de testlat van de template staat: ${unit.length + rls.length} testbestanden en ${e2e.length} browsertests verzameld, de afkorting @ wijst naar ./src`,
  );

fail("De tests of de servercode van de template worden omzeild.", [
  ...problemen.map((p) => `- ${p}`),
  "",
  "De config van de tests en de build (vitest.config.ts, playwright.config.ts, vite.config.ts,",
  "tsconfig.json) is van de app, maar mag de tests van de template niet uitzetten en de",
  "afkorting @ niet ombuigen. Zet het terug; heb je een test van de app die niet moet draaien,",
  "sluit dan alleen dát bestand uit. Zie docs/WERKWIJZE.md, hoofdstuk 7.",
]);
