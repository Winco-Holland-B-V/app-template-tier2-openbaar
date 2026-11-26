// @vitest-environment node
import type { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { controleerWachtwoord, leesWachtwoordlink } from "./wachtwoord";

/**
 * /wachtwoord-instellen en /wachtwoord-vergeten op de server (wachtwoord.server.ts), door de
 * Worker van de template heen, met Supabase nagebootst op het niveau van `fetch` (zoals
 * inloggen.server.test.ts). De aanvallen: een link laten verbruiken door een GET (een scanner),
 * een wachtwoord zetten zonder sessie, en zien of een adres een account heeft.
 */
const APP = "https://shop.klant.nl";
const SESSIE = "__Host-sb-abcdefghijklmnopqrst-auth-token";
const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef01234567";

type Verzoek = { pad: string; methode: string; body: string };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function laad(diensten = "cloudflare,wachtwoord", omgeving: Record<string, string> = {}) {
  vi.resetModules();
  vi.stubEnv("VITE_INLOGDIENST", diensten);
  for (const [naam, waarde] of Object.entries(omgeving)) vi.stubEnv(naam, waarde);
  const hulp = await import("../../../tests/unit/server-hulp");
  const ww = await import("./wachtwoord.server");
  const account = await import("./tweede-stap.server");

  const alsAntwoord = (uit: unknown): Response => {
    if (uit instanceof Response) return uit;
    if (typeof uit === "object" && uit !== null && "data" in uit && "init" in uit) {
      const init = typeof uit.init === "object" && uit.init !== null ? uit.init : undefined;
      return Response.json(uit.data, init);
    }
    return Response.json(uit);
  };
  const route =
    (doe: (context: RouterContextProvider, request: Request) => unknown) =>
    async (request: Request, context: RouterContextProvider) => {
      try {
        return alsAntwoord(await doe(context, request));
      } catch (gegooid) {
        if (gegooid instanceof Error) throw gegooid;
        return alsAntwoord(gegooid);
      }
    };

  const verzoeken: Verzoek[] = [];
  let antwoord: (v: Verzoek) => Response | undefined = () => undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (invoer: RequestInfo | URL, init?: RequestInit) => {
      const request = invoer instanceof Request ? invoer : new Request(String(invoer), init);
      if (request.url.endsWith("/.well-known/jwks.json")) return Response.json({ keys: [] });
      const v = {
        pad: new URL(request.url).pathname,
        methode: request.method,
        body: await request.text(),
      };
      verzoeken.push(v);
      return antwoord(v) ?? Response.json({});
    }),
  );

  const post = (
    pad: string,
    doe: (context: RouterContextProvider, request: Request) => unknown,
    velden: Record<string, string>,
    Cookie?: string,
  ) =>
    hulp.vraag(`${APP}${pad}`, route(doe), {
      init: {
        method: "POST",
        body: new URLSearchParams(velden),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: APP,
          ...(Cookie ? { Cookie } : {}),
        },
      },
    });

  return {
    hulp,
    verzoeken,
    supabase: (nieuw: (v: Verzoek) => Response | undefined) => {
      antwoord = nieuw;
    },
    openInstellen: (pad: string, Cookie?: string) =>
      hulp.vraag(`${APP}${pad}`, route(ww.instelstand), {
        init: Cookie ? { headers: { Cookie } } : undefined,
      }),
    instellen: (pad: string, velden: Record<string, string>, Cookie?: string) =>
      post(pad, ww.instellen, velden, Cookie),
    openVergeten: (Cookie?: string) =>
      hulp.vraag(`${APP}/wachtwoord-vergeten`, route(ww.vergetenstand), {
        init: Cookie ? { headers: { Cookie } } : undefined,
      }),
    vergeten: (velden: Record<string, string>) => post("/wachtwoord-vergeten", ww.vergeten, velden),
    openAccount: (Cookie: string) =>
      hulp.vraag(`${APP}/account`, route(account.accountStand), { init: { headers: { Cookie } } }),
    account: (velden: Record<string, string>, Cookie: string) =>
      post("/account", account.accountWijzigen, velden, Cookie),
  };
}

