import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/lib/database.types";
import {
  type Actor,
  admin,
  anoniem,
  controleerAfscherming,
  maakActor,
  verwijderActor,
} from "./lib/afscherming";
import { houdVastInDatabase, vraagDatabase } from "./lib/database";
import { type NepInlogdienst, startNepInlogdienst } from "./lib/inlogdienst-nep";
import {
  accountsVan,
  inloggenMetMailcode,
  nieuwAdres,
  nieuwPersoon,
  noemIdentiteitCloudflare,
  pauze,
  type Sessie,
  sessieViaInlogdienst,
  verwijderAccount,
} from "./lib/sessies";

/**
 * De voorbeeldshop: de prijs van de één komt nooit bij de ander, en bestellen gaat alleen via
 * de database, die zelf de prijs en de voorraad bepaalt.
 *
 * De winkel is een klantportaal: iedereen kan per mail een account maken, dus een account
 * alleen geeft niets. Alleen een goedgekeurde klant ziet zijn prijs en bestelt; alleen een
 * medewerker (een sessie via Cloudflare) beheert producten en prijzen, ziet alle bestellingen
 * en keurt klanten goed. Het laatste blok hieronder bewijst dat met echte sessies.
 *
 * Elke test maakt zijn eigen producten (met een unieke slug) en ruimt ze op; de seed-gegevens
 * worden niet gebruikt en niet gewijzigd.
 */
type Product = { id: string; slug: string };

const gemaakt: string[] = [];
let alice: Actor;
let bob: Actor;

