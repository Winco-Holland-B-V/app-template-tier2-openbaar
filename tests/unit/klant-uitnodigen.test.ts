import { describe, expect, it, vi } from "vitest";
import { bepaalOntvangers, type MailOmgeving } from "../../supabase/functions/_shared/mail";
import {
  isKlantaccount,
  leesVerzoek,
  magUitnodigen,
  type Omgeving,
  uitnodigen,
} from "../../supabase/functions/klant-uitnodigen/kern";

/**
 * De kern van de Edge Function klant-uitnodigen, met een nagebootste Supabase. De echte keten
 * (hook, mail, koppeling) toetst tests/rls/klant-uitnodigen.test.ts op de lokale Supabase.
 */
type Antwoord = { status?: number; json?: unknown; tekst?: string };

function nepSupabase(antwoorden: Partial<Record<string, Antwoord>>) {
  const verzoeken: { pad: string; methode: string; kop: Record<string, string>; body: string }[] =
    [];
  const nep = vi.fn(async (adres: string | URL | Request, init?: RequestInit) => {
    const pad = new URL(String(adres)).pathname;
    const methode = init?.method ?? "GET";
    verzoeken.push({
      pad,
      methode,
      kop: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ""),
    });
    const a = antwoorden[`${methode} ${pad}`] ?? {};
    const status = a.status ?? 200;
    return new Response(a.tekst ?? JSON.stringify(a.json ?? null), { status });
  });
  return { nep, verzoeken };
}

const richt = (omgeving: MailOmgeving) => (mail: { aan: string; onderwerp: string }) =>
  bepaalOntvangers(mail, omgeving);

function omgeving(nep: typeof fetch, mail: MailOmgeving = {}): Omgeving {
  return {
    url: "http://supabase.test",
    anonSleutel: "anon",
    serviceSleutel: "dienst",
    richt: richt(mail),
    nieuweSleutel: () => "11111111-1111-4111-8111-111111111111",
    fetch: nep,
  };
}

const MEDEWERKER = "Bearer token-van-medewerker";
const GOED = {
  "POST /rest/v1/rpc/is_medewerker": { json: true },
  "POST /rest/v1/klant_uitnodigingen": { status: 201, json: [{ id: "u1" }] },
  "POST /auth/v1/invite": { json: { id: "nieuw" } },
  "POST /rest/v1/rpc/klant_uitnodiging_afronden": { json: "nieuw" },
};

describe("leesVerzoek", () => {
  it("maakt het adres klein en zonder spaties, en laat de naam leeg als die er niet is", () => {
    expect(leesVerzoek({ e_mail: "  Piet@Klant.NL " })).toEqual({
      e_mail: "piet@klant.nl",
      naam: null,
      inloglink: false,
    });
    // Alleen precies `true` zet de inloglink aan.
    expect(leesVerzoek({ e_mail: "a@b.nl", inloglink: true })).toMatchObject({ inloglink: true });
    expect(leesVerzoek({ e_mail: "a@b.nl", inloglink: "true" })).toMatchObject({
      inloglink: false,
    });
  });

  it("weigert een vreemd adres, en neemt niets over wat de functie niet kent", () => {
    expect(typeof leesVerzoek({ e_mail: "geen-adres" })).toBe("string");
    expect(leesVerzoek({ e_mail: "a@b.nl", sleutel: "zelf-gekozen" })).toEqual({
      e_mail: "a@b.nl",
      naam: null,
      inloglink: false,
    });
    expect(typeof leesVerzoek(null)).toBe("string");
  });
});

describe("magUitnodigen", () => {
  it("in productie elk adres, daarbuiten alleen het testadres", () => {
    expect(magUitnodigen("piet@klant.nl", richt({}))).toBe(true);
    expect(magUitnodigen("piet@klant.nl", richt({ omgeving: "productie" }))).toBe(true);
    expect(
      magUitnodigen("piet@klant.nl", richt({ omgeving: "test", testmailAdres: "t@w.nl" })),
    ).toBe(false);
    expect(magUitnodigen("t@w.nl", richt({ omgeving: "test", testmailAdres: "t@w.nl" }))).toBe(
      true,
    );
    expect(magUitnodigen("t@w.nl", richt({ omgeving: "test" }))).toBe(false);
  });
});

