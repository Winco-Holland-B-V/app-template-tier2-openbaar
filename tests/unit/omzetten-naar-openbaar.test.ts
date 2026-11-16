import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * scripts/omzetten-naar-openbaar.mjs (het mechanische deel van
 * docs/routes/omzetten-naar-openbaar.md) op een nagebootste app van de gewone tier 2-template:
 * een eigen manifest met de oude template, react-router-dom, index.html en src/main.tsx, een
 * eigen domein, en een AGENTS.md met een eigen naam boven de markering.
 *
 * Deze test is van de template.
 */
const WORTEL = resolve(__dirname, "../..");
const SCRIPT = join(WORTEL, "scripts/omzetten-naar-openbaar.mjs");
const manifest = JSON.parse(readFileSync(join(WORTEL, ".claude/stack-manifest.json"), "utf8"));

let app: string;

function schrijf(pad: string, inhoud: string) {
  mkdirSync(dirname(join(app, pad)), { recursive: true });
  writeFileSync(join(app, pad), inhoud);
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: app, encoding: "utf8" }).trim();

beforeEach(() => {
  app = realpathSync(mkdtempSync(join(tmpdir(), "omzetten-")));
  schrijf(
    ".claude/stack-manifest.json",
    JSON.stringify({
      manifestFormaat: 2,
      stackVersion: manifest.stackVersion,
      variant: "cloudflare",
      template: "app-template-tier2",
      vanDeTemplate: { vervangen: ["docs/routes/klantportaal.md", "scripts/guard-rls.mjs"] },
    }),
  );
  schrijf("docs/routes/klantportaal.md", "# oud\n");
  schrijf("scripts/guard-rls.mjs", "// oud\n");
  schrijf(
    "AGENTS.md",
    "# Mijn eigen app\n\nWat ze doet.\n\n<!-- stack:begin -->\noud\n<!-- stack:end -->\n",
  );
  schrijf(
    "package.json",
    JSON.stringify({
      name: "mijn-app",
      scripts: { eigen: "node eigen.mjs", check: "oud" },
      dependencies: { "react-router-dom": "^7.0.0", xlsx: "^0.18.5", react: "^19.0.0" },
      devDependencies: { vitest: "^1.0.0" },
    }),
  );
  schrijf("index.html", "<title>Mijn app</title>");
  schrijf("src/main.tsx", "export {};\n");
  schrijf(
    "src/features/oud/lijst.tsx",
    'import { Link } from "react-router-dom";\nexport { Link };\n',
  );
  schrijf(
    "wrangler.jsonc",
    '// eigen\n{\n  "name": "mijn-app",\n  "assets": { "not_found_handling": "single-page-application" },\n  "workers_dev": true,\n  "preview_urls": true,\n  "routes": [{ "pattern": "app.mijnbedrijf.nl", "custom_domain": true }]\n}\n',
  );
  schrijf(".gitignore", "node_modules/\ndist/\n");
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@e.invalid", "-c", "user.name=t", "commit", "-qm", "app");
});
afterEach(() => rmSync(app, { recursive: true, force: true }));

const draai = () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: app, encoding: "utf8" });
  return { code: r.status, uitvoer: `${r.stdout}${r.stderr}` };
};

describe("scripts/omzetten-naar-openbaar.mjs", () => {
  it("zet de bestanden van de template neer en haalt weg wat alleen in het oude manifest stond", () => {
    const r = draai();
    expect(r.code, r.uitvoer).toBe(0);
    for (const pad of manifest.vanDeTemplate.vervangen) {
      if (existsSync(join(WORTEL, pad))) expect(existsSync(join(app, pad)), pad).toBe(true);
    }
    expect(existsSync(join(app, "docs/routes/klantportaal.md"))).toBe(false);
    expect(readFileSync(join(app, "scripts/guard-rls.mjs"), "utf8")).toBe(
      readFileSync(join(WORTEL, "scripts/guard-rls.mjs"), "utf8"),
    );
    expect(JSON.parse(readFileSync(join(app, ".claude/stack-manifest.json"), "utf8")).variant).toBe(
      "cloudflare-openbaar",
    );
    expect(existsSync(join(app, "index.html"))).toBe(false);
    expect(existsSync(join(app, "src/main.tsx"))).toBe(false);
    expect(existsSync(join(app, "src/lib/browser-scherm.tsx"))).toBe(true);
    expect(existsSync(join(app, "src/routes/login.tsx"))).toBe(true);
    expect(r.uitvoer).toContain("Met de hand");
  });

  it("AGENTS.md alleen tussen de markeringen; de eigen naam blijft", () => {
    draai();
    const agents = readFileSync(join(app, "AGENTS.md"), "utf8");
    expect(agents.startsWith("# Mijn eigen app\n\nWat ze doet.")).toBe(true);
    expect(agents).not.toContain("\noud\n");
    expect(agents).toContain("browser-scherm");
  });

  it("package.json: scripts van de template, eigen extra's blijven, react-router-dom eruit", () => {
    draai();
    const pkg = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
    const template = JSON.parse(readFileSync(join(WORTEL, "package.json"), "utf8"));
    expect(pkg.name).toBe("mijn-app");
    expect(pkg.scripts.eigen).toBe("node eigen.mjs");
    expect(pkg.scripts.check).toBe(template.scripts.check);
    expect(pkg.dependencies["react-router-dom"]).toBeUndefined();
    expect(pkg.dependencies.xlsx).toBe("^0.18.5");
    for (const naam of ["react-router", "@supabase/ssr", "isbot"]) {
      expect(pkg.dependencies[naam], naam).toBe(template.dependencies[naam]);
    }
    expect(pkg.devDependencies.vitest).toBe(template.devDependencies.vitest);
    expect(readFileSync(join(app, "src/features/oud/lijst.tsx"), "utf8")).toContain(
      'from "react-router"',
    );
  });

  it("wrangler.jsonc van de template, met de naam en het eigen domein van de app", () => {
    draai();
    const w = readFileSync(join(app, "wrangler.jsonc"), "utf8");
    expect(w).toContain('"name": "mijn-app"');
    expect(w).toContain('"pattern": "app.mijnbedrijf.nl"');
    expect(w).toContain('"main": "./workers/app.ts"');
    expect(w).not.toContain("single-page-application");
  });

  it(".gitignore krijgt de gegenereerde bestanden erbij, één keer", () => {
    draai();
    const gi = readFileSync(join(app, ".gitignore"), "utf8");
    expect(gi).toContain(".react-router/");
    expect(gi).toContain("worker-configuration.d.ts");
    expect(gi.match(/\.react-router\//g)).toHaveLength(1);
  });

  it("weigert met wijzigingen die niet gecommit zijn, op een andere versie, of als de app al is omgezet", () => {
    schrijf("los.txt", "x");
    expect(draai().code).not.toBe(0);
    rmSync(join(app, "los.txt"));
    const m = JSON.parse(readFileSync(join(app, ".claude/stack-manifest.json"), "utf8"));
    schrijf(".claude/stack-manifest.json", JSON.stringify({ ...m, stackVersion: 1 }));
    git("-c", "user.email=t@e.invalid", "-c", "user.name=t", "commit", "-qam", "oud");
    const oud = draai();
    expect(oud.code).not.toBe(0);
    expect(oud.uitvoer).toContain("/stagetwo-tier2:updaten");
    schrijf(".claude/stack-manifest.json", JSON.stringify({ ...m, template: manifest.template }));
    git("-c", "user.email=t@e.invalid", "-c", "user.name=t", "commit", "-qam", "al");
    expect(draai().uitvoer).toContain("staat al op");
  });
});
