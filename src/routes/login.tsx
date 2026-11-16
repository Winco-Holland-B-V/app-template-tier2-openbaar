import { inloggen, inlogstand } from "@/features/auth/inloggen.server";
import { Inlogpagina } from "@/features/auth/inlogpagina";
import { paginaMeta } from "@/lib/vindbaar/meta";
import { SITE } from "@/site";
import type { Route } from "./+types/login";

/**
 * Het adres `/login`: de inlogpagina. De server maakt haar en verwerkt haar formulieren; zie
 * src/features/auth/inloggen.server.ts voor de stappen en de regels.
 *
 * Een GET (deze loader) logt nooit in, ook niet met de link uit de mail in het adres: dat
 * doet alleen een formulier. Zonder database valt er niets in te loggen: terug naar `/`.
 */
export function loader({ context, request }: Route.LoaderArgs) {
  return inlogstand(context, request);
}

export function action({ context, request }: Route.ActionArgs) {
  return inloggen(context, request);
}

/** Ook als header: zoekmachines blijven weg van de inlogpagina, op elk adres. */
export function headers() {
  return { "X-Robots-Tag": "noindex, nofollow" };
}

/** Niet in Google, en de titel zegt bij wie je inlogt. */
export const meta: Route.MetaFunction = () =>
  paginaMeta({
    site: SITE,
    titel: "Inloggen",
    omschrijving: `Inloggen bij ${SITE.naam}.`,
    zoekmachines: false,
  });

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  return <Inlogpagina stand={loaderData} uitkomst={actionData} merk={SITE.naam} />;
}
