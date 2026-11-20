import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
  useActionData,
} from "react-router";
import { tweedeStapDoen, tweedeStapStand } from "@/features/auth/tweede-stap.server";
import { TweedeStap } from "@/features/auth/tweede-stap-pagina";
import { paginaMeta } from "@/lib/vindbaar/meta";
import { SITE } from "@/site";

/**
 * `/tweede-stap`: de code uit de authenticator-app, na het wachtwoord. Alleen als de klant de
 * tweede stap (2FA) heeft aangezet; anders gaat het meteen door. Zie
 * src/features/auth/tweede-stap.server.ts.
 */
export function loader({ context, request }: LoaderFunctionArgs) {
  return tweedeStapStand(context, request);
}

export function action({ context, request }: ActionFunctionArgs) {
  return tweedeStapDoen(context, request);
}

export function headers() {
  return { "X-Robots-Tag": "noindex, nofollow" };
}

export const meta: MetaFunction = () =>
  paginaMeta({
    site: SITE,
    titel: "Tweede stap",
    omschrijving: `Inloggen bij ${SITE.naam}.`,
    zoekmachines: false,
  });

export default function Pagina() {
  const actionData = useActionData<typeof action>();
  return <TweedeStap uitkomst={actionData} merk={SITE.naam} />;
}
