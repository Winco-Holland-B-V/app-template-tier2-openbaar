import { openbareProducten } from "@/features/winkel/catalogus.server";
import { openbaarCache } from "@/lib/server/sessie.server";
import { vindbaarAdres } from "@/lib/vindbaar/adres.server";
import { sitemapAntwoord } from "@/lib/vindbaar/sitemap";
import type { Route } from "./+types/sitemap";

/**
 * De sitemap: elke openbare pagina, met het adres op het echte domein. Alleen wat
 * openbare_producten() teruggeeft (zichtbare producten), dus nooit een verborgen product.
 * Een nieuwe openbare pagina komt hier met één regel bij.
 */
export async function loader({ context }: Route.LoaderArgs) {
  openbaarCache(context, { seconden: 3600 });
  const { absoluut } = vindbaarAdres(context);
  const producten = await openbareProducten(context);
  const laatste = producten.reduce<string | null>(
    (max, p) => (max === null || p.bijgewerkt_op > max ? p.bijgewerkt_op : max),
    null,
  );
  return sitemapAntwoord([
    { adres: absoluut("/"), gewijzigd: laatste },
    ...producten.map((p) => ({
      adres: absoluut(`/producten/${p.slug}`),
      gewijzigd: p.bijgewerkt_op,
    })),
  ]);
}
