// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isOpenbareSleutel } from "../../src/lib/server/instellingen.server";
import {
  gebruiker,
  heeftServerDatabase,
  supabaseVoorVerzoek,
  vereisGebruiker,
} from "../../src/lib/server/sessie.server";
import { verzoekContext, verzoekUit } from "../../src/lib/server/verzoek.server";
import { vindbaarAdres } from "../../src/lib/vindbaar/adres.server";
import { html, INSTELLINGEN, nepJwt, type Route, sessieCookie, vraag } from "./server-hulp";

/**
 * Supabase op de server (src/lib/server/sessie.server.ts). Twee aanvallen:
 *
 *   - gegevens lezen met meer rechten dan de gebruiker zelf heeft (een nagemaakt cookie,
 *     een service role-sleutel in de Worker);
 *   - de sessie van de ene bezoeker bij de andere (gedeelde toestand tussen verzoeken).
 */
const APP = "https://shop.klant.nl";

/**
 * De client van de server zonder de databasetypes van de app: de tabel `proeftabel` bestaat in
 * geen enkele app, en hoeft ook niet, want fetch is hier nagebootst. Zo leunt deze test alleen
 * op de template, niet op de tabellen van het voorbeeld.
 */
const zonderTypen = (context: Parameters<typeof supabaseVoorVerzoek>[0]) =>
  supabaseVoorVerzoek(context) as unknown as SupabaseClient;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Elk verzoek dat de Supabase-client van de server doet, met wat erin stond. */
function luisterMee(antwoord: (adres: string, init: RequestInit | undefined) => Response) {
  const verzoeken: { adres: string; apikey: string | null; authorization: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (invoer: RequestInfo | URL, init?: RequestInit) => {
      const request = invoer instanceof Request ? invoer : null;
      const adres = request ? request.url : String(invoer);
      // De sleutellijst van het project: hier een project zonder openbare sleutels (HS256), dus
      // gaat elk token na de vormcontrole naar Supabase. De sessie haalt hem op en bewaart hem.
      if (adres.endsWith("/.well-known/jwks.json")) return Response.json({ keys: [] });
      const headers = new Headers(request ? request.headers : init?.headers);
      verzoeken.push({
        adres,
        apikey: headers.get("apikey"),
        authorization: headers.get("Authorization"),
      });
      return antwoord(adres, init);
    }),
  );
  return verzoeken;
}

const wieBenIk: Route = async (_request, context) => {
  const wie = await gebruiker(context);
  return Response.json(wie ? { id: wie.id, email: wie.email, rol: wie.claims.role ?? null } : null);
};

