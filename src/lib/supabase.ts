import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/database.types";
import { env, heeftDatabase } from "@/lib/env";
import { cookieOverHttps, sessieCookieOpties } from "@/lib/server/sessie-cookie";

/**
 * De Supabase-client van de schermen in de browser. Importeer deze; maak nergens anders een
 * tweede client aan, anders raakt de ingelogde sessie versnipperd.
 *
 * Alleen voor de browser. Op de server deelt een Worker zijn modules tussen alle bezoekers,
 * dus één client hier zou van iedereen tegelijk zijn. Een loader of action gebruikt
 * `supabaseVoorVerzoek(context)` uit @/lib/server/sessie.server: één client per verzoek.
 *
 * De template zelf gebruikt deze client niet meer: inloggen en de winkel lopen via de server.
 * Hij staat er voor een scherm dat in de browser rechtstreeks met Supabase praat (live
 * bijwerken, een bestand uploaden). Laad hem dan alleen in de browser en alleen met een
 * database (`heeftDatabase` in env.ts), bijvoorbeeld met `lazy(() => import(...))` in een
 * `useEffect`. Wordt hij toch op de server of zonder database geladen, dan is dat een
 * programmeerfout en zeggen we dat meteen.
 */
if (typeof document === "undefined") {
  throw new Error(
    "@/lib/supabase is de client van de browser en mag niet op de server geladen worden. Gebruik in een loader of action `supabaseVoorVerzoek(context)` uit @/lib/server/sessie.server.",
  );
}
if (!heeftDatabase) {
  throw new Error(
    "Deze app heeft geen database (VITE_SUPABASE_URL en VITE_SUPABASE_ANON_KEY ontbreken). Importeer @/lib/supabase alleen in schermen die achter `heeftDatabase` staan.",
  );
}

/**
 * Het schema waar deze app mee praat: `public` bij een eigen database, `api` bij een
 * gedeelde. Welk van de twee het is, staat in stack.config.json en komt via
 * `VITE_SUPABASE_SCHEMA` binnen; `database.types.ts` is voor precies dát ene schema
 * gegenereerd. Die koppeling kan TypeScript niet zelf zien, vandaar deze ene bewuste
 * vernauwing, en geen enkele andere in dit bestand.
 *
 * `SchemaName` leidt hetzelfde af als supabase-js zelf doet: heeft de gegenereerde
 * `Database` een `public`, dan is dat het schema; anders is het het enige andere
 * schema dat erin zit, en dat is bij een gedeelde app per definitie `api`.
 */
type SchemaName = "public" extends keyof Database
  ? "public"
  : Exclude<keyof Database, "__InternalSupabase"> & string;

const SCHEMA = env.VITE_SUPABASE_SCHEMA as SchemaName;

export const supabase = createBrowserClient<Database>(
  env.VITE_SUPABASE_URL as string,
  env.VITE_SUPABASE_ANON_KEY as string,
  {
    db: { schema: SCHEMA },
    // PKCE: na inloggen bij een externe dienst komt er een eenmalige code terug in het
    // adres, geen token. Een token in een adres kan in logboeken of verkeerde handen
    // belanden; de code is zonder de geheime helft in deze browser waardeloos.
    auth: { flowType: "pkce" },
    // De sessie staat in een cookie, niet in de opslag van de browser: zo ziet de server bij
    // elk verzoek wie er is ingelogd. Dezelfde instellingen en dezelfde naam als op de server
    // (over https met `__Host-`, zie sessie-cookie.ts).
    cookieOptions: sessieCookieOpties(
      cookieOverHttps(window.location),
      env.VITE_SUPABASE_URL as string,
    ),
  },
);
