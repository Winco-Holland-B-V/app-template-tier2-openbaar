import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * guard:secrets draait op alles wat in git staat. Deze test zet een los git-repo neer
 * met één bestand en draait de guard daarin, zoals CI dat doet.
 */
const WORTEL = resolve(__dirname, "../..");
const GUARD = resolve(WORTEL, "scripts/guard-secrets.mjs");

let map: string;

beforeEach(() => {
  map = mkdtempSync(join(tmpdir(), "guard-secrets-"));
  execFileSync("git", ["init", "-q"], { cwd: map });
});

afterEach(() => {
  rmSync(map, { recursive: true, force: true });
});

function metBestand(naam: string, inhoud: string): { code: number | null; uitvoer: string } {
  writeFileSync(join(map, naam), inhoud);
  execFileSync("git", ["add", naam], { cwd: map });
  const r = spawnSync("node", [GUARD], { cwd: map, encoding: "utf8" });
  return { code: r.status, uitvoer: `${r.stdout}${r.stderr}` };
}

describe("guard:secrets en Cloudflare-sleutels", () => {
  it("vindt een Cloudflare-API-sleutel met waarde", () => {
    const r = metBestand("uitrol.sh", `CLOUDFLARE_API_TOKEN=${"a1B2c3D4e5".repeat(4)}\n`);
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("Cloudflare-API-sleutel");
  });

  it("laat een verwijzing naar een secret staan", () => {
    const r = metBestand(
      "uitrollen.yml",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub-expressie, geen JS-template
      "env:\n  CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n",
    );
    expect(r.code).toBe(0);
  });
});

/**
 * Wat een aanvaller in de zustertemplate (uitgave 43) langs de guard kreeg: een databaseadres
 * met wachtwoord, een sleutel van Resend, tekst in UTF-16, en een sleutel in een bestand dat
 * geen tekst is (public/brochure.pdf gaat na de build naar dist/ en naar elke bezoeker). De
 * sleutels zijn nep en worden pas bij het draaien samengesteld.
 */
const b64 = (tekst: string) => Buffer.from(tekst).toString("base64url");
const jwt = (rol: string) =>
  [
    b64('{"alg":"HS256","typ":"JWT"}'),
    b64(JSON.stringify({ iss: "supabase", role: rol })),
    b64("nep-handtekening-voor-de-test"),
  ].join(".");
const GEHEIM = ["sb", "secret", "nepwaardealleenvoordetest"].join("_");
const RESEND = ["re", "Ab12Cd34", "EfGh56IjKl78MnOp90QrSt12"].join("_");
const POSTGRES = [
  "postgresql://postgres.abcdefghijklmnopqrst",
  "Nep-Wachtwoord-123@aws-0-eu.pooler.supabase.com:5432/postgres",
].join(":");

function schrijf(pad: string, inhoud: string | Buffer) {
  mkdirSync(dirname(join(map, pad)), { recursive: true });
  writeFileSync(join(map, pad), inhoud);
}

function guard(): { code: number | null; uitvoer: string } {
  // Zoals in een app: de gebouwde bestanden staan niet in git.
  writeFileSync(join(map, ".gitignore"), "dist/\n");
  execFileSync("git", ["add", "-A"], { cwd: map });
  const r = spawnSync("node", [GUARD], { cwd: map, encoding: "utf8" });
  return { code: r.status, uitvoer: `${r.stdout}${r.stderr}` };
}

/** Wat een echt binair bestand rond de sleutel heeft: willekeurige bytes. */
function binairMet(tekst: string | Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x13, 0x88]),
    typeof tekst === "string" ? Buffer.from(` ${tekst} `, "latin1") : tekst,
    Buffer.from([0x00, 0xfe, 0x01, 0x7f]),
  ]);
}

