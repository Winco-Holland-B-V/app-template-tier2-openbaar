import {
  data,
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import type { Route } from "./+types/root";
import "@/index.css";
import { netIngelogdAls } from "@/features/auth/inloggen.server";
import { IngelogdAls } from "@/features/auth/inlogpagina";
import { env, envFout } from "@/lib/env";
import { Startfout } from "@/lib/startfout";

/**
 * De buitenkant van elke pagina: het HTML-document, de stijl en de testbalk. De server maakt
 * dit voor elk adres, dus alles in dit bestand moet zonder browser kunnen draaien (geen
 * `window`, geen `document`).
 */

/**
 * Draait bij elk verzoek, dus doet bijna niets: kloppen de omgevingsvariabelen niet, dan
 * stopt het hier en toont de ErrorBoundary hieronder "Deze app kan niet starten". En is er
 * zojuist ingelogd, dan geeft dit één keer het adres voor de regel "Je bent ingelogd als".
 * Voor een bezoeker zonder cookie is de uitkomst altijd dezelfde.
 */
export async function loader({ context }: Route.LoaderArgs) {
  if (envFout) throw data(null, { status: 500 });
  return { ingelogdAls: await netIngelogdAls(context) };
}

/**
 * De titel van de app; een route kan er met een eigen `meta` een andere voor in de plaats
 * zetten. Bij een fout of een adres dat niet bestaat: een eigen titel, en niet in Google.
 */
export const meta: Route.MetaFunction = ({ error }) =>
  error
    ? [
        {
          title: envFout
            ? "Deze app kan niet starten"
            : isRouteErrorResponse(error) && error.status === 404
              ? "Pagina niet gevonden"
              : "Er ging iets mis",
        },
        { name: "robots", content: "noindex, nofollow" },
      ]
    : [{ title: "Stack Template" }];

export const links: Route.LinksFunction = () => [
  // Installeerbaar als app op telefoon en computer (zie docs/WERKWIJZE.md). Het manifest
  // gaat met het inlogkoekje mee (use-credentials), anders houdt Access het tegen.
  { rel: "manifest", href: "/manifest.webmanifest", crossOrigin: "use-credentials" },
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="nl">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="theme-color" content="#ffffff" />
        <meta name="apple-mobile-web-app-title" content="Stack Template" />
        <Meta />
        <Links />
      </head>
      <body>
        {env.VITE_OMGEVING === "test" && (
          <p className="bg-amber-200 px-3 py-1 text-center text-xs text-amber-950" role="status">
            Testomgeving: dit is de testdatabase, niet de echte app.
          </p>
        )}
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <IngelogdAls adres={loaderData.ingelogdAls} />
      <Outlet />
    </>
  );
}

/** Een adres dat niet bestaat (404) of een fout in een pagina: een nette melding, geen leeg scherm. */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  // Een fout in de omgeving (lib/env.ts): zeg wat er mis is, op elk adres.
  if (envFout) return <Startfout tekst={envFout} />;
  const nietGevonden = isRouteErrorResponse(error) && error.status === 404;
  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-semibold">
        {nietGevonden ? "Pagina niet gevonden" : "Er ging iets mis"}
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">
        {nietGevonden
          ? "Dit adres bestaat niet (meer)."
          : "Probeer het opnieuw. Blijft het misgaan, meld het dan bij de beheerder van deze app."}
      </p>
      <p className="mt-3 text-sm">
        <a className="underline" href="/">
          Naar de startpagina
        </a>
      </p>
      {import.meta.env.DEV && error instanceof Error ? (
        <pre className="mt-6 overflow-x-auto rounded-md border p-3 text-xs">{error.stack}</pre>
      ) : null}
    </main>
  );
}
