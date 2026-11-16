// @vitest-environment node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "../../src/lib/server/beveiliging.server";
import { leesBrowserRegels, leesInstellingen } from "../../src/lib/server/instellingen.server";
import { INSTELLINGEN } from "./server-hulp";

/**
 * De eigen aanvullingen van een app op de Content-Security-Policy (`browser` in
 * stack.config.json): afbeeldingen van een leverancier, een scanner met WebAssembly. Wat mag,
 * wat geweigerd wordt, en dat er voor scripts nooit iets bij komt behalve WebAssembly.
 *
 * Deze test is van de template.
 */
type Regels = {
  img: string[];
  connect: string[];
  media: string[];
  font: string[];
  frame: string[];
  wasm: boolean;
};
const LIB = pathToFileURL(resolve(__dirname, "../../scripts/lib/browser-regels.mjs")).href;
const { browserRegels, weigerBron } = (await import(LIB)) as {
  browserRegels: (config: unknown) => { regels: Regels; fouten: string[] };
  weigerBron: (bron: unknown) => string | null;
};

const reden = "productfoto's van de leverancier";

describe("welke bron mag", () => {
  it("een kale https-oorsprong, ook met een jokerteken vooraan op een eigen domein", () => {
    for (const bron of [
      "https://beeld.leverancier.nl",
      "https://leverancier.nl",
      "https://*.leverancier.nl",
      "https://cdn-2.foto.leverancier.co.uk",
    ]) {
      expect(weigerBron(bron), bron).toBeNull();
    }
  });

  it("weigert alles wat geen vaste https-oorsprong is", () => {
    for (const bron of [
      "*",
      "https:",
      "http:",
      "data:",
      "blob:",
      "'unsafe-inline'",
      "'unsafe-eval'",
      "'self'",
      "http://beeld.leverancier.nl",
      "https://beeld.leverancier.nl/",
      "https://beeld.leverancier.nl/fotos",
      "https://beeld.leverancier.nl:8443",
      "https://beeld.leverancier.nl?x=1",
      "https://Beeld.Leverancier.nl",
      " https://beeld.leverancier.nl",
      "https://*",
      "https://*.nl",
      "https://*.*.nl",
      "https://beeld.*.nl",
      "https://127.0.0.1",
      "https://localhost",
      "https://localhost.localhost",
      "https://user:pw@beeld.leverancier.nl",
      "https://a.nl https://b.nl",
      "https://a.nl;script-src *",
      "https://a.nl'",
      "wss://live.leverancier.nl",
    ]) {
      expect(weigerBron(bron), bron).not.toBeNull();
    }
  });

  it("geen jokerteken op een adres waar iedereen een eigen site kan zetten", () => {
    for (const bron of [
      "https://*.workers.dev",
      "https://*.stagetwo.workers.dev",
      "https://*.github.io",
      "https://*.supabase.co",
      "https://*.s3.amazonaws.com",
      "https://*.r2.dev",
    ]) {
      expect(weigerBron(bron), bron).not.toBeNull();
    }
    // Een vaste naam op zo'n adres mag wel: dat is één bekende site.
    expect(weigerBron("https://fotos.leverancier.workers.dev")).toBeNull();
  });
});

