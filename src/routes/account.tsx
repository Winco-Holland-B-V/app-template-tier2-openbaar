import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
  useActionData,
  useLoaderData,
} from "react-router";
import { accountStand, accountWijzigen } from "@/features/auth/tweede-stap.server";
import { Account } from "@/features/auth/tweede-stap-pagina";
import { paginaMeta } from "@/lib/vindbaar/meta";
import { SITE } from "@/site";

/**
 * `/account`: Mijn account voor een klant met een wachtwoord. Hier zet hij de tweede stap (2FA)
 * aan of uit en wijzigt hij zijn wachtwoord; in de stand vooraf stelt hij het hier ook voor het
 * eerst in. Zie src/features/auth/tweede-stap.server.ts.
 */
export function loader({ context }: LoaderFunctionArgs) {
  return accountStand(context);
}

export function action({ context, request }: ActionFunctionArgs) {
  return accountWijzigen(context, request);
}

export function headers() {
  return { "X-Robots-Tag": "noindex, nofollow" };
}

export const meta: MetaFunction = () =>
  paginaMeta({
    site: SITE,
    titel: "Mijn account",
    omschrijving: `Je account bij ${SITE.naam}.`,
    zoekmachines: false,
  });

export default function Pagina() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return <Account stand={loaderData} uitkomst={actionData} merk={SITE.naam} />;
}
