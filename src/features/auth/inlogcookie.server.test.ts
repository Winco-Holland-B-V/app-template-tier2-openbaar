// @vitest-environment node
import { describe, expect, it } from "vitest";
import { html, INSTELLINGEN, vraag } from "../../../tests/unit/server-hulp";
import { type Inlogopslag, inlogOpslag } from "./inlogcookie.server";

/**
 * Het cookie waarin de inlogpagina onthoudt waar iemand was (inlogcookie.server.ts). Wat
 * ertoe doet: geen script kan het lezen, een ander adres kan het niet neerzetten, het leeft
 * kort, en onzin van buiten wordt genegeerd.
 */
function met(adres: string, doe: (opslag: Inlogopslag) => void, Cookie?: string) {
  return vraag(
    adres,
    (_request, context) => {
      doe(inlogOpslag(context));
      return html("x");
    },
    { init: Cookie ? { headers: { Cookie } } : undefined },
  );
}

const waarde = (velden: unknown) => encodeURIComponent(JSON.stringify(velden));

describe("het inlogcookie", () => {
  it("over https: __Host-, HttpOnly, Secure, SameSite=Lax, een kwartier", async () => {
    const antwoord = await met("https://shop.klant.nl/login", (o) =>
      o.setItem("volgende", "/wagen"),
    );
    expect(antwoord.headers.getSetCookie()).toEqual([
      `__Host-inlog=${waarde({ volgende: "/wagen" })}; Path=/; Max-Age=900; HttpOnly; SameSite=Lax; Secure`,
    ]);
    // Een antwoord dat iets onthoudt, komt nooit in een openbare cache.
    expect(antwoord.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("op de eigen computer (http) zonder __Host- en Secure, verder gelijk", async () => {
    const antwoord = await met(
      "http://127.0.0.1:4173/login",
      (o) => o.setItem("net", "1"),
      undefined,
    );
    expect(antwoord.headers.getSetCookie()).toEqual([
      `inlog=${waarde({ net: "1" })}; Path=/; Max-Age=900; HttpOnly; SameSite=Lax`,
    ]);
    // Over https telt een cookie zonder voorvoegsel niet: een zusterdomein kan dat neerzetten.
    let gelezen: string | null = "x";
    await met(
      "https://shop.klant.nl/login",
      (o) => {
        gelezen = o.getItem("inlog-via-dienst");
      },
      `inlog=${waarde({ "inlog-via-dienst": String(Date.now()) })}`,
    );
    expect(gelezen).toBeNull();
  });

  it("meer wijzigingen in één verzoek worden één cookie; lezen ziet wat net geschreven is", async () => {
    let tussendoor: string | null = null;
    const antwoord = await met(
      "https://shop.klant.nl/login",
      (o) => {
        o.setItem("a", "1");
        o.setItem("b", "2");
        tussendoor = o.getItem("a");
        o.removeItem("a");
        expect(o.neem("bestaand")).toBe("ja");
        expect(o.neem("bestaand")).toBeNull();
      },
      `__Host-inlog=${waarde({ bestaand: "ja" })}`,
    );
    expect(tussendoor).toBe("1");
    expect(antwoord.headers.getSetCookie()).toEqual([
      `__Host-inlog=${waarde({ b: "2" })}; Path=/; Max-Age=900; HttpOnly; SameSite=Lax; Secure`,
    ]);
  });

  it("leegmaken haalt het cookie weg; was er niets, dan komt er ook niets", async () => {
    const weg = await met(
      "https://shop.klant.nl/login",
      (o) => o.wisAlles(),
      `__Host-inlog=${waarde({ volgende: "/wagen" })}`,
    );
    expect(weg.headers.getSetCookie()).toEqual([
      "__Host-inlog=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
    ]);
    const niets = await met("https://shop.klant.nl/login", (o) => {
      o.wisAlles();
      o.removeItem("bestaat-niet");
      o.neem("ook-niet");
    });
    expect(niets.headers.getSetCookie()).toEqual([]);
  });

  it("onzin van buiten wordt genegeerd: geen JSON, geen object, te lang, geen tekst als waarde", async () => {
    for (const rommel of [
      "kapot",
      "%7Bkapot",
      waarde(["lijst"]),
      waarde("tekst"),
      waarde(null),
      waarde({ diep: { volgende: "/x" }, getal: 1 }),
      waarde({ lang: "x".repeat(3000) }),
      "%E0%A4%A",
    ]) {
      let gelezen: unknown = "x";
      await met(
        "https://shop.klant.nl/login",
        (o) => {
          gelezen = [
            o.getItem("volgende"),
            o.getItem("diep"),
            o.getItem("getal"),
            o.getItem("lang"),
          ];
        },
        `__Host-inlog=${rommel}`,
      );
      expect(gelezen, rommel.slice(0, 30)).toEqual([null, null, null, null]);
    }
  });

  it("staat los van de instellingen van Supabase: het werkt ook zonder database", async () => {
    const antwoord = await vraag(
      "https://shop.klant.nl/login",
      (_request, context) => {
        inlogOpslag(context).setItem("net", "1");
        return html("x");
      },
      { instellingen: { ...INSTELLINGEN, supabaseUrl: null, supabaseAnonKey: null } },
    );
    expect(antwoord.headers.getSetCookie()).toHaveLength(1);
  });
});

describe("cookie-velden: een opgeblazen inlogcookie", () => {
  it("leest hoogstens twaalf velden; de rest (van een aanvaller die zelf het cookie vult) telt niet", async () => {
    const velden: Record<string, string> = {};
    for (let i = 0; i < 40; i++) velden[`veld${String(i).padStart(2, "0")}`] = "x";
    velden.volgende = "/stiekem";
    let gezien: Record<string, string | null> = {};
    await met(
      "https://shop.klant.nl/login",
      (o) => {
        gezien = { eerste: o.getItem("veld00"), twaalfde: o.getItem("veld11") };
        gezien.dertiende = o.getItem("veld12");
        gezien.volgende = o.getItem("volgende");
      },
      `__Host-inlog=${waarde(velden)}`,
    );
    expect(gezien).toEqual({ eerste: "x", twaalfde: "x", dertiende: null, volgende: null });
  });
});