describe("de lijst in stack.config.json", () => {
  it("zonder blok `browser`: niets extra", () => {
    expect(browserRegels({})).toEqual({
      regels: { img: [], connect: [], media: [], font: [], frame: [], wasm: false },
      fouten: [],
    });
  });

  it("neemt elke lijst over, met een reden per bron", () => {
    const { regels, fouten } = browserRegels({
      browser: {
        afbeeldingen_van: { "https://beeld.leverancier.nl": reden },
        verbindingen_met: { "https://api.kaart.nl": "de kaart op de contactpagina" },
        media_van: { "https://video.voorbeeld.nl": "de uitlegvideo" },
        lettertypen_van: { "https://fonts.voorbeeld.nl": "de huisstijl" },
        frames_van: { "https://www.youtube-nocookie.com": "de video op de startpagina" },
        webassembly: "de barcodescanner in het magazijn",
      },
    });
    expect(fouten).toEqual([]);
    expect(regels).toEqual({
      img: ["https://beeld.leverancier.nl"],
      connect: ["https://api.kaart.nl"],
      media: ["https://video.voorbeeld.nl"],
      font: ["https://fonts.voorbeeld.nl"],
      frame: ["https://www.youtube-nocookie.com"],
      wasm: true,
    });
  });

  it("weigert scripts van elders, onbekende lijsten, een lijst zonder redenen en webassembly zonder reden", () => {
    for (const [browser, verwacht] of [
      [{ scripts_van: { "https://cdn.voorbeeld.nl": reden } }, /scripts van een ander domein/],
      [{ script_src: ["https://cdn.voorbeeld.nl"] }, /scripts van een ander domein/],
      [{ default_src: { "https://a.nl": reden } }, /bestaat niet/],
      [{ afbeeldingen_van: ["https://beeld.leverancier.nl"] }, /per oorsprong een reden/],
      [{ afbeeldingen_van: { "https://beeld.leverancier.nl": "" } }, /geen reden/],
      [{ afbeeldingen_van: { "*": reden } }, /hele groep/],
      [{ verbindingen_met: { "https:": reden } }, /hele groep/],
      [{ afbeeldingen_van: { "data:": reden } }, /hele groep/],
      [{ webassembly: true }, /reden/],
      [{ webassembly: "ja" }, /reden/],
      ["alles", /geen blok/],
    ] as const) {
      const { fouten } = browserRegels({ browser });
      expect(fouten.join("\n"), JSON.stringify(browser)).toMatch(verwacht);
    }
  });

  it("een fout in de ene lijst neemt de rest niet mee, maar is wel een fout", () => {
    const { regels, fouten } = browserRegels({
      browser: { afbeeldingen_van: { "https://goed.nl": reden, "https://*": reden } },
    });
    expect(regels.img).toEqual(["https://goed.nl"]);
    expect(fouten).toHaveLength(1);
  });
});

describe("in de Worker", () => {
  it("de lijst uit de build komt in de juiste regels, en scripts krijgen alleen WebAssembly erbij", () => {
    const browser = leesBrowserRegels(
      JSON.stringify({
        img: ["https://beeld.leverancier.nl"],
        connect: ["https://api.kaart.nl"],
        media: ["https://video.voorbeeld.nl"],
        font: ["https://fonts.voorbeeld.nl"],
        frame: ["https://www.youtube-nocookie.com"],
        wasm: true,
      }),
    );
    const csp = contentSecurityPolicy("abc", { ...INSTELLINGEN, browser }, true);
    const regel = (naam: string) =>
      csp
        .split("; ")
        .find((r) => r.startsWith(`${naam} `))
        ?.slice(naam.length + 1)
        .split(" ") ?? [];
    expect(regel("img-src")).toContain("https://beeld.leverancier.nl");
    expect(regel("connect-src")).toContain("https://api.kaart.nl");
    expect(regel("media-src")).toContain("https://video.voorbeeld.nl");
    expect(regel("font-src")).toContain("https://fonts.voorbeeld.nl");
    expect(regel("frame-src")).toContain("https://www.youtube-nocookie.com");
    expect(regel("script-src")).toEqual(["'self'", "'nonce-abc'", "'wasm-unsafe-eval'"]);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("'unsafe-inline' ");
    // Elke eigen bron staat alleen in zijn eigen regel.
    expect(regel("script-src")).not.toContain("https://beeld.leverancier.nl");
    expect(regel("default-src")).toEqual(["'self'"]);
  });

  it("zonder lijst: de strenge regels van de template, zonder WebAssembly", () => {
    const csp = contentSecurityPolicy("abc", INSTELLINGEN, true);
    expect(csp).toContain("script-src 'self' 'nonce-abc';");
    expect(csp).not.toContain("wasm");
    expect(csp).toContain("font-src 'self' data:;");
  });

  it("een gerommelde waarde in de omgeving komt nooit in de header", () => {
    for (const waarde of [
      JSON.stringify({ img: ["*"], connect: ["https:"], frame: ["https://a.nl; script-src *"] }),
      JSON.stringify({ img: ["https://a.nl 'unsafe-inline'"], wasm: "ja" }),
      JSON.stringify({ script: ["https://evil.example"] }),
      "geen json",
      "",
    ]) {
      const browser = leesInstellingen({ VITE_BROWSER_REGELS: waarde }, "production").browser;
      expect(browser, waarde).toEqual({
        img: [],
        connect: [],
        media: [],
        font: [],
        frame: [],
        wasm: false,
      });
      const csp = contentSecurityPolicy("abc", { ...INSTELLINGEN, browser }, true);
      expect(csp).toContain("script-src 'self' 'nonce-abc';");
      expect(csp).not.toContain("evil");
    }
  });
});
