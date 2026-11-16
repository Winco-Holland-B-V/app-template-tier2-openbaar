import { data, Form, Link, redirect, useNavigation } from "react-router";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { klantstand } from "@/features/auth/medewerkersessie.server";
import { WachtOpGoedkeuring } from "@/features/auth/wacht-op-goedkeuring";
import { euro } from "@/features/winkel/geld";
import { supabaseVoorVerzoek, vereisGebruiker } from "@/lib/server/sessie.server";
import { paginaMeta } from "@/lib/vindbaar/meta";
import { SITE } from "@/site";
import type { Route } from "./+types/wagen";

/**
 * De winkelwagen van de goedgekeurde klant, met zijn eigen prijzen. Niet openbaar, niet in Google.
 *
 * Bestellen stuurt alleen een sleutel en het getoonde totaal mee, geen prijs en geen regels:
 * bestelling_plaatsen() in de database pakt de wagen, rekent de prijs uit en boekt de voorraad
 * af. De sleutel maakt de server bij het tonen van deze pagina; twee keer klikken stuurt twee
 * keer dezelfde, en dat wordt één bestelling. Het totaal is wat de klant op deze pagina zag; de
 * database vergelijkt het alleen met haar eigen som en plaatst niets als die anders is (een
 * prijs die intussen veranderde). Het is nooit de prijs zelf.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const wie = await vereisGebruiker(context);
  // alleen lezen: de database zegt of dit account is goedgekeurd. Zonder goedkeuring geeft
  // de wagen niets; de pagina zegt dan waarom, in plaats van "je wagen is leeg".
  const stand = await klantstand(context, wie);
  if (stand !== "goedgekeurd") return { stand, regels: [], totaal: 0, sleutel: "" };
  const { data: regels, error } = await supabaseVoorVerzoek(context)
    .from("wagen_overzicht")
    .select("id, slug, naam, aantal, stukprijs_centen, te_koop, genoeg_voorraad")
    .order("naam");
  if (error) throw data("De winkelwagen kon niet geladen worden.", { status: 503 });
  const lijst = (regels ?? []).flatMap((r) => {
    if (!r.id || r.aantal === null) return [];
    // Een product dat niet meer te koop is: zonder naam en prijs, alleen om weg te halen.
    const teKoop = r.te_koop === true && r.slug !== null && r.stukprijs_centen !== null;
    return [
      {
        id: r.id,
        slug: teKoop ? r.slug : null,
        naam: teKoop && r.naam ? r.naam : "Niet meer te koop",
        aantal: r.aantal,
        stukprijs: teKoop ? (r.stukprijs_centen ?? 0) : 0,
        teKoop,
        genoegVoorraad: r.genoeg_voorraad === true,
      },
    ];
  });
  return {
    stand,
    regels: lijst,
    // Alleen om te tonen. Het bedrag van de bestelling rekent de database zelf uit.
    totaal: lijst.reduce((som, r) => som + r.aantal * r.stukprijs, 0),
    sleutel: crypto.randomUUID(),
  };
}

export const meta: Route.MetaFunction = () =>
  paginaMeta({
    site: SITE,
    titel: "Winkelwagen",
    omschrijving: "Je winkelwagen.",
    zoekmachines: false,
  });

const opdracht = z.discriminatedUnion("doe", [
  z.object({
    doe: z.literal("bestellen"),
    sleutel: z.uuid(),
    // Het totaal in centen zoals de pagina het toonde; alleen om te vergelijken.
    verwacht: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
  z.object({
    doe: z.literal("aantal"),
    id: z.uuid(),
    aantal: z.coerce.number().int().min(0).max(99),
  }),
]);

/** Wat de database bij een mislukte bestelling zegt, in gewone taal. */
const MELDINGEN: Record<string, string> = {
  SP001: "Je winkelwagen is leeg.",
  SP002: "Er is niet genoeg voorraad.",
  SP003: "Een product in je wagen is niet meer te koop.",
  SP004: "De prijs is gewijzigd. Bekijk je wagen opnieuw.",
  "42501": "Je account is nog niet goedgekeurd.",
};

/**
 * Fouten waarbij de database niets heeft gedaan en het later wel kan lukken: een deadlock
 * (40P01), een slot dat niet op tijd vrijkwam (55P03) of een vraag die te lang duurde (57014).
 * De bestelling is dan helemaal teruggedraaid; met dezelfde sleutel nog eens proberen is veilig.
 */
const OPNIEUW = new Set(["40P01", "55P03", "57014"]);
const EVEN_NIET = "Bestellen lukte even niet. Probeer het opnieuw.";

/** De melding bij een gewijzigde prijs, met het nieuwe totaal als de database het meegaf. */
function prijsGewijzigd(detail: string | undefined): string {
  const nieuw = Number(detail);
  return Number.isSafeInteger(nieuw) && nieuw >= 0
    ? `De prijs is gewijzigd. Bekijk je wagen opnieuw. Het totaal is nu ${euro(nieuw)}.`
    : (MELDINGEN.SP004 ?? EVEN_NIET);
}

