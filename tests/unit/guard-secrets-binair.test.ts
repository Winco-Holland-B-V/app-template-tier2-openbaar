import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Aanval (uitgave 43): een geheime sleutel in een bestand dat geen tekst is, zoals
 * public/brochure.pdf. De build kopieert het naar dist/client en Cloudflare serveert het aan
 * elke bezoeker. guard:secrets sloeg die bestandstypen vroeger helemaal over; nu leest hij ze
 * byte voor byte. De sleutels zijn nep en worden pas bij het draaien samengesteld.
 *
 * Deze test is van de template.
 */
const WORTEL = resolve(__dirname, "../..");
const GUARD = join(WORTEL, "scripts/guard-secrets.mjs");

const b64 = (tekst: string) => Buffer.from(tekst).toString("base64url");
const jwt = (rol: string) =>
  [
    b64('{"alg":"HS256","typ":"JWT"}'),
    b64(JSON.stringify({ iss: "supabase", role: rol })),
    b64("nep-handtekening-voor-de-test"),
  ].join(".");
const GEHEIM = ["sb", "secret", "nepwaardealleenvoordetest"].join("_");
const HEADERS = "https://:versie.:subdomein.workers.dev/*\n  X-Robots-Tag: noindex, nofollow\n";

let map: string;
beforeEach(() => {
  map = mkdtempSync(join(tmpdir(), "guard-secrets-binair-"));
  execFileSync("git", ["init", "-q"], { cwd: map });
});
afterEach(() => rmSync(map, { recursive: true, force: true }));

function schrijf(pad: string, inhoud: string | Buffer) {
  mkdirSync(dirname(join(map, pad)), { recursive: true });
  writeFileSync(join(map, pad), inhoud);
}

function guard() {
  execFileSync("git", ["add", "-A"], { cwd: map });
  const r = spawnSync(process.execPath, [GUARD], { cwd: map, encoding: "utf8" });
  return { code: r.status, uitvoer: `${r.stdout}${r.stderr}` };
}

/** Wat een echt binair bestand rond de sleutel heeft: willekeurige bytes. */
function binairMet(tekst: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x13, 0x88]),
    Buffer.from(` ${tekst} `, "latin1"),
    Buffer.from([0x00, 0xfe, 0x01, 0x7f]),
  ]);
}

describe("guard:secrets kijkt ook in bestanden die geen tekst zijn", () => {
  for (const ext of ["pdf", "zip", "mp4", "woff2"]) {
    it(`een service role-sleutel in public/brochure.${ext} en dist/client: rood`, () => {
      schrijf(`public/brochure.${ext}`, binairMet(jwt("service_role")));
      schrijf(`dist/client/brochure.${ext}`, binairMet(jwt("service_role")));
      schrijf("dist/client/_headers", HEADERS);
      const r = guard();
      expect(r.code, r.uitvoer).not.toBe(0);
      expect(r.uitvoer).toContain(`[git] public/brochure.${ext}`);
      expect(r.uitvoer).toContain(`[bundel] dist/client/brochure.${ext}`);
      expect(r.uitvoer).toContain('rol "service_role"');
    });
  }

  it("alleen in de gebouwde bestanden (niet in git): ook rood", () => {
    schrijf("dist/client/assets/lettertype.woff2", binairMet(GEHEIM));
    const r = guard();
    expect(r.code, r.uitvoer).not.toBe(0);
    expect(r.uitvoer).toContain("Supabase secret key");
  });

  it("in de gebouwde Worker (dist/server): ook rood", () => {
    schrijf("dist/server/assets/data.wasm", binairMet(jwt("service_role")));
    expect(guard().code).not.toBe(0);
  });

  it("de afbeeldingen die er al staan geven geen vals alarm", () => {
    // Alles wat deze app in public/ heeft, in welke map ook: de iconen van de template en de
    // eigen afbeeldingen van de app (of van het voorbeeld, in de template zelf).
    const alle = (onder: string): string[] =>
      readdirSync(join(WORTEL, onder), { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? alle(`${onder}/${d.name}`) : [`${onder}/${d.name}`],
      );
    const beelden = alle("public").filter((pad) =>
      /\.(png|jpe?g|webp|gif|svg|ico|webmanifest)$/i.test(pad),
    );
    expect(beelden.length).toBeGreaterThan(0);
    for (const pad of beelden) {
      cpSync(join(WORTEL, pad), join(map, pad), { recursive: true });
      cpSync(join(WORTEL, pad), join(map, pad.replace(/^public/, "dist/client")), {
        recursive: true,
      });
    }
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
    const begin = Date.now();
    const r = guard();
    expect(r.code, r.uitvoer).toBe(0);
    expect(Date.now() - begin).toBeLessThan(5000);
  });
});
