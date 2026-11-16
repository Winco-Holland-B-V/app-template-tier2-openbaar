import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Een update moet groen zijn in een app, niet alleen in de template. In uitgave 42
 * (tests/unit/template-afhankelijk.test.ts) en weer in 43 (tests/unit/rls-regels.test.ts las de
 * migraties van de app en verwachtte die van de template) was een test van de template groen in
 * de template en rood in elke app. Pas de generale repetitie op kopieën van echte apps zag het.
 *
 * Deze test bootst daarom een afgeleide app na, zoals /stagetwo-tier2:updaten hem achterlaat:
 * de boom van de vorige uitgave (git archive stack-vN), met daaroverheen ALLEEN de bestanden uit
 * .claude/stack-manifest.json van de huidige stand (vervangen: vervangen; alsHetOntbreekt: alleen
 * als het ontbreekt; package.json: de sleutels samengevoegd; AGENTS.md: tussen de markeringen).
 * Alles van het project blijft van de vorige uitgave: src/, supabase/, stack.config.json. De app
 * krijgt een eigen tabel, zodat "dit is niet de template" ook voor de migraties waar is. Daarin
 * draaien de typecontrole, de lint, de unittests en de guards die geen database nodig hebben.
 *
 * Alleen in de template zelf (herkend zoals guard-template dat doet). In een app slaat hij over:
 * daar is niets na te bootsen. Kan hij in de template niet draaien (geen git, geen
 * node_modules), dan is dat in CI rood, niet stil.
 *
 * Eén geval slaat hij wel over, ook in CI: er is nog geen vorige uitgave van déze template.
 * app-template-tier2-openbaar begint bij uitgave 43; tot de tag `stack-v43` er staat, bestaat
 * er geen app om na te bootsen. Een tag telt alleen als zijn manifest deze template noemt: een
 * tag uit de gewone tier 2-template (waar deze repo als kopie van begon) is geen vorige
 * uitgave van deze. Vanaf de eerste eigen tag draait de test vanzelf (`kiesVorigeTag`).
 *
 * Deze test is van de template en komt met elke versie mee.
 */
const WORTEL = resolve(__dirname, "../..");
const RUIME_BUFFER = 256 * 1024 * 1024;

type Manifest = {
  stackVersion: number;
  vanDeTemplate: {
    vervangen: string[];
    sleutelsSamenvoegen?: Record<string, string[]>;
    tussenMarkeringen?: Record<string, string>;
    alsHetOntbreekt?: string[];
  };
  nietMeenemen?: string[];
};

const DEZE_TEMPLATE = "app-template-tier2-openbaar";

function isDeTemplate(repo: string): boolean {
  return /\/(?:app-template-tier(?:1|2|2-openbaar)|stack-template(?:-cloudflare|-light)?)(?:\.git)?$/.test(
    repo,
  );
}

function git(args: string[], cwd = WORTEL): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: RUIME_BUFFER }).trim();
}

