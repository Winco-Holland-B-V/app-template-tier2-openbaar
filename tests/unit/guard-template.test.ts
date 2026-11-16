import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * guard:template slaat de controle over in de templates zelf: daar is een wijziging
 * aan templatebestanden juist de bedoeling. De Cloudflare-variant is ook een template.
 * In een afgeleide app loopt de controle gewoon door.
 */
const GUARD = resolve(__dirname, "../../scripts/guard-template.mjs");

function draai(repository: string): string {
  const uitkomst = spawnSync("node", [GUARD], {
    cwd: resolve(__dirname, "../.."),
    encoding: "utf8",
    env: { ...process.env, GITHUB_REPOSITORY: repository, PR_BODY: "" },
  });
  return `${uitkomst.stdout}${uitkomst.stderr}`;
}

describe("guard:template herkent de templates", () => {
  it("slaat over in stack-template", () => {
    expect(draai("Stage-Two-AI/stack-template")).toContain("dit is de template zelf");
  });

  it("slaat over in app-template-tier2 en app-template-tier1", () => {
    expect(draai("Stage-Two-AI/app-template-tier2")).toContain("dit is de template zelf");
    expect(draai("Stage-Two-AI/app-template-tier1")).toContain("dit is de template zelf");
  });

  it("slaat over in app-template-tier2-openbaar, deze template", () => {
    expect(draai("Stage-Two-AI/app-template-tier2-openbaar")).toContain("dit is de template zelf");
    expect(draai("Klant-BV/app-template-tier2-openbaar")).toContain("dit is de template zelf");
  });

  it("slaat over onder de oude naam (doorverwijzing van GitHub)", () => {
    expect(draai("Stage-Two-AI/stack-template-cloudflare")).toContain("dit is de template zelf");
  });

  it("slaat niet over in een afgeleide app", () => {
    expect(draai("Klant-BV/planning")).not.toContain("dit is de template zelf");
  });

  it("slaat niet over bij een naam die er alleen op lijkt", () => {
    expect(draai("Klant-BV/stack-template-cloudflare-kopie")).not.toContain(
      "dit is de template zelf",
    );
    expect(draai("Klant-BV/app-template-tier2-openbaar-kopie")).not.toContain(
      "dit is de template zelf",
    );
    expect(draai("Klant-BV/app-template-tier3")).not.toContain("dit is de template zelf");
  });
});

/**
 * Een beveiligingsupdate van Dependabot kan de versie van een GitHub Action in een workflow
 * ophogen. Zo'n pull request van dependabot[bot] die alleen `uses:`-regels wijzigt, mag door;
 * al het andere blijft de bevestigingsregel nodig hebben. Getest in een losse git-repo met
 * dezelfde guard en hetzelfde manifest.
 */
describe("guard:template en Dependabot", () => {
  const WORTEL = resolve(__dirname, "../..");
  const WORKFLOW = [
    "name: CI",
    "on: pull_request",
    "jobs:",
    "  code:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v5",
    "      - uses: actions/setup-node@v5 # v5.0.0",
    "        with:",
    "          node-version: 22",
    "",
  ].join("\n");

  function metRepo(wijzig: (tekst: string) => string, actor: string): string {
    const map = mkdtempSync(join(tmpdir(), "guard-template-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", map, ...args], { encoding: "utf8", stdio: "pipe" });
      git("init", "-q", "-b", "main");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.com");
      for (const pad of [
        "scripts/guard-template.mjs",
        "scripts/lib/changed-files.mjs",
        ".claude/stack-manifest.json",
      ]) {
        mkdirSync(dirname(join(map, pad)), { recursive: true });
        copyFileSync(join(WORTEL, pad), join(map, pad));
      }
      mkdirSync(join(map, ".github/workflows"), { recursive: true });
      writeFileSync(join(map, ".github/workflows/ci.yml"), WORKFLOW);
      git("add", "-A");
      git("commit", "-q", "-m", "basis");
      git("checkout", "-q", "-b", "dependabot/github_actions/x");
      writeFileSync(join(map, ".github/workflows/ci.yml"), wijzig(WORKFLOW));
      git("commit", "-q", "-am", "wijziging");
      const uitkomst = spawnSync("node", ["scripts/guard-template.mjs"], {
        cwd: map,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_REPOSITORY: "Klant-BV/planning",
          GITHUB_BASE_REF: "",
          GITHUB_ACTOR: actor,
          PR_BODY: "",
        },
      });
      return `${uitkomst.status}|${uitkomst.stdout}${uitkomst.stderr}`;
    } finally {
      rmSync(map, { recursive: true, force: true });
    }
  }

  const nieuweVersie = (tekst: string) =>
    tekst
      .replace("actions/checkout@v5", "actions/checkout@v6")
      .replace("actions/setup-node@v5 # v5.0.0", "actions/setup-node@v5.1.2 # v5.1.2");

  it("laat een voorstel van dependabot[bot] door dat alleen uses:-regels wijzigt", () => {
    const uit = metRepo(nieuweVersie, "dependabot[bot]");
    expect(uit).toMatch(/^0\|/);
    expect(uit).toContain("voorstel van Dependabot");
  });

  it("dezelfde wijziging door iemand anders blijft rood", () => {
    expect(metRepo(nieuweVersie, "bouwer")).toMatch(
      /^1\|[\s\S]*bestanden die van de gedeelde template/,
    );
  });

  it("een voorstel van dependabot[bot] dat meer wijzigt dan uses:-regels blijft rood", () => {
    const uit = metRepo(
      (tekst) => nieuweVersie(tekst).replace("node-version: 22", "node-version: 20"),
      "dependabot[bot]",
    );
    expect(uit).toMatch(/^1\|[\s\S]*bestanden die van de gedeelde template/);
  });
});