describe("aanval: meer rechten dan de gebruiker zelf heeft", () => {
  it("een zelfgeschreven cookie met een nagemaakt token maakt je niemand: Supabase keurt het af", async () => {
    const verzoeken = luisterMee(() => Response.json({ message: "invalid JWT" }, { status: 401 }));
    for (const alg of ["HS256", "ES256", "RS256", "none"]) {
      const Cookie = sessieCookie(
        { sub: "beheerder-1", email: "baas@klant.nl", role: "service_role" },
        alg,
      );
      const antwoord = await vraag(`${APP}/wie`, wieBenIk, { init: { headers: { Cookie } } });
      expect(await antwoord.json(), alg).toBeNull();
    }
    // De server heeft het echt gevraagd, niet het cookie geloofd.
    expect(verzoeken.length).toBeGreaterThan(0);
  });

  it("de gebruiker komt uit wat Supabase bevestigt, niet uit wat er in het cookie staat", async () => {
    luisterMee(() =>
      Response.json({
        id: "klant-1",
        email: "klant@voorbeeld.nl",
        aud: "authenticated",
        role: "authenticated",
      }),
    );
    const Cookie = sessieCookie({ sub: "klant-1", email: "klant@voorbeeld.nl" });
    const antwoord = await vraag(`${APP}/wie`, wieBenIk, { init: { headers: { Cookie } } });
    expect(await antwoord.json()).toMatchObject({ id: "klant-1", email: "klant@voorbeeld.nl" });
  });

  it("een kapot cookie, een leeg cookie en een cookie van een ander project: niet ingelogd", async () => {
    luisterMee(() => Response.json({}, { status: 401 }));
    for (const Cookie of [
      "__Host-sb-abcdefghijklmnopqrst-auth-token=base64-kapot",
      "__Host-sb-abcdefghijklmnopqrst-auth-token=",
      "__Host-sb-abcdefghijklmnopqrst-auth-token=%7B%22access_token%22%3A1%7D",
      sessieCookie({ sub: "x" }).replace("abcdefghijklmnopqrst", "anderprojectanderproj"),
      "iets=anders",
    ]) {
      const antwoord = await vraag(`${APP}/wie`, wieBenIk, { init: { headers: { Cookie } } });
      expect(await antwoord.json(), Cookie.slice(0, 50)).toBeNull();
    }
  });

  it("zonder cookie vraagt de server niets aan Supabase en is er niemand ingelogd", async () => {
    const verzoeken = luisterMee(() => Response.json({}));
    const antwoord = await vraag(`${APP}/wie`, wieBenIk);
    expect(await antwoord.json()).toBeNull();
    expect(verzoeken).toEqual([]);
  });

  it("een Authorization-header of een token in het adres maakt je niet ingelogd", async () => {
    luisterMee(() => Response.json({ id: "klant-1", email: "klant@voorbeeld.nl" }));
    const token = nepJwt({ sub: "beheerder-1", role: "service_role" });
    const antwoord = await vraag(`${APP}/wie?access_token=${token}`, wieBenIk, {
      init: {
        headers: { Authorization: `Bearer ${token}`, apikey: token, "X-Supabase-Auth": token },
      },
    });
    expect(await antwoord.json()).toBeNull();
  });

  it("de server leest als anonieme bezoeker met de anon-sleutel, en met niets anders", async () => {
    const verzoeken = luisterMee(() => Response.json([]));
    await vraag(`${APP}/lijst`, async (_request, context) => {
      await zonderTypen(context).from("proeftabel").select("id");
      return html("x");
    });
    expect(verzoeken).toHaveLength(1);
    expect(verzoeken[0]?.apikey).toBe(INSTELLINGEN.supabaseAnonKey);
    // Zonder sessie is de anon-sleutel ook het token: de rol `anon` in de database.
    expect(verzoeken[0]?.authorization).toBe(`Bearer ${INSTELLINGEN.supabaseAnonKey}`);
  });

  it("met een sessie leest de server met het token van die gebruiker", async () => {
    const verzoeken = luisterMee(() => Response.json([]));
    const Cookie = sessieCookie({ sub: "klant-1", email: "klant@voorbeeld.nl" });
    const token = JSON.parse(
      Buffer.from(Cookie.split("base64-")[1] ?? "", "base64url").toString(),
    ).access_token;
    await vraag(
      `${APP}/lijst`,
      async (_request, context) => {
        await zonderTypen(context).from("proeftabel").select("id");
        return html("x");
      },
      { init: { headers: { Cookie } } },
    );
    const lezen = verzoeken.find((v) => v.adres.includes("/rest/v1/proeftabel"));
    expect(lezen?.apikey).toBe(INSTELLINGEN.supabaseAnonKey);
    expect(lezen?.authorization).toBe(`Bearer ${token}`);
  });

  it("weigert te starten met een service role-sleutel of een geheime sleutel als anon-sleutel", async () => {
    const fout = vi.spyOn(console, "error").mockImplementation(() => {});
    const sleutels = [
      nepJwt({ role: "service_role", iss: "supabase" }),
      nepJwt({ role: "supabase_admin" }),
      nepJwt({ iss: "supabase" }),
      `sb_${"secret"}_${"x".repeat(24)}`,
    ];
    for (const supabaseAnonKey of sleutels) {
      expect(isOpenbareSleutel(supabaseAnonKey)).toBe(false);
      const verzoeken = luisterMee(() => Response.json([{ geheim: "alles" }]));
      const antwoord = await vraag(
        `${APP}/lijst`,
        async (_request, context) => {
          const { data } = await zonderTypen(context).from("proeftabel").select("*");
          return Response.json(data);
        },
        { instellingen: { ...INSTELLINGEN, supabaseAnonKey } },
      );
      expect(antwoord.status).toBe(500);
      expect(await antwoord.text()).not.toContain("alles");
      expect(verzoeken).toEqual([]);
    }
    fout.mockRestore();
    expect(isOpenbareSleutel(nepJwt({ role: "anon" }))).toBe(true);
    expect(isOpenbareSleutel("sb_publishable_abcdefghijkl")).toBe(true);
  });

  it("geeft de bindingen van Cloudflare (env) niet door aan de app", async () => {
    const { maakWorker } = await import("../../src/lib/server/worker.server");
    const bron = (await import("node:fs")).readFileSync("src/lib/server/worker.server.ts", "utf8");
    // De Worker krijgt env van Cloudflare, maar gebruikt hem nergens en zet hem niet in de context.
    expect(bron).toMatch(/fetch\(request, _env, ctx\)/);
    expect(bron.match(/_env/g)).toHaveLength(1);
    expect(typeof maakWorker).toBe("function");
  });
});

