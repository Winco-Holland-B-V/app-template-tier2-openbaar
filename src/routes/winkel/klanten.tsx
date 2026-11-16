import { data, Form, Link, useNavigation } from "react-router";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MedewerkersKnop, OpnieuwAlsMedewerker } from "@/features/auth/medewerkersessie";
import { medewerkersessie } from "@/features/auth/medewerkersessie.server";
import { supabaseVoorVerzoek, vereisGebruiker } from "@/lib/server/sessie.server";
import { paginaMeta } from "@/lib/vindbaar/meta";
import { SITE } from "@/site";
import type { Route } from "./+types/klanten";

/**
 * Voor medewerkers: wie zich als klant heeft aangemeld. Zoeken op e-mailadres, filteren op
 * stand, bladeren, en per klant goedkeuren, afwijzen of de goedkeuring intrekken. Niet
 * openbaar, niet in Google.
 *
 * De server besluit hier niets over rechten. Hij vraagt de database of deze sessie
 * medewerkerrechten heeft (`is_medewerker()`: alleen een inlog via Cloudflare, hoogstens
 * twaalf uur oud) en leest en schrijft daarna met de sessie van de bezoeker. Zegt de database
 * nee, dan geeft de tabel `klanten` niets en wijzigt een knop niets, wat deze pagina ook doet.
 *
 * Zoeken en bladeren gaan via het adres (`?q=…&stand=…&pagina=…`), en de database doet het
 * werk: zo duwen honderden nep-aanmeldingen een echte klant niet van de lijst.
 */
const PER_PAGINA = 50;

const STANDEN = {
  alle: "Allemaal",
  wacht: "Wacht op goedkeuring",
  goedgekeurd: "Goedgekeurd",
  afgewezen: "Afgewezen",
} as const;
type Stand = keyof typeof STANDEN;

const zoekvraag = z.object({
  q: z.string().trim().max(100).catch(""),
  stand: z.enum(["alle", "wacht", "goedgekeurd", "afgewezen"]).catch("alle"),
  pagina: z.coerce.number().int().min(1).max(10_000).catch(1),
});

/** Een stuk van een e-mailadres als zoekpatroon: `%` en `_` betekenen hier gewoon dat teken. */
function patroon(tekst: string): string {
  return `%${tekst.replace(/[\\%_]/g, (teken) => `\\${teken}`)}%`;
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const wie = await vereisGebruiker(context);
  const zoek = zoekvraag.parse(Object.fromEntries(new URL(request.url).searchParams));
  // alleen lezen: de database zegt of deze sessie nu medewerkerrechten heeft.
  const stand = await medewerkersessie(context, wie);
  if (stand !== "medewerker") return { stand, zoek, klanten: [], totaal: 0 };
  let vraag = supabaseVoorVerzoek(context)
    .from("klanten_overzicht")
    .select("user_id, e_mail, goedgekeurd, afgewezen, aangemeld_op", { count: "exact" });
  if (zoek.stand === "wacht") vraag = vraag.eq("goedgekeurd", false).eq("afgewezen", false);
  if (zoek.stand === "goedgekeurd") vraag = vraag.eq("goedgekeurd", true);
  if (zoek.stand === "afgewezen") vraag = vraag.eq("afgewezen", true);
  if (zoek.q) vraag = vraag.ilike("e_mail", patroon(zoek.q.toLowerCase()));
  const begin = (zoek.pagina - 1) * PER_PAGINA;
  const {
    data: klanten,
    count,
    error,
  } = await vraag
    .order("afgewezen")
    .order("goedgekeurd")
    .order("aangemeld_op", { ascending: false })
    .order("user_id")
    .range(begin, begin + PER_PAGINA - 1);
  // Een pagina voorbij het einde geeft bij Supabase een fout (416); dan gewoon een lege lijst.
  if (error && error.code !== "PGRST103") {
    throw data("De klanten konden niet geladen worden.", { status: 503 });
  }
  // Een view geeft elke kolom als mogelijk leeg; elke regel heeft ze in de praktijk allemaal.
  const lijst = (klanten ?? []).flatMap((k) =>
    k.user_id && k.e_mail !== null && k.aangemeld_op
      ? [
          {
            user_id: k.user_id,
            e_mail: k.e_mail,
            goedgekeurd: k.goedgekeurd === true,
            afgewezen: k.afgewezen === true,
            aangemeld_op: k.aangemeld_op,
          },
        ]
      : [],
  );
  return { stand, zoek, klanten: lijst, totaal: count ?? 0 };
}

export const meta: Route.MetaFunction = () =>
  paginaMeta({
    site: SITE,
    titel: "Klanten",
    omschrijving: "Klanten goedkeuren.",
    zoekmachines: false,
  });

const opdracht = z.object({
  doe: z.enum(["goedkeuren", "afwijzen", "intrekken"]),
  user_id: z.uuid(),
});

export async function action({ context, request }: Route.ActionArgs) {
  await vereisGebruiker(context);
  const invoer = opdracht.safeParse(Object.fromEntries(await request.formData()));
  if (!invoer.success) {
    return data({ melding: "Dat ging niet goed. Probeer het opnieuw." }, { status: 400 });
  }
  // Met de sessie van de bezoeker: alleen een medewerker raakt hier een regel (RLS). Goedkeuren,
  // afwijzen en intrekken doet de database in één transactie (klant_beoordelen).
  const { error } = await supabaseVoorVerzoek(context).rpc("klant_beoordelen", {
    p_klant: invoer.data.user_id,
    p_doe: invoer.data.doe,
  });
  if (error) {
    return data(
      {
        melding: "Dat is niet gelukt. Log opnieuw in als medewerker en probeer het nog eens.",
      },
      { status: 403 },
    );
  }
  return { melding: null };
}

