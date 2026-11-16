#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Het mechanische deel van docs/routes/omzetten-naar-openbaar.md (stap 2 en 3): een app van de
 * gewone tier 2-template overzetten op deze template. Draai het in de map van de app, met het
 * script uit een kloon van deze template op dezelfde versie:
 *
 *   node "$T/scripts/omzetten-naar-openbaar.mjs"
 *
 * Wat het doet:
 *   - elk bestand uit het manifest van deze template neerzetten, en weghalen wat alleen in het
 *     oude manifest stond; AGENTS.md alleen tussen de markeringen;
 *   - het skelet van het project (de config, src/root.tsx, de inlog, src/lib/env.ts ...)
 *     overnemen; wat de app daarin zelf had, laat `git diff` zien;
 *   - package.json: scripts en devDependencies van de template, dependencies van allebei,
 *     zonder `react-router-dom`; in src/, tests/ en e2e/ `react-router-dom` naar
 *     `react-router`;
 *   - wrangler.jsonc van de template, met de naam en het eigen domein van de app;
 *   - de regels voor gegenereerde bestanden in .gitignore.
 *
 * Wat het niet doet, en aan het eind opsomt: de schermen als browser-scherm in src/routes.ts
 * zetten, src/root.tsx en src/site.ts invullen, de rechten in de database (stap 4 tot en met 9
 * van de route). Het commit niets en installeert niets.
 *
 * Getest in tests/unit/omzetten-naar-openbaar.test.ts. Dit bestand is van de template.
 */

const TEMPLATE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Van het project, maar zonder de versie van deze template werkt de app niet. */
export const SKELET = [
  "react-router.config.ts",
  "vite.config.ts",
  "tsconfig.json",
  "vitest.config.ts",
  "vitest.rls.config.ts",
  "playwright.config.ts",
  ".env.example",
  "src/root.tsx",
  "src/entry.client.tsx",
  "src/lib/env.ts",
  "src/lib/env.test.ts",
  "src/lib/supabase.ts",
  "src/lib/supabase.test.ts",
  "src/lib/startfout.tsx",
  "src/lib/fouten.ts",
  "src/lib/fouten.test.ts",
  "src/vite-env.d.ts",
  "src/routes/login.tsx",
  "src/routes/login-terug.ts",
  "src/routes/robots.ts",
  "src/routes/sitemap.ts",
  "e2e/stack-config.ts",
  "e2e/global-setup.ts",
  "tests/unit/installeerbaar.test.ts",
  "supabase/testrol.sql",
];

/** Alleen neerzetten als de app ze nog niet heeft. */
export const ALS_HET_ONTBREEKT = ["src/site.ts"];

/** Uit de gewone template, in deze template overbodig: de server maakt de pagina. */
export const WEG = ["index.html", "src/main.tsx"];

export const GITIGNORE = [
  ".react-router/",
  "worker-configuration.d.ts",
  ".wrangler/",
  ".dev.vars*",
];

const leesJson = (pad) => JSON.parse(readFileSync(pad, "utf8"));

function kopieer(van, naar) {
  mkdirSync(dirname(naar), { recursive: true });
  copyFileSync(van, naar);
}

function tussenMarkeringen(eigen, template, naam) {
  const begin = `<!-- ${naam}:begin -->`;
  const eind = `<!-- ${naam}:end -->`;
  const knip = (t) => {
    const a = t.indexOf(begin);
    const b = t.indexOf(eind);
    return a === -1 || b === -1 || b < a ? null : { a, b: b + eind.length };
  };
  const hier = knip(eigen);
  const daar = knip(template);
  if (!hier || !daar) return null;
  return eigen.slice(0, hier.a) + template.slice(daar.a, daar.b) + eigen.slice(hier.b);
}

/** package.json: de regels van de stap "Het skelet van het project". */
export function voegPackageSamen(eigen, template) {
  const uit = { ...eigen };
  uit.scripts = { ...(eigen.scripts ?? {}), ...(template.scripts ?? {}) };
  uit.devDependencies = { ...(eigen.devDependencies ?? {}), ...(template.devDependencies ?? {}) };
  const deps = { ...(eigen.dependencies ?? {}) };
  delete deps["react-router-dom"];
  for (const [naam, versie] of Object.entries(template.dependencies ?? {})) {
    if (!(naam in deps)) deps[naam] = versie;
    else if (["react-router", "@supabase/ssr", "isbot"].includes(naam)) deps[naam] = versie;
  }
  uit.dependencies = Object.fromEntries(
    Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)),
  );
  if (template.engines) uit.engines = template.engines;
  return uit;
}

