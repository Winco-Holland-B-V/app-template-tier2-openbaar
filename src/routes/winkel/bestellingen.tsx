import { data, Link } from "react-router";
import { klantstand } from "@/features/auth/medewerkersessie.server";
import { WachtOpGoedkeuring } from "@/features/auth/wacht-op-goedkeuring";
import { euro } from "@/features/winkel/geld";
import { supabaseVoorVerzoek, vereisGebruiker } from "@/lib/server/sessie.server";
import { paginaMeta } from "@/lib/vindbaar/meta";
import { SITE } from "@/site";
import type { Route } from "./+types/bestellingen";

/**
 * De eigen bestellingen van de goedgekeurde klant. Niet openbaar, niet in Google. De regels in
 * de database geven een medewerker alle bestellingen; deze pagina toont alleen de eigen.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const wie = await vereisGebruiker(context);
  // alleen lezen: de database zegt of dit account is goedgekeurd.
  const stand = await klantstand(context, wie);
  if (stand !== "goedgekeurd") return { stand, bestellingen: [], geplaatst: null, inWagen: 0 };
  const geplaatst = new URL(request.url).searchParams.get("geplaatst");
  const { data: bestellingen, error } = await supabaseVoorVerzoek(context)
    .from("bestellingen")
    .select("id, geplaatst_op, totaal_centen, bestelregels(id, naam, aantal, stukprijs_centen)")
    .eq("klant_id", wie.id)
    .order("geplaatst_op", { ascending: false })
    .limit(50);
  if (error) throw data("Je bestellingen konden niet geladen worden.", { status: 503 });
  // Net besteld: ligt er nog iets in de wagen? Dat is dan NIET besteld. Dat gebeurt als
  // dezelfde bestelling (dezelfde sleutel) nog eens werd verstuurd nadat de wagen veranderde:
  // de database geeft dan de bestelling van de eerste keer terug.
  let inWagen = 0;
  if (geplaatst) {
    const wagen = await supabaseVoorVerzoek(context)
      .from("wagen_overzicht")
      .select("id", { count: "exact", head: true });
    inWagen = wagen.count ?? 0;
  }
  return { stand, bestellingen: bestellingen ?? [], geplaatst, inWagen };
}

export const meta: Route.MetaFunction = () =>
  paginaMeta({
    site: SITE,
    titel: "Bestellingen",
    omschrijving: "Je bestellingen.",
    zoekmachines: false,
  });

const DATUM = new Intl.DateTimeFormat("nl-NL", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "Europe/Amsterdam",
});

export default function Bestellingen({ loaderData }: Route.ComponentProps) {
  const { stand, bestellingen, geplaatst, inWagen } = loaderData;
  const nieuw = bestellingen.find((b) => b.id === geplaatst);
  return (
    <>
      <h1 className="text-2xl font-semibold">Bestellingen</h1>
      {nieuw ? (
        <div className="mt-4 rounded-md border p-3 text-sm" role="status">
          <p>Bedankt, je bestelling is geplaatst.</p>
          <p className="mt-1">Bestelling van {DATUM.format(new Date(nieuw.geplaatst_op))}:</p>
          <ul className="mt-1 list-disc pl-5" aria-label="Wat je hebt besteld">
            {nieuw.bestelregels.map((r) => (
              <li key={r.id}>{`${r.aantal} × ${r.naam}`}</li>
            ))}
          </ul>
          <p className="mt-1 font-medium">Totaal {euro(nieuw.totaal_centen)}</p>
          {inWagen > 0 ? (
            <p className="mt-2 text-destructive" data-testid="niet-besteld">
              Let op: in je{" "}
              <Link className="underline underline-offset-4" to="/wagen">
                winkelwagen
              </Link>{" "}
              {inWagen === 1 ? "ligt nog 1 regel" : `liggen nog ${inWagen} regels`}. Die{" "}
              {inWagen === 1 ? "is" : "zijn"} niet besteld.
            </p>
          ) : null}
        </div>
      ) : null}
      {stand !== "goedgekeurd" ? (
        <WachtOpGoedkeuring stand={stand} />
      ) : bestellingen.length === 0 ? (
        <p className="mt-4 text-sm">Je hebt nog niets besteld.</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-4">
          {bestellingen.map((b) => (
            <li key={b.id} className="rounded-md border p-4 text-sm" data-testid="bestelling">
              <h2 className="font-medium">
                Bestelling van {DATUM.format(new Date(b.geplaatst_op))}
              </h2>
              <ul className="mt-2">
                {b.bestelregels.map((r) => (
                  <li key={r.id} className="flex justify-between gap-3">
                    <span>{`${r.aantal} × ${r.naam} à ${euro(r.stukprijs_centen)}`}</span>
                    <span>{euro(r.aantal * r.stukprijs_centen)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 flex justify-between border-t pt-2 font-semibold">
                <span>Totaal</span>
                <span>{euro(b.totaal_centen)}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