describe("vereisGebruiker: een pagina die alleen met inlog mag", () => {
  const alleenMetInlog: Route = async (_request, context) => {
    const wie = await vereisGebruiker(context);
    return html(`geheim van ${wie.email}`);
  };

  /** Zoals React Router: een omleiding die een loader gooit, wordt het antwoord. */
  const metOmleiding =
    (route: Route): Route =>
    async (request, context) => {
      try {
        return await route(request, context);
      } catch (gegooid) {
        if (gegooid instanceof Response) return gegooid;
        throw gegooid;
      }
    };

  it("stuurt een bezoeker zonder sessie naar de inlogpagina, met het pad waar hij heen wilde", async () => {
    const antwoord = await vraag(`${APP}/bestellingen/12?tab=regels`, metOmleiding(alleenMetInlog));
    expect(antwoord.status).toBe(302);
    expect(antwoord.headers.get("Location")).toBe("/login?volgende=%2Fbestellingen%2F12");
    expect(await antwoord.text()).not.toContain("geheim");
    expect(antwoord.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("ook bij een gegevensverzoek (.data), en nooit naar een ander domein", async () => {
    const data = await vraag(`${APP}/bestellingen.data`, metOmleiding(alleenMetInlog));
    expect(data.headers.get("Location")).toBe("/login?volgende=%2Fbestellingen");
    // De gegevens van de startpagina heten in React Router 8 `/_.data`.
    const start = await vraag(`${APP}/_.data`, metOmleiding(alleenMetInlog));
    expect(start.headers.get("Location")).toBe("/login?volgende=%2F");
    const map = await vraag(`${APP}/winkel/_.data`, metOmleiding(alleenMetInlog));
    expect(map.headers.get("Location")).toBe("/login?volgende=%2Fwinkel%2F");
    const vreemd = await vraag(`${APP}//evil.example/pad`, metOmleiding(alleenMetInlog));
    const locatie = vreemd.headers.get("Location") ?? "";
    expect(locatie.startsWith("/login?volgende=")).toBe(true);
    const volgende = new URL(locatie, APP).searchParams.get("volgende") ?? "";
    expect(new URL(volgende, APP).origin).toBe(APP);
  });

  it("laat een nagemaakt cookie niet door", async () => {
    luisterMee(() => Response.json({}, { status: 401 }));
    const Cookie = sessieCookie({ sub: "klant-1", email: "klant@voorbeeld.nl" });
    const antwoord = await vraag(`${APP}/mijn`, metOmleiding(alleenMetInlog), {
      init: { headers: { Cookie } },
    });
    expect(antwoord.status).toBe(302);
  });
});

describe("aanval: de sessie van de ene bezoeker bij de andere (gedeelde toestand)", () => {
  it("elk verzoek krijgt zijn eigen toestand en zijn eigen Supabase-client", async () => {
    const gezien: unknown[] = [];
    const clients: unknown[] = [];
    const route: Route = (_request, context) => {
      gezien.push(verzoekUit(context));
      clients.push(supabaseVoorVerzoek(context));
      // Binnen één verzoek steeds dezelfde.
      expect(supabaseVoorVerzoek(context)).toBe(clients.at(-1));
      return html("x");
    };
    await Promise.all(Array.from({ length: 10 }, () => vraag(`${APP}/`, route)));
    expect(new Set(gezien).size).toBe(10);
    expect(new Set(clients).size).toBe(10);
  });

  it("twintig verzoeken door elkaar, de helft ingelogd: ieder krijgt alleen zichzelf terug", async () => {
    // Supabase bevestigt het token dat het krijgt: wie erin staat, die ben je.
    luisterMee((_adres, init) => {
      const token = new Headers(init?.headers).get("Authorization")?.replace("Bearer ", "") ?? "";
      const inhoud = JSON.parse(
        Buffer.from(token.split(".")[1] ?? "", "base64url").toString() || "{}",
      );
      return Response.json({
        id: inhoud.sub,
        email: inhoud.email,
        aud: "authenticated",
        role: "authenticated",
      });
    });
    const traag: Route = async (_request, context) => {
      await new Promise((klaar) => setTimeout(klaar, Math.random() * 20));
      const wie = await gebruiker(context);
      await new Promise((klaar) => setTimeout(klaar, Math.random() * 20));
      // Nog een keer vragen, na het wachten: nog steeds dezelfde.
      const nogEens = await gebruiker(context);
      expect(nogEens).toBe(wie);
      return Response.json({ email: wie?.email ?? null });
    };
    const uitkomsten = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const email = i % 2 === 0 ? `klant${i}@voorbeeld.nl` : null;
        const headers: Record<string, string> = email
          ? { Cookie: sessieCookie({ sub: `id-${i}`, email }) }
          : {};
        const antwoord = await vraag(`${APP}/wie`, traag, { init: { headers } });
        return {
          verwacht: email,
          kreeg: ((await antwoord.json()) as { email: string | null }).email,
        };
      }),
    );
    for (const { verwacht, kreeg } of uitkomsten) expect(kreeg).toBe(verwacht);
  });

  it("de servercode bewaart niets op moduleniveau: geen let of var bovenin een bestand van de template", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    for (const naam of readdirSync("src/lib/server")) {
      const tekst = readFileSync(`src/lib/server/${naam}`, "utf8");
      expect(tekst, naam).not.toMatch(/^(export\s+)?(let|var)\s/m);
      // Een vaste lijst mag (`new Set([...])`); een lege verzameling om later te vullen niet.
      // Eén uitzondering, met reden: de openbare sleutels van het Supabase-project in
      // sessie.server.ts (niets van een bezoeker; supabase-js bewaart ze zelf ook zo).
      const zonderUitzondering = tekst.replace(/^const sleutelsPerProject = new Map<.*$/m, "");
      expect(zonderUitzondering, naam).not.toMatch(
        /^(export\s+)?const\s+\w+\s*=\s*(new\s+(Map|Set|WeakMap)\s*(<[^>]*>)?\s*\(\)|\[\]|\{\})/m,
      );
    }
  });

  it("een ververste sessie komt als cookie op het antwoord van dit verzoek, en nergens anders", async () => {
    const a = await vraag(`${APP}/`, (_request, context) => {
      context.get(verzoekContext)?.cookiesUit.push("sb-x-auth-token=van-a; Path=/");
      return html("a");
    });
    const b = await vraag(`${APP}/`, () => html("b"));
    expect(a.headers.get("Set-Cookie")).toContain("van-a");
    expect(b.headers.get("Set-Cookie")).toBeNull();
  });
});