/** De naam en het eigen domein uit een wrangler.jsonc, als tekst. */
export function eigenWrangler(tekst) {
  const zonderCommentaar = tekst
    .split("\n")
    .filter((r) => !/^\s*\/\//.test(r))
    .join("\n");
  const naam = /"name"\s*:\s*"([^"]+)"/.exec(zonderCommentaar)?.[1] ?? null;
  const routes = /"routes"\s*:\s*(\[[^\]]*\])/.exec(zonderCommentaar)?.[1] ?? null;
  return { naam, routes };
}

/** wrangler.jsonc van de template, met de naam en het domein van de app. */
export function nieuweWrangler(template, { naam, routes }) {
  let uit = template;
  if (naam) uit = uit.replace(/"name"\s*:\s*"[^"]*"/, `"name": "${naam}"`);
  uit = uit.replace(/,?\s*"routes"\s*:\s*\[[^\]]*\]/, "");
  if (routes) {
    uit = uit.replace(/"preview_urls"\s*:\s*true/, `"preview_urls": true,\n  "routes": ${routes}`);
  }
  return uit;
}

function alleBestanden(map) {
  if (!existsSync(map)) return [];
  return readdirSync(map).flatMap((naam) => {
    const pad = join(map, naam);
    return statSync(pad).isDirectory() ? alleBestanden(pad) : [pad];
  });
}

