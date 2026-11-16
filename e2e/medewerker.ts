import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { codeVoor, type Persoon } from "../tests/rls/lib/inlogdienst-nep";

/**
 * Inloggen als medewerker in een browsertest. In productie is de inlogdienst Cloudflare
 * Access; lokaal en in CI is er een nagebootste dienst (tests/rls/lib/inlogdienst-nep.ts) die
 * de lokale Supabase echt aanroept. De app zelf weet daar niets van: zij vraagt Supabase om
 * `custom:cloudflare`, precies zoals in productie, en begint de inlog op de server (PKCE).
 *
 * Twee dingen kan de lokale Supabase niet, en die doet deze hulp buiten de app om:
 *
 *   1. Een eigen inlogdienst zonder https kent zij alleen in het vak `keycloak`
 *      (supabase/config.toml). De hulp stuurt de vraag van de browser aan Supabase daarom door
 *      onder die naam, en speelt het inlogscherm van de dienst: "deze persoon is ingelogd".
 *      Daarna doet Supabase alles zelf: de code bij de dienst omwisselen, het account koppelen,
 *      de sessie beginnen en de browser terugsturen naar `/login/terug` van de app, waar de
 *      server de code omwisselt met de geheime helft uit het cookie.
 *   2. `is_medewerker()` vraagt om een koppeling die `custom:cloudflare` heet.
 *      `noemIdentiteitCloudflare` zet, als beheerder van de database, alleen die naam om op de
 *      koppeling die Supabase zelf maakte (zie tests/rls/lib/sessies.ts voor wat dat wel en
 *      niet bewijst).
 */
export async function speelInlogdienst(page: Page, persoon: Persoon): Promise<void> {
  await page.route("**/auth/v1/authorize?**", async (route) => {
    const gevraagd = new URL(route.request().url());
    // De app vraagt om Cloudflare, zoals in productie.
    if (gevraagd.searchParams.get("provider") !== "custom:cloudflare") return route.continue();
    gevraagd.searchParams.set("provider", "keycloak");
    const naarDienst = await route.fetch({ url: gevraagd.toString(), maxRedirects: 0 });
    const scherm = new URL(naarDienst.headers().location ?? "");
    const terug = new URL(scherm.searchParams.get("redirect_uri") ?? "");
    // Supabase draait in Docker en noemt zichzelf soms anders dan de browser hem kent.
    const supabase = new URL(process.env.SUPABASE_URL ?? gevraagd.origin);
    terug.protocol = supabase.protocol;
    terug.host = supabase.host;
    terug.searchParams.set("code", codeVoor(persoon));
    terug.searchParams.set("state", scherm.searchParams.get("state") ?? "");
    await route.fulfill({ status: 302, headers: { location: terug.toString() } });
  });
}

function alsBeheerder(sql: string): string {
  const adres = process.env.SUPABASE_DB_URL ?? "";
  if (!/@(?:127\.0\.0\.1|localhost):/.test(adres)) {
    throw new Error("SUPABASE_DB_URL wijst niet naar de lokale database (pnpm env:local).");
  }
  const beheerder = new URL(adres);
  beheerder.username = "supabase_admin";
  const opties = ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql];
  const fouten: string[] = [];
  for (const als of [beheerder.toString(), adres]) {
    try {
      return execFileSync("psql", [als, ...opties], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (fout) {
      fouten.push(String((fout as { stderr?: unknown }).stderr ?? "").trim());
    }
  }
  throw new Error(`De lokale database weigerde de opdracht van de test: ${fouten.join(" | ")}`);
}

const ADRES = /^[a-z0-9._+-]+@voorbeeld\.nl$/;

/** Zet op het account met dit adres de naam van de nagebootste dienst om naar Cloudflare. */
export function noemIdentiteitCloudflare(email: string): void {
  if (!ADRES.test(email)) throw new Error("Ongeldige testgegevens.");
  const aantal = alsBeheerder(
    `with gewijzigd as (
       update auth.identities i set provider = 'custom:cloudflare'
         from auth.users u
        where u.id = i.user_id and u.email = '${email}' and i.provider = 'keycloak'
       returning 1
     )
     select count(*) from gewijzigd`,
  );
  if (aantal !== "1") {
    throw new Error(
      `Verwachtte één koppeling met de inlogdienst voor ${email}, vond er ${aantal}.`,
    );
  }
}

/** Doet alsof de sessies van dit account zoveel uur geleden zijn begonnen (voor de twaalf uur). */
export function zetSessiesTerug(email: string, uren: number): void {
  if (!ADRES.test(email) || !Number.isFinite(uren)) throw new Error("Ongeldige testgegevens.");
  alsBeheerder(
    `update auth.sessions s set created_at = now() - interval '${Math.round(uren * 60)} minutes'
       from auth.users u where u.id = s.user_id and u.email = '${email}'`,
  );
}
