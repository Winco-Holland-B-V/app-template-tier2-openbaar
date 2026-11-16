// @vitest-environment node
import { UNSAFE_ErrorResponseImpl as ErrorResponse } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  framesUit,
  isStoring,
  leesDsn,
  meldServerfout,
  sentryBericht,
} from "../../src/lib/server/fouten.server";
import { INSTELLINGEN, vraag } from "./server-hulp";

/**
 * Fouten in de servercode gaan naar Sentry (src/lib/server/fouten.server.ts), zonder ruis en
 * zonder persoonsgegevens. `src/entry.server.tsx` geeft `handleError` door aan React Router.
 */
const DSN = "https://0123456789abcdef@o123456.ingest.de.sentry.io/4500000000000000";
const verzoek = (
  adres = "https://shop.klant.nl/bestellen?email=klant%40voorbeeld.nl",
  init?: RequestInit,
) => new Request(adres, init);

let logboek: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logboek = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  logboek.mockRestore();
});

function meld(fout: unknown, request = verzoek(), dsn: string | null = DSN) {
  const verstuurd: { adres: string; body: string }[] = [];
  const wachten: Promise<unknown>[] = [];
  const gemeld = meldServerfout(fout, {
    request,
    dsn,
    omgeving: "test",
    wachtOp: (werk) => wachten.push(werk),
    verstuur: (async (adres: string, init?: RequestInit) => {
      verstuurd.push({ adres, body: String(init?.body) });
      return new Response(null, { status: 200 });
    }) as typeof fetch,
  });
  return { gemeld, verstuurd, wachten };
}

