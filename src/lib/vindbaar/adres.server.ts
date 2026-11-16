import type { RouterContextProvider } from "react-router";
import { paginaPad } from "@/lib/server/sessie.server";
import { veiligPad } from "@/lib/server/veilig-pad";
import { verzoekUit } from "@/lib/server/verzoek.server";

/**
 * Het volledige adres van een pagina, zoals zoekmachines en gedeelde links het moeten zien:
 * altijd op het echte domein van de app (`VITE_PRODUCTIEDOMEIN`, uit `routes` in
 * wrangler.jsonc), ook als de pagina via een preview of workers.dev wordt bekeken. Zo wijzen
 * de canonical, `og:url` en de sitemap nooit naar een preview. Heeft de app nog geen eigen
 * domein, dan het adres waarop de pagina nu wordt bekeken.
 *
 * Gebruik in een loader:
 *
 *   return { ..., adres: vindbaarAdres(context).adres };
 *
 * De zoekvraag (`?…`) hoort niet bij het adres: zo telt `/producten?utm=x` als dezelfde pagina.
 *
 * Dit bestand is van de template en komt met elke versie mee.
 */
export function vindbaarAdres(
  context: Readonly<RouterContextProvider>,
  pad?: string,
): { basis: string; adres: string; absoluut: (pad: string) => string } {
  const { request, instellingen } = verzoekUit(context);
  const huidig = new URL(request.url);
  const basis = instellingen.productiedomein
    ? `https://${instellingen.productiedomein}`
    : huidig.origin;
  // Een volledig adres blijft staan; al het andere is een pad in de app en gaat door
  // `veiligPad`. Zonder die stap maakt `new URL` van `/\elders.example/x.png` (een backslash
  // leest een browser als schuine streep) een adres op een ander domein.
  const absoluut = (p: string) =>
    /^https?:\/\//.test(p) ? p : new URL(veiligPad(p), basis).toString();
  // Een gegevensverzoek van React Router (`/pad.data`, `/_.data`) hoort bij de pagina `/pad`.
  const eigenPad = paginaPad(huidig.pathname);
  return { basis, adres: absoluut(pad ?? eigenPad), absoluut };
}
