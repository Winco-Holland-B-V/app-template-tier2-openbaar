import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/lib/database.types";
import {
  type Actor,
  admin,
  controleerAfscherming,
  keurGoedAlsKlant,
  maakActor,
  verwijderActor,
} from "./lib/afscherming";
import { vraagDatabase } from "./lib/database";
import { type NepInlogdienst, startNepInlogdienst } from "./lib/inlogdienst-nep";
import {
  accountsVan,
  nieuwPersoon,
  noemIdentiteitCloudflare,
  type Sessie,
  sessieViaInlogdienst,
  verwijderAccount,
} from "./lib/sessies";

/**
 * Klantportaal met accounts (supabase/migrations/20261120100000_klantaccounts.sql), op de
 * lokale Supabase met echte tokens:
 *
 *   - klantaccount_toestaan (voor de hook before-user-created): alleen een account per mail met
 *     de sleutel van een open uitnodiging; geen vreemd adres, verzonnen of oude sleutel, of
 *     andere inlogdienst;
 *   - klant_uitnodigingen: alleen een medewerker zet er iets op of leest het; een klant of een
 *     bezoeker niet, en niemand leest de sleutel;
 *   - klant_uitnodiging_afronden: alleen de service role; daarna is het account een goedgekeurde
 *     klant;
 *   - de tweede stap (2FA): heeft een klant een bevestigde factor, dan is hij alleen klant in een
 *     sessie die de tweede stap deed (aal2).
 *
 * Deze test is van de template en komt met elke versie mee.
 */
function nodig(naam: string, waarde: string | undefined): string {
  if (!waarde) throw new Error(`${naam} ontbreekt. Draai \`pnpm db:start\` en \`pnpm env:local\`.`);
  return waarde;
}
const url = nodig("SUPABASE_URL", import.meta.env.SUPABASE_URL);
const anonKey = nodig("SUPABASE_ANON_KEY", import.meta.env.SUPABASE_ANON_KEY);

const heeftAccounts =
  vraagDatabase<{ ja: boolean }>(
    "select to_regprocedure('public.klantaccount_toestaan(jsonb)') is not null as ja",
  )[0]?.ja === true;

/** Een functie aanroepen als een bepaalde rol, rechtstreeks in de lokale database. */
function alsRol(rol: string, sql: string): string {
  const adres = nodig(
    "SUPABASE_DB_URL",
    import.meta.env.SUPABASE_DB_URL ?? process.env.SUPABASE_DB_URL,
  );
  if (!/@(?:127\.0\.0\.1|localhost):/.test(adres)) throw new Error("Niet de lokale database.");
  const beheerder = new URL(adres);
  beheerder.username = "supabase_admin";
  try {
    return execFileSync(
      "psql",
      [beheerder.toString(), "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"],
      {
        encoding: "utf8",
        input: `set role ${rol};\n${sql}`,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ).trim();
  } catch (fout) {
    return `FOUT: ${String((fout as { stderr?: unknown }).stderr ?? "").trim()}`;
  }
}

const sqlTekst = (waarde: string) => `'${waarde.replaceAll("'", "''")}'`;

function toestaan(event: Record<string, unknown>): string {
  return alsRol(
    "supabase_auth_admin",
    `select public.klantaccount_toestaan(${sqlTekst(JSON.stringify(event))}::jsonb);`,
  );
}

const nieuwAccount = (adres: string, aanbieder: string, sleutel?: string) => ({
  user: {
    email: adres,
    app_metadata: { provider: aanbieder },
    user_metadata: sleutel ? { uitnodiging: sleutel } : {},
  },
});

/** Een code van een authenticator-app (TOTP, RFC 6238) uit het geheim dat Supabase geeft. */
function totp(geheim: string, tijd = Date.now()): string {
  const alfabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const teken of geheim.replace(/=+$/, "").toUpperCase()) {
    bits += alfabet.indexOf(teken).toString(2).padStart(5, "0");
  }
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => Number.parseInt(b, 2)));
  const teller = Buffer.alloc(8);
  teller.writeBigUInt64BE(BigInt(Math.floor(tijd / 1000 / 30)));
  const hash = createHmac("sha1", bytes).update(teller).digest();
  const plek = (hash.at(-1) ?? 0) & 0xf;
  const getal = (hash.readUInt32BE(plek) & 0x7fffffff) % 1_000_000;
  return String(getal).padStart(6, "0");
}

let dienst: NepInlogdienst;
let medewerker: Sessie;
const opruimen = new Set<string>();
const adressen = new Set<string>();

