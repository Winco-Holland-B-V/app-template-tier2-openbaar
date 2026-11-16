import { data, Link, useFetcher } from "react-router";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { klantstand } from "@/features/auth/medewerkersessie.server";
import { WachtOpGoedkeuring } from "@/features/auth/wacht-op-goedkeuring";
import { klantprijzen, openbaarProduct } from "@/features/winkel/catalogus.server";
import { euro } from "@/features/winkel/geld";
import { ProductAfbeelding } from "@/features/winkel/product-afbeelding";
import {
  gebruiker,
  openbaarCache,
  supabaseVoorVerzoek,
  vereisGebruiker,
} from "@/lib/server/sessie.server";
import { vindbaarAdres } from "@/lib/vindbaar/adres.server";
import { kruimelpadLd, productLd } from "@/lib/vindbaar/json-ld";
import { paginaMeta } from "@/lib/vindbaar/meta";
import { SITE } from "@/site";
import type { Route } from "./+types/product";

/**
 * Eén product. Openbaar en vindbaar: titel, omschrijving, gedeelde-linkvoorbeeld en JSON-LD
 * met de openbare prijs. Een goedgekeurde klant ziet daarnaast zijn eigen prijs en kan het in
 * zijn wagen leggen; dat werkt ook zonder JavaScript (een gewoon formulier). Wie is ingelogd
 * maar nog niet is goedgekeurd, ziet dat zijn account op goedkeuring wacht.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  openbaarCache(context, { seconden: 300 });
  const [product, wie] = await Promise.all([
    openbaarProduct(context, params.slug),
    gebruiker(context),
  ]);
  if (!product) throw data("Dit product bestaat niet (meer).", { status: 404 });
  // alleen lezen: de database zegt of dit account is goedgekeurd.
  const stand = wie ? await klantstand(context, wie) : null;
  const prijzen = await klantprijzen(context, stand === "goedgekeurd" ? wie : null, [product.id]);
  const { adres, absoluut } = vindbaarAdres(context);
  return {
    product,
    adres,
    afbeelding: product.afbeelding ? absoluut(product.afbeelding) : null,
    winkel: absoluut("/"),
    stand,
    klantprijs: prijzen.get(product.id) ?? null,
  };
}

export const meta: Route.MetaFunction = ({ loaderData }) => {
  // Bij een onbekend product (404) zet src/root.tsx de titel en `noindex`.
  if (!loaderData) return [];
  const { product, adres, afbeelding, winkel } = loaderData;
  return paginaMeta({
    site: SITE,
    titel: product.naam,
    omschrijving: product.omschrijving || `${product.naam} bij ${SITE.naam}.`,
    adres,
    afbeelding,
    type: "product",
    jsonLd: [
      productLd({
        naam: product.naam,
        omschrijving: product.omschrijving,
        adres,
        afbeelding,
        sku: product.slug,
        // Altijd de basisprijs, ook voor een ingelogde klant: dit is wat iedereen ziet.
        prijsCenten: product.basisprijs_centen,
        opVoorraad: product.op_voorraad,
      }),
      kruimelpadLd([
        { naam: "Producten", adres: winkel },
        { naam: product.naam, adres },
      ]),
    ],
  });
};

const inWagen = z.object({
  product_id: z.uuid(),
  aantal: z.coerce.number().int().min(1).max(99).default(1),
});

export async function action({ context, request }: Route.ActionArgs) {
  await vereisGebruiker(context);
  const invoer = inWagen.safeParse(Object.fromEntries(await request.formData()));
  if (!invoer.success) {
    return data({ ok: false as const, melding: "Kies een aantal van 1 tot 99." }, { status: 400 });
  }
  const { data: aantal, error } = await supabaseVoorVerzoek(context).rpc("wagen_toevoegen", {
    p_product_id: invoer.data.product_id,
    p_aantal: invoer.data.aantal,
  });
  if (error) {
    return data(
      { ok: false as const, melding: "Dit product kan nu niet in je wagen." },
      { status: 409 },
    );
  }
  return { ok: true as const, melding: `Ligt in je winkelwagen (${aantal} stuks).` };
}

export default function Product({ loaderData, actionData, params }: Route.ComponentProps) {
  const { product, stand, klantprijs } = loaderData;
  const fetcher = useFetcher<typeof action>();
  const bezig = fetcher.state !== "idle";
  // Met JavaScript komt de uitkomst via de fetcher (de pagina blijft staan); zonder
  // JavaScript stuurt de browser het formulier gewoon op en komt de uitkomst als actionData.
  const uitkomst = fetcher.data ?? actionData;
  return (
    <article>
      <nav aria-label="Kruimelpad" className="text-sm text-muted-foreground">
        <Link to="/" className="underline-offset-4 hover:underline">
          Producten
        </Link>{" "}
        <span aria-hidden>›</span> <span aria-current="page">{product.naam}</span>
      </nav>
      <div className="mt-4 grid gap-6 sm:grid-cols-2">
        <ProductAfbeelding src={product.afbeelding} alt={product.naam} belangrijk />
        <div>
          <h1 className="text-2xl font-semibold">{product.naam}</h1>
          <p className="mt-3 text-lg" data-testid="prijs">
            {klantprijs !== null ? (
              <>
                <span className="font-semibold">{`Jouw prijs ${euro(klantprijs)}`}</span>{" "}
                <span className="text-sm text-muted-foreground">
                  {`(normaal ${euro(product.basisprijs_centen)})`}
                </span>
              </>
            ) : (
              euro(product.basisprijs_centen)
            )}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {product.op_voorraad ? "Op voorraad" : "Tijdelijk uitverkocht"}
          </p>
          <p className="mt-4 text-sm leading-relaxed">{product.omschrijving}</p>

          {stand === null ? (
            <p className="mt-6 text-sm">
              <Link
                className="underline underline-offset-4"
                to={`/login?volgende=${encodeURIComponent(`/producten/${params.slug}`)}`}
              >
                Log in om te bestellen
              </Link>
            </p>
          ) : stand !== "goedgekeurd" ? (
            <WachtOpGoedkeuring stand={stand} />
          ) : product.op_voorraad ? (
            <fetcher.Form method="post" className="mt-6 flex items-end gap-3">
              <input type="hidden" name="product_id" value={product.id} />
              <div className="flex flex-col gap-1">
                <label htmlFor="aantal" className="text-sm">
                  Aantal
                </label>
                <input
                  id="aantal"
                  name="aantal"
                  type="number"
                  min={1}
                  max={99}
                  defaultValue={1}
                  className="h-10 w-20 rounded-md border bg-background px-3 text-sm"
                />
              </div>
              <Button type="submit" disabled={bezig}>
                {bezig ? "Bezig…" : "In winkelwagen"}
              </Button>
            </fetcher.Form>
          ) : null}
          <p className="mt-3 text-sm" role="status" aria-live="polite">
            {uitkomst ? (
              <>
                {uitkomst.melding}{" "}
                {uitkomst.ok ? (
                  <Link className="underline underline-offset-4" to="/wagen">
                    Naar de winkelwagen
                  </Link>
                ) : null}
              </>
            ) : null}
          </p>
        </div>
      </div>
    </article>
  );
}