describe("een app zonder database", () => {
  const zonder = { ...INSTELLINGEN, supabaseUrl: null, supabaseAnonKey: null };

  it("heeft geen gebruiker en zegt dat er geen database is", async () => {
    const antwoord = await vraag(
      `${APP}/`,
      async (_request, context) =>
        Response.json({ database: heeftServerDatabase(context), wie: await gebruiker(context) }),
      { instellingen: zonder, init: { headers: { Cookie: "a=b" } } },
    );
    expect(await antwoord.json()).toEqual({ database: false, wie: null });
  });
});

describe("servercode buiten de Worker van de template", () => {
  it("weigert: zonder de Worker is er geen toestand per verzoek en geen beveiliging", async () => {
    const { RouterContextProvider } = await import("react-router");
    expect(() => verzoekUit(new RouterContextProvider())).toThrow(
      /buiten de Worker van de template/,
    );
  });
});

describe("het adres van de pagina bij een gegevensverzoek", () => {
  it("/_.data hoort bij /, /wagen.data bij /wagen (ook voor canonical en og:url)", async () => {
    for (const [pad, verwacht] of [
      ["/_.data", "https://shop.klant.nl/"],
      ["/wagen.data", "https://shop.klant.nl/wagen"],
      ["/producten/koffie", "https://shop.klant.nl/producten/koffie"],
    ]) {
      const antwoord = await vraag(`${APP}${pad}`, async (_request, context) =>
        Response.json(vindbaarAdres(context).adres),
      );
      expect(await antwoord.json(), pad).toBe(verwacht);
    }
  });
});

describe("een afbeelding of pad in een volledig adres (og:image, JSON-LD, sitemap)", () => {
  it("een pad met een backslash, tab of twee schuine strepen wordt nooit een adres op een ander domein", async () => {
    const antwoord = await vraag(`${APP}/producten/koffie`, async (_request, context) => {
      const { absoluut } = vindbaarAdres(context);
      return Response.json(
        [
          "/\\elders.example/volg.png",
          "\\\\elders.example/volg.png",
          "//elders.example/volg.png",
          "/\t/elders.example/volg.png",
          "/voorbeeldshop/koffie.png",
          "https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/x.png",
        ].map(absoluut),
      );
    });
    const adressen: string[] = await antwoord.json();
    expect(adressen.slice(0, 4).every((a) => new URL(a).origin === "https://shop.klant.nl")).toBe(
      true,
    );
    expect(adressen.join(" ")).not.toContain("elders.example");
    expect(adressen[4]).toBe("https://shop.klant.nl/voorbeeldshop/koffie.png");
    expect(adressen[5]).toMatch(/^https:\/\/abcdefghijklmnopqrst\.supabase\.co\//);
  });
});