describe("meldServerfout", () => {
  it("stuurt een echte fout naar Sentry, en het antwoord wacht daar niet op", async () => {
    const { gemeld, verstuurd, wachten } = meld(new TypeError("kan prijs niet lezen"));
    expect(gemeld).toBe(true);
    expect(wachten).toHaveLength(1);
    await Promise.all(wachten);
    expect(verstuurd[0]?.adres).toBe(
      "https://o123456.ingest.de.sentry.io/api/4500000000000000/envelope/?sentry_key=0123456789abcdef&sentry_version=7&sentry_client=stagetwo-worker%2F1",
    );
    const [kop, soort, gebeurtenis] = (verstuurd[0]?.body ?? "")
      .split("\n")
      .map((r) => JSON.parse(r));
    expect(kop.event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(soort).toEqual({ type: "event" });
    expect(gebeurtenis.environment).toBe("test");
    expect(gebeurtenis.exception.values[0]).toMatchObject({
      type: "TypeError",
      value: "kan prijs niet lezen",
    });
    expect(gebeurtenis.exception.values[0].stacktrace.frames.length).toBeGreaterThan(0);
  });

  it("stuurt geen persoonsgegevens mee: geen parameters uit het adres, geen cookies, geen headers", async () => {
    const request = verzoek(undefined, {
      headers: { Cookie: "sb-x-auth-token=geheim-token", Authorization: "Bearer geheim" },
    });
    const { verstuurd } = meld(new Error("stuk"), request);
    const body = verstuurd[0]?.body ?? "";
    expect(body).toContain("https://shop.klant.nl/bestellen");
    expect(body).not.toContain("klant%40voorbeeld.nl");
    expect(body).not.toContain("klant@voorbeeld.nl");
    expect(body).not.toContain("geheim");
    expect(body).not.toContain("ookie");
  });

  it("geen ruis: een 404, een weigering, een omleiding en een afgebroken verzoek gaan niet mee", () => {
    const afgebroken = new AbortController();
    afgebroken.abort();
    const gevallen: [string, unknown, Request?][] = [
      ["404 van React Router", new ErrorResponse(404, "Not Found", null)],
      ["403 uit een loader", new ErrorResponse(403, "Forbidden", "mag niet")],
      ["omleiding", new Response(null, { status: 302, headers: { Location: "/login" } })],
      ["404 als antwoord", new Response("weg", { status: 404 })],
      ["afgebroken verzoek", new Error("stuk"), verzoek(undefined, { signal: afgebroken.signal })],
      ["AbortError", Object.assign(new Error("afgebroken"), { name: "AbortError" })],
    ];
    for (const [naam, fout, request] of gevallen) {
      const { gemeld, verstuurd } = meld(fout, request);
      expect(gemeld, naam).toBe(false);
      expect(verstuurd, naam).toEqual([]);
      expect(isStoring(fout, request ?? verzoek()), naam).toBe(false);
    }
    expect(logboek).not.toHaveBeenCalled();
  });

  it("een 500 uit een loader is wel een storing", () => {
    expect(meld(new ErrorResponse(500, "Internal Server Error", "database weg")).gemeld).toBe(true);
    expect(meld(new Response("stuk", { status: 503 })).gemeld).toBe(true);
  });

  it("zonder DSN of met een DSN die niet klopt: alleen het logboek, en nooit een crash", () => {
    for (const dsn of [
      null,
      "",
      "geen-adres",
      "http://sleutel@sentry.example/1",
      "https://sentry.example/1",
      "https://sleutel@sentry.example/project",
    ]) {
      const { gemeld, verstuurd } = meld(new Error("stuk"), verzoek(), dsn);
      expect(gemeld, String(dsn)).toBe(false);
      expect(verstuurd).toEqual([]);
      expect(leesDsn(dsn)).toBeNull();
    }
    expect(logboek).toHaveBeenCalled();
  });

  it("faalt het versturen, dan blijft het daarbij", async () => {
    const wachten: Promise<unknown>[] = [];
    meldServerfout(new Error("stuk"), {
      request: verzoek(),
      dsn: DSN,
      omgeving: null,
      wachtOp: (werk) => wachten.push(werk),
      verstuur: (async () => {
        throw new Error("Sentry is onbereikbaar");
      }) as typeof fetch,
    });
    await expect(Promise.all(wachten)).resolves.toBeDefined();
  });

  it("maakt van iets wat geen Error is toch een bruikbare melding", () => {
    for (const fout of ["tekst", 12, null, undefined, { code: 1 }]) {
      const { tekst } = sentryBericht(fout, { request: verzoek(), omgeving: null });
      const gebeurtenis = JSON.parse(tekst.split("\n")[2] ?? "{}");
      expect(gebeurtenis.exception.values[0].value).toBeTruthy();
      expect(gebeurtenis.environment).toBe("productie");
    }
  });

  it("leest de regels van een stack, de oudste aanroep eerst", () => {
    const frames = framesUit(
      "Error: stuk\n    at loader (file:///dist/server/assets/build.js:10:5)\n    at async callRoute (file:///dist/server/index.js:99:1)\n    at file:///dist/server/index.js:200:3",
    );
    expect(frames).toHaveLength(3);
    expect(frames.at(-1)).toMatchObject({ function: "loader", lineno: 10, colno: 5 });
    expect(framesUit(undefined)).toEqual([]);
  });
});

describe("de Worker meldt een fout die buiten React Router om valt", () => {
  it("een fout in de afhandeling zelf gaat naar Sentry, en de bezoeker krijgt een kale 500", async () => {
    const wachten: Promise<unknown>[] = [];
    const verstuur = vi.fn(async () => new Response(null));
    vi.stubGlobal("fetch", verstuur);
    const antwoord = await vraag(
      "https://shop.klant.nl/",
      () => {
        throw new Error("de afhandeling is stuk");
      },
      { instellingen: { ...INSTELLINGEN, sentryDsn: DSN }, wachtOp: (werk) => wachten.push(werk) },
    );
    await Promise.all(wachten);
    vi.unstubAllGlobals();
    expect(antwoord.status).toBe(500);
    expect(verstuur).toHaveBeenCalledTimes(1);
  });
});

describe("src/entry.server.tsx", () => {
  it("geeft handleError van de template door aan React Router", async () => {
    const { readFileSync } = await import("node:fs");
    const ingang = readFileSync("src/entry.server.tsx", "utf8");
    expect(ingang).toContain(
      `export { default, handleError, streamTimeout } ${"from"} "./lib/server/document.server";`,
    );
    const document = readFileSync("src/lib/server/document.server.tsx", "utf8");
    expect(document).toContain("export const handleError");
    expect(document).toContain("meldServerfout(");
  });
});