function probeer(args: string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

const repo = process.env.GITHUB_REPOSITORY ?? probeer(["remote", "get-url", "origin"]) ?? "";
const inDeTemplate = isDeTemplate(repo);

type Tag = {
  naam: string;
  /** De commit waar de tag naar wijst. */
  commit: string | null;
  /** Welke template het manifest in die tag noemt; null als het er geen noemt. */
  template: string | null;
};

/**
 * De vorige uitgave: de hoogste tag stack-vN van déze template, met N tot en met de huidige
 * versie, die niet deze commit zelf is. Vóór het ophogen van de versie is dat de tag van de
 * huidige versie, erna die van de vorige, en op de tag zelf ook de vorige.
 *
 *   { tag }             er is een vorige uitgave: bouw de app na
 *   { tag: null }       er is er nog geen (de eerste uitgave van deze template): overslaan
 */
function kiesVorigeTag(tags: Tag[], head: string, stackVersion: number): { tag: string | null } {
  const kandidaten = tags
    .map((tag) => ({ ...tag, n: Number(/^stack-v(\d+)$/.exec(tag.naam.trim())?.[1]) }))
    .filter((k) => Number.isInteger(k.n) && k.n <= stackVersion)
    .filter((k) => k.template === DEZE_TEMPLATE)
    .sort((a, b) => b.n - a.n);
  return { tag: kandidaten.find((k) => k.commit !== head)?.naam ?? null };
}

/** De tags van deze repo, met per tag welke template zijn manifest noemt. */
function leesTags(): { head: string; tags: Tag[] } | null {
  const head = probeer(["rev-parse", "HEAD"]);
  const lijst = probeer(["tag", "--list", "stack-v*"]);
  if (!head || lijst === null) return null;
  const tags = lijst
    .split("\n")
    .map((naam) => naam.trim())
    .filter(Boolean)
    .map((naam) => {
      let template: string | null = null;
      try {
        const manifest = JSON.parse(git(["show", `${naam}:.claude/stack-manifest.json`]));
        template = typeof manifest.template === "string" ? manifest.template : null;
      } catch {
        template = null;
      }
      return { naam, commit: probeer(["rev-parse", `${naam}^{commit}`]), template };
    });
  return { head, tags };
}

/** Een eenvoudige glob uit het manifest (`**`, `*`) als reguliere expressie. */
function globNaarRegex(glob: string): RegExp {
  const bron = glob
    .split("**")
    .map((deel) => deel.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join(".*");
  return new RegExp(`^${bron}$`);
}

function alleBestanden(map: string, onder = ""): string[] {
  const uit: string[] = [];
  for (const naam of readdirSync(join(map, onder))) {
    const pad = onder ? `${onder}/${naam}` : naam;
    if (pad === ".git" || pad === "node_modules") continue;
    if (statSync(join(map, pad)).isDirectory()) uit.push(...alleBestanden(map, pad));
    else uit.push(pad);
  }
  return uit;
}

function kopieer(pad: string, naar: string) {
  mkdirSync(dirname(join(naar, pad)), { recursive: true });
  copyFileSync(join(WORTEL, pad), join(naar, pad));
}

/** Zoals voegSleutelsSamen in de plugin: eigen extra's blijven, de template wint per naam. */
function voegSleutelsSamen(eigen: string, template: string, welke: string[]): string {
  const uit = JSON.parse(eigen);
  const van = JSON.parse(template);
  for (const sleutel of welke) {
    if (!van[sleutel]) continue;
    const samen = { ...(uit[sleutel] ?? {}), ...van[sleutel] };
    uit[sleutel] = Object.fromEntries(
      Object.keys(samen)
        .sort()
        .map((k) => [k, samen[k]]),
    );
  }
  return `${JSON.stringify(uit, null, 2)}\n`;
}

function tussenMarkeringen(eigen: string, template: string, naam: string): string | null {
  const begin = `<!-- ${naam}:begin -->`;
  const eind = `<!-- ${naam}:end -->`;
  const knip = (t: string) => {
    const a = t.indexOf(begin);
    const b = t.indexOf(eind);
    return a === -1 || b === -1 || b < a ? null : { a, b: b + eind.length };
  };
  const hier = knip(eigen);
  const daar = knip(template);
  if (!hier || !daar) return null;
  return eigen.slice(0, hier.a) + template.slice(daar.a, daar.b) + eigen.slice(hier.b);
}

/**
 * Een eigen tabel van de app, met row level security en een policy op de eigenaar. De app is
 * een klantportaal (stack.config.json van de template), dus de policy heeft de poort.
 */
const EIGEN_MIGRATIE = `-- Een eigen tabel van deze app: niet het voorbeeld van de template.
create table public.notities (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  omschrijving text not null
);

alter table public.notities enable row level security;

create policy "notities_eigen" on public.notities
  for all to authenticated
  using (public.is_goedgekeurde_klant() and owner_id = auth.uid())
  with check (public.is_goedgekeurde_klant() and owner_id = auth.uid());
`;

/** Bouwt de nagebootste app en geeft de map terug. */
function bouwAfgeleideApp(tag: string, manifest: Manifest): string {
  const map = mkdtempSync(join(tmpdir(), "afgeleide-app-"));
  const tar = join(map, "..", `${map.split("/").at(-1)}.tar`);
  try {
    git(["archive", "--format=tar", "-o", tar, tag]);
    execFileSync("tar", ["-xf", tar, "-C", map]);
  } finally {
    rmSync(tar, { force: true });
  }

  // Wat nooit naar een app gaat. De migraties (het klantportaal en de voorbeeldshop) zijn van
  // het project en blijven zoals ze in de vorige uitgave waren; de app krijgt er een eigen
  // tabel bij.
  const weg = (manifest.nietMeenemen ?? []).map(globNaarRegex);
  for (const pad of alleBestanden(map)) {
    if (weg.some((re) => re.test(pad))) rmSync(join(map, pad));
  }
  writeFileSync(join(map, "supabase/migrations/20990101000000_notities.sql"), EIGEN_MIGRATIE);

  const inApp = (...args: string[]) => git(args, map);
  inApp("init", "-q", "-b", "main");
  inApp("config", "user.email", "test@example.invalid");
  inApp("config", "user.name", "Nagebootste app");
  inApp("config", "commit.gpgsign", "false");
  inApp("remote", "add", "origin", "https://github.com/Klant/eigen-app.git");
  inApp("add", "-A");
  inApp("commit", "-q", "-m", `app op ${tag}`);
  inApp("checkout", "-q", "-b", "stagetwo/update");

  // Zoals /stagetwo-tier2:updaten (lib/toepassen.mjs in de plugin).
  const van = manifest.vanDeTemplate;
  for (const pad of van.vervangen) {
    if (existsSync(join(WORTEL, pad))) kopieer(pad, map);
  }
  for (const pad of van.alsHetOntbreekt ?? []) {
    if (!existsSync(join(map, pad)) && existsSync(join(WORTEL, pad))) kopieer(pad, map);
  }
  for (const [pad, welke] of Object.entries(van.sleutelsSamenvoegen ?? {})) {
    if (!existsSync(join(map, pad))) continue;
    const samen = voegSleutelsSamen(
      readFileSync(join(map, pad), "utf8"),
      readFileSync(join(WORTEL, pad), "utf8"),
      welke,
    );
    writeFileSync(join(map, pad), samen);
  }
  for (const [pad, naam] of Object.entries(van.tussenMarkeringen ?? {})) {
    if (!existsSync(join(map, pad))) continue;
    const nieuw = tussenMarkeringen(
      readFileSync(join(map, pad), "utf8"),
      readFileSync(join(WORTEL, pad), "utf8"),
      naam,
    );
    if (nieuw !== null) writeFileSync(join(map, pad), nieuw);
  }
  inApp("add", "-A");
  inApp("commit", "-q", "--allow-empty", "-m", "update naar de huidige stand");

  symlinkSync(join(WORTEL, "node_modules"), join(map, "node_modules"), "dir");
  return map;
}

/** De omgeving van een app op een update-PR: niets van deze testrun of van de template-CI. */
function omgevingVanDeApp(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [sleutel, waarde] of Object.entries(process.env)) {
    if (/^(?:GITHUB_|VITEST|VITE_|TEST$|NODE_ENV$|PR_BODY$)/.test(sleutel)) continue;
    env[sleutel] = waarde;
  }
  // De updater zet deze regel zelf in de PR-tekst.
  env.PR_BODY = "Bevestigd: templatebestanden gewijzigd";
  return env;
}

const STAPPEN: Array<[string, string, string[]]> = [
  // Zoals `pnpm typecheck`: eerst de types van de Worker en van de routes, dan de controle.
  ["types van de Worker", "node_modules/.bin/wrangler", ["types"]],
  ["types van de routes", "node_modules/.bin/react-router", ["typegen"]],
  ["typecontrole", "node_modules/.bin/tsc", ["--noEmit"]],
  ["lint", "node_modules/.bin/biome", ["check", "."]],
  ["unittests", "node_modules/.bin/vitest", ["run", "--config", "vitest.config.ts"]],
  ["guard:tests", "node", ["scripts/guard-tests.mjs"]],
  ["guard:migrations", "node", ["scripts/guard-migrations.mjs"]],
  ["guard:rls", "node", ["scripts/guard-rls.mjs"]],
  ["guard:rls-tests", "node", ["scripts/guard-rls-tests.mjs"]],
  ["guard:secrets", "node", ["scripts/guard-secrets.mjs"]],
  ["guard:escapes", "node", ["scripts/guard-escape-hatches.mjs"]],
  ["guard:template", "node", ["scripts/guard-template.mjs"]],
  ["guard:cloudflare", "node", ["scripts/guard-cloudflare.mjs"]],
  ["guard:server", "node", ["scripts/guard-server.mjs"]],
];

describe("een afgeleide app na de update (alleen in de template zelf)", () => {
  it("herkent de template zoals guard-template dat doet", () => {
    expect(isDeTemplate("https://github.com/Stage-Two-AI/app-template-tier2.git")).toBe(true);
    expect(isDeTemplate("Stage-Two-AI/app-template-tier2-openbaar")).toBe(true);
    expect(isDeTemplate("https://github.com/Klant/eigen-app.git")).toBe(false);
    expect(globNaarRegex("beheer/**").test("beheer/lib/x.mjs")).toBe(true);
    expect(globNaarRegex(".github/workflows/proef-*.yml").test(".github/workflows/ci.yml")).toBe(
      false,
    );
  });

  describe("welke tag de vorige uitgave is", () => {
    const deze = (naam: string, commit: string): Tag => ({ naam, commit, template: DEZE_TEMPLATE });
    const andere = (naam: string, commit: string): Tag => ({ naam, commit, template: null });

    it("zonder eigen tag is er niets na te bootsen: de eerste uitgave slaat over", () => {
      expect(kiesVorigeTag([], "h", 43)).toEqual({ tag: null });
      // Tags uit de gewone tier 2-template (de kopie waar deze repo mee begon) tellen niet,
      // ook niet als hun manifest een andere template noemt.
      const geerfd = [andere("stack-v41", "a"), andere("stack-v42", "b")];
      expect(kiesVorigeTag(geerfd, "h", 43)).toEqual({ tag: null });
      expect(
        kiesVorigeTag(
          [{ naam: "stack-v42", commit: "b", template: "app-template-tier2" }],
          "h",
          43,
        ),
      ).toEqual({ tag: null });
    });

    it("op de commit van de eerste eigen tag zelf is er ook nog geen vorige", () => {
      expect(kiesVorigeTag([andere("stack-v42", "b"), deze("stack-v43", "h")], "h", 43)).toEqual({
        tag: null,
      });
    });

    it("vanaf de eerste eigen tag werkt het vanzelf: vóór en na het ophogen van de versie", () => {
      const tags = [andere("stack-v42", "b"), deze("stack-v43", "c")];
      // Na de tag van 43, nog op versie 43: de app van 43 krijgt de nieuwe stand.
      expect(kiesVorigeTag(tags, "h", 43)).toEqual({ tag: "stack-v43" });
      // Na het ophogen naar 44: nog steeds 43.
      expect(kiesVorigeTag(tags, "h", 44)).toEqual({ tag: "stack-v43" });
      // Op de tag van 44 zelf: de vorige is 43, niet 44.
      const met44 = [...tags, deze("stack-v44", "h")];
      expect(kiesVorigeTag(met44, "h", 44)).toEqual({ tag: "stack-v43" });
      expect(kiesVorigeTag(met44, "later", 44)).toEqual({ tag: "stack-v44" });
    });

    it("een tag van een latere versie, een andere naam of zonder commit telt niet", () => {
      const tags = [
        deze("stack-v45", "x"),
        deze("stack-v43-proef", "y"),
        deze("v43", "z"),
        deze("stack-v43", "c"),
      ];
      expect(kiesVorigeTag(tags, "h", 44)).toEqual({ tag: "stack-v43" });
    });
  });

  it.runIf(inDeTemplate)(
    "typecontrole, lint, unittests en guards zijn groen in een app van de vorige uitgave",
    () => {
      const manifest: Manifest = JSON.parse(
        readFileSync(join(WORTEL, ".claude/stack-manifest.json"), "utf8"),
      );
      const gelezen = leesTags();
      if (gelezen === null || !existsSync(join(WORTEL, "node_modules"))) {
        const reden = "geen git of geen node_modules";
        // In CI is dit een fout: dan zou deze test ongemerkt niets meer bewijzen.
        if (process.env.CI)
          throw new Error(`De nagebootste app kan niet gebouwd worden: ${reden}.`);
        console.warn(`afgeleide app overgeslagen: ${reden}`);
        return;
      }
      const { tag } = kiesVorigeTag(gelezen.tags, gelezen.head, manifest.stackVersion);
      if (tag === null) {
        // De eerste uitgave van deze template: er bestaat nog geen app om na te bootsen.
        console.warn(
          `afgeleide app overgeslagen: er is nog geen tag stack-vN van ${DEZE_TEMPLATE} vóór deze commit (de eerste uitgave).`,
        );
        return;
      }

      const map = bouwAfgeleideApp(tag, manifest);
      try {
        const env = omgevingVanDeApp();
        const fouten: string[] = [];
        for (const [naam, opdracht, args] of STAPPEN) {
          const uit = spawnSync(opdracht, args, {
            cwd: map,
            env,
            encoding: "utf8",
            maxBuffer: RUIME_BUFFER,
          });
          if (uit.status !== 0) {
            const tekst = `${uit.stdout ?? ""}\n${uit.stderr ?? ""}${uit.error ? `\n${uit.error}` : ""}`;
            fouten.push(`${naam} (op ${tag}):\n${tekst.trim().split("\n").slice(-40).join("\n")}`);
          }
        }
        expect(fouten, "rood in een app na de update").toEqual([]);
      } finally {
        if (!process.env.AFGELEIDE_APP_BEWAREN) rmSync(map, { recursive: true, force: true });
        else console.log(`afgeleide app bewaard in ${map}`);
      }
    },
    300_000,
  );
});