describe("guard:secrets: databaseadressen en Resend", () => {
  it("vindt een Postgres-adres met wachtwoord, ook als postgres://", () => {
    for (const adres of [POSTGRES, POSTGRES.replace("postgresql://", "postgres://")]) {
      const r = metBestand("migreren.sh", `psql "${adres}" -f dump.sql\n`);
      expect(r.code, adres).not.toBe(0);
      expect(r.uitvoer).toContain("Postgres-adres met wachtwoord");
    }
  });

  it("laat een open plek en de lokale database staan", () => {
    const r = metBestand(
      "uitleg.md",
      [
        "postgresql://postgres.<ref>:<ww>@<pooler>:5432/postgres",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: zo staat het in een script
        "postgresql://postgres:${ww}@db.${ref}.supabase.co:5432/postgres",
        "postgresql://postgres:$WACHTWOORD@db.abcd.supabase.co:5432/postgres",
        "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        "postgres://postgres:postgres@localhost:5432/postgres",
        "postgresql://postgres@db.abcd.supabase.co:5432/postgres",
      ].join("\n"),
    );
    expect(r.code, r.uitvoer).toBe(0);
  });

  it("vindt een sleutel van Resend, en niet een naam die met re_ begint", () => {
    const r = metBestand("mail.ts", `const sleutel = "${RESEND}";\n`);
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("Resend-sleutel");
    const goed = metBestand("mail.ts", "re_render(); const re_GeheimeSleutelVanResend123 = 1;\n");
    expect(goed.code, goed.uitvoer).toBe(0);
  });
});

describe("guard:secrets: tekst in UTF-16", () => {
  const varianten: Array<[string, Buffer]> = [
    [
      "UTF-16LE met BOM",
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`SLEUTEL=${GEHEIM}\r\n`, "utf16le")]),
    ],
    ["UTF-16LE zonder BOM", Buffer.from(`SLEUTEL=${GEHEIM}\r\n`, "utf16le")],
    [
      "UTF-16BE met BOM",
      Buffer.concat([
        Buffer.from([0xfe, 0xff]),
        Buffer.from(`SLEUTEL=${GEHEIM}\r\n`, "utf16le").swap16(),
      ]),
    ],
    ["UTF-16BE zonder BOM", Buffer.from(`SLEUTEL=${GEHEIM}\r\n`, "utf16le").swap16()],
  ];
  for (const [naam, inhoud] of varianten) {
    it(`${naam}: rood`, () => {
      schrijf("export.csv", inhoud);
      const r = guard();
      expect(r.code, r.uitvoer).not.toBe(0);
      expect(r.uitvoer).toContain("[git] export.csv:1: Supabase secret key");
    });
  }

  it("UTF-16 zonder sleutel: groen", () => {
    schrijf("export.csv", Buffer.from("naam;adres\r\nPiet;Dorpsstraat 1\r\n", "utf16le"));
    const r = guard();
    expect(r.code, r.uitvoer).toBe(0);
  });
});

describe("guard:secrets kijkt ook in bestanden die geen tekst zijn, in public/ en dist/", () => {
  for (const ext of ["pdf", "zip", "woff2", "png", "mp4", "wasm"]) {
    it(`een service role-sleutel in public/bestand.${ext} en dist/bestand.${ext}: rood`, () => {
      schrijf(`public/bestand.${ext}`, binairMet(jwt("service_role")));
      schrijf(`dist/bestand.${ext}`, binairMet(jwt("service_role")));
      const r = guard();
      expect(r.code, r.uitvoer).not.toBe(0);
      expect(r.uitvoer).toContain(`[git] public/bestand.${ext}`);
      expect(r.uitvoer).toContain(`[bundel] dist/bestand.${ext}`);
      expect(r.uitvoer).toContain('rol "service_role"');
    });
  }

  it("elk patroon, ook alleen in dist/ en ook als UTF-16 in een pdf", () => {
    schrijf("dist/assets/lettertype.woff2", binairMet(GEHEIM));
    schrijf("dist/folder.pdf", binairMet(Buffer.from(RESEND, "utf16le")));
    schrijf("dist/data.zip", binairMet(POSTGRES));
    schrijf("dist/anon.png", binairMet(jwt("anon")));
    const r = guard();
    expect(r.code, r.uitvoer).not.toBe(0);
    expect(r.uitvoer).toContain("dist/assets/lettertype.woff2: Supabase secret key");
    expect(r.uitvoer).toContain("dist/folder.pdf: Resend-sleutel");
    expect(r.uitvoer).toContain("dist/data.zip: Postgres-adres met wachtwoord");
    // In een afbeelding hoort zelfs de anon key niet.
    expect(r.uitvoer).toContain('dist/anon.png: JSON Web Token met rol "anon"');
  });

  it("in de bundel telt elk token op een regel, en de markering geldt daar niet", () => {
    schrijf("dist/assets/index.js", `const a="${jwt("anon")}",b="${jwt("service_role")}";\n`);
    schrijf("dist/assets/ander.js", `const s="${GEHEIM}"; // guard-secrets:allow\n`);
    const r = guard();
    expect(r.code, r.uitvoer).not.toBe(0);
    expect(r.uitvoer).toContain('dist/assets/index.js:1: JSON Web Token met rol "service_role"');
    expect(r.uitvoer).toContain("dist/assets/ander.js:1: Supabase secret key");
  });

  it("de afbeeldingen van de template, in public/ en dist/, en de anon key in de bundel: groen", () => {
    const beelden = readdirSync(join(WORTEL, "public")).map((naam) => `public/${naam}`);
    expect(beelden.length).toBeGreaterThan(0);
    for (const pad of beelden) {
      cpSync(join(WORTEL, pad), join(map, pad), { recursive: true });
      cpSync(join(WORTEL, pad), join(map, pad.replace(/^public/, "dist")), { recursive: true });
    }
    schrijf("dist/assets/index.js", `const anon="${jwt("anon")}";\n`);
    const r = guard();
    expect(r.code, r.uitvoer).toBe(0);
  });

  it("willekeurige bytes (een megabyte) geven geen vals alarm en zijn snel gelezen", () => {
    const ruis = Buffer.alloc(1024 * 1024);
    let x = 12345;
    for (let i = 0; i < ruis.length; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      ruis[i] = x >> 16;
    }
    schrijf("public/video.mp4", ruis);
    schrijf("dist/video.mp4", ruis);
    const begin = Date.now();
    const r = guard();
    expect(r.code, r.uitvoer).toBe(0);
    expect(Date.now() - begin).toBeLessThan(5000);
  });
});

