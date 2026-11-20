// Klant uitnodigen: de kern, zonder Deno-afhankelijkheden (getest met vitest in
// tests/unit/klant-uitnodigen.test.ts). index.ts geeft de omgeving en fetch mee.
//
// De stappen, elk met de minste rechten die ervoor nodig zijn:
//   1. is de aanroeper een medewerker? Met zijn eigen token: rpc is_medewerker;
//   2. het adres op klant_uitnodigingen, met zijn eigen token (RLS: alleen is_medewerker), met een
//      nieuwe geheime sleutel;
//   3. het account met een uitnodigingsmail (Supabase Auth, met de service role). De sleutel gaat
//      mee in de gegevens van het account; de hook nieuw_account_toestaan controleert hem;
//   4. klant_uitnodiging_afronden (service role): goedgekeurd op klanten.

/**
 * De regel van richtMail (_shared/mail.ts) voor één mail: geeft de ontvangers zoals ze echt weg
 * mogen, of null. index.ts geeft `richtMail` mee; zo heeft deze kern geen imports.
 */
export type Richt = (mail: {
  aan: string;
  onderwerp: string;
}) => { aan: string | readonly string[] } | null;

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

export type Verzoek = { e_mail: string; naam: string | null };

const ADRES = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Leest de invoer van de app: een adres, en eventueel een naam. Of een fout. */
export function leesVerzoek(body: unknown): Verzoek | string {
  if (body === null || typeof body !== "object") return "Geen geldige invoer.";
  const ruw = body as Record<string, unknown>;
  const e_mail = typeof ruw.e_mail === "string" ? ruw.e_mail.trim().toLowerCase() : "";
  if (e_mail.length > 320 || !ADRES.test(e_mail)) return "Vul een geldig e-mailadres in.";
  let naam: string | null = null;
  if (typeof ruw.naam === "string" && ruw.naam.trim() !== "") naam = ruw.naam.trim().slice(0, 200);
  return { e_mail, naam };
}

/**
 * Buiten productie (de testdatabase is een kopie van echte gegevens) gaat een uitnodiging
 * alleen naar het testadres: dezelfde regel als richtMail in _shared/mail.ts. Supabase verstuurt
 * de mail zelf, dus de functie weigert vooraf.
 */
export function magUitnodigen(e_mail: string, richt: Richt): boolean {
  const gericht = richt({ aan: e_mail, onderwerp: "uitnodiging" });
  if (gericht === null) return false;
  const aan = Array.isArray(gericht.aan) ? gericht.aan : [gericht.aan];
  return aan.length === 1 && String(aan[0]).toLowerCase() === e_mail;
}

export type Omgeving = {
  url: string;
  anonSleutel: string;
  serviceSleutel: string;
  richt: Richt;
  nieuweSleutel: () => string;
  fetch: typeof fetch;
};

export type Uitkomst = { status: number; body: Record<string, unknown> };

const fout = (status: number, tekst: string, code?: string): Uitkomst => ({
  status,
  body: code ? { fout: tekst, code } : { fout: tekst },
});

/** De hele uitnodiging. `authorization` is de kop van de aanroeper ("Bearer <token>"). */
export async function uitnodigen(
  authorization: string | null,
  body: unknown,
  o: Omgeving,
): Promise<Uitkomst> {
  if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) {
    return fout(401, "Niet ingelogd.");
  }
  if (!o.url || !o.anonSleutel || !o.serviceSleutel) {
    return fout(500, "De functie mist SUPABASE_URL of een sleutel.");
  }
  const alsAanroeper = {
    apikey: o.anonSleutel,
    Authorization: authorization,
    "content-type": "application/json",
  };
  const alsDienst = {
    apikey: o.serviceSleutel,
    Authorization: `Bearer ${o.serviceSleutel}`,
    "content-type": "application/json",
  };

  // 1. Alleen een medewerker (een sessie via Cloudflare).
  const rol = await o.fetch(`${o.url}/rest/v1/rpc/is_medewerker`, {
    method: "POST",
    headers: alsAanroeper,
    body: "{}",
  });
  if (!rol.ok || (await rol.json()) !== true) {
    return fout(403, "Alleen een medewerker nodigt een klant uit.");
  }

  const verzoek = leesVerzoek(body);
  if (typeof verzoek === "string") return fout(400, verzoek);
  if (!magUitnodigen(verzoek.e_mail, o.richt)) {
    return fout(
      400,
      "In de testomgeving gaat een uitnodiging alleen naar het testadres (testmail in stack.config.json).",
      "alleen_testadres",
    );
  }

  // 2. Op de lijst, met het token van de medewerker: RLS beslist.
  const sleutel = o.nieuweSleutel();
  const lijst = await o.fetch(`${o.url}/rest/v1/klant_uitnodigingen?select=id`, {
    method: "POST",
    headers: { ...alsAanroeper, Prefer: "return=representation" },
    body: JSON.stringify({ ...verzoek, sleutel }),
  });
  if (!lijst.ok) return fout(502, `Op de lijst zetten lukte niet (${lijst.status}).`);
  const rij = ((await lijst.json()) as { id?: string }[])[0];
  const opruimen = async () => {
    if (!rij?.id) return;
    await o.fetch(`${o.url}/rest/v1/klant_uitnodigingen?id=eq.${rij.id}`, {
      method: "DELETE",
      headers: alsAanroeper,
    });
  };

  // 3. Het account met de uitnodigingsmail (de link gaat naar /wachtwoord-instellen, zie
  //    supabase/templates/uitnodiging.html).
  const uitnodiging = await o.fetch(`${o.url}/auth/v1/invite`, {
    method: "POST",
    headers: alsDienst,
    body: JSON.stringify({ email: verzoek.e_mail, data: { uitnodiging: sleutel } }),
  });
  if (!uitnodiging.ok) {
    await opruimen();
    const tekst = await uitnodiging.text();
    if (uitnodiging.status === 422 || /already been registered|email_exists/i.test(tekst)) {
      return fout(409, "Dit e-mailadres heeft al een account.", "bestaat_al");
    }
    // De tekst van Supabase Auth (zonder geheimen) helpt de beheerder bij een storing.
    return fout(
      502,
      `De uitnodiging versturen lukte niet (${uitnodiging.status}: ${tekst.slice(0, 300)}).`,
    );
  }

  // 4. Goedgekeurd als klant.
  const afronden = await o.fetch(`${o.url}/rest/v1/rpc/klant_uitnodiging_afronden`, {
    method: "POST",
    headers: alsDienst,
    body: JSON.stringify({ p_sleutel: sleutel }),
  });
  if (!afronden.ok) {
    return fout(502, `Het account koppelen lukte niet (${afronden.status}).`);
  }
  return { status: 200, body: { ok: true, e_mail: verzoek.e_mail } };
}
