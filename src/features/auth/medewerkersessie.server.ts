import type { RouterContextProvider } from "react-router";
import { type Medewerkersessie, standVan } from "@/features/auth/medewerkersessie";
import { supabaseVoorVerzoek } from "@/lib/server/sessie.server";
import type { Gebruiker } from "@/lib/server/verzoek.server";

/**
 * Heeft deze sessie nu medewerkerrechten? Het antwoord komt van de database
 * (`is_medewerker()`), nooit van de server zelf: de server kijkt niet naar een e-mailadres,
 * een rol of een veld in het token om dat te besluiten. Het token dient alleen om bij een
 * "nee" de juiste uitleg te kiezen (verlopen, of nooit medewerker geweest).
 *
 * Alleen lezen: gebruik dit in een loader met `// alleen lezen: ...` erbij.
 */
export async function medewerkersessie(
  context: Readonly<RouterContextProvider>,
  wie: Gebruiker | null,
): Promise<Exclude<Medewerkersessie, "laden">> {
  if (!wie) return "geen";
  const { data, error } = await supabaseVoorVerzoek(context).rpc("is_medewerker");
  // Bij een storing: geen rechten tonen. De database beslist toch zelf.
  const stand = standVan(wie.claims, error ? false : data === true);
  return stand === "laden" ? "geen" : stand;
}

/**
 * Wat een ingelogde bezoeker in de winkel is: een goedgekeurde klant, een medewerker, of
 * iemand die nog op goedkeuring wacht. Ook dit zegt de database. Alleen lezen.
 */
export type Klantstand = "goedgekeurd" | "medewerker" | "wacht";

export async function klantstand(
  context: Readonly<RouterContextProvider>,
  wie: Gebruiker,
): Promise<Klantstand> {
  const supabase = supabaseVoorVerzoek(context);
  const goedgekeurd = await supabase.rpc("is_goedgekeurde_klant");
  if (goedgekeurd.data === true) return "goedgekeurd";
  return (await medewerkersessie(context, wie)) === "medewerker" ? "medewerker" : "wacht";
}
