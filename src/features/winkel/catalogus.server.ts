import type { RouterContextProvider } from "react-router";
import { heeftServerDatabase, supabaseVoorVerzoek } from "@/lib/server/sessie.server";
import type { Gebruiker } from "@/lib/server/verzoek.server";

/**
 * De catalogus lezen, op de server. Twee wegen, bewust gescheiden:
 *
 *   - `openbareProducten`: voor iedereen, ook zonder inlog, via de databasefunctie
 *     openbare_producten(). Alleen zichtbare producten, met de basisprijs. Alles wat op een
 *     openbare pagina, in JSON-LD of in de sitemap komt, komt hier vandaan.
 *   - `klantprijzen`: alleen voor een ingelogde klant, uit de tabel klantprijzen. De regels in
 *     de database geven elke klant alleen zijn eigen prijzen.
 *
 * Een pagina die een klantprijs toont, is nooit openbaar te cachen: zodra er een ingelogde
 * gebruiker is, maakt de Worker het antwoord `private, no-store` (zie docs/routes/webshop.md).
 */
type Context = Readonly<RouterContextProvider>;

export type OpenbaarProduct = {
  id: string;
  slug: string;
  naam: string;
  omschrijving: string;
  afbeelding: string | null;
  basisprijs_centen: number;
  op_voorraad: boolean;
  bijgewerkt_op: string;
};

export async function openbareProducten(context: Context): Promise<OpenbaarProduct[]> {
  if (!heeftServerDatabase(context)) return [];
  const { data, error } = await supabaseVoorVerzoek(context).rpc("openbare_producten", {});
  if (error) throw new Response("De producten konden niet geladen worden.", { status: 503 });
  return data ?? [];
}

export async function openbaarProduct(
  context: Context,
  slug: string,
): Promise<OpenbaarProduct | null> {
  if (!heeftServerDatabase(context)) return null;
  const { data, error } = await supabaseVoorVerzoek(context).rpc("openbare_producten", {
    p_slug: slug,
  });
  if (error) throw new Response("Het product kon niet geladen worden.", { status: 503 });
  return data?.[0] ?? null;
}

/** De eigen prijzen van de ingelogde klant: product-id naar prijs in centen. */
export async function klantprijzen(
  context: Context,
  wie: Gebruiker | null,
  productIds?: string[],
): Promise<Map<string, number>> {
  if (!wie) return new Map();
  let vraag = supabaseVoorVerzoek(context).from("klantprijzen").select("product_id, prijs_centen");
  if (productIds) vraag = vraag.in("product_id", productIds);
  const { data, error } = await vraag;
  if (error) throw new Response("Je prijzen konden niet geladen worden.", { status: 503 });
  return new Map((data ?? []).map((r) => [r.product_id, r.prijs_centen]));
}