async function maakProduct(
  o: { prijs?: number; voorraad?: number; zichtbaar?: boolean } = {},
): Promise<Product> {
  const slug = `rls-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { data, error } = await admin
    .from("producten")
    .insert({
      slug,
      naam: `Testproduct ${slug}`,
      basisprijs_centen: o.prijs ?? 1000,
      voorraad: o.voorraad ?? 10,
      zichtbaar: o.zichtbaar ?? true,
    })
    .select("id, slug")
    .single();
  if (error) throw new Error(`Kon geen testproduct maken: ${error.message}`);
  gemaakt.push(data.id);
  return data;
}

/** Zet een account op de lijst van klanten, als beheerder: goedgekeurd of juist niet. */
async function zetKlant(klant: { id: string; email: string }, goedgekeurd: boolean): Promise<void> {
  const { error } = await admin
    .from("klanten")
    .upsert({ user_id: klant.id, e_mail: klant.email, goedgekeurd });
  if (error) throw new Error(`Kon de klant niet op de lijst zetten: ${error.message}`);
}

const keurGoed = (klant: Actor) => zetKlant(klant, true);

async function zetKlantprijs(
  klant: { id: string },
  product: Product,
  prijs: number,
): Promise<string> {
  const { data, error } = await admin
    .from("klantprijzen")
    .insert({ klant_id: klant.id, product_id: product.id, prijs_centen: prijs })
    .select("id")
    .single();
  if (error) throw new Error(`Kon geen klantprijs zetten: ${error.message}`);
  return data.id;
}

async function inWagen(klant: Actor, product: Product, aantal: number): Promise<void> {
  const { error } = await klant.client.rpc("wagen_toevoegen", {
    p_product_id: product.id,
    p_aantal: aantal,
  });
  if (error) throw new Error(`Kon niet in de wagen leggen: ${error.message}`);
}

async function voorraad(product: Product): Promise<number> {
  const { data, error } = await admin
    .from("producten")
    .select("voorraad")
    .eq("id", product.id)
    .single();
  if (error) throw new Error(error.message);
  return data.voorraad;
}

/**
 * Het totaal zoals de wagenpagina het toont (wagen_overzicht), in centen. Zo doet de pagina het
 * ook: dit bedrag gaat als p_verwacht_totaal mee, en de functie vergelijkt het met haar eigen som.
 */
async function getoondTotaal(client: SupabaseClient<Database>): Promise<number> {
  const { data, error } = await client.from("wagen_overzicht").select("aantal, stukprijs_centen");
  if (error) throw new Error(`Kon de wagen niet lezen: ${error.message}`);
  return (data ?? []).reduce((som, r) => som + (r.aantal ?? 0) * (r.stukprijs_centen ?? 0), 0);
}

/** Bestellen zoals de wagenpagina: met de sleutel en het totaal dat de klant zag. */
async function plaats(client: SupabaseClient<Database>, sleutel: string = crypto.randomUUID()) {
  const p_verwacht_totaal = await getoondTotaal(client);
  return client.rpc("bestelling_plaatsen", { p_sleutel: sleutel, p_verwacht_totaal });
}

async function bestel(klant: Actor): Promise<string> {
  const { data, error } = await plaats(klant.client);
  if (error || !data) throw new Error(`Bestellen mislukte: ${error?.message}`);
  return data;
}

beforeAll(async () => {
  alice = await maakActor("alice-shop");
  bob = await maakActor("bob-shop");
  await keurGoed(alice);
  await keurGoed(bob);
});

afterAll(async () => {
  await verwijderActor(alice);
  await verwijderActor(bob);
  // Alleen de eigen testproducten weg; bestelregels houden hun naam (product_id wordt leeg).
  if (gemaakt.length > 0) await admin.from("producten").delete().in("id", gemaakt);
});

describe("A/B per tabel: B ziet, wijzigt en verwijdert niets van A", () => {
  it("producten: een verborgen product ziet niemand, wijzigen kan niemand", async () => {
    await controleerAfscherming({
      tabel: "producten",
      voorbereidB: keurGoed,
      maakRijAlsA: async () => (await maakProduct({ zichtbaar: false })).id,
    });
  });

  it("klantprijzen", async () => {
    await controleerAfscherming({
      tabel: "klantprijzen",
      voorbereidB: keurGoed,
      maakRijAlsA: async (a) => {
        await keurGoed(a);
        return zetKlantprijs(a, await maakProduct(), 500);
      },
    });
  });

  it("winkelwagen_regels", async () => {
    await controleerAfscherming({
      tabel: "winkelwagen_regels",
      voorbereidB: keurGoed,
      maakRijAlsA: async (a) => {
        await keurGoed(a);
        const product = await maakProduct();
        const { data, error } = await a.client
          .from("winkelwagen_regels")
          .insert({ klant_id: a.id, product_id: product.id, aantal: 1 })
          .select("id")
          .single();
        if (error) throw new Error(error.message);
        return data.id;
      },
    });
  });

  it("bestellingen", async () => {
    await controleerAfscherming({
      tabel: "bestellingen",
      voorbereidB: keurGoed,
      maakRijAlsA: async (a) => {
        await keurGoed(a);
        await inWagen(a, await maakProduct(), 1);
        const { data, error } = await plaats(a.client);
        if (error) throw new Error(error.message);
        return data;
      },
    });
  });

  it("bestelregels", async () => {
    await controleerAfscherming({
      tabel: "bestelregels",
      voorbereidB: keurGoed,
      maakRijAlsA: async (a) => {
        await keurGoed(a);
        await inWagen(a, await maakProduct(), 1);
        const { data: bestelling, error } = await plaats(a.client);
        if (error) throw new Error(error.message);
        const { data, error: fout } = await a.client
          .from("bestelregels")
          .select("id")
          .eq("bestelling_id", bestelling)
          .single();
        if (fout) throw new Error(fout.message);
        return data.id;
      },
    });
  });
  it("klant_afwijzingen: alleen voor medewerkers, dus maakt de beheerder de rij van A", async () => {
    await controleerAfscherming({
      tabel: "klant_afwijzingen",
      sleutel: "user_id",
      voorbereidB: keurGoed,
      maakRijAlsA: async (a) => {
        await zetKlant(a, false);
        const { error } = await admin.from("klant_afwijzingen").insert({ user_id: a.id });
        if (error) throw new Error(error.message);
        return a.id;
      },
    });
  });
});

describe("de prijs van de één komt nooit bij de ander", () => {
  it("een anonieme bezoeker leest alleen de catalogus, met de basisprijs en zonder klantprijs", async () => {
    const product = await maakProduct({ prijs: 1495 });
    await zetKlantprijs(alice, product, 1100);
    const { data, error } = await anoniem().rpc("openbare_producten", { p_slug: product.slug });
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    const rij = data?.[0];
    expect(rij?.basisprijs_centen).toBe(1495);
    // Alleen deze velden: geen klantprijs, geen voorraadaantal.
    expect(Object.keys(rij ?? {}).sort()).toEqual(
      [
        "afbeelding",
        "basisprijs_centen",
        "bijgewerkt_op",
        "id",
        "naam",
        "omschrijving",
        "op_voorraad",
        "slug",
      ].sort(),
    );
    expect(JSON.stringify(data)).not.toContain("1100");
  });

  it("een anonieme bezoeker komt niet bij de tabellen zelf", async () => {
    const bezoeker = anoniem();
    for (const tabel of [
      "producten",
      "klantprijzen",
      "winkelwagen_regels",
      "bestellingen",
      "bestelregels",
    ] as const) {
      const { data } = await bezoeker.from(tabel).select("id").limit(1);
      expect(data ?? [], tabel).toEqual([]);
    }
    const { data } = await bezoeker.from("wagen_overzicht").select("id").limit(1);
    expect(data ?? []).toEqual([]);
    const bestellen = await bezoeker.rpc("bestelling_plaatsen", {
      p_sleutel: crypto.randomUUID(),
      p_verwacht_totaal: 0,
    });
    expect(bestellen.error).not.toBeNull();
  });

  it("een verborgen product staat niet in de openbare catalogus", async () => {
    const product = await maakProduct({ zichtbaar: false });
    const { data } = await anoniem().rpc("openbare_producten", { p_slug: product.slug });
    expect(data).toEqual([]);
    const alles = await anoniem().rpc("openbare_producten", {});
    expect((alles.data ?? []).some((p) => p.id === product.id)).toBe(false);
  });

  it("een goedgekeurde klant ziet niet hoeveel er op voorraad is: alleen 'op voorraad' en 'genoeg voor dit aantal'", async () => {
    const product = await maakProduct({ prijs: 500, voorraad: 37 });
    const tabel = await alice.client.from("producten").select("id, voorraad").eq("id", product.id);
    expect(tabel.data ?? []).toEqual([]);
    const openbaar = await alice.client.rpc("openbare_producten", { p_slug: product.slug });
    expect(openbaar.data?.[0]?.op_voorraad).toBe(true);
    // Geen enkel veld is het aantal (een id of slug kan toevallig "37" bevatten).
    expect(Object.values(openbaar.data?.[0] ?? {})).not.toContain(37);
    expect(Object.keys(openbaar.data?.[0] ?? {})).not.toContain("voorraad");

    await inWagen(alice, product, 37);
    const wagen = await alice.client
      .from("wagen_overzicht")
      .select("*")
      .eq("product_id", product.id);
    expect(wagen.data).toHaveLength(1);
    expect(wagen.data?.[0]?.genoeg_voorraad).toBe(true);
    expect(Object.keys(wagen.data?.[0] ?? {})).not.toContain("voorraad");
    await alice.client.rpc("wagen_toevoegen", { p_product_id: product.id, p_aantal: 1 });
    const teVeel = await alice.client
      .from("wagen_overzicht")
      .select("genoeg_voorraad, aantal")
      .eq("product_id", product.id);
    expect(teVeel.data).toEqual([{ genoeg_voorraad: false, aantal: 38 }]);
    await alice.client.from("winkelwagen_regels").delete().eq("product_id", product.id);
  });

  it("de wagen (een view die de tabellen zelf leest) toont alleen de eigen regels, en een verborgen product zonder naam en prijs", async () => {
    const product = await maakProduct({ prijs: 1495 });
    await zetKlantprijs(bob, product, 1250);
    await inWagen(alice, product, 1);
    await inWagen(bob, product, 2);
    const vanAlice = await alice.client
      .from("wagen_overzicht")
      .select("aantal, stukprijs_centen")
      .eq("product_id", product.id);
    expect(vanAlice.data).toEqual([{ aantal: 1, stukprijs_centen: 1495 }]);
    const vanBob = await bob.client
      .from("wagen_overzicht")
      .select("aantal, stukprijs_centen")
      .eq("product_id", product.id);
    expect(vanBob.data).toEqual([{ aantal: 2, stukprijs_centen: 1250 }]);
    expect((await anoniem().from("wagen_overzicht").select("id")).data ?? []).toEqual([]);
    await admin.from("producten").update({ zichtbaar: false }).eq("id", product.id);
    const verborgen = await alice.client
      .from("wagen_overzicht")
      .select("te_koop, naam, stukprijs_centen, genoeg_voorraad")
      .eq("product_id", product.id);
    expect(verborgen.data).toEqual([
      { te_koop: false, naam: null, stukprijs_centen: null, genoeg_voorraad: false },
    ]);
    await alice.client.from("winkelwagen_regels").delete().eq("product_id", product.id);
    await bob.client.from("winkelwagen_regels").delete().eq("product_id", product.id);
  });

  it("klant A ziet alleen haar eigen prijs, klant B alleen de zijne", async () => {
    const product = await maakProduct({ prijs: 1495 });
    await zetKlantprijs(alice, product, 1100);
    await zetKlantprijs(bob, product, 1250);
    const vanAlice = await alice.client
      .from("klantprijzen")
      .select("prijs_centen")
      .eq("product_id", product.id);
    const vanBob = await bob.client
      .from("klantprijzen")
      .select("prijs_centen")
      .eq("product_id", product.id);
    expect(vanAlice.data).toEqual([{ prijs_centen: 1100 }]);
    expect(vanBob.data).toEqual([{ prijs_centen: 1250 }]);
  });

  it("de wagen toont de eigen prijs; B ziet de wagen van A niet", async () => {
    const product = await maakProduct({ prijs: 1495 });
    await zetKlantprijs(alice, product, 1100);
    await inWagen(alice, product, 2);
    const { data } = await alice.client
      .from("wagen_overzicht")
      .select("stukprijs_centen, aantal")
      .eq("product_id", product.id);
    expect(data).toEqual([{ stukprijs_centen: 1100, aantal: 2 }]);
    const doorBob = await bob.client
      .from("wagen_overzicht")
      .select("id")
      .eq("product_id", product.id);
    expect(doorBob.data).toEqual([]);
    await alice.client.from("winkelwagen_regels").delete().eq("product_id", product.id);
  });

  it("een klant kan geen regel in de wagen van een ander leggen, en geen verborgen product", async () => {
    const product = await maakProduct();
    const namens = await bob.client
      .from("winkelwagen_regels")
      .insert({ klant_id: alice.id, product_id: product.id, aantal: 1 });
    expect(namens.error).not.toBeNull();
    const verborgen = await maakProduct({ zichtbaar: false });
    const stiekem = await bob.client.rpc("wagen_toevoegen", { p_product_id: verborgen.id });
    expect(stiekem.error).not.toBeNull();
  });
});

describe("bestelling_plaatsen()", () => {
  it("rekent zelf de prijs uit: de klantprijs, en geen prijs uit het verzoek", async () => {
    const product = await maakProduct({ prijs: 1495, voorraad: 10 });
    await zetKlantprijs(alice, product, 1100);
    await inWagen(alice, product, 3);

    // Een prijs meesturen kan niet: de functie heeft er geen parameter voor.
    const metPrijsErbij = { p_sleutel: crypto.randomUUID(), p_verwacht_totaal: 1, p_prijs: 1 };
    const metPrijs = await alice.client.rpc("bestelling_plaatsen", metPrijsErbij);
    expect(metPrijs.error).not.toBeNull();
    // Een prijs in de wagen zetten ook niet: die kolom bestaat niet.
    const inDeWagen = await alice.client
      .from("winkelwagen_regels")
      .update({ aantal: 3, stukprijs_centen: 1 } as never)
      .eq("product_id", product.id);
    expect(inDeWagen.error).not.toBeNull();

    const id = await bestel(alice);
    const bestelling = await alice.client
      .from("bestellingen")
      .select("totaal_centen, bestelregels(aantal, stukprijs_centen)")
      .eq("id", id)
      .single();
    expect(bestelling.data).toEqual({
      totaal_centen: 3300,
      bestelregels: [{ aantal: 3, stukprijs_centen: 1100 }],
    });
    expect(await voorraad(product)).toBe(7);
  });

  it("een klant kan zijn bestelling achteraf niet goedkoper maken", async () => {
    const product = await maakProduct({ prijs: 2000 });
    await inWagen(alice, product, 1);
    const id = await bestel(alice);
    const totaal = await alice.client
      .from("bestellingen")
      .update({ totaal_centen: 1 })
      .eq("id", id)
      .select("id");
    expect(totaal.error).not.toBeNull();
    const regel = await alice.client
      .from("bestelregels")
      .update({ stukprijs_centen: 1 })
      .eq("bestelling_id", id)
      .select("id");
    expect(regel.error).not.toBeNull();
    const nieuw = await alice.client
      .from("bestellingen")
      .insert({ klant_id: alice.id, sleutel: crypto.randomUUID(), totaal_centen: 1 });
    expect(nieuw.error).not.toBeNull();
  });

  it("weigert bij te weinig voorraad en verandert dan niets", async () => {
    const product = await maakProduct({ voorraad: 2 });
    await inWagen(alice, product, 3);
    const { error } = await plaats(alice.client);
    expect(error?.code).toBe("SP002");
    expect(await voorraad(product)).toBe(2);
    const wagen = await alice.client
      .from("winkelwagen_regels")
      .select("aantal")
      .eq("product_id", product.id);
    expect(wagen.data).toEqual([{ aantal: 3 }]);
    await alice.client.from("winkelwagen_regels").delete().eq("product_id", product.id);
  });

  it("weigert een product dat intussen niet meer te koop is", async () => {
    const product = await maakProduct();
    await inWagen(alice, product, 1);
    await admin.from("producten").update({ zichtbaar: false }).eq("id", product.id);
    const { error } = await plaats(alice.client);
    expect(error?.code).toBe("SP003");
    // De regel blijft zichtbaar in de wagen, zonder naam en prijs, zodat de klant hem kan weghalen.
    const { data } = await alice.client
      .from("wagen_overzicht")
      .select("te_koop, naam, stukprijs_centen")
      .eq("product_id", product.id);
    expect(data).toEqual([{ te_koop: false, naam: null, stukprijs_centen: null }]);
    await alice.client.from("winkelwagen_regels").delete().eq("product_id", product.id);
  });

  it("is idempotent: dezelfde sleutel, ook tegelijk verstuurd, is één bestelling", async () => {
    const product = await maakProduct({ voorraad: 10 });
    await inWagen(alice, product, 2);
    const sleutel = crypto.randomUUID();
    const [een, twee] = await Promise.all([
      plaats(alice.client, sleutel),
      plaats(alice.client, sleutel),
    ]);
    expect(een.error).toBeNull();
    expect(twee.error).toBeNull();
    expect(een.data).toBe(twee.data);
    const derde = await plaats(alice.client, sleutel);
    expect(derde.data).toBe(een.data);
    const { data } = await alice.client.from("bestellingen").select("id").eq("sleutel", sleutel);
    expect(data).toHaveLength(1);
    expect(await voorraad(product)).toBe(8);
  });

  it("werkt niet voor de wagen van een ander, ook niet met diens sleutel", async () => {
    const product = await maakProduct({ voorraad: 10 });
    await inWagen(alice, product, 1);
    const sleutel = crypto.randomUUID();
    const doorBob = await plaats(bob.client, sleutel);
    // Bob heeft een lege wagen; die van Alice blijft staan.
    expect(doorBob.error?.code).toBe("SP001");
    const wagen = await alice.client
      .from("winkelwagen_regels")
      .select("aantal")
      .eq("product_id", product.id);
    expect(wagen.data).toEqual([{ aantal: 1 }]);
    // Plaatst Alice met die sleutel, dan krijgt Bob met dezelfde sleutel niet haar bestelling.
    const vanAlice = await plaats(alice.client, sleutel);
    expect(vanAlice.error).toBeNull();
    const nogmaalsBob = await plaats(bob.client, sleutel);
    expect(nogmaalsBob.data ?? null).not.toBe(vanAlice.data);
    expect(await voorraad(product)).toBe(9);
  });

  it("het laatste stuk gaat naar één klant, ook als twee tegelijk bestellen", async () => {
    const product = await maakProduct({ voorraad: 1 });
    await inWagen(alice, product, 1);
    await inWagen(bob, product, 1);
    const uitkomsten = await Promise.all([plaats(alice.client), plaats(bob.client)]);
    expect(uitkomsten.filter((u) => u.error === null)).toHaveLength(1);
    expect(uitkomsten.filter((u) => u.error?.code === "SP002")).toHaveLength(1);
    expect(await voorraad(product)).toBe(0);
    await bob.client.from("winkelwagen_regels").delete().eq("product_id", product.id);
    await alice.client.from("winkelwagen_regels").delete().eq("product_id", product.id);
  });

  it("de functies hebben precies de rechten die ze nodig hebben", () => {
    const rechten = vraagDatabase<{ functie: string; anon: boolean; ingelogd: boolean }>(`
      select p.proname as functie,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as ingelogd
        from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.proname in ('openbare_producten', 'bestelling_plaatsen', 'wagen_toevoegen',
                           'product_te_koop', 'producten_bijgewerkt')
       order by p.proname`);
    expect(rechten).toEqual([
      { functie: "bestelling_plaatsen", anon: false, ingelogd: true },
      { functie: "openbare_producten", anon: true, ingelogd: true },
      { functie: "product_te_koop", anon: false, ingelogd: true },
      { functie: "producten_bijgewerkt", anon: false, ingelogd: false },
      { functie: "wagen_toevoegen", anon: false, ingelogd: true },
    ]);
  });
});

/**
 * De aanvallen op het geld van ronde 3, omgekeerd: elke test slaagt als de aanval NIET lukt.
 */
describe("bestelling_plaatsen(): de klant betaalt wat hij zag, en leert de voorraad niet", () => {
  it("A1 omgekeerd: de melding bij te weinig voorraad noemt het product, niet het aantal dat er nog is", async () => {
    const product = await maakProduct({ voorraad: 37 });
    await inWagen(alice, product, 99);
    const { data, error } = await plaats(alice.client);
    expect(data).toBeNull();
    expect(error?.code).toBe("SP002");
    expect(error?.message).toContain("niet genoeg op voorraad");
    // De naam van een testproduct bevat cijfers; het getal 37 mag er los niet in staan.
    expect(error?.message.replace(product.slug, "")).not.toMatch(/\b37\b/);
    expect(`${error?.details ?? ""} ${error?.hint ?? ""}`).not.toMatch(/\b37\b/);
    await alice.client.from("winkelwagen_regels").delete().eq("product_id", product.id);
  });

  it("A2 omgekeerd: de prijs gaat omhoog tussen het tonen van de wagen en de klik; de functie plaatst niets en geeft het nieuwe totaal terug", async () => {
    const product = await maakProduct({ prijs: 1000, voorraad: 50 });
    await inWagen(alice, product, 10);
    const opScherm = await getoondTotaal(alice.client);
    expect(opScherm).toBe(10_000);

    await admin.from("producten").update({ basisprijs_centen: 9000 }).eq("id", product.id);
    const { data, error } = await alice.client.rpc("bestelling_plaatsen", {
      p_sleutel: crypto.randomUUID(),
      p_verwacht_totaal: opScherm,
    });
    expect(data).toBeNull();
    expect(error?.code).toBe("SP004");
    expect(error?.details).toBe("90000");
    // Niets geplaatst: geen bon, voorraad gelijk, de wagen staat er nog.
    const { count } = await admin
      .from("bestellingen")
      .select("id", { count: "exact", head: true })
      .eq("klant_id", alice.id)
      .eq("totaal_centen", 90_000);
    expect(count).toBe(0);
    expect(await voorraad(product)).toBe(50);
    const wagen = await alice.client
      .from("winkelwagen_regels")
      .select("aantal")
      .eq("product_id", product.id);
    expect(wagen.data).toEqual([{ aantal: 10 }]);

    // Met het totaal dat de klant nu ziet, gaat het gewoon door, tegen de nieuwe prijs.
    const id = await bestel(alice);
    const bon = await admin.from("bestellingen").select("totaal_centen").eq("id", id).single();
    expect(bon.data?.totaal_centen).toBe(90_000);
    expect(await voorraad(product)).toBe(40);
  });

  it("het verwachte totaal is alleen een vergelijking, nooit de prijs: een lager bedrag meesturen bestelt niets, en ontbreken mag het niet", async () => {
    const product = await maakProduct({ prijs: 2500, voorraad: 5 });
    await inWagen(alice, product, 2);
    const lager = await alice.client.rpc("bestelling_plaatsen", {
      p_sleutel: crypto.randomUUID(),
      p_verwacht_totaal: 1,
    });
    expect(lager.error?.code).toBe("SP004");
    const zonder = await alice.client.rpc("bestelling_plaatsen", {
      p_sleutel: crypto.randomUUID(),
    } as never);
    expect(zonder.error).not.toBeNull();
    expect(await voorraad(product)).toBe(5);
    await alice.client.from("winkelwagen_regels").delete().eq("product_id", product.id);
  });

  it("A4 omgekeerd: klanten die hun eigen wagen vullen en legen (veel rijen, omgekeerde volgorde) laten de bestellingen van anderen niet vastlopen (geen 40P01)", async () => {
    const producten: Product[] = [];
    for (let i = 0; i < 25; i++) producten.push(await maakProduct({ voorraad: 1_000_000 }));
    const aflopend = [...producten].sort((a, b) => (a.id < b.id ? 1 : -1));
    const eigen: Actor[] = [];
    const klant = async (label: string) => {
      const actor = await maakActor(label);
      await keurGoed(actor);
      eigen.push(actor);
      return actor;
    };
    try {
      const slachtoffers = [
        await klant("a4-carol"),
        await klant("a4-dave"),
        await klant("a4-erin"),
      ];
      const kwaad = [await klant("a4-eve"), await klant("a4-mallory"), await klant("a4-trudy")];
      let klaar = false;
      let gevuld = 0;
      const aanvallers = kwaad.map(async (wie) => {
        while (!klaar) {
          const { error } = await wie.client
            .from("winkelwagen_regels")
            .insert(aflopend.map((p) => ({ product_id: p.id, aantal: 1 })));
          if (!error) gevuld += 1;
          await wie.client.from("winkelwagen_regels").delete().eq("klant_id", wie.id);
        }
      });
      const codes: string[] = [];
      await Promise.all(
        slachtoffers.map(async (wie) => {
          for (let ronde = 0; ronde < 15; ronde++) {
            const leg = await wie.client
              .from("winkelwagen_regels")
              .insert(producten.slice(0, 8).map((p) => ({ product_id: p.id, aantal: 1 })));
            if (leg.error) codes.push(`wagen:${leg.error.code}`);
            const { error } = await plaats(wie.client);
            codes.push(error ? `bestel:${error.code}` : "bestel:ok");
            await wie.client.from("winkelwagen_regels").delete().eq("klant_id", wie.id);
          }
        }),
      );
      klaar = true;
      await Promise.all(aanvallers);
      const telling: Record<string, number> = {};
      for (const code of codes) telling[code] = (telling[code] ?? 0) + 1;
      expect(gevuld).toBeGreaterThan(0);
      expect(telling).toEqual({ "bestel:ok": 45 });
    } finally {
      for (const actor of eigen) {
        await admin.from("bestellingen").delete().eq("klant_id", actor.id);
        await verwijderActor(actor);
      }
    }
  }, 240_000);
});

/** Elke bon van deze klant, met de som van zijn regels ernaast. */
async function bonnenVan(klant: { id: string }) {
  const { data, error } = await admin
    .from("bestellingen")
    .select("id, sleutel, totaal_centen, bestelregels(product_id, aantal, stukprijs_centen)")
    .eq("klant_id", klant.id);
  if (error) throw new Error(error.message);
  return (data ?? []).map((b) => ({
    sleutel: b.sleutel,
    totaal: b.totaal_centen,
    somRegels: b.bestelregels.reduce((som, r) => som + r.aantal * r.stukprijs_centen, 0),
    regels: b.bestelregels,
  }));
}

/** Hoeveel stuks van dit product staan er in alle bonnen van deze klant? */
function besteldVan(bonnen: Awaited<ReturnType<typeof bonnenVan>>, product: Product): number {
  return bonnen
    .flatMap((b) => b.regels)
    .filter((r) => r.product_id === product.id)
    .reduce((som, r) => som + r.aantal, 0);
}

/**
 * De regel "lees de wagen één keer, onder slot" (docs/routes/webshop.md). Een klant die
 * tijdens het bestellen zijn wagen wijzigt (een tweede tabblad, of met opzet), mag geen bon
 * krijgen die afwijkt van zijn regels, en geen voorraad laten afboeken die niet op de bon staat.
 * Elke test heeft een eigen klant, zodat de sloten niet op die van een andere test wachten.
 */
describe("bestellen terwijl de wagen verandert", () => {
  async function eigenKlant(label: string): Promise<Actor> {
    const klant = await maakActor(label);
    await keurGoed(klant);
    return klant;
  }
  const klanten: Actor[] = [];
  afterAll(async () => {
    for (const klant of klanten) {
      await admin.from("bestellingen").delete().eq("klant_id", klant.id);
      await verwijderActor(klant);
    }
  });

  it("met steiger: wat tijdens het bestellen in de wagen komt, staat niet op de bon en blijft in de wagen", async () => {
    const goedkoop = await maakProduct({ prijs: 100, voorraad: 500 });
    const duur = await maakProduct({ prijs: 99_900, voorraad: 500 });
    const eva = await eigenKlant("race-steiger");
    klanten.push(eva);
    await inWagen(eva, goedkoop, 1);

    // De steiger rekt het ogenblik tussen het lezen van de wagen en het schrijven van de bon
    // op: het invoegen in `bestellingen` wacht 2,5 seconde. Zo valt het toevoegen gegarandeerd
    // midden in het bestellen.
    const steiger = houdVastInDatabase("lock table public.bestellingen in share mode", 2500);
    await pauze(700);
    const bestelling = plaats(eva.client);
    await pauze(700);
    const erbij = eva.client.rpc("wagen_toevoegen", { p_product_id: duur.id, p_aantal: 99 });
    await steiger;
    expect((await bestelling).error).toBeNull();
    expect((await erbij).error).toBeNull();

    const bonnen = await bonnenVan(eva);
    expect(bonnen).toHaveLength(1);
    expect(bonnen[0]?.totaal).toBe(100);
    expect(bonnen[0]?.somRegels).toBe(100);
    expect(await voorraad(goedkoop)).toBe(499);
    expect(await voorraad(duur)).toBe(500);
    // Het dure product is niet stil verdwenen: het ligt klaar voor de volgende bestelling.
    const wagen = await eva.client.from("winkelwagen_regels").select("product_id, aantal");
    expect(wagen.data).toEqual([{ product_id: duur.id, aantal: 99 }]);
  }, 30_000);

  it("zonder steiger: 150 keer tegelijk bestellen en de wagen wijzigen; elke bon is de som van zijn regels en de voorraad klopt", async () => {
    const goedkoop = await maakProduct({ prijs: 100, voorraad: 100_000 });
    const duur = await maakProduct({ prijs: 99_900, voorraad: 100_000 });
    const eva = await eigenKlant("race-zonder-steiger");
    klanten.push(eva);
    const fouten: string[] = [];
    const RONDES = 150;
    let geplaatst = 0;
    for (let ronde = 0; ronde < RONDES; ronde++) {
      await inWagen(eva, goedkoop, 1);
      const sleutel = crypto.randomUUID();
      // Het totaal dat de klant zag, vóór de wedloop gelezen: zo vertrekken de bestellingen
      // tegelijk met de wijzigingen, en niet een leesronde later. Anders wint de wagen bijna
      // altijd, op een trage machine elke ronde, en toetst de test het plaatsen niet meer.
      const p_verwacht_totaal = await getoondTotaal(eva.client);
      const bestel = () =>
        eva.client.rpc("bestelling_plaatsen", { p_sleutel: sleutel, p_verwacht_totaal });
      const [een, twee] = await Promise.all([
        // Twee keer dezelfde sleutel (dubbel klikken), midden in de wijzigingen.
        bestel(),
        bestel(),
        eva.client.rpc("wagen_toevoegen", { p_product_id: duur.id, p_aantal: 99 }),
        eva.client.rpc("wagen_toevoegen", { p_product_id: duur.id, p_aantal: 99 }),
        eva.client.from("winkelwagen_regels").update({ aantal: 50 }).eq("product_id", duur.id),
        eva.client.rpc("wagen_toevoegen", { p_product_id: duur.id, p_aantal: 99 }),
      ]);
      for (const uit of [een, twee]) {
        // Leeg (SP001) kan niet: het goedkope product ligt er steeds in. SP004 mag: de wagen
        // veranderde na het lezen van het totaal, en dan plaatst de functie niets. Elke andere
        // fout is er een.
        if (uit.error && uit.error.code !== "SP004") {
          fouten.push(`${uit.error.code} ${uit.error.message}`);
        }
      }
      if (een.data && twee.data && een.data !== twee.data) {
        fouten.push(`ronde ${ronde}: twee bestellingen voor één sleutel`);
      }
      if (een.data || twee.data) geplaatst += 1;
      await eva.client.from("winkelwagen_regels").delete().eq("klant_id", eva.id);
    }
    expect(fouten).toEqual([]);

    const bonnen = await bonnenVan(eva);
    expect(geplaatst).toBeGreaterThan(0);
    expect(bonnen).toHaveLength(geplaatst);
    expect(new Set(bonnen.map((b) => b.sleutel)).size).toBe(geplaatst);
    expect(bonnen.filter((b) => b.totaal !== b.somRegels)).toEqual([]);
    expect(100_000 - (await voorraad(goedkoop))).toBe(besteldVan(bonnen, goedkoop));
    expect(100_000 - (await voorraad(duur))).toBe(besteldVan(bonnen, duur));
  }, 300_000);

  it("het slot per klant: bestellen en elke schrijfweg naar de wagen wachten erop", async () => {
    const product = await maakProduct({ voorraad: 100 });
    const nogEen = await maakProduct({ voorraad: 100 });
    const eva = await eigenKlant("race-slot");
    klanten.push(eva);
    await inWagen(eva, product, 1);

    // Dezelfde sleutel als in bestelling_plaatsen() en de trigger wagen_slot_per_klant.
    const slot = `select pg_advisory_xact_lock(hashtextextended('winkelwagen:${eva.id}', 0))`;
    const vast = houdVastInDatabase(slot, 2000);
    await pauze(500);
    const begin = Date.now();
    const meet = <T>(belofte: PromiseLike<T>) =>
      Promise.resolve(belofte).then((uit) => ({ uit, ms: Date.now() - begin }));
    const [bestellen, ...schrijven] = await Promise.all([
      meet(plaats(eva.client)),
      meet(eva.client.rpc("wagen_toevoegen", { p_product_id: product.id, p_aantal: 1 })),
      meet(eva.client.from("winkelwagen_regels").update({ aantal: 3 }).eq("klant_id", eva.id)),
      meet(eva.client.from("winkelwagen_regels").delete().eq("product_id", product.id)),
      meet(
        eva.client
          .from("winkelwagen_regels")
          .insert({ klant_id: eva.id, product_id: nogEen.id, aantal: 1 }),
      ),
    ]);
    await vast;
    // Na het slot gaan ze in willekeurige volgorde; de wagen kan dan al leeg zijn.
    // SP004: de wagen veranderde tussen het lezen van het totaal en het bestellen.
    expect([undefined, "SP001", "SP004"]).toContain(bestellen?.uit.error?.code);
    for (const { uit } of schrijven) expect(uit.error).toBeNull();
    for (const { ms } of [bestellen, ...schrijven].filter((m) => m !== undefined)) {
      // Het slot zat er nog anderhalve seconde op toen deze verzoeken begonnen.
      expect(ms).toBeGreaterThan(1000);
    }
  }, 30_000);

  it("in de wagen mag een klant alleen het aantal wijzigen (grant update (aantal)): geen ander product, geen andere klant", async () => {
    const rechten = vraagDatabase<{ kolom: string; mag: boolean }>(`
      select a.attname as kolom,
             has_column_privilege('authenticated', 'public.winkelwagen_regels', a.attname, 'UPDATE') as mag
        from pg_attribute a
       where a.attrelid = 'public.winkelwagen_regels'::regclass and a.attnum > 0 and not a.attisdropped
       order by a.attname`);
    expect(rechten.filter((r) => r.mag).map((r) => r.kolom)).toEqual(["aantal"]);

    const eva = await eigenKlant("wagen-kolommen");
    klanten.push(eva);
    const product = await maakProduct({ prijs: 99_900 });
    const verborgen = await maakProduct({ prijs: 1, zichtbaar: false });
    await inWagen(eva, product, 1);
    const ander = await eva.client
      .from("winkelwagen_regels")
      .update({ product_id: verborgen.id })
      .eq("klant_id", eva.id)
      .select("id");
    expect(ander.error).not.toBeNull();
    const wagen = await eva.client.from("winkelwagen_regels").select("product_id");
    expect(wagen.data).toEqual([{ product_id: product.id }]);
  });
});

describe("de poorten van het klantportaal: een account alleen geeft niets", () => {
  let dienst: NepInlogdienst;
  /** Een nieuwe klant, echt per mail ingelogd en aangemeld, nog niet goedgekeurd. */
  let nieuw: Sessie;
  /** Een medewerker: een sessie via de inlogdienst (Cloudflare). */
  let medewerker: Sessie;
  /** Iemand met de mailbox van die medewerker: hetzelfde account, per mail ingelogd. */
  let perMail: Sessie;
  let product: Product;
  const opruimen = new Set<string>();

  beforeAll(async () => {
    dienst = await startNepInlogdienst();
    const persoon = nieuwPersoon("shop-medewerker", { adresBevestigd: true });
    medewerker = await sessieViaInlogdienst(persoon);
    for (const id of await accountsVan(persoon)) opruimen.add(id);
    noemIdentiteitCloudflare(medewerker.userId);
    perMail = await inloggenMetMailcode(persoon.email);

    nieuw = await inloggenMetMailcode(nieuwAdres("shop-nieuw"));
    opruimen.add(nieuw.userId);
    const { error } = await nieuw.client.rpc("klant_aanmelden");
    if (error) throw new Error(`De klant kon zich niet aanmelden: ${error.message}`);

    product = await maakProduct({ prijs: 1495, voorraad: 5 });
    // Een beheerder zet alvast een prijs klaar voor de nieuwe klant.
    await zetKlantprijs({ id: nieuw.userId }, product, 1100);
  }, 60_000);

  afterAll(async () => {
    for (const id of opruimen) await verwijderAccount(id);
    await dienst?.stop();
  });

  it("de opzet klopt: de medewerker is medewerker, de mailsessie op zijn adres niet", async () => {
    expect(perMail.userId).toBe(medewerker.userId);
    expect((await medewerker.client.rpc("is_medewerker")).data).toBe(true);
    expect((await perMail.client.rpc("is_medewerker")).data).toBe(false);
    expect((await nieuw.client.rpc("is_goedgekeurde_klant")).data).toBe(false);
  });

  it("een niet-goedgekeurde klant ziet geen klantprijs en geen tabel, alleen de openbare catalogus", async () => {
    const prijs = await nieuw.client.from("klantprijzen").select("prijs_centen");
    expect(prijs.data ?? []).toEqual([]);
    const producten = await nieuw.client.from("producten").select("id").eq("id", product.id);
    expect(producten.data ?? []).toEqual([]);
    for (const tabel of ["winkelwagen_regels", "bestellingen", "bestelregels"] as const) {
      const { data } = await nieuw.client.from(tabel).select("id").limit(1);
      expect(data ?? [], tabel).toEqual([]);
    }
    const wagen = await nieuw.client.from("wagen_overzicht").select("id").limit(1);
    expect(wagen.data ?? []).toEqual([]);
    // Wat iedereen ziet, ziet hij ook: de catalogus met de basisprijs.
    const openbaar = await nieuw.client.rpc("openbare_producten", { p_slug: product.slug });
    expect(openbaar.data?.[0]?.basisprijs_centen).toBe(1495);
    expect(JSON.stringify(openbaar.data)).not.toContain("1100");
  });

  it("een niet-goedgekeurde klant kan niets in de wagen leggen en niet bestellen", async () => {
    const viaFunctie = await nieuw.client.rpc("wagen_toevoegen", { p_product_id: product.id });
    expect(viaFunctie.error).not.toBeNull();
    const rechtstreeks = await nieuw.client
      .from("winkelwagen_regels")
      .insert({ klant_id: nieuw.userId, product_id: product.id, aantal: 1 });
    expect(rechtstreeks.error).not.toBeNull();
    // Ook met een regel die een beheerder in zijn wagen legt, komt er geen bestelling.
    const klaargezet = await admin
      .from("winkelwagen_regels")
      .insert({ klant_id: nieuw.userId, product_id: product.id, aantal: 1 });
    expect(klaargezet.error).toBeNull();
    const bestellen = await plaats(nieuw.client);
    expect(bestellen.error?.code).toBe("42501");
    expect(bestellen.error?.message).toContain("nog niet goedgekeurd");
    const { count } = await admin
      .from("bestellingen")
      .select("*", { count: "exact", head: true })
      .eq("klant_id", nieuw.userId);
    expect(count).toBe(0);
    expect(await voorraad(product)).toBe(5);
    await admin.from("winkelwagen_regels").delete().eq("klant_id", nieuw.userId);
    // Zichzelf goedkeuren kan niet, ook niet via de functie waarmee hij zich aanmeldde.
    await nieuw.client.from("klanten").update({ goedgekeurd: true }).eq("user_id", nieuw.userId);
    await nieuw.client.rpc("klant_aanmelden");
    expect((await nieuw.client.rpc("is_goedgekeurde_klant")).data).toBe(false);
  });

  it("een mailsessie op het adres van een medewerker keurt niemand goed en beheert niets", async () => {
    const klanten = await perMail.client.from("klanten").select("user_id");
    expect(klanten.data ?? []).toEqual([]);
    const goedkeuren = await perMail.client
      .from("klanten")
      .update({ goedgekeurd: true })
      .eq("user_id", nieuw.userId)
      .select("user_id");
    expect(goedkeuren.data ?? []).toEqual([]);
    expect((await nieuw.client.rpc("is_goedgekeurde_klant")).data).toBe(false);

    const prijs = await perMail.client
      .from("producten")
      .update({ basisprijs_centen: 1 })
      .eq("id", product.id)
      .select("id");
    expect(prijs.data ?? []).toEqual([]);
    const klantprijs = await perMail.client
      .from("klantprijzen")
      .insert({ klant_id: nieuw.userId, product_id: (await maakProduct()).id, prijs_centen: 1 });
    expect(klantprijs.error).not.toBeNull();
    const alles = await perMail.client.from("bestellingen").select("id").limit(1);
    expect(alles.data ?? []).toEqual([]);
    const { data } = await admin
      .from("producten")
      .select("basisprijs_centen")
      .eq("id", product.id)
      .single();
    expect(data?.basisprijs_centen).toBe(1495);
  });

  it("de medewerker keurt de klant goed; daarna ziet de klant zijn prijs en bestelt hij ertegen", async () => {
    const lijst = await medewerker.client
      .from("klanten")
      .select("user_id, goedgekeurd")
      .eq("user_id", nieuw.userId);
    expect(lijst.data).toEqual([{ user_id: nieuw.userId, goedgekeurd: false }]);
    const goedkeuren = await medewerker.client
      .from("klanten")
      .update({ goedgekeurd: true })
      .eq("user_id", nieuw.userId)
      .select("user_id");
    expect(goedkeuren.error).toBeNull();
    expect(goedkeuren.data).toHaveLength(1);

    expect((await nieuw.client.rpc("is_goedgekeurde_klant")).data).toBe(true);
    const prijs = await nieuw.client
      .from("klantprijzen")
      .select("prijs_centen")
      .eq("product_id", product.id);
    expect(prijs.data).toEqual([{ prijs_centen: 1100 }]);
    const inDeWagen = await nieuw.client.rpc("wagen_toevoegen", {
      p_product_id: product.id,
      p_aantal: 2,
    });
    expect(inDeWagen.error).toBeNull();
    const bestelling = await plaats(nieuw.client);
    expect(bestelling.error).toBeNull();
    const { data } = await admin
      .from("bestellingen")
      .select("totaal_centen")
      .eq("id", bestelling.data ?? "")
      .single();
    expect(data?.totaal_centen).toBe(2200);
    expect(await voorraad(product)).toBe(3);
  });

  it("de medewerker beheert producten en prijzen en ziet alle bestellingen; een goedgekeurde klant niet", async () => {
    const nieuwePrijs = await medewerker.client
      .from("producten")
      .update({ basisprijs_centen: 1595 })
      .eq("id", product.id)
      .select("basisprijs_centen");
    expect(nieuwePrijs.data).toEqual([{ basisprijs_centen: 1595 }]);
    const verborgen = await maakProduct({ zichtbaar: false });
    const zietVerborgen = await medewerker.client
      .from("producten")
      .select("id")
      .eq("id", verborgen.id);
    expect(zietVerborgen.data).toHaveLength(1);
    const klantprijs = await medewerker.client
      .from("klantprijzen")
      .update({ prijs_centen: 1050 })
      .eq("klant_id", nieuw.userId)
      .eq("product_id", product.id)
      .select("prijs_centen");
    expect(klantprijs.data).toEqual([{ prijs_centen: 1050 }]);
    const bestellingen = await medewerker.client
      .from("bestellingen")
      .select("id, bestelregels(id)")
      .eq("klant_id", nieuw.userId);
    expect(bestellingen.data).toHaveLength(1);
    expect(bestellingen.data?.[0]?.bestelregels).toHaveLength(1);

    // Dezelfde dingen als goedgekeurde klant: niets.
    const doorKlant = await nieuw.client
      .from("producten")
      .update({ basisprijs_centen: 1 })
      .eq("id", product.id)
      .select("id");
    expect(doorKlant.data ?? []).toEqual([]);
    const eigenPrijs = await nieuw.client
      .from("klantprijzen")
      .update({ prijs_centen: 1 })
      .eq("klant_id", nieuw.userId)
      .select("id");
    expect(eigenPrijs.data ?? []).toEqual([]);
    const vanAnderen = await nieuw.client.from("bestellingen").select("klant_id");
    expect((vanAnderen.data ?? []).every((b) => b.klant_id === nieuw.userId)).toBe(true);
    const klanten = await nieuw.client.from("klanten").select("user_id");
    expect(klanten.data ?? []).toEqual([]);
  });

  it("een medewerker is zelf geen klant: hij bestelt niet", async () => {
    const wagen = await medewerker.client.rpc("wagen_toevoegen", { p_product_id: product.id });
    expect(wagen.error).not.toBeNull();
    const bestellen = await plaats(medewerker.client);
    expect(bestellen.error?.code).toBe("42501");
  });

  it("afwijzen doet alleen een medewerker; een afgewezen klant komt bij opnieuw aanmelden niet terug op de wachtlijst", async () => {
    const stand = async () => {
      const { data } = await admin
        .from("klanten_overzicht")
        .select("afgewezen, goedgekeurd")
        .eq("user_id", nieuw.userId)
        .single();
      return data;
    };
    // Zelf goedkeuren of een ander afwijzen lukt niet: alleen een medewerker beoordeelt.
    const zelf = await nieuw.client.rpc("klant_beoordelen", {
      p_klant: nieuw.userId,
      p_doe: "goedkeuren",
    });
    expect(zelf.error?.code).toBe("42501");
    const doorPerMail = await perMail.client.rpc("klant_beoordelen", {
      p_klant: nieuw.userId,
      p_doe: "afwijzen",
    });
    expect(doorPerMail.error?.code).toBe("42501");
    const rechtstreeks = await perMail.client
      .from("klant_afwijzingen")
      .insert({ user_id: nieuw.userId })
      .select("user_id");
    expect(rechtstreeks.data ?? []).toEqual([]);
    expect(await stand()).toEqual({ afgewezen: false, goedgekeurd: true });

    const afwijzen = await medewerker.client.rpc("klant_beoordelen", {
      p_klant: nieuw.userId,
      p_doe: "afwijzen",
    });
    expect(afwijzen.error).toBeNull();
    expect(await stand()).toEqual({ afgewezen: true, goedgekeurd: false });
    expect((await nieuw.client.rpc("is_goedgekeurde_klant")).data).toBe(false);
    // De klant ziet zijn eigen afwijzing niet, en zijn regel in het overzicht zegt niets.
    const eigen = await nieuw.client.from("klant_afwijzingen").select("user_id");
    expect(eigen.data ?? []).toEqual([]);
    // Opnieuw aanmelden zet hem niet terug op de wachtlijst.
    await nieuw.client.rpc("klant_aanmelden");
    expect(await stand()).toEqual({ afgewezen: true, goedgekeurd: false });
    // Goedgekeurd gaat voor: nooit allebei tegelijk in het overzicht.
    const { error: fout } = await admin
      .from("klanten")
      .update({ goedgekeurd: true })
      .eq("user_id", nieuw.userId);
    expect(fout).toBeNull();
    expect(await stand()).toEqual({ afgewezen: false, goedgekeurd: true });

    // Terug naar goedgekeurd zonder afwijzing, voor de volgende test.
    const terug = await medewerker.client.rpc("klant_beoordelen", {
      p_klant: nieuw.userId,
      p_doe: "goedkeuren",
    });
    expect(terug.error).toBeNull();
    const over = await admin
      .from("klant_afwijzingen")
      .select("user_id")
      .eq("user_id", nieuw.userId);
    expect(over.data ?? []).toEqual([]);
  });

  it("trekt een beheerder de goedkeuring in, dan is de klant meteen weer alles kwijt", async () => {
    await zetKlant({ id: nieuw.userId, email: "ingetrokken@voorbeeld.nl" }, false);
    const prijs = await nieuw.client.from("klantprijzen").select("prijs_centen");
    expect(prijs.data ?? []).toEqual([]);
    const bestellingen = await nieuw.client.from("bestellingen").select("id");
    expect(bestellingen.data ?? []).toEqual([]);
    const wagen = await nieuw.client.rpc("wagen_toevoegen", { p_product_id: product.id });
    expect(wagen.error).not.toBeNull();
  });
});