/**
 * Aanval: een service role-sleutel in de servercode, de gebouwde Worker of de config die
 * naar Cloudflare gaat krijgen zonder dat de guard rood wordt.
 *
 * De sleutels hieronder zijn nep en worden pas bij het draaien samengesteld, zodat er in git
 * geen tekst staat die op een sleutel lijkt. De guard herkent ze wel: hij kijkt naar de vorm
 * (`sb_secret_...`) en naar de rol in het token (alles behalve `anon`).
 */
const SERVICE_JWT = jwt("service_role");
const ANON_JWT = jwt("anon");
const GEHEIM_NIEUW = GEHEIM;

/** Zet bestanden neer (met `git` = ook in git) en draait de guard. */
function draai(bestanden: Record<string, string>, inGit: string[] = []) {
  for (const [naam, inhoud] of Object.entries(bestanden)) {
    mkdirSync(dirname(join(map, naam)), { recursive: true });
    writeFileSync(join(map, naam), inhoud);
  }
  if (inGit.length) execFileSync("git", ["add", "-f", ...inGit], { cwd: map });
  const r = spawnSync("node", [GUARD], { cwd: map, encoding: "utf8" });
  return { code: r.status, uitvoer: `${r.stdout}${r.stderr}` };
}

describe("aanval: een service role-sleutel in de servercode", () => {
  for (const [vorm, sleutel] of [
    ["JWT-vorm", SERVICE_JWT],
    ["de nieuwe vorm (sb_secret_)", GEHEIM_NIEUW],
  ] as const) {
    for (const pad of [
      "workers/app.ts",
      "src/routes/bestellen.tsx",
      "src/lib/server/eigen.server.ts",
      "src/lib/admin.server.ts",
      "src/entry.server.tsx",
      "react-router.config.ts",
      "vite.config.ts",
      "wrangler.jsonc",
    ]) {
      it(`${vorm} in ${pad} (in git): rood`, () => {
        const r = draai({ [pad]: `export const sleutel = "${sleutel}";\n` }, [pad]);
        expect(r.code, r.uitvoer).not.toBe(0);
        expect(r.uitvoer).toContain(pad);
      });
    }

    for (const pad of [
      "dist/server/index.js",
      "dist/server/assets/server-build-AbC123.js",
      "dist/server/index.js.map",
      "dist/server/assets/server-build-AbC123.js.map",
      "dist/server/wrangler.json",
      "dist/server/.vite/manifest.json",
      "dist/client/assets/entry.client-AbC123.js",
    ]) {
      it(`${vorm} in de gebouwde app (${pad}): rood`, () => {
        const inhoud = pad.endsWith(".map")
          ? JSON.stringify({
              version: 3,
              sources: ["x.ts"],
              sourcesContent: [`const k = "${sleutel}";`],
              mappings: "",
            })
          : pad.endsWith("wrangler.json")
            ? JSON.stringify({ name: "app", vars: { VITE_SUPABASE_ANON_KEY: sleutel } })
            : `const a=1;const k="${sleutel}";export{k};`;
        const r = draai({ [pad]: inhoud });
        expect(r.code, r.uitvoer).not.toBe(0);
        expect(r.uitvoer).toContain("[bundel]");
        expect(r.uitvoer).toContain(pad);
      });
    }
  }

  it("de anon key vóór een service role-sleutel op dezelfde lange regel verbergt hem niet", () => {
    const regel = `const anon="${ANON_JWT}";const s=createClient(u,"${SERVICE_JWT}");`;
    for (const pad of ["dist/server/index.js", "dist/client/assets/app.js"]) {
      const r = draai({ [pad]: regel });
      expect(r.code, pad).not.toBe(0);
      expect(r.uitvoer).toContain('rol "service_role"');
      rmSync(join(map, "dist"), { recursive: true, force: true });
    }
  });

  it("de markering guard-secrets:allow werkt niet in een gebouwd bestand", () => {
    const r = draai({
      "dist/server/index.js": `/* guard-secrets:allow */const k="${SERVICE_JWT}";`,
    });
    expect(r.code).not.toBe(0);
  });

  it("een token met een andere rol dan anon is ook rood (authenticated, supabase_admin, geen rol)", () => {
    for (const token of [
      jwt("authenticated"),
      jwt("supabase_admin"),
      [b64('{"alg":"HS256"}'), b64('{"iss":"supabase"}'), b64("nep-handtekening")].join("."),
    ]) {
      const r = draai({ "dist/server/index.js": `const k="${token}";` });
      expect(r.code).not.toBe(0);
    }
  });

  it("geen vals alarm: de anon key en de woorden service en service_role in de gebouwde Worker", () => {
    const r = draai({
      // De Supabase-bibliotheek noemt service_role in haar toelichting; de servercode is niet verkleind.
      "dist/server/assets/server-build-AbC123.js": `// Requires the \`service_role\` key.\nimport{serviceHulp}from"service-pakket";const anon="${ANON_JWT}";const sleutel="sb_publishable_abcdefghijkl";`,
      "dist/server/assets/server-build-AbC123.js.map": JSON.stringify({
        sourcesContent: ["// service_role en serviceRoleClient als naam"],
      }),
      "dist/client/assets/app.js": `const anon="${ANON_JWT}";const serviceDesk="hulp";`,
    });
    expect(r.code, r.uitvoer).toBe(0);
  });

  it("het woord service_role in wat de bezoeker downloadt blijft rood", () => {
    const r = draai({ "dist/client/assets/app.js": 'const rol="service_role";' });
    expect(r.code).not.toBe(0);
    // Een map die toevallig server heet binnen de bestanden van de browser telt als browser.
    rmSync(join(map, "dist"), { recursive: true, force: true });
    expect(draai({ "dist/client/server/app.js": 'const rol="service_role";' }).code).not.toBe(0);
  });

  it("een import van iets met service in de naam, in git, is geen alarm", () => {
    const r = draai(
      {
        "src/routes/klantenservice.tsx":
          'import { serviceRoleUitleg } from "service-pakket";\nexport const tekst = serviceRoleUitleg;\n',
      },
      ["src/routes/klantenservice.tsx"],
    );
    expect(r.code, r.uitvoer).toBe(0);
  });

  it("geheimen voor de Worker (.dev.vars) zijn overal rood: in git, in de map en in de gebouwde app", () => {
    const inGit = draai({ ".dev.vars": "IETS=waarde\n" }, [".dev.vars"]);
    expect(inGit.code).not.toBe(0);
    expect(inGit.uitvoer).toContain(".dev.vars");
    rmSync(join(map, ".dev.vars"));
    execFileSync("git", ["rm", "-q", "--cached", ".dev.vars"], { cwd: map });

    const los = draai({ ".dev.vars.production": "IETS=waarde\n" });
    expect(los.code).not.toBe(0);
    expect(los.uitvoer).toContain("de servercode krijgt geen geheimen");
    rmSync(join(map, ".dev.vars.production"));

    for (const pad of [
      "dist/server/.dev.vars",
      "dist/server/.env",
      "dist/client/.env.production",
    ]) {
      const r = draai({ [pad]: "ONSCHULDIGE_NAAM=waarde-zonder-herkenbare-vorm\n" });
      expect(r.code, pad).not.toBe(0);
      rmSync(join(map, "dist"), { recursive: true, force: true });
    }
  });

  it("een service role-sleutel onder de naam SUPABASE_SERVICE_ROLE_KEY, zonder herkenbare vorm", () => {
    const naam = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
    const r = draai({
      "dist/server/index.js": `const env={${naam}:"een-waarde-zonder-vaste-vorm-1234"};`,
    });
    expect(r.code).not.toBe(0);
  });
});

