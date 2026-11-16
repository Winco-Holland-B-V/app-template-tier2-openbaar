import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

/**
 * De waarheid over een testrun: welke tests van de template zijn echt GEDRAAID? Een regel die
 * naar de tekst kijkt (`.skip(`, `.only`), mist altijd wel een vorm: `const t = it; t.skip()`,
 * `it.skipIf(1)`, `describe.each([])`. Daarom leest guard:testlat het resultaat van de echte
 * run van Vitest (de JSON-reporter, met `--includeTaskLocation`) en legt dat naast de tests
 * die in de templatebestanden staan:
 *
 *   - elke aanroep van `it(` of `test(` in een testbestand van de template heeft in de run
 *     minstens één test op die regel die gedraaid heeft (geslaagd of mislukt);
 *   - een test van de template die niet draaide (overgeslagen, todo) mag alleen als de reden
 *     in het templatebestand zelf staat: een `skipIf(...)` of `runIf(...)` met een echte
 *     voorwaarde (geen vaste waarde als `true` of `1`) op die test of op een `describe`
 *     eromheen.
 *
 * Deze module is van de template, net als scripts/guard-testlat.mjs.
 */

/**
 * De bron met de inhoud van tekst en commentaar vervangen door spaties (regeleinden blijven):
 * zo telt `it("a")` in een tekst (een testbestand dat een ander testbestand schrijft) niet als
 * test, en kloppen de regelnummers nog.
 */
export function blankeer(bron) {
  let uit = "";
  let i = 0;
  const leeg = (t) => (t === "\n" ? "\n" : " ");
  while (i < bron.length) {
    const t = bron[i];
    const volgende = bron[i + 1];
    if (t === "/" && volgende === "/") {
      while (i < bron.length && bron[i] !== "\n") {
        uit += " ";
        i++;
      }
    } else if (t === "/" && volgende === "*") {
      const eind = bron.indexOf("*/", i + 2);
      const stop = eind === -1 ? bron.length : eind + 2;
      for (; i < stop; i++) uit += leeg(bron[i]);
    } else if (t === '"' || t === "'" || t === "`") {
      uit += t;
      i++;
      let diepte = 0;
      while (i < bron.length) {
        const c = bron[i];
        if (c === "\\") {
          uit += "  ";
          i += 2;
          continue;
        }
        if (t === "`" && c === "$" && bron[i + 1] === "{") diepte++;
        else if (t === "`" && c === "}" && diepte > 0) diepte--;
        else if (c === t && diepte === 0) break;
        else if (c === "\n" && t !== "`") break;
        uit += leeg(c);
        i++;
      }
      if (i < bron.length) uit += bron[i];
      i++;
    } else {
      uit += t;
      i++;
    }
  }
  return uit;
}

const regelVan = (bron, index) => bron.slice(0, index).split("\n").length;

/** Het einde (index) van de haakjes die bij `open` beginnen. */
function sluit(bron, open) {
  let diepte = 0;
  for (let j = open; j < bron.length; j++) {
    if (bron[j] === "(") diepte++;
    else if (bron[j] === ")" && --diepte === 0) return j;
  }
  return bron.length;
}

/** Is deze voorwaarde een vaste waarde (`true`, `1`, `!0`, `"x"`)? Dan is het geen reden. */
function vasteWaarde(voorwaarde) {
  return /^!*\s*(?:true|false|null|undefined|-?\d+(?:\.\d+)?|"[^"]*"|'[^']*'|`[^`]*`)$/.test(
    voorwaarde.trim(),
  );
}

/** De regels met een aanroep van `it(` of `test(` (met of zonder `.each`, `.skipIf` enz.). */
export function testRegels(bron) {
  const kaal = blankeer(bron);
  const regels = new Set();
  for (const m of kaal.matchAll(/(?<![\w.$])(?:it|test)\b(?=\s*[.(])/g)) {
    regels.add(regelVan(kaal, m.index ?? 0));
  }
  return regels;
}

/**
 * Waar het templatebestand zelf zegt dat een test mag overslaan: een `skipIf(...)` of
 * `runIf(...)` met een echte voorwaarde. Geeft per stuk het bereik van regels dat eronder valt
 * (een hele `describe`, of die ene test).
 */
export function redenenOmOverTeSlaan(bron) {
  const kaal = blankeer(bron);
  const bereiken = [];
  for (const m of kaal.matchAll(/(?<![\w.$])(?:it|test|describe)\s*\.\s*(?:skipIf|runIf)\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const dicht = sluit(kaal, open);
    // De voorwaarde zelf uit de echte bron: daar staan de teksten nog in.
    if (vasteWaarde(bron.slice(open + 1, dicht))) continue;
    const romp = kaal.indexOf("(", dicht + 1);
    const eind = romp === -1 ? dicht : sluit(kaal, romp);
    bereiken.push({ van: regelVan(kaal, m.index ?? 0), tot: regelVan(kaal, eind) });
  }
  return bereiken;
}

/**
 * Leg het resultaat van een run naast de testbestanden van de template. Geeft de problemen.
 * `pad` is het JSON-bestand van de reporter; `bestanden` de templatebestanden die in deze run
 * horen (relatief aan `wortel`).
 */
export function controleerResultaat(pad, bestanden, wortel = process.cwd()) {
  const problemen = [];
  let rapport;
  try {
    rapport = JSON.parse(readFileSync(pad, "utf8"));
  } catch {
    return [`${pad}: het resultaat van de testrun is niet te lezen.`];
  }
  const perBestand = new Map();
  for (const bestand of rapport.testResults ?? []) {
    const naam = relative(wortel, resolve(wortel, bestand.name ?? ""))
      .split("\\")
      .join("/");
    perBestand.set(naam, bestand.assertionResults ?? []);
  }
  for (const bestand of bestanden) {
    if (!existsSync(resolve(wortel, bestand))) continue;
    const uitkomsten = perBestand.get(bestand);
    if (!uitkomsten) {
      problemen.push(`${bestand}: dit testbestand van de template is in de run niet gedraaid.`);
      continue;
    }
    const bron = readFileSync(resolve(wortel, bestand), "utf8");
    const redenen = redenenOmOverTeSlaan(bron);
    const metReden = (regel) => redenen.some((r) => regel >= r.van && regel <= r.tot);
    const gedraaid = new Set();
    for (const u of uitkomsten) {
      const regel = u.location?.line;
      if (regel === undefined) {
        problemen.push(
          `${pad}: de run is zonder --includeTaskLocation gemaakt; zo is niet na te gaan welke test waar staat.`,
        );
        return problemen;
      }
      if (u.status === "passed" || u.status === "failed") gedraaid.add(regel);
      else if (!metReden(regel))
        problemen.push(
          `${bestand}:${regel}: "${u.title}" is niet gedraaid (${u.status}), en de reden staat niet in het testbestand van de template.`,
        );
    }
    for (const regel of testRegels(bron)) {
      if (gedraaid.has(regel) || metReden(regel)) continue;
      if (uitkomsten.some((u) => u.location?.line === regel)) continue;
      problemen.push(
        `${bestand}:${regel}: deze test van de template kwam in de run niet voor (bijvoorbeeld een lege describe.each of een uitgeschakelde describe).`,
      );
    }
  }
  return problemen;
}
