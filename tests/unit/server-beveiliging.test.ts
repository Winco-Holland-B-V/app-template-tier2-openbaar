// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { contentSecurityPolicy, vanEigenSite } from "../../src/lib/server/beveiliging.server";
import { leesInstellingen } from "../../src/lib/server/instellingen.server";
import { verzoekContext } from "../../src/lib/server/verzoek.server";
import { html, INSTELLINGEN, vraag } from "./server-hulp";

/**
 * De beveiliging die de Worker van de template op elk verzoek en elk antwoord zet
 * (src/lib/server/worker.server.ts), wat een route ook doet.
 */
const APP = "https://shop.klant.nl";

describe("aanval: een schrijvend verzoek vanaf een andere site (CSRF)", () => {
  const route = vi.fn(() => new Response("gedaan"));

  async function post(
    headers: Record<string, string>,
    adres = `${APP}/bestellen`,
    method = "POST",
  ) {
    route.mockClear();
    const antwoord = await vraag(adres, route, {
      init: {
        method,
        headers: { Cookie: "sb-x-auth-token=iets", ...headers },
        body: method === "GET" ? undefined : "a=1",
      },
    });
    return { antwoord, bereikt: route.mock.calls.length > 0 };
  }

  for (const [naam, headers] of [
    ["een vreemde Origin", { Origin: "https://evil.example" }],
    ["een Origin op een subdomein van ons", { Origin: "https://evil.shop.klant.nl" }],
    ["ons domein als voorvoegsel", { Origin: "https://shop.klant.nl.evil.example" }],
    ["ons domein over http", { Origin: "http://shop.klant.nl" }],
    ["ons domein op een andere poort", { Origin: "https://shop.klant.nl:8443" }],
    ["Origin null (een ingesloten pagina zonder herkomst)", { Origin: "null" }],
    ["een lege Origin", { Origin: "" }],
    ["geen Origin en geen Sec-Fetch-Site", {}],
    ["geen Origin, Sec-Fetch-Site cross-site", { "Sec-Fetch-Site": "cross-site" }],
    ["geen Origin, Sec-Fetch-Site same-site (een zusterdomein)", { "Sec-Fetch-Site": "same-site" }],
    ["geen Origin, Sec-Fetch-Site none", { "Sec-Fetch-Site": "none" }],
    [
      "vreemde Origin met Sec-Fetch-Site same-origin erbij gelogen",
      { Origin: "https://evil.example", "Sec-Fetch-Site": "same-origin" },
    ],
    [
      "vreemde Origin met onze naam in Referer en X-Forwarded-Host",
      {
        Origin: "https://evil.example",
        Referer: `${APP}/`,
        "X-Forwarded-Host": "evil.example",
        Host: "evil.example",
      },
    ],
  ] as [string, Record<string, string>][]) {
    it(`weigert een POST met ${naam}, en de route wordt niet bereikt`, async () => {
      const { antwoord, bereikt } = await post(headers);
      expect(antwoord.status).toBe(403);
      expect(bereikt).toBe(false);
      expect(antwoord.headers.get("Cache-Control")).toBe("private, no-store");
    });
  }

  for (const method of ["POST", "PUT", "PATCH", "DELETE", "QUERY", "PROPFIND"]) {
    it(`weigert ${method} van een andere site, ook naar een .data-adres en een route zonder scherm`, async () => {
      for (const adres of [
        `${APP}/bestellen.data`,
        `${APP}/api/bestelling`,
        `${APP}/_.data?index`,
      ]) {
        const { antwoord, bereikt } = await post({ Origin: "https://evil.example" }, adres, method);
        expect(antwoord.status, adres).toBe(403);
        expect(bereikt, adres).toBe(false);
      }
    });
  }

  it("laat een POST van de app zelf door", async () => {
    const { antwoord, bereikt } = await post({ Origin: APP });
    expect(antwoord.status).toBe(200);
    expect(bereikt).toBe(true);
  });

  it("laat een POST zonder Origin door als de browser zelf same-origin meldt", async () => {
    const { bereikt } = await post({ "Sec-Fetch-Site": "same-origin" });
    expect(bereikt).toBe(true);
  });

  it("laat lezen (GET, HEAD) van overal door: dat wijzigt niets", async () => {
    expect((await post({ Origin: "https://evil.example" }, `${APP}/`, "GET")).bereikt).toBe(true);
    expect(vanEigenSite(new Request(`${APP}/`, { method: "HEAD" }))).toBe(true);
  });

  it("vergelijkt met het adres van het verzoek, niet met een header die de bezoeker meestuurt", () => {
    const verzoek = new Request(`${APP}/x`, {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "X-Forwarded-Host": "evil.example",
        "X-Forwarded-Proto": "https",
      },
    });
    expect(vanEigenSite(verzoek)).toBe(false);
  });
});

