import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
  useActionData,
  useLoaderData,
} from "react-router";
import { vergeten, vergetenstand } from "@/features/auth/wachtwoord.server";
import { WachtwoordVergeten } from "@/features/auth/wachtwoord-pagina";
import { paginaMeta } from "@/lib/vindbaar/meta";
import { SITE } from "@/site";

/**
 * `/wachtwoord-vergeten`: een nieuwe link aanvragen. Altijd hetzelfde antwoord, of het adres
 * een account heeft of niet; er ontstaat hier nooit een account. In de stand vooraf stuurt de
 * pagina door naar /login (inloggen met een code). Zie src/features/auth/wachtwoord.server.ts.
 *
 * Zonder de types uit ./+types: zo blijft dit bestand ook geldig in een app die de pagina (nog)
 * niet in src/routes.ts heeft (een klantportaal met een code per mail).
 */
export function loader({ context }: LoaderFunctionArgs) {
  return vergetenstand(context);
}

export function action({ context, request }: ActionFunctionArgs) {
  return vergeten(context, request);
}

export function headers() {
  return { "X-Robots-Tag": "noindex, nofollow" };
}

export const meta: MetaFunction = () =>
  paginaMeta({
    site: SITE,
    titel: "Wachtwoord vergeten",
    omschrijving: `Een nieuw wachtwoord voor ${SITE.naam}.`,
    zoekmachines: false,
  });

export default function Pagina() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return <WachtwoordVergeten stand={loaderData} uitkomst={actionData} merk={SITE.naam} />;
}
