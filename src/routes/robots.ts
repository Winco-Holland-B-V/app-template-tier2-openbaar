import { openbaarCache } from "@/lib/server/sessie.server";
import { vindbaarAdres } from "@/lib/vindbaar/adres.server";
import { robotsAntwoord } from "@/lib/vindbaar/sitemap";
import type { Route } from "./+types/robots";

/**
 * robots.txt op het echte domein. Op elk ander adres (workers.dev, previews, je eigen computer)
 * komt dit bestand niet aan bod: daar antwoordt de Worker zelf met een robots.txt die alles
 * weigert. Pagina's van een ingelogde klant hoeven niet bezocht te worden; ze hebben ook
 * `noindex`.
 */
export function loader({ context }: Route.LoaderArgs) {
  openbaarCache(context, { seconden: 86400 });
  const { absoluut } = vindbaarAdres(context);
  return robotsAntwoord({
    sitemap: absoluut("/sitemap.xml"),
    verboden: ["/wagen", "/bestellingen", "/login"],
  });
}