function nieuweSessie(hulp: Awaited<ReturnType<typeof laad>>["hulp"], email: string) {
  const over = Math.floor(Date.now() / 1000) + 3600;
  return {
    access_token: hulp.nepJwt({ sub: "klant-1", email, exp: over, role: "authenticated" }),
    refresh_token: "nieuwe-verversing",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: over,
    user: { id: "klant-1", email, aud: "authenticated", role: "authenticated" },
  };
}

describe("de regels voor een wachtwoord en de link", () => {
  it("minstens tien tekens, hoogstens 72 bytes, twee keer hetzelfde", () => {
    expect(controleerWachtwoord("kort", "kort")).toContain("minstens 10");
    expect(controleerWachtwoord("a".repeat(73), "a".repeat(73))).toContain("hoogstens");
    expect(controleerWachtwoord("een-lang-wachtwoord", "een-ander-wachtwoord")).toContain(
      "niet gelijk",
    );
    expect(controleerWachtwoord("een-lang-wachtwoord", "een-lang-wachtwoord")).toBeNull();
  });

  it("alleen een uitnodiging of herstel, met een token_hash die er een kan zijn", () => {
    expect(leesWachtwoordlink(`?token_hash=${HASH}&type=invite`)).toEqual({
      tokenHash: HASH,
      type: "invite",
    });
    expect(leesWachtwoordlink(`?token_hash=${HASH}&type=recovery`)?.type).toBe("recovery");
    for (const zoek of [
      `?token_hash=${HASH}&type=email`,
      `?token_hash=${HASH}&type=signup`,
      "?token_hash=<script>&type=invite",
      `?type=invite`,
    ]) {
      expect(leesWachtwoordlink(zoek), zoek).toBeNull();
    }
  });
});