beforeAll(async () => {
  if (!heeftAccounts) return;
  dienst = await startNepInlogdienst();
  const persoon = nieuwPersoon("uitnodiger", { adresBevestigd: true });
  medewerker = await sessieViaInlogdienst(persoon);
  for (const id of await accountsVan(persoon)) opruimen.add(id);
  noemIdentiteitCloudflare(medewerker.userId);
}, 60_000);

afterAll(async () => {
  if (!heeftAccounts) return;
  const alsAdmin = admin as unknown as SupabaseClient;
  for (const adres of adressen)
    await alsAdmin.from("klant_uitnodigingen").delete().eq("e_mail", adres);
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  for (const u of data?.users ?? []) if (u.email && adressen.has(u.email)) opruimen.add(u.id);
  for (const id of opruimen) await verwijderAccount(id);
  await dienst?.stop();
});

const adres = (label: string) => {
  const a = `kp-account-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@voorbeeld.nl`;
  adressen.add(a);
  return a;
};

describe.runIf(heeftAccounts)("klantportaal met accounts", () => {
  describe("klantaccount_toestaan, zoals de hook hem aanroept (supabase_auth_admin)", () => {
    it("een open uitnodiging met de juiste sleutel: ja", async () => {
      const a = adres("open");
      const { data, error } = await medewerker.client
        .from("klant_uitnodigingen")
        .insert({ e_mail: a, sleutel: crypto.randomUUID() })
        .select("id");
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      const sleutel = vraagDatabase<{ sleutel: string }>(
        `select sleutel::text as sleutel from public.klant_uitnodigingen where e_mail = ${sqlTekst(a)}`,
      )[0]?.sleutel;
      expect(sleutel).toBeDefined();
      expect(toestaan(nieuwAccount(a, "email", sleutel))).toBe("t");
      // Hoofdletters en spaties in het adres maken geen verschil.
      expect(toestaan(nieuwAccount(` ${a.toUpperCase()} `, "email", sleutel))).toBe("t");
    });

    it("een vreemd adres, een verzonnen sleutel, geen sleutel of een andere dienst: nee", async () => {
      const a = adres("dicht");
      const sleutel = crypto.randomUUID();
      await medewerker.client.from("klant_uitnodigingen").insert({ e_mail: a, sleutel });
      expect(toestaan(nieuwAccount(adres("vreemd"), "email", sleutel))).toBe("f");
      expect(toestaan(nieuwAccount(a, "email", crypto.randomUUID()))).toBe("f");
      expect(toestaan(nieuwAccount(a, "email"))).toBe("f");
      expect(toestaan(nieuwAccount(a, "phone", sleutel))).toBe("f");
      expect(toestaan(nieuwAccount(a, "anonymous", sleutel))).toBe("f");
      expect(toestaan({})).toBe("f");
    });

    it("een uitnodiging ouder dan een kwartier, of al afgerond: nee", async () => {
      const oud = adres("oud");
      const klaar = adres("klaar");
      const s1 = crypto.randomUUID();
      const s2 = crypto.randomUUID();
      await medewerker.client.from("klant_uitnodigingen").insert([
        { e_mail: oud, sleutel: s1 },
        { e_mail: klaar, sleutel: s2 },
      ]);
      alsRol(
        "postgres",
        `update public.klant_uitnodigingen set uitgenodigd_op = now() - interval '16 minutes' where e_mail = ${sqlTekst(oud)};
         update public.klant_uitnodigingen set afgerond_op = now() where e_mail = ${sqlTekst(klaar)};`,
      );
      expect(toestaan(nieuwAccount(oud, "email", s1))).toBe("f");
      expect(toestaan(nieuwAccount(klaar, "email", s2))).toBe("f");
    });

    it("een ingelogde gebruiker of bezoeker kan de functie niet aanroepen", () => {
      for (const rol of ["authenticated", "anon"]) {
        expect(toestaan.length).toBe(1);
        expect(alsRol(rol, `select public.klantaccount_toestaan('{}'::jsonb);`)).toMatch(
          /FOUT: .*permission denied/,
        );
      }
    });
  });

  describe("klant_uitnodigingen", () => {
    it("A/B: een klant ziet, wijzigt en verwijdert geen uitnodiging (alleen medewerkers)", async () => {
      await controleerAfscherming({
        tabel: "klant_uitnodigingen",
        // Alleen een medewerker zet iemand op de lijst; de rij maakt hier de beheerder.
        maakRijAlsA: async () => {
          const { data, error } = await admin
            .from("klant_uitnodigingen")
            .insert({ e_mail: adres("ab-rij"), sleutel: crypto.randomUUID() })
            .select("id")
            .single();
          if (error) throw error;
          return data.id;
        },
      });
    });

    let klant: Actor | undefined;
    afterAll(async () => verwijderActor(klant));

    it("een klant en een bezoeker zien niets en zetten niets op de lijst; niemand leest de sleutel", async () => {
      const a = adres("ab");
      await medewerker.client
        .from("klant_uitnodigingen")
        .insert({ e_mail: a, sleutel: crypto.randomUUID() });
      klant = await maakActor("kp-klant", { goedgekeurd: true });
      const gezien = await klant.client.from("klant_uitnodigingen").select("id, e_mail");
      expect(gezien.data ?? []).toEqual([]);
      const zelf = await klant.client
        .from("klant_uitnodigingen")
        .insert({ e_mail: adres("zelf"), sleutel: crypto.randomUUID() });
      expect(zelf.error).not.toBeNull();
      const bezoeker = createClient<Database>(url, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const anoniem = await bezoeker.from("klant_uitnodigingen").select("id");
      expect(anoniem.data ?? []).toEqual([]);
      const sleutel = await medewerker.client.from("klant_uitnodigingen").select("sleutel");
      expect(sleutel.error?.code).toBe("42501");
      const lijst = await medewerker.client
        .from("klant_uitnodigingen")
        .select("e_mail")
        .eq("e_mail", a);
      expect(lijst.data).toEqual([{ e_mail: a }]);
    });
  });

  describe("klant_uitnodiging_afronden", () => {
    it("alleen de service role; daarna is het account een goedgekeurde klant", async () => {
      const a = adres("afronden");
      const sleutel = crypto.randomUUID();
      await medewerker.client.from("klant_uitnodigingen").insert({ e_mail: a, sleutel });

      const alsMedewerker = await medewerker.client.rpc("klant_uitnodiging_afronden", {
        p_sleutel: sleutel,
      });
      expect(alsMedewerker.error).not.toBeNull();

      const { data } = await admin.auth.admin.createUser({ email: a, email_confirm: true });
      const id = data.user?.id;
      expect(id).toBeDefined();
      if (id) opruimen.add(id);
      const gedaan = await admin.rpc("klant_uitnodiging_afronden", { p_sleutel: sleutel });
      expect(gedaan.error).toBeNull();
      expect(gedaan.data).toBe(id);
      const klant = vraagDatabase<{ goedgekeurd: boolean }>(
        `select goedgekeurd from public.klanten where user_id = ${sqlTekst(String(id))}::uuid`,
      );
      expect(klant).toEqual([{ goedgekeurd: true }]);

      // Een tweede keer kan niet: de uitnodiging is afgerond.
      const nogmaals = await admin.rpc("klant_uitnodiging_afronden", { p_sleutel: sleutel });
      expect(nogmaals.error).not.toBeNull();
    });
  });

  describe("de tweede stap (2FA)", () => {
    let klant: Actor | undefined;
    afterAll(async () => verwijderActor(klant));

    it("met een bevestigde factor is een klant alleen klant na de tweede stap (aal2)", async () => {
      klant = await maakActor("kp-2fa", { goedgekeurd: false });
      await keurGoedAlsKlant(klant);
      const ervoor = await klant.client.rpc("is_goedgekeurde_klant");
      expect(ervoor.data, "zonder factor: klant").toBe(true);

      const inschrijven = await klant.client.auth.mfa.enroll({ factorType: "totp" });
      expect(inschrijven.error).toBeNull();
      const factor = inschrijven.data;
      if (factor?.type !== "totp") throw new Error("geen totp-factor");
      const nogNiet = await klant.client.rpc("is_goedgekeurde_klant");
      expect(nogNiet.data, "factor nog niet bevestigd: telt niet").toBe(true);

      const bevestig = await klant.client.auth.mfa.challengeAndVerify({
        factorId: factor.id,
        code: totp(factor.totp.secret),
      });
      expect(bevestig.error).toBeNull();
      const na = await klant.client.rpc("is_goedgekeurde_klant");
      expect(na.data, "sessie met de tweede stap (aal2): klant").toBe(true);

      // Opnieuw inloggen met alleen het wachtwoord: aal1, dus geen klant.
      const tweede = createClient<Database>(url, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const inlog = await tweede.auth.signInWithPassword({
        email: klant.email,
        password: "rls-test-wachtwoord-123",
      });
      expect(inlog.error).toBeNull();
      const alleenWachtwoord = await tweede.rpc("is_goedgekeurde_klant");
      expect(alleenWachtwoord.data, "alleen het wachtwoord (aal1): geen klant").toBe(false);

      // Met de code uit de app erbij: weer klant.
      const stap = await tweede.auth.mfa.challengeAndVerify({
        factorId: factor.id,
        code: totp(factor.totp.secret, Date.now() + 30_000),
      });
      expect(stap.error).toBeNull();
      const weer = await tweede.rpc("is_goedgekeurde_klant");
      expect(weer.data).toBe(true);
    });
  });
});
