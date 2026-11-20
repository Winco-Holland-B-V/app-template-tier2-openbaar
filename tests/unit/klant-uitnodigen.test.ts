import { describe, expect, it, vi } from "vitest";
import { bepaalOntvangers, type MailOmgeving } from "../../supabase/functions/_shared/mail";
import {
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
    });
  });

  it("weigert een vreemd adres, en neemt niets over wat de functie niet kent", () => {
    expect(typeof leesVerzoek({ e_mail: "geen-adres" })).toBe("string");
    expect(leesVerzoek({ e_mail: "a@b.nl", sleutel: "zelf-gekozen" })).toEqual({
      e_mail: "a@b.nl",
      naam: null,
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
