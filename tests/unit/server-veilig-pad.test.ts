// @vitest-environment node
import { describe, expect, it } from "vitest";
import { veiligPad, volgendePad } from "../../src/lib/server/veilig-pad";

/**
 * Aanval: na het inloggen naar een vreemde site sturen. Een oplichter zet een adres in
 * `?volgende=` en mailt de link; het begint met het echte domein, dus de bezoeker vertrouwt
 * het. `veiligPad` laat alleen een pad binnen de app door.
 *
 * Elke waarde hieronder wordt ook gelezen zoals een browser dat doet (`new URL`), tegen het
 * domein van de app: het resultaat moet op dat domein blijven.
 */
const APP = "https://shop.klant.nl";

function blijftBinnen(pad: string): boolean {
  return new URL(pad, APP).origin === APP;
}

describe("veiligPad: een omleiding blijft binnen de app", () => {
  const GOED = [
    "/",
    "/bestellingen",
    "/bestellingen/12?tab=regels#onder",
    "/zoeken?q=a%2Fb&volgende=/x",
    "/pad/met.punt/en-streep_",
    "/%2F%2Fevil.example",
    "/a//b",
  ];
  for (const pad of GOED) {
    it(`laat een pad binnen de app door: ${pad}`, () => {
      expect(veiligPad(pad, "/terugval")).toBe(pad);
      expect(blijftBinnen(veiligPad(pad))).toBe(true);
    });
  }

  const FOUT: [string, string][] = [
    ["een heel adres", "https://evil.example/"],
    ["een adres zonder protocol", "//evil.example"],
    ["drie schuine strepen", "///evil.example"],
    ["een backslash na de streep", "/\\evil.example"],
    ["twee backslashes", "\\\\evil.example"],
    ["backslash en streep", "\\/evil.example"],
    ["een backslash verderop", "/pad\\..\\..\\evil"],
    ["een tab tussen de strepen", "/\t/evil.example"],
    ["een regeleinde tussen de strepen", "/\n/evil.example"],
    ["een regeleinde met wagenterugloop", "/\r\n/evil.example"],
    ["een spatie vooraan", " /bestellingen"],
    ["een spatie erin", "/ /evil.example"],
    ["javascript:", "javascript:alert(1)"],
    ["javascript: met hoofdletters", "JaVaScRiPt:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["http zonder strepen", "http:evil.example"],
    ["https met één streep", "https:/evil.example"],
    ["een relatief pad", "bestellingen"],
    ["een punt vooraan", "./bestellingen"],
    ["een apenstaartje", "@evil.example"],
    ["gebruikersnaam in het adres", "https://shop.klant.nl@evil.example/"],
    ["een leeg adres", ""],
    ["een vraagteken", "?volgende=//evil.example"],
    ["een hekje", "#//evil.example"],
    ["een nulteken", "/\u0000/evil.example"],
    ["dubbele streep na punten", "/..//evil.example/.."],
  ];
  for (const [naam, waarde] of FOUT) {
    it(`weigert ${naam}`, () => {
      const uit = veiligPad(waarde);
      expect(blijftBinnen(uit)).toBe(true);
      expect(uit.startsWith("//")).toBe(false);
      // Geweigerd betekent: de terugval, tenzij het na opschonen een gewoon pad bleek.
      if (uit !== "/") expect(uit).toMatch(/^\/[^/\\]/);
    });
  }

  it("geeft de terugval bij alles wat geen tekst is", () => {
    for (const waarde of [null, undefined, 12, {}, ["/x"], true]) {
      expect(veiligPad(waarde)).toBe("/");
      expect(veiligPad(waarde, "/start")).toBe("/start");
    }
  });

  it("weigert een extreem lang adres", () => {
    expect(veiligPad(`/${"a".repeat(3000)}`)).toBe("/");
  });

  it("wat eruit komt, leest een browser nooit als een ander domein (willekeurige proef)", () => {
    const stukken = [
      "/",
      "\\",
      "//",
      "evil.example",
      "@",
      ":",
      "https:",
      "\t",
      "%2f",
      "%5c",
      ".",
      "..",
      "?",
      "#",
      " ",
      "a",
    ];
    let zaad = 43;
    const kies = () => {
      zaad = (zaad * 1103515245 + 12345) % 2147483648;
      return stukken[zaad % stukken.length] ?? "/";
    };
    for (let i = 0; i < 5000; i++) {
      const waarde = Array.from({ length: 1 + (i % 6) }, kies).join("");
      const uit = veiligPad(waarde);
      expect(blijftBinnen(uit), JSON.stringify(waarde)).toBe(true);
      expect(uit.startsWith("/") && !uit.startsWith("//"), JSON.stringify(waarde)).toBe(true);
      expect(uit.includes("\\"), JSON.stringify(waarde)).toBe(false);
    }
  });
});

describe("volgendePad: het pad uit ?volgende=", () => {
  it("leest een pad binnen de app", () => {
    expect(volgendePad("https://shop.klant.nl/login?volgende=%2Fbestellingen%3Ftab%3D1")).toBe(
      "/bestellingen?tab=1",
    );
  });

  it("geeft de startpagina bij een vreemd adres of zonder waarde", () => {
    expect(volgendePad("https://shop.klant.nl/login?volgende=https%3A%2F%2Fevil.example")).toBe(
      "/",
    );
    expect(volgendePad("https://shop.klant.nl/login?volgende=%2F%2Fevil.example")).toBe("/");
    expect(volgendePad("https://shop.klant.nl/login?volgende=%2F%5Cevil.example")).toBe("/");
    expect(volgendePad("https://shop.klant.nl/login")).toBe("/");
    expect(volgendePad("/login?volgende=/mijn")).toBe("/mijn");
  });
});
