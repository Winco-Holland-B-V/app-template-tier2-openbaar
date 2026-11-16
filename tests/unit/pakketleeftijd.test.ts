import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * pnpm installeert een versie pas als die minstens een dag oud is. Een uitzondering daarop
 * (`minimumReleaseAgeExclude` in pnpm-workspace.yaml) is soms nodig, maar hoort tijdelijk te
 * zijn: blijft hij staan, dan vergeet iedereen waarom, en groeit de lijst. Daarom heeft elke
 * uitzondering een regel erboven met een einddatum en een reden, en wordt deze test rood als
 * die regel ontbreekt of de datum voorbij is.
 *
 * Deze test is van de template en komt met elke versie mee.
 */
type Uitzondering = { pakket: string; tot: string | null; reden: string | null };

function uitzonderingen(tekst: string): Uitzondering[] {
  const regels = tekst.split("\n");
  const start = regels.findIndex((regel) => /^minimumReleaseAgeExclude:\s*$/.test(regel));
  if (start === -1) return [];
  const uit: Uitzondering[] = [];
  let toelichting: RegExpExecArray | null = null;
  for (const regel of regels.slice(start + 1)) {
    if (/^\S/.test(regel)) break;
    const opmerking = /^\s+#\s*tot (\d{4}-\d{2}-\d{2}):\s*(\S.*)$/.exec(regel);
    if (opmerking) {
      toelichting = opmerking;
      continue;
    }
    const pakket = /^\s+-\s+['"]?([^'"\s]+)['"]?\s*$/.exec(regel);
    if (pakket) {
      uit.push({
        pakket: pakket[1] ?? "",
        tot: toelichting?.[1] ?? null,
        reden: toelichting?.[2] ?? null,
      });
      toelichting = null;
    } else if (regel.trim() !== "" && !regel.trim().startsWith("#")) {
      toelichting = null;
    }
  }
  return uit;
}

/** De datum van vandaag als JJJJ-MM-DD (UTC). */
const VANDAAG = new Date().toISOString().slice(0, 10);

describe("uitzonderingen op de minimale leeftijd van pakketten", () => {
  const lijst = uitzonderingen(
    readFileSync(resolve(__dirname, "../../pnpm-workspace.yaml"), "utf8"),
  );

  it("elke uitzondering heeft een einddatum en een reden op de regel erboven", () => {
    for (const { pakket, tot, reden } of lijst) {
      expect(tot, `${pakket}: zet erboven "# tot JJJJ-MM-DD: <reden>"`).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
      expect(reden, pakket).toBeTruthy();
    }
  });

  it("geen uitzondering is over zijn datum: haal hem dan weg uit pnpm-workspace.yaml", () => {
    const verlopen = lijst
      .filter(({ tot }) => tot !== null && tot < VANDAAG)
      .map(({ pakket, tot }) => `${pakket} (tot ${tot})`);
    expect(verlopen).toEqual([]);
  });

  it("een uitzondering geldt voor één precieze versie, niet voor een heel pakket", () => {
    for (const { pakket } of lijst) expect(pakket).toMatch(/.@\d+\.\d+\.\d+/);
  });

  it("de lezer herkent een uitzondering zonder toelichting en een verlopen datum", () => {
    const tekst = [
      "minimumReleaseAgeExclude:",
      "  # tot 2020-01-01: was ooit nodig",
      "  - 'oud@1.0.0'",
      "  - zonder@2.0.0",
      "  # zomaar een opmerking",
      "  - ook-zonder@3.0.0",
      "anders: waar",
      "  - 'niet-meer@1.0.0'",
    ].join("\n");
    expect(uitzonderingen(tekst)).toEqual([
      { pakket: "oud@1.0.0", tot: "2020-01-01", reden: "was ooit nodig" },
      { pakket: "zonder@2.0.0", tot: null, reden: null },
      { pakket: "ook-zonder@3.0.0", tot: null, reden: null },
    ]);
    expect("2020-01-01" < VANDAAG).toBe(true);
  });
});