describe("beveiligingsheaders op elk antwoord", () => {
  it("zet op een pagina de vaste headers en een Content-Security-Policy met een eenmalige code", async () => {
    const antwoord = await vraag(`${APP}/`, () => html("hoi"));
    expect(antwoord.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(antwoord.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(antwoord.headers.get("X-Frame-Options")).toBe("DENY");
    expect(antwoord.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
    const csp = antwoord.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{20,}'(;|$)/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp.split(";").find((r) => r.trim().startsWith("script-src"))).not.toContain(
      "unsafe-inline",
    );
  });

  it("de controle tegen robots (Turnstile): alleen met de sleutel mag het script van Cloudflare laden, en verder verandert er niets", async () => {
    const regel = (csp: string, naam: string) =>
      csp
        .split(";")
        .map((r) => r.trim())
        .find((r) => r.startsWith(`${naam} `)) ?? "";
    const zonder = (await vraag(`${APP}/login`, () => html("hoi"))).headers.get(
      "Content-Security-Policy",
    );
    expect(zonder).not.toContain("challenges.cloudflare.com");
    expect(regel(zonder ?? "", "frame-src")).toBe("frame-src 'self'");

    const met =
      (
        await vraag(`${APP}/login`, () => html("hoi"), {
          instellingen: { ...INSTELLINGEN, turnstileSitekey: "1x00000000000000000000AA" },
        })
      ).headers.get("Content-Security-Policy") ?? "";
    expect(regel(met, "script-src")).toMatch(
      /^script-src 'self' 'nonce-[A-Za-z0-9+/=]{20,}' https:\/\/challenges\.cloudflare\.com$/,
    );
    expect(regel(met, "frame-src")).toBe("frame-src 'self' https://challenges.cloudflare.com");
    // Alleen die twee regels zijn ruimer; formulieren gaan nog steeds alleen naar de app zelf.
    const zonderCode = (csp: string) => csp.replace(/'nonce-[^']+'/, "'nonce'");
    expect(zonderCode(met).replaceAll(" https://challenges.cloudflare.com", "")).toBe(
      zonderCode(zonder ?? ""),
    );
    expect(regel(met, "form-action")).toBe("form-action 'self'");
    expect(regel(met, "connect-src")).not.toContain("challenges.cloudflare.com");
    expect(met).not.toContain("unsafe-eval");
    // De sleutel komt bij het bouwen uit VITE_TURNSTILE_SITEKEY; leeg is uit.
    expect(
      leesInstellingen({ VITE_TURNSTILE_SITEKEY: " 0x4AAA " }, "production").turnstileSitekey,
    ).toBe("0x4AAA");
    expect(
      leesInstellingen({ VITE_TURNSTILE_SITEKEY: "" }, "production").turnstileSitekey,
    ).toBeNull();
    expect(leesInstellingen({}, "production").turnstileSitekey).toBeNull();
  });

  it("geeft elk antwoord een andere code, en dezelfde als de pagina in zijn scripts zet", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      let inPagina = "";
      const antwoord = await vraag(`${APP}/`, (_request, context) => {
        inPagina = context.get(verzoekContext)?.nonce ?? "";
        return html("hoi");
      });
      const csp = antwoord.headers.get("Content-Security-Policy") ?? "";
      expect(csp).toContain(`'nonce-${inPagina}'`);
      codes.add(inPagina);
    }
    expect(codes.size).toBe(20);
  });

  it("laat verbinden alleen toe met de app, Supabase (ook live) en Sentry", () => {
    const csp = contentSecurityPolicy(
      "abc",
      {
        ...INSTELLINGEN,
        sentryDsn: "https://0123abcd@o123456.ingest.de.sentry.io/4500000000000000",
      },
      true,
    );
    expect(csp).toContain(
      "connect-src 'self' https://abcdefghijklmnopqrst.supabase.co wss://abcdefghijklmnopqrst.supabase.co https://o123456.ingest.de.sentry.io",
    );
    expect(csp).toContain("upgrade-insecure-requests");
    // De sleutel uit de DSN hoort niet in de header.
    expect(csp).not.toContain("0123abcd");
  });

  it("overschrijft een eigen Content-Security-Policy of X-Frame-Options van een route", async () => {
    const antwoord = await vraag(`${APP}/`, () =>
      html("hoi", {
        headers: {
          "Content-Security-Policy": "default-src *; script-src * 'unsafe-inline'",
          "X-Frame-Options": "ALLOWALL",
          "X-Content-Type-Options": "sniff-maar-raak",
        },
      }),
    );
    expect(antwoord.headers.get("Content-Security-Policy")).toContain("script-src 'self' 'nonce-");
    expect(antwoord.headers.get("Content-Security-Policy")).not.toContain("*");
    expect(antwoord.headers.get("X-Frame-Options")).toBe("DENY");
    expect(antwoord.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("zet de vaste headers ook op gegevens, omleidingen en fouten", async () => {
    for (const route of [
      () => Response.json({ a: 1 }),
      () => new Response(null, { status: 302, headers: { Location: "/login" } }),
      () => {
        throw new Error("stuk");
      },
    ]) {
      const fout = vi.spyOn(console, "error").mockImplementation(() => {});
      const antwoord = await vraag(`${APP}/x.data`, route);
      fout.mockRestore();
      expect(antwoord.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(antwoord.headers.get("X-Frame-Options")).toBe("DENY");
      expect(antwoord.headers.get("Cache-Control")).toBe("private, no-store");
    }
  });

  it("in de dev-server meldt de browser een overtreding alleen (Report-Only)", async () => {
    const antwoord = await vraag("http://localhost:5173/", () => html("hoi"), {
      instellingen: { ...INSTELLINGEN, mode: "development" },
    });
    expect(antwoord.headers.get("Content-Security-Policy")).toBeNull();
    expect(antwoord.headers.get("Content-Security-Policy-Report-Only")).toContain("script-src");
    expect(antwoord.headers.get("Content-Security-Policy-Report-Only")).not.toContain(
      "upgrade-insecure-requests",
    );
    expect(antwoord.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("een fout in een route geeft een kale 500, zonder de foutmelding", async () => {
    const fout = vi.spyOn(console, "error").mockImplementation(() => {});
    const antwoord = await vraag(`${APP}/`, () => {
      throw new Error("geheim detail uit de database");
    });
    fout.mockRestore();
    expect(antwoord.status).toBe(500);
    expect(await antwoord.text()).not.toContain("geheim detail");
  });
});
