import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
  useActionData,
  useLoaderData,
} from "react-router";
import { instellen, instelstand } from "@/features/auth/wachtwoord.server";
import { WachtwoordInstellen } from "@/features/auth/wachtwoord-pagina";
import { paginaMeta } from "@/lib/vindbaar/meta";
import { SITE } from "@/site";

/**
 * `/wachtwoord-instellen`: hier komt de link uit de uitnodiging en uit "wachtwoord vergeten"
 * binnen. Een GET (deze loader) wisselt de link nooit om; dat doet alleen de knop (de action).
 * Zie src/features/auth/wachtwoord.server.ts.
 */
export function loader({ context, request }: LoaderFunctionArgs) {
  return instelstand(context, request);
}

export function action({ context, request }: ActionFunctionArgs) {
  return instellen(context, request);
}

export function headers() {
  return { "X-Robots-Tag": "noindex, nofollow" };
}

export const meta: MetaFunction = () =>
  paginaMeta({
    site: SITE,
    titel: "Wachtwoord instellen",
    omschrijving: `Een wachtwoord kiezen voor ${SITE.naam}.`,
    zoekmachines: false,
  });

export default function Pagina() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return <WachtwoordInstellen stand={loaderData} uitkomst={actionData} merk={SITE.naam} />;
}
