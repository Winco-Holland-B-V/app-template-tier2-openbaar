import { Link } from "react-router";
import { klantstand } from "@/features/auth/medewerkersessie.server";
import { WachtOpGoedkeuring } from "@/features/auth/wacht-op-goedkeuring";
import { klantprijzen, openbareProducten } from "@/features/winkel/catalogus.server";
import { euro } from "@/features/winkel/geld";
import { ProductAfbeelding } from "@/features/winkel/product-afbeelding";
import { gebruiker, openbaarCache } from "@/lib/server/sessie.server";
import { vindbaarAdres } from "@/lib/vindbaar/adres.server";
import { itemListLd, organisatieLd, websiteLd } from "@/lib/vindbaar/json-ld";
import { paginaMeta } from "@/lib/vindbaar/meta";
import { SITE } from "@/site";
import type { Route } from "./+types/producten";

/**
 * De startpagina: de winkel, met alle producten. Openbaar, en zonder inlog vijf minuten in de cache. Een
 * goedgekeurde klant ziet zijn eigen prijs; zijn pagina gaat nooit in een cache (dat regelt de
 * Worker zodra er een sessie is). Wie is ingelogd maar nog niet is goedgekeurd, ziet de
 * gewone prijzen en de melding dat zijn account op goedkeuring wacht.
 */
export async function loader({ context }: Route.LoaderArgs) {
  openbaarCache(context, { seconden: 300 });
  const [producten, wie] = await Promise.all([openbareProducten(context), gebruiker(context)]);
  // alleen lezen: de database zegt of dit account is goedgekeurd.
  const stand = wie ? await klantstand(context, wie) : null;
  const prijzen = await klantprijzen(context, stand === "goedgekeurd" ? wie : null);
  const { adres, absoluut } = vindbaarAdres(context);
  return {
    adres,
    winkel: absoluut("/"),
    logo: absoluut(SITE.logo),
    wacht: stand === "wacht",
    producten: producten.map((p) => ({
      ...p,
      adres: absoluut(`/producten/${p.slug}`),
      klantprijs: prijzen.get(p.id) ?? null,
    })),
  };
}

export const meta: Route.MetaFunction = ({ loaderData }) =>
  paginaMeta({
    site: SITE,
    titel: "Producten",
    omschrijving: SITE.omschrijving,
    adres: loaderData?.adres,
    afbeelding: loaderData?.logo,
    jsonLd: loaderData
      ? [
          // De prijs staat hier niet in: alleen naam en adres, voor iedereen gelijk.
          itemListLd(loaderData.producten.map((p) => ({ naam: p.naam, adres: p.adres }))),
          websiteLd({ naam: SITE.naam, adres: loaderData.winkel }),
          organisatieLd({ naam: SITE.naam, adres: loaderData.winkel, logo: loaderData.logo }),
        ]
      : undefined,
  });

export default function Producten({ loaderData }: Route.ComponentProps) {
  const { producten, wacht } = loaderData;
  return (
    <>
      <h1 className="text-2xl font-semibold">Producten</h1>
      <p className="mt-2 text-sm text-muted-foreground">{SITE.omschrijving}</p>
      {wacht ? <WachtOpGoedkeuring stand="wacht" /> : null}
      {producten.length === 0 ? (
        <p className="mt-6 text-sm">Er zijn nog geen producten.</p>
      ) : (
        <ul className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-6">
          {producten.map((p, index) => (
            <li key={p.id}>
              <Link to={`/producten/${p.slug}`} className="group block" prefetch="intent">
                <ProductAfbeelding src={p.afbeelding} alt="" belangrijk={index === 0} />
                <h2 className="mt-3 font-medium group-hover:underline">{p.naam}</h2>
              </Link>
              <p className="mt-1 text-sm" data-testid="prijs">
                {p.klantprijs !== null ? (
                  <>
                    <span className="font-semibold">{`Jouw prijs ${euro(p.klantprijs)}`}</span>{" "}
                    <span className="text-muted-foreground">
                      {`(normaal ${euro(p.basisprijs_centen)})`}
                    </span>
                  </>
                ) : (
                  euro(p.basisprijs_centen)
                )}
              </p>
              {p.op_voorraad ? null : (
                <p className="mt-1 text-sm text-muted-foreground">Tijdelijk uitverkocht</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
