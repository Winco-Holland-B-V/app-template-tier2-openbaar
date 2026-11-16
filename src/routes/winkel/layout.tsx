import { NavLink, Outlet } from "react-router";
import { StartPage } from "@/features/start/start-page";
import { heeftDatabase } from "@/lib/env";
import { SITE } from "@/site";

/**
 * De buitenkant van de winkel: een kop met de vaste links en de inhoud eronder. Geen loader:
 * de kop is voor iedereen gelijk, zodat de openbare pagina's in de cache kunnen.
 *
 * Zonder database is er geen winkel: dan staat hier de startpagina van een verse app.
 */
export default function WinkelLayout() {
  if (!heeftDatabase) return <StartPage />;
  const link = ({ isActive }: { isActive: boolean }) =>
    `rounded-md px-2 py-2 underline-offset-4 hover:underline ${isActive ? "font-semibold" : ""}`;
  return (
    <>
      <a
        href="#inhoud"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2"
      >
        Naar de inhoud
      </a>
      <header className="border-b">
        <nav
          aria-label="Winkel"
          className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 text-sm"
        >
          <NavLink to="/" end className="mr-auto px-2 py-2 text-base font-semibold">
            {SITE.naam}
          </NavLink>
          <NavLink to="/" end className={link}>
            Producten
          </NavLink>
          <NavLink to="/wagen" className={link}>
            Winkelwagen
          </NavLink>
          <NavLink to="/bestellingen" className={link}>
            Bestellingen
          </NavLink>
          {/* Voor iedereen dezelfde link: de inlogpagina zegt zelf of je al bent ingelogd. */}
          <NavLink to="/login" className={link}>
            Account
          </NavLink>
        </nav>
      </header>
      <main id="inhoud" className="mx-auto max-w-4xl px-4 py-6">
        <Outlet />
      </main>
    </>
  );
}