export function zetOm({ app = process.cwd(), template = TEMPLATE } = {}) {
  const rapport = { gedaan: [], weg: [], overschreven: [], metDeHand: [] };
  const appManifestPad = join(app, ".claude/stack-manifest.json");
  if (!existsSync(appManifestPad)) {
    throw new Error("Geen .claude/stack-manifest.json: dit is geen app van de Stage Two-stack.");
  }
  const oud = leesJson(appManifestPad);
  const nieuw = leesJson(join(template, ".claude/stack-manifest.json"));
  if (oud.template === nieuw.template) {
    throw new Error(`Deze app staat al op ${nieuw.template}.`);
  }
  if (oud.template && oud.template !== "app-template-tier2") {
    throw new Error(
      `Deze app komt uit ${oud.template}; omzetten kan alleen vanuit app-template-tier2.`,
    );
  }
  if (Number(oud.stackVersion) !== Number(nieuw.stackVersion)) {
    throw new Error(
      `De app staat op versie ${oud.stackVersion}, de template op ${nieuw.stackVersion}. Werk de app eerst bij (/stagetwo-tier2:updaten) of neem de template op dezelfde versie.`,
    );
  }

  // 1. De bestanden van de template.
  const van = nieuw.vanDeTemplate;
  for (const pad of van.vervangen) {
    if (!existsSync(join(template, pad))) continue;
    kopieer(join(template, pad), join(app, pad));
  }
  for (const pad of van.alsHetOntbreekt ?? []) {
    if (!existsSync(join(app, pad)) && existsSync(join(template, pad))) {
      kopieer(join(template, pad), join(app, pad));
    }
  }
  for (const pad of oud.vanDeTemplate?.vervangen ?? []) {
    if (!van.vervangen.includes(pad) && existsSync(join(app, pad))) {
      rmSync(join(app, pad));
      rapport.weg.push(pad);
    }
  }
  for (const [pad, naam] of Object.entries(van.tussenMarkeringen ?? {})) {
    if (!existsSync(join(app, pad))) continue;
    const samen = tussenMarkeringen(
      readFileSync(join(app, pad), "utf8"),
      readFileSync(join(template, pad), "utf8"),
      naam,
    );
    if (samen === null)
      rapport.metDeHand.push(
        `${pad}: de markeringen ${naam} ontbreken; zet het deel van de template er met de hand in.`,
      );
    else writeFileSync(join(app, pad), samen);
  }
  rapport.gedaan.push(`${van.vervangen.length} bestanden van de template neergezet`);

  // 2. Het skelet.
  for (const pad of SKELET) {
    if (!existsSync(join(template, pad))) continue;
    const bestond = existsSync(join(app, pad));
    if (
      bestond &&
      readFileSync(join(app, pad), "utf8") === readFileSync(join(template, pad), "utf8")
    )
      continue;
    kopieer(join(template, pad), join(app, pad));
    if (bestond) rapport.overschreven.push(pad);
  }
  for (const pad of ALS_HET_ONTBREEKT) {
    if (!existsSync(join(app, pad))) kopieer(join(template, pad), join(app, pad));
  }
  for (const pad of alleBestanden(join(template, "src/features/auth"))) {
    const rel = pad.slice(template.length + 1);
    const bestond = existsSync(join(app, rel));
    kopieer(pad, join(app, rel));
    if (bestond) rapport.overschreven.push(rel);
  }
  for (const pad of WEG) {
    if (existsSync(join(app, pad))) {
      rmSync(join(app, pad));
      rapport.weg.push(pad);
    }
  }
  rapport.gedaan.push("het skelet van het project overgenomen");

  // 3. package.json en react-router-dom.
  const pkgPad = join(app, "package.json");
  const pkg = voegPackageSamen(leesJson(pkgPad), leesJson(join(template, "package.json")));
  writeFileSync(pkgPad, `${JSON.stringify(pkg, null, 2)}\n`);
  let omgezet = 0;
  for (const map of ["src", "tests", "e2e"]) {
    for (const pad of alleBestanden(join(app, map))) {
      if (!/\.(ts|tsx|js|jsx|mjs)$/.test(pad)) continue;
      const tekst = readFileSync(pad, "utf8");
      const na = tekst.replace(/(["'])react-router-dom\1/g, "$1react-router$1");
      if (na !== tekst) {
        writeFileSync(pad, na);
        omgezet++;
      }
    }
  }
  rapport.gedaan.push(
    `package.json samengevoegd; react-router-dom in ${omgezet} bestand(en) omgezet`,
  );

  // 4. wrangler.jsonc.
  const wPad = join(app, "wrangler.jsonc");
  const eigen = existsSync(wPad)
    ? eigenWrangler(readFileSync(wPad, "utf8"))
    : { naam: null, routes: null };
  writeFileSync(
    wPad,
    nieuweWrangler(readFileSync(join(template, "wrangler.jsonc"), "utf8"), eigen),
  );
  rapport.gedaan.push(
    `wrangler.jsonc van de template, met naam ${eigen.naam ?? "(geen)"} en ${eigen.routes ? "het eigen domein" : "nog geen eigen domein"}`,
  );
  if (!eigen.routes)
    rapport.metDeHand.push(
      "wrangler.jsonc: nog geen eigen domein; de owner regelt er een (stap 0).",
    );

  // 5. .gitignore.
  const gPad = join(app, ".gitignore");
  const gi = existsSync(gPad) ? readFileSync(gPad, "utf8") : "";
  const regels = new Set(gi.split("\n").map((r) => r.trim()));
  const erbij = GITIGNORE.filter((r) => !regels.has(r));
  if (erbij.length > 0) {
    writeFileSync(
      gPad,
      `${gi.replace(/\n*$/, "\n")}\n# Gegenereerd door de server-variant\n${erbij.join("\n")}\n`,
    );
    rapport.gedaan.push(`.gitignore: ${erbij.join(", ")} erbij`);
  }

  rapport.metDeHand.push(
    "src/root.tsx: titel, theme-color, favicons en lettertypen uit de oude index.html en src/main.tsx terugzetten (zie git diff).",
    "src/site.ts: naam en omschrijving van de app.",
    "src/routes.ts en src/routes/browser-app.tsx: de oude schermen als browser-scherm (route, stap 4).",
    "src/onderdelen.ts: node scripts/lib/onderdelen.mjs, en elk pad in ONDERDELEN of GEEN_ONDERDEEL (stap 5).",
    "stack.config.json: klantportaal, browser en browsertest (stap 5, 6 en 8).",
    "supabase/migrations: de migratie van het klantportaal en de poorten (stap 8).",
    "pnpm install, daarna pnpm check.",
  );
  return rapport;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
    if (status.trim() !== "") {
      console.error("Er staan nog wijzigingen die niet gecommit zijn. Commit of bewaar ze eerst.");
      process.exit(1);
    }
    const r = zetOm();
    console.log("Gedaan:");
    for (const r1 of r.gedaan) console.log(`  - ${r1}`);
    if (r.weg.length) console.log(`Weggehaald:\n${r.weg.map((p) => `  - ${p}`).join("\n")}`);
    if (r.overschreven.length) {
      console.log(
        "Overschreven met de versie van de template (kijk met git diff wat de app zelf had):",
      );
      for (const p of r.overschreven) console.log(`  - ${p}`);
    }
    console.log("Met de hand (docs/routes/omzetten-naar-openbaar.md):");
    for (const p of r.metDeHand) console.log(`  - ${p}`);
  } catch (fout) {
    console.error(fout instanceof Error ? fout.message : String(fout));
    process.exit(1);
  }
}