export async function action({ context, request }: Route.ActionArgs) {
  await vereisGebruiker(context);
  const invoer = opdracht.safeParse(Object.fromEntries(await request.formData()));
  if (!invoer.success)
    return data({ melding: "Dat ging niet goed. Probeer het opnieuw." }, { status: 400 });
  const supabase = supabaseVoorVerzoek(context);

  if (invoer.data.doe === "aantal") {
    const { id, aantal } = invoer.data;
    const { error } =
      aantal === 0
        ? await supabase.from("winkelwagen_regels").delete().eq("id", id)
        : await supabase.from("winkelwagen_regels").update({ aantal }).eq("id", id);
    if (error) return data({ melding: "Het aantal kon niet worden aangepast." }, { status: 409 });
    return { melding: null };
  }

  const { sleutel, verwacht } = invoer.data;
  const bestel = () =>
    supabase.rpc("bestelling_plaatsen", { p_sleutel: sleutel, p_verwacht_totaal: verwacht });
  let { data: bestelling, error } = await bestel();
  // Eén keer opnieuw bij een fout die vanzelf overgaat; daarna een gewone melding.
  if (error && OPNIEUW.has(error.code)) ({ data: bestelling, error } = await bestel());
  if (error || !bestelling) {
    const code = error?.code ?? "";
    // De tekst van de database noemt bij SP002 alleen het product, niet de voorraad.
    const melding =
      code === "SP002"
        ? (error?.message ?? MELDINGEN.SP002)
        : code === "SP004"
          ? prijsGewijzigd(error?.details)
          : OPNIEUW.has(code)
            ? EVEN_NIET
            : (MELDINGEN[code] ?? "Bestellen is niet gelukt.");
    return data({ melding }, { status: 409 });
  }
  throw redirect(`/bestellingen?geplaatst=${encodeURIComponent(bestelling)}`);
}

export default function Wagen({ loaderData, actionData }: Route.ComponentProps) {
  const { stand, regels, totaal, sleutel } = loaderData;
  const navigatie = useNavigation();
  const bestelt = navigatie.formData?.get("doe") === "bestellen";
  return (
    <>
      <h1 className="text-2xl font-semibold">Winkelwagen</h1>
      {actionData?.melding ? (
        <p className="mt-4 rounded-md border border-destructive p-3 text-sm" role="alert">
          {actionData.melding}
        </p>
      ) : null}
      {stand !== "goedgekeurd" ? (
        <WachtOpGoedkeuring stand={stand} />
      ) : regels.length === 0 ? (
        <p className="mt-4 text-sm">
          Je winkelwagen is leeg.{" "}
          <Link className="underline underline-offset-4" to="/">
            Naar de producten
          </Link>
        </p>
      ) : (
        <>
          <ul className="mt-4 divide-y border-y" aria-label="Regels in je winkelwagen">
            {regels.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                {r.slug ? (
                  <Link
                    className="mr-auto underline-offset-4 hover:underline"
                    to={`/producten/${r.slug}`}
                  >
                    {r.naam}
                  </Link>
                ) : (
                  <span className="mr-auto text-destructive">{r.naam}</span>
                )}
                {r.teKoop ? <span>{euro(r.stukprijs)} per stuk</span> : null}
                <Form method="post" className="flex items-center gap-2">
                  <input type="hidden" name="doe" value="aantal" />
                  <input type="hidden" name="id" value={r.id} />
                  <label className="sr-only" htmlFor={`aantal-${r.id}`}>
                    Aantal {r.naam}
                  </label>
                  <input
                    id={`aantal-${r.id}`}
                    name="aantal"
                    type="number"
                    min={0}
                    max={99}
                    defaultValue={r.aantal}
                    className="h-9 w-16 rounded-md border bg-background px-2"
                  />
                  <Button type="submit" size="sm" variant="outline">
                    Aanpassen
                  </Button>
                </Form>
                <span className="w-24 text-right font-medium">{euro(r.aantal * r.stukprijs)}</span>
                {r.teKoop && !r.genoegVoorraad ? (
                  <span className="w-full text-destructive">
                    Niet genoeg voorraad voor dit aantal.
                  </span>
                ) : null}
                {r.teKoop ? null : (
                  <span className="w-full text-destructive">
                    Dit product is niet meer te koop. Zet het aantal op 0 om het weg te halen.
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-right text-base">
            Totaal{" "}
            <span className="font-semibold" data-testid="totaal">
              {euro(totaal)}
            </span>
          </p>
          <Form method="post" className="mt-4 flex justify-end">
            <input type="hidden" name="doe" value="bestellen" />
            <input type="hidden" name="sleutel" value={sleutel} />
            <input type="hidden" name="verwacht" value={totaal} />
            <Button type="submit" size="lg" disabled={bestelt}>
              {bestelt ? "Bezig met bestellen…" : "Bestellen"}
            </Button>
          </Form>
          <p className="mt-2 text-right text-xs text-muted-foreground">
            Je betaalt op rekening. De prijs en de voorraad worden bij het bestellen nog een keer
            gecontroleerd.
          </p>
        </>
      )}
    </>
  );
}