describe("/wachtwoord-instellen", () => {
  it("een GET met de link wisselt niets om: alleen een knop", async () => {
    const t = await laad();
    const antwoord = await t.openInstellen(`/wachtwoord-instellen?token_hash=${HASH}&type=invite`);
    expect(await antwoord.json()).toEqual({ stap: "link", soort: "invite" });
    expect(t.verzoeken.filter((v) => v.pad === "/auth/v1/verify")).toEqual([]);
    expect(antwoord.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("de knop wisselt de link om, zet de sessie in het cookie en haalt de link uit het adres", async () => {
    const t = await laad();
    t.supabase((v) =>
      v.pad === "/auth/v1/verify"
        ? Response.json(nieuweSessie(t.hulp, "klant@voorbeeld.nl"))
        : undefined,
    );
    const antwoord = await t.instellen(`/wachtwoord-instellen?token_hash=${HASH}&type=invite`, {
      doe: "link",
    });
    expect(antwoord.status).toBe(302);
    expect(antwoord.headers.get("Location")).toBe("/wachtwoord-instellen");
    expect(antwoord.headers.getSetCookie().some((c) => c.startsWith(SESSIE))).toBe(true);
    const verify = t.verzoeken.filter((v) => v.pad === "/auth/v1/verify");
    expect(verify).toHaveLength(1);
    expect(JSON.parse(verify[0]?.body ?? "{}")).toMatchObject({ token_hash: HASH, type: "invite" });
  });

  it("een verlopen link: een vaste tekst, geen sessie", async () => {
    const t = await laad();
    t.supabase((v) =>
      v.pad === "/auth/v1/verify"
        ? Response.json({ error_code: "otp_expired", msg: "x" }, { status: 403 })
        : undefined,
    );
    const antwoord = await t.instellen(`/wachtwoord-instellen?token_hash=${HASH}&type=recovery`, {
      doe: "link",
    });
    expect(antwoord.status).toBe(400);
    expect(((await antwoord.json()) as { melding: string }).melding).toContain("verlopen");
    expect(antwoord.headers.getSetCookie().some((c) => c.startsWith(SESSIE))).toBe(false);
  });

  it("zonder sessie geen wachtwoord: terug naar de pagina, niets naar Supabase", async () => {
    const t = await laad();
    const antwoord = await t.instellen("/wachtwoord-instellen", {
      doe: "opslaan",
      wachtwoord: "een-lang-wachtwoord",
      herhaling: "een-lang-wachtwoord",
    });
    expect(antwoord.status).toBe(302);
    expect(t.verzoeken.filter((v) => v.pad === "/auth/v1/user" && v.methode === "PUT")).toEqual([]);
  });

  it("met sessie: te kort of ongelijk gaat niet naar Supabase, een goed wachtwoord wel", async () => {
    const t = await laad();
    const Cookie = t.hulp.sessieCookie({ sub: "klant-1", email: "klant@voorbeeld.nl" });
    t.supabase((v) =>
      v.pad === "/auth/v1/user"
        ? Response.json({ id: "klant-1", email: "klant@voorbeeld.nl" })
        : undefined,
    );
    expect(await (await t.openInstellen("/wachtwoord-instellen", Cookie)).json()).toEqual({
      stap: "kiezen",
      adres: "klant@voorbeeld.nl",
    });
    for (const [wachtwoord, herhaling] of [
      ["kort", "kort"],
      ["een-lang-wachtwoord", "een-ander-wachtwoord"],
    ]) {
      const fout = await t.instellen(
        "/wachtwoord-instellen",
        { doe: "opslaan", wachtwoord: wachtwoord ?? "", herhaling: herhaling ?? "" },
        Cookie,
      );
      expect(fout.status).toBe(400);
    }
    expect(t.verzoeken.filter((v) => v.methode === "PUT")).toEqual([]);
    const goed = await t.instellen(
      "/wachtwoord-instellen",
      { doe: "opslaan", wachtwoord: "een-lang-wachtwoord", herhaling: "een-lang-wachtwoord" },
      Cookie,
    );
    expect(goed.status).toBe(302);
    expect(goed.headers.get("Location")).toBe("/");
    const zet = t.verzoeken.filter((v) => v.pad === "/auth/v1/user" && v.methode === "PUT");
    expect(zet).toHaveLength(1);
    expect(JSON.parse(zet[0]?.body ?? "{}")).toMatchObject({ password: "een-lang-wachtwoord" });
  });

  it("bestaat niet zonder wachtwoorden (een build met alleen de code per mail)", async () => {
    const t = await laad("cloudflare,mailcode");
    expect((await t.openInstellen("/wachtwoord-instellen")).status).toBe(404);
  });
});

describe("/wachtwoord-vergeten", () => {
  it("bekend of onbekend adres: hetzelfde antwoord", async () => {
    const t = await laad();
    let bekend = true;
    t.supabase((v) =>
      v.pad === "/auth/v1/recover"
        ? bekend
          ? Response.json({})
          : Response.json({ error_code: "user_not_found", msg: "x" }, { status: 400 })
        : undefined,
    );
    const een = await t.vergeten({ doe: "vraag", email: "klant@voorbeeld.nl" });
    bekend = false;
    const twee = await t.vergeten({ doe: "vraag", email: "niemand@voorbeeld.nl" });
    for (const antwoord of [een, twee]) {
      expect(antwoord.status).toBe(302);
      expect(antwoord.headers.get("Location")).toBe("/wachtwoord-vergeten");
    }
    expect(t.verzoeken.filter((v) => v.pad === "/auth/v1/recover")).toHaveLength(2);
    // Er ontstaat nooit een account: geen aanmelding, geen inlogcode.
    expect(t.verzoeken.some((v) => v.pad === "/auth/v1/signup" || v.pad === "/auth/v1/otp")).toBe(
      false,
    );
  });

  it("met Turnstile aan: zonder bewijs niet naar Supabase, met bewijs gaat het mee", async () => {
    const t = await laad("cloudflare,wachtwoord", { VITE_TURNSTILE_SITEKEY: "0x4AAAA-test" });
    expect((await t.vergeten({ doe: "vraag", email: "klant@voorbeeld.nl" })).status).toBe(400);
    expect(t.verzoeken.filter((v) => v.pad === "/auth/v1/recover")).toEqual([]);
    const echt = `0.${"Ab1_-".repeat(40)}`;
    await t.vergeten({ doe: "vraag", email: "klant@voorbeeld.nl", captcha: echt });
    const recover = t.verzoeken.filter((v) => v.pad === "/auth/v1/recover");
    expect(recover).toHaveLength(1);
    expect(recover[0]?.body).toContain(echt);
  });
});

describe("de stand vooraf (`cloudflare,mailcode,wachtwoord`)", () => {
  const VOORAF = "cloudflare,mailcode,wachtwoord";

  it("wachtwoord vergeten bestaat niet: de pagina en het formulier sturen door naar /login, er gaat niets naar Supabase", async () => {
    const t = await laad(VOORAF);
    const open = await t.openVergeten();
    expect(open.status).toBe(302);
    expect(open.headers.get("Location")).toBe("/login");
    const verstuurd = await t.vergeten({ email: "klant@voorbeeld.nl" });
    expect(verstuurd.status).toBe(302);
    expect(verstuurd.headers.get("Location")).toBe("/login");
    expect(t.verzoeken.filter((v) => v.pad === "/auth/v1/recover")).toEqual([]);
  });

  it("Mijn account: een wachtwoord instellen, ook zonder eerder wachtwoord; daarna één keer de melding", async () => {
    const t = await laad(VOORAF);
    const Cookie = t.hulp.sessieCookie({ sub: "klant-1", email: "klant@voorbeeld.nl" });
    t.supabase((v) =>
      v.pad === "/auth/v1/user"
        ? Response.json({ id: "klant-1", email: "klant@voorbeeld.nl", factors: [] })
        : undefined,
    );
    expect(await (await t.openAccount(Cookie)).json()).toMatchObject({
      adres: "klant@voorbeeld.nl",
      vooraf: true,
      google: false,
      melding: null,
    });
    const kort = await t.account(
      { doe: "wachtwoord", wachtwoord: "kort", herhaling: "kort" },
      Cookie,
    );
    expect(kort.status).toBe(400);
    expect(await kort.json()).toMatchObject({ soort: "wachtwoord" });
    expect(t.verzoeken.filter((v) => v.methode === "PUT")).toEqual([]);

    const goed = await t.account(
      { doe: "wachtwoord", wachtwoord: "een-lang-wachtwoord", herhaling: "een-lang-wachtwoord" },
      Cookie,
    );
    expect(goed.status).toBe(302);
    expect(goed.headers.get("Location")).toBe("/account");
    const zet = t.verzoeken.filter((v) => v.pad === "/auth/v1/user" && v.methode === "PUT");
    expect(zet).toHaveLength(1);
    expect(JSON.parse(zet[0]?.body ?? "{}")).toMatchObject({ password: "een-lang-wachtwoord" });
    const merk = goed.headers
      .getSetCookie()
      .find((regel) => regel.startsWith("__Host-inlog="))
      ?.split(";")[0];
    const daarna = await t.openAccount(`${Cookie}; ${merk}`);
    expect(await daarna.json()).toMatchObject({ melding: "Je wachtwoord is opgeslagen." });
  });

  it("met Google in de lijst zegt Mijn account dat; in de stand account kan het wachtwoord hier niet", async () => {
    const google = await laad("cloudflare,mailcode,google,wachtwoord");
    const Cookie = google.hulp.sessieCookie({ sub: "klant-1", email: "klant@voorbeeld.nl" });
    google.supabase((v) =>
      v.pad === "/auth/v1/user"
        ? Response.json({ id: "klant-1", email: "klant@voorbeeld.nl", factors: [] })
        : undefined,
    );
    expect(await (await google.openAccount(Cookie)).json()).toMatchObject({
      vooraf: true,
      google: true,
    });

    const account = await laad("cloudflare,wachtwoord");
    expect(
      (
        await account.account(
          {
            doe: "wachtwoord",
            wachtwoord: "een-lang-wachtwoord",
            herhaling: "een-lang-wachtwoord",
          },
          Cookie,
        )
      ).status,
    ).toBe(400);
    expect(account.verzoeken.filter((v) => v.methode === "PUT")).toEqual([]);
  });
});