const DATUM = new Intl.DateTimeFormat("nl-NL", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "Europe/Amsterdam",
});

/** Het adres van deze pagina met een andere zoekvraag; lege velden laten we weg. */
function adres(zoek: { q: string; stand: Stand; pagina: number }): string {
  const delen = new URLSearchParams();
  if (zoek.q) delen.set("q", zoek.q);
  if (zoek.stand !== "alle") delen.set("stand", zoek.stand);
  if (zoek.pagina > 1) delen.set("pagina", String(zoek.pagina));
  const tekst = delen.toString();
  return tekst ? `/klanten?${tekst}` : "/klanten";
}

function Knop({
  doe,
  klant,
  bezig,
}: {
  doe: z.infer<typeof opdracht>["doe"];
  klant: string;
  bezig: boolean;
}) {
  const tekst = { goedkeuren: "Goedkeuren", afwijzen: "Afwijzen", intrekken: "Intrekken" }[doe];
  return (
    <Form method="post">
      <input type="hidden" name="doe" value={doe} />
      <input type="hidden" name="user_id" value={klant} />
      <Button
        type="submit"
        size="sm"
        variant={doe === "goedkeuren" ? "default" : "outline"}
        disabled={bezig}
      >
        {tekst}
      </Button>
    </Form>
  );
}

export default function Klanten({ loaderData, actionData }: Route.ComponentProps) {
  const { stand, zoek, klanten, totaal } = loaderData;
  const bezig = useNavigation().state !== "idle";
  if (stand !== "medewerker") {
    return (
      <>
        <h1 className="text-2xl font-semibold">Klanten</h1>
        {stand === "verlopen" ? (
          <div className="mt-4">
            <OpnieuwAlsMedewerker terug="/klanten" />
          </div>
        ) : (
          <div className="mt-4 flex flex-col items-start gap-3 text-sm">
            <p>Deze pagina is alleen voor medewerkers.</p>
            <MedewerkersKnop terug="/klanten" nadruk={false} />
          </div>
        )}
      </>
    );
  }
  const paginas = Math.max(1, Math.ceil(totaal / PER_PAGINA));
  return (
    <>
      <h1 className="text-2xl font-semibold">Klanten</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Wie hier staat, heeft ingelogd met een code per mail. Pas na goedkeuring ziet een klant zijn
        eigen prijzen en kan hij bestellen. Keur alleen goed wie je kent: zoek bij twijfel eerst
        contact.
      </p>
      <Form method="get" className="mt-4 flex flex-wrap items-end gap-3" role="search">
        <div className="flex flex-col gap-1">
          <Label htmlFor="q">E-mailadres</Label>
          <Input id="q" name="q" type="search" defaultValue={zoek.q} maxLength={100} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="stand">Laat zien</Label>
          <select
            id="stand"
            name="stand"
            defaultValue={zoek.stand}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            {Object.entries(STANDEN).map(([waarde, tekst]) => (
              <option key={waarde} value={waarde}>
                {tekst}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" size="sm" variant="outline">
          Zoeken
        </Button>
      </Form>
      {actionData?.melding ? (
        <p className="mt-4 rounded-md border border-destructive p-3 text-sm" role="alert">
          {actionData.melding}
        </p>
      ) : null}
      <p className="mt-4 text-sm text-muted-foreground" data-testid="aantal">
        {totaal === 1 ? "1 klant" : `${totaal} klanten`}
      </p>
      {klanten.length === 0 ? (
        <p className="mt-2 text-sm">
          {zoek.q || zoek.stand !== "alle"
            ? "Niemand gevonden."
            : "Er heeft zich nog niemand aangemeld."}
        </p>
      ) : (
        <ul className="mt-2 divide-y border-y" aria-label="Aangemelde klanten">
          {klanten.map((klant) => (
            <li
              key={klant.user_id}
              className="flex flex-wrap items-center gap-3 py-3 text-sm"
              data-testid="klant"
            >
              <span className="mr-auto">
                <span className="font-medium">{klant.e_mail}</span>
                <span className="block text-xs text-muted-foreground">
                  Aangemeld op {DATUM.format(new Date(klant.aangemeld_op))}
                </span>
              </span>
              {klant.goedgekeurd ? (
                <>
                  <span className="text-muted-foreground">Goedgekeurd</span>
                  <Knop doe="intrekken" klant={klant.user_id} bezig={bezig} />
                </>
              ) : klant.afgewezen ? (
                <>
                  <span className="text-muted-foreground">Afgewezen</span>
                  <Knop doe="goedkeuren" klant={klant.user_id} bezig={bezig} />
                </>
              ) : (
                <>
                  <Knop doe="goedkeuren" klant={klant.user_id} bezig={bezig} />
                  <Knop doe="afwijzen" klant={klant.user_id} bezig={bezig} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {paginas > 1 ? (
        <nav className="mt-4 flex items-center gap-4 text-sm" aria-label="Bladeren">
          {zoek.pagina > 1 ? (
            <Link to={adres({ ...zoek, pagina: zoek.pagina - 1 })}>Vorige pagina</Link>
          ) : null}
          <span>
            Pagina {Math.min(zoek.pagina, paginas)} van {paginas}
          </span>
          {zoek.pagina < paginas ? (
            <Link to={adres({ ...zoek, pagina: zoek.pagina + 1 })}>Volgende pagina</Link>
          ) : null}
        </nav>
      ) : null}
    </>
  );
}