describe("uitnodigen", () => {
  it("zonder token: 401, en er gaat niets naar Supabase", async () => {
    const { nep } = nepSupabase(GOED);
    const uit = await uitnodigen(null, { e_mail: "piet@klant.nl" }, omgeving(nep));
    expect(uit.status).toBe(401);
    expect(nep).not.toHaveBeenCalled();
  });

  it("geen medewerker: 403, er komt niets op de lijst en er gaat geen uitnodiging weg", async () => {
    const { nep, verzoeken } = nepSupabase({
      ...GOED,
      "POST /rest/v1/rpc/is_medewerker": { json: false },
    });
    const uit = await uitnodigen(MEDEWERKER, { e_mail: "piet@klant.nl" }, omgeving(nep));
    expect(uit.status).toBe(403);
    expect(verzoeken.map((v) => v.pad)).toEqual(["/rest/v1/rpc/is_medewerker"]);
  });

  it("een medewerker: lijst met zijn eigen token, account en koppeling met de service role", async () => {
    const { nep, verzoeken } = nepSupabase(GOED);
    const uit = await uitnodigen(
      MEDEWERKER,
      {
        e_mail: "Piet@Klant.nl",
        naam: "Piet",
      },
      omgeving(nep),
    );
    expect(uit).toEqual({ status: 200, body: { ok: true, e_mail: "piet@klant.nl" } });
    const [rol, lijst, account, afronden] = verzoeken;
    expect(rol?.kop.Authorization).toBe(MEDEWERKER);
    expect(lijst?.kop.Authorization).toBe(MEDEWERKER);
    expect(JSON.parse(lijst?.body ?? "{}")).toEqual({
      e_mail: "piet@klant.nl",
      naam: "Piet",
      sleutel: "11111111-1111-4111-8111-111111111111",
    });
    expect(account?.pad).toBe("/auth/v1/invite");
    expect(account?.kop.Authorization).toBe("Bearer dienst");
    expect(JSON.parse(account?.body ?? "{}")).toEqual({
      email: "piet@klant.nl",
      data: { uitnodiging: "11111111-1111-4111-8111-111111111111" },
    });
    expect(afronden?.kop.Authorization).toBe("Bearer dienst");
    expect(JSON.parse(afronden?.body ?? "{}")).toEqual({
      p_sleutel: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("een adres met een account: 409, en de regel op de lijst gaat weer weg", async () => {
    const { nep, verzoeken } = nepSupabase({
      ...GOED,
      "POST /auth/v1/invite": {
        status: 422,
        tekst: '{"msg":"A user with this email address has already been registered"}',
      },
    });
    const uit = await uitnodigen(MEDEWERKER, { e_mail: "piet@klant.nl" }, omgeving(nep));
    expect(uit.status).toBe(409);
    expect(uit.body.code).toBe("bestaat_al");
    expect(verzoeken.at(-1)).toMatchObject({ methode: "DELETE" });
    expect(verzoeken.some((v) => v.pad.endsWith("klant_uitnodiging_afronden"))).toBe(false);
  });

  it("in de testomgeving een ander adres dan het testadres: geweigerd vóór er iets gebeurt", async () => {
    const { nep, verzoeken } = nepSupabase(GOED);
    const uit = await uitnodigen(
      MEDEWERKER,
      { e_mail: "echte-klant@klant.nl" },
      omgeving(nep, { omgeving: "test", testmailAdres: "test@voorbeeld.nl" }),
    );
    expect(uit.status).toBe(400);
    expect(verzoeken.map((v) => v.pad)).toEqual(["/rest/v1/rpc/is_medewerker"]);
  });
});

describe("isKlantaccount", () => {
  it("alleen email, of email en google; niet Cloudflare, niet zonder identiteit", () => {
    expect(isKlantaccount({ identities: [{ provider: "email" }] })).toBe(true);
    expect(isKlantaccount({ identities: [{ provider: "email" }, { provider: "google" }] })).toBe(
      true,
    );
    expect(isKlantaccount({ app_metadata: { provider: "email", providers: ["email"] } })).toBe(
      true,
    );
    expect(
      isKlantaccount({ identities: [{ provider: "email" }, { provider: "custom:cloudflare" }] }),
    ).toBe(false);
    // Ook als alleen app_metadata het zegt.
    expect(
      isKlantaccount({
        identities: [{ provider: "email" }],
        app_metadata: { providers: ["email", "custom:cloudflare"] },
      }),
    ).toBe(false);
    expect(isKlantaccount({ identities: [] })).toBe(false);
  });
});

describe("uitnodigen met een inloglink (de stand vooraf)", () => {
  const ZOEK = "GET /auth/v1/admin/users";
  const account = (email: string, ...providers: string[]) => ({
    json: { users: [{ email, identities: providers.map((provider) => ({ provider })) }] },
  });

  it("zonder inloglink zoekt de functie geen account op: precies de stappen van de stand account", async () => {
    const { nep, verzoeken } = nepSupabase(GOED);
    const uit = await uitnodigen(MEDEWERKER, { e_mail: "piet@klant.nl" }, omgeving(nep));
    expect(uit).toEqual({ status: 200, body: { ok: true, e_mail: "piet@klant.nl" } });
    expect(verzoeken.map((v) => `${v.methode} ${v.pad}`)).toEqual([
      "POST /rest/v1/rpc/is_medewerker",
      "POST /rest/v1/klant_uitnodigingen",
      "POST /auth/v1/invite",
      "POST /rest/v1/rpc/klant_uitnodiging_afronden",
    ]);
  });

  it("geen account: de uitnodiging zoals altijd, en de lijst krijgt alleen adres, naam en sleutel", async () => {
    const { nep, verzoeken } = nepSupabase({ ...GOED, [ZOEK]: { json: { users: [] } } });
    const uit = await uitnodigen(
      MEDEWERKER,
      { e_mail: "piet@klant.nl", naam: "Piet", inloglink: true },
      omgeving(nep),
    );
    expect(uit).toEqual({
      status: 200,
      body: { ok: true, e_mail: "piet@klant.nl", soort: "uitnodiging" },
    });
    const zoek = verzoeken.find((v) => v.pad === "/auth/v1/admin/users");
    expect(zoek?.kop.Authorization).toBe("Bearer dienst");
    const lijst = verzoeken.find((v) => v.pad === "/rest/v1/klant_uitnodigingen");
    expect(JSON.parse(lijst?.body ?? "{}")).toEqual({
      e_mail: "piet@klant.nl",
      naam: "Piet",
      sleutel: "11111111-1111-4111-8111-111111111111",
    });
    expect(verzoeken.some((v) => v.pad === "/auth/v1/invite")).toBe(true);
    expect(verzoeken.some((v) => v.pad === "/auth/v1/otp")).toBe(false);
  });

  it("een ander account dat maar op het adres lijkt, telt niet als hetzelfde adres", async () => {
    const { nep, verzoeken } = nepSupabase({ ...GOED, [ZOEK]: account("xpiet@klant.nl", "email") });
    const uit = await uitnodigen(
      MEDEWERKER,
      { e_mail: "piet@klant.nl", inloglink: true },
      omgeving(nep),
    );
    expect(uit.body.soort).toBe("uitnodiging");
    expect(verzoeken.some((v) => v.pad === "/auth/v1/otp")).toBe(false);
  });

  for (const providers of [["email"], ["email", "google"]]) {
    it(`een klantaccount (${providers.join(" en ")}): Supabase stuurt een inlogmail, de functie geeft geen link of code terug`, async () => {
      const { nep, verzoeken } = nepSupabase({
        ...GOED,
        [ZOEK]: account("piet@klant.nl", ...providers),
        "POST /auth/v1/otp": { json: {} },
      });
      const uit = await uitnodigen(
        MEDEWERKER,
        { e_mail: "Piet@Klant.nl", inloglink: true },
        omgeving(nep),
      );
      expect(uit).toEqual({
        status: 200,
        body: { ok: true, e_mail: "piet@klant.nl", soort: "inloglink" },
      });
      const otp = verzoeken.find((v) => v.pad === "/auth/v1/otp");
      expect(otp?.kop.apikey).toBe("dienst");
      expect(otp?.kop.Authorization).toBe("Bearer dienst");
      expect(JSON.parse(otp?.body ?? "{}")).toEqual({
        email: "piet@klant.nl",
        create_user: false,
      });
      // Niets op de lijst, geen uitnodiging, geen koppeling.
      expect(verzoeken.map((v) => v.pad)).toEqual([
        "/rest/v1/rpc/is_medewerker",
        "/auth/v1/admin/users",
        "/auth/v1/otp",
      ]);
    });
  }

  it("een medewerker (identiteit van Cloudflare): geweigerd, er gaat geen mail weg", async () => {
    const { nep, verzoeken } = nepSupabase({
      ...GOED,
      [ZOEK]: account("baas@klant.nl", "email", "custom:cloudflare"),
    });
    const uit = await uitnodigen(
      MEDEWERKER,
      { e_mail: "baas@klant.nl", inloglink: true },
      omgeving(nep),
    );
    expect(uit.status).toBe(409);
    expect(uit.body.code).toBe("andere_inlog");
    expect(verzoeken.map((v) => v.pad)).toEqual([
      "/rest/v1/rpc/is_medewerker",
      "/auth/v1/admin/users",
    ]);
  });

  it("net al een mail gestuurd: een nette melding; opzoeken mislukt: geen uitnodiging", async () => {
    const teVaak = nepSupabase({
      ...GOED,
      [ZOEK]: account("piet@klant.nl", "email"),
      "POST /auth/v1/otp": { status: 429, tekst: '{"error_code":"over_email_send_rate_limit"}' },
    });
    const uit = await uitnodigen(
      MEDEWERKER,
      { e_mail: "piet@klant.nl", inloglink: true },
      omgeving(teVaak.nep),
    );
    expect(uit.status).toBe(429);
    expect(uit.body.code).toBe("te_vaak");

    const stuk = nepSupabase({ ...GOED, [ZOEK]: { status: 500, tekst: "storing" } });
    const fout = await uitnodigen(
      MEDEWERKER,
      { e_mail: "piet@klant.nl", inloglink: true },
      omgeving(stuk.nep),
    );
    expect(fout.status).toBe(502);
    expect(stuk.verzoeken.some((v) => v.pad === "/auth/v1/invite")).toBe(false);
  });

  it("in de testomgeving een ander adres dan het testadres: geweigerd vóór er iets wordt opgezocht", async () => {
    const { nep, verzoeken } = nepSupabase(GOED);
    const uit = await uitnodigen(
      MEDEWERKER,
      { e_mail: "echte-klant@klant.nl", inloglink: true },
      omgeving(nep, { omgeving: "test", testmailAdres: "test@voorbeeld.nl" }),
    );
    expect(uit.status).toBe(400);
    expect(verzoeken.map((v) => v.pad)).toEqual(["/rest/v1/rpc/is_medewerker"]);
  });
});
