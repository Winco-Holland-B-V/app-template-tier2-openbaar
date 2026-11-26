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
//
// Met `"inloglink": true` in de body (de stand `vooraf` van een klantportaal, zie
// src/features/auth/inlogdienst.ts) kijkt de functie eerst of het adres al een account heeft:
//   - geen account: de stappen hierboven; de mail `invite` is in die stand een inlogmail;
//   - een klantaccount (alleen de identiteit `email`, eventueel ook `google`): Supabase Auth stuurt
//     met de service role een inlogmail (`POST /auth/v1/otp` met `create_user: false`, de mail
//     `magic_link`). Er komt niets op de lijst en er verandert niets aan het account;
//   - een account met een andere identiteit (een medewerker via Cloudflare): geweigerd.
// De functie geeft nooit een link of code terug: die staan alleen in de mail aan de klant.
// Zonder `inloglink` doet de functie precies wat ze in de stand `account` doet.

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

export type Verzoek = { e_mail: string; naam: string | null; inloglink: boolean };

const ADRES = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Leest de invoer van de app: een adres, eventueel een naam en `inloglink: true`. Of een fout. */
export function leesVerzoek(body: unknown): Verzoek | string {
  if (body === null || typeof body !== "object") return "Geen geldige invoer.";
  const ruw = body as Record<string, unknown>;
  const e_mail = typeof ruw.e_mail === "string" ? ruw.e_mail.trim().toLowerCase() : "";
  if (e_mail.length > 320 || !ADRES.test(e_mail)) return "Vul een geldig e-mailadres in.";
  let naam: string | null = null;
  if (typeof ruw.naam === "string" && ruw.naam.trim() !== "") naam = ruw.naam.trim().slice(0, 200);
  return { e_mail, naam, inloglink: ruw.inloglink === true };
}

/** De identiteiten van een klantaccount: inloggen per mail (code, link, wachtwoord) en Google. */
const KLANTIDENTITEITEN = new Set(["email", "google"]);

type Account = {
  email?: string;
  identities?: { provider?: string }[] | null;
  app_metadata?: { provider?: string; providers?: string[] };
};

/** Alle inlogdiensten van een account, uit zijn identiteiten en uit app_metadata. */
export function identiteitenVan(account: Account): string[] {
  const namen = new Set<string>();
  for (const identiteit of account.identities ?? []) {
    if (typeof identiteit.provider === "string") namen.add(identiteit.provider);
  }
  for (const naam of account.app_metadata?.providers ?? []) {
    if (typeof naam === "string") namen.add(naam);
  }
  if (typeof account.app_metadata?.provider === "string") namen.add(account.app_metadata.provider);
  return [...namen];
}

/** Een klantaccount: minstens één identiteit, en alleen `email` en `google`. */
export function isKlantaccount(account: Account): boolean {
  const namen = identiteitenVan(account);
  return namen.length > 0 && namen.every((naam) => KLANTIDENTITEITEN.has(naam));
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

  // De stand vooraf: heeft het adres al een account, dan een inlogmail in plaats van een uitnodiging.
  if (verzoek.inloglink) {
    const bestaand = await zoekAccount(verzoek.e_mail, o, alsDienst);
    if (bestaand === "fout")
      return fout(502, "Opzoeken of dit adres een account heeft lukte niet.");
    if (bestaand) {
      if (!isKlantaccount(bestaand)) {
        return fout(
          409,
          "Dit e-mailadres hoort bij een account dat op een andere manier inlogt, bijvoorbeeld een medewerker. Daar gaat geen inloglink heen.",
          "andere_inlog",
        );
      }
      const otp = await o.fetch(`${o.url}/auth/v1/otp`, {
        method: "POST",
        headers: alsDienst,
        body: JSON.stringify({ email: verzoek.e_mail, create_user: false }),
      });
      if (!otp.ok) {
        const tekst = await otp.text();
        if (otp.status === 429 || /over_email_send_rate_limit|rate limit/i.test(tekst)) {
          return fout(
            429,
            "Er is net al een inlogmail naar dit adres gestuurd. Probeer het over een minuut opnieuw.",
            "te_vaak",
          );
        }
        return fout(
          502,
          `De inlogmail versturen lukte niet (${otp.status}: ${tekst.slice(0, 300)}).`,
        );
      }
      // Alleen dat het gelukt is: de link en de code staan in de mail, nergens anders.
      return { status: 200, body: { ok: true, e_mail: verzoek.e_mail, soort: "inloglink" } };
    }
  }

  // 2. Op de lijst, met het token van de medewerker: RLS beslist.
  const sleutel = o.nieuweSleutel();
  const lijst = await o.fetch(`${o.url}/rest/v1/klant_uitnodigingen?select=id`, {
    method: "POST",
    headers: { ...alsAanroeper, Prefer: "return=representation" },
    body: JSON.stringify({ e_mail: verzoek.e_mail, naam: verzoek.naam, sleutel }),
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
  return {
    status: 200,
    body: verzoek.inloglink
      ? { ok: true, e_mail: verzoek.e_mail, soort: "uitnodiging" }
      : { ok: true, e_mail: verzoek.e_mail },
  };
}

/**
 * Het account op dit adres, als het er een is (Supabase Auth, met de service role). `filter`
 * zoekt op een deel van het adres; daarom vergelijkt de functie daarna het hele adres.
 */
async function zoekAccount(
  e_mail: string,
  o: Omgeving,
  alsDienst: Record<string, string>,
): Promise<Account | null | "fout"> {
  const antwoord = await o.fetch(
    `${o.url}/auth/v1/admin/users?filter=${encodeURIComponent(e_mail)}&page=1&per_page=50`,
    { method: "GET", headers: alsDienst },
  );
  if (!antwoord.ok) return "fout";
  const lijst = (await antwoord.json()) as { users?: Account[] } | null;
  return lijst?.users?.find((account) => account.email?.toLowerCase() === e_mail) ?? null;
}