/**
 * De servercode van de template (sinds versie 43): de Worker, de ingang van de server en
 * src/lib/server/** staan onder src/ en workers/, maar zijn van de template. Daar zit de
 * beveiliging van elk verzoek, en een verbetering daarin moet elke app bereiken. In een app
 * maakt een wijziging eraan guard:template rood, net als bij een workflow of een guard.
 */
describe("guard:template bewaakt de servercode van de template", () => {
  const WORTEL = resolve(__dirname, "../..");
  const SERVERCODE = [
    "workers/app.ts",
    "src/entry.server.tsx",
    "src/lib/server/worker.server.ts",
    "src/lib/server/cache.server.ts",
    "src/lib/server/beveiliging.server.ts",
    "src/lib/server/sessie.server.ts",
    "src/lib/server/verzoek.server.ts",
    "src/lib/server/instellingen.server.ts",
    "src/lib/server/document.server.tsx",
    "src/lib/server/fouten.server.ts",
    "src/lib/server/veilig-pad.ts",
    "src/lib/server/sessie-cookie.ts",
    "public/_headers",
    "scripts/guard-server.mjs",
    "scripts/preview-controle.mjs",
  ];

  function wijzigInApp(pad: string, prTekst = ""): string {
    const map = mkdtempSync(join(tmpdir(), "guard-template-server-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", map, ...args], { encoding: "utf8", stdio: "pipe" });
      git("init", "-q", "-b", "main");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.com");
      for (const kopie of [
        "scripts/guard-template.mjs",
        "scripts/lib/changed-files.mjs",
        ".claude/stack-manifest.json",
        ...SERVERCODE,
      ]) {
        mkdirSync(dirname(join(map, kopie)), { recursive: true });
        copyFileSync(join(WORTEL, kopie), join(map, kopie));
      }
      git("add", "-A");
      git("commit", "-q", "-m", "basis");
      git("checkout", "-q", "-b", "eigen-wijziging");
      writeFileSync(join(map, pad), "// de beveiliging eruit gehaald\n");
      git("commit", "-q", "-am", "wijziging");
      const uitkomst = spawnSync("node", ["scripts/guard-template.mjs"], {
        cwd: map,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_REPOSITORY: "Klant-BV/shop",
          GITHUB_BASE_REF: "",
          GITHUB_ACTOR: "bouwer",
          PR_BODY: prTekst,
        },
      });
      return `${uitkomst.status}|${uitkomst.stdout}${uitkomst.stderr}`;
    } finally {
      rmSync(map, { recursive: true, force: true });
    }
  }

  it("elk bestand van de servercode staat in het manifest onder vervangen, en bestaat", () => {
    const manifest = JSON.parse(
      execFileSync("cat", [join(WORTEL, ".claude/stack-manifest.json")], { encoding: "utf8" }),
    ) as { vanDeTemplate: { vervangen: string[] } };
    for (const pad of SERVERCODE) {
      expect(manifest.vanDeTemplate.vervangen, pad).toContain(pad);
    }
    // En omgekeerd: geen bestand in src/lib/server/ dat niet in het manifest staat.
    const inMap = execFileSync("ls", [join(WORTEL, "src/lib/server")], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((naam) => `src/lib/server/${naam}`);
    for (const pad of inMap) expect(manifest.vanDeTemplate.vervangen, pad).toContain(pad);
  });

  for (const pad of [
    "workers/app.ts",
    "src/entry.server.tsx",
    "src/lib/server/cache.server.ts",
    "src/lib/server/worker.server.ts",
    "public/_headers",
  ]) {
    it(`een app die ${pad} wijzigt, is rood`, () => {
      const uit = wijzigInApp(pad);
      expect(uit).toMatch(/^1\|/);
      expect(uit).toContain(pad);
    });
  }

  it("alleen met de zichtbare bevestigingsregel in de PR-tekst mag het", () => {
    expect(wijzigInApp("workers/app.ts", "Bevestigd: templatebestanden gewijzigd")).toMatch(/^0\|/);
  });
});

/**
 * Het manifest zegt welke template dit is. Sinds versie 43 heeft de openbare variant een eigen
 * naam en formaat 2: een oudere plugin die alleen `cloudflare` (de gewone tier 2) kent, stopt
 * dan in plaats van de verkeerde template op deze app toe te passen.
 */
describe("het manifest van deze template", () => {
  it("heeft formaat 2, de variant cloudflare-openbaar en de naam van deze template", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(__dirname, "../../.claude/stack-manifest.json"), "utf8"),
    ) as { manifestFormaat: number; variant: string; template: string; $beschrijving: string[] };
    expect(manifest.manifestFormaat).toBe(2);
    expect(manifest.variant).toBe("cloudflare-openbaar");
    expect(manifest.template).toBe("app-template-tier2-openbaar");
    expect(manifest.$beschrijving.join(" ")).not.toMatch(/dezelfde variant/);
  });
});