/**
 * Dezelfde drie sleutels in de vormen die alleen de openbare variant kent: dist/client en een
 * map public/ met submappen, en meer voorbeelden van een adres dat geen geheim is.
 */
describe("guard:secrets: Resend, Postgres en UTF-16 (openbare variant)", () => {
  const WACHTWOORD = ["sUper", "Z3cret", "wachtwoord"].join("");
  const POOLER = "aws-0-eu-central-1.pooler.supabase.com";

  function metBytes(pad: string, inhoud: Buffer): { code: number | null; uitvoer: string } {
    mkdirSync(dirname(join(map, pad)), { recursive: true });
    writeFileSync(join(map, pad), inhoud);
    execFileSync("git", ["add", "-A"], { cwd: map });
    const r = spawnSync("node", [GUARD], { cwd: map, encoding: "utf8" });
    return { code: r.status, uitvoer: `${r.stdout}${r.stderr}` };
  }

  it("vindt een Resend-sleutel", () => {
    const r = metBestand("mail.ts", `export const KEY = "${RESEND}";\n`);
    expect(r.code).not.toBe(0);
    expect(r.uitvoer).toContain("Resend-sleutel");
  });

  it("vindt een Postgres-adres met wachtwoord, ook als postgres:// en in een .env.example", () => {
    for (const [naam, regel] of [
      [
        "db.ts",
        `const DB = "postgresql://postgres.abcdefghijklmnop:${WACHTWOORD}@${POOLER}:6543/postgres";`,
      ],
      [
        "notitie.md",
        `postgres://gebruiker:${WACHTWOORD}@db.abcdefghijklmnop.supabase.co:5432/postgres`,
      ],
    ] as const) {
      const r = metBestand(naam, `${regel}\n`);
      expect(r.code, naam).not.toBe(0);
      expect(r.uitvoer).toContain("Postgres-adres met wachtwoord");
    }
  });

  it("vindt een service role-sleutel en een Resend-sleutel in UTF-16, in git en in de bundel", () => {
    const tekst = `sleutel=${jwt("service_role")}\nmail=${RESEND}\n`;
    for (const codering of ["utf16le", "utf16be"] as const) {
      const bytes =
        codering === "utf16le"
          ? Buffer.from(tekst, "utf16le")
          : Buffer.from(tekst, "utf16le").swap16();
      const r = metBytes(`public/geheim-${codering}.txt`, bytes);
      expect(r.code, codering).not.toBe(0);
      expect(r.uitvoer).toContain('rol "service_role"');
      expect(r.uitvoer).toContain("Resend-sleutel");
    }
  });

  it("vindt een sleutel in UTF-16 in de gebouwde bundel (dist/client), ook in een afbeelding", () => {
    const bytes = Buffer.from(`sleutel=${jwt("service_role")}`, "utf16le");
    mkdirSync(join(map, "dist/client"), { recursive: true });
    writeFileSync(join(map, "dist/client/geheim.txt"), bytes);
    writeFileSync(join(map, "dist/client/plaatje.png"), bytes);
    const r = spawnSync("node", [GUARD], { cwd: map, encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("dist/client/geheim.txt");
    expect(`${r.stdout}${r.stderr}`).toContain("dist/client/plaatje.png");
  });

  it("geen vals alarm: een gewone naam met re_, een voorbeeldadres, een verwijzing en de lokale database", () => {
    const r = metBestand(
      "voorbeeld.ts",
      [
        "const re_render_pagina_opnieuw_als_het_moet = 1;",
        'const LOKAAL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";',
        'const ANDER = "postgresql://iemand:geheim2@localhost:5432/db";',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: een verwijzing, geen JS-template
        'const UIT_ENV = "postgresql://postgres.${REF}:${WACHTWOORD}@pooler.supabase.com:5432/postgres";',
        'const UITLEG = "postgresql://postgres:[YOUR-PASSWORD]@db.abcd.supabase.co:5432/postgres";',
        'const MET_HAAKJES = "postgresql://postgres:<wachtwoord>@db.abcd.supabase.co:5432/postgres";',
        "",
      ].join("\n"),
    );
    expect(r.code, r.uitvoer).toBe(0);
  });

  it("een gewoon UTF-16-bestand zonder sleutel blijft groen", () => {
    const r = metBytes("public/leesmij.txt", Buffer.from("Welkom bij de winkel.\n", "utf16le"));
    expect(r.code, r.uitvoer).toBe(0);
  });
});
