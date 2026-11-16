import { Form } from "react-router";
import { Button } from "@/components/ui/button";

/**
 * Hulp voor een klantportaal: weten of iemand nu medewerkerrechten heeft, en het zeggen als
 * die verlopen zijn.
 *
 * Medewerkerrechten gelden twaalf uur na het inloggen via Cloudflare
 * (`sessie_via_cloudflare()` in supabase/migrations). Daarna is de medewerker nog ingelogd,
 * maar geeft de database hem niets meer: zonder uitleg ziet hij lege schermen. Gebruik in de
 * loader van een pagina voor medewerkers (zie src/routes/klanten.tsx):
 *
 *   const stand = await medewerkersessie(context, wie);   // medewerkersessie.server.ts
 *   ...
 *   if (stand === "verlopen") return <OpnieuwAlsMedewerker terug="/klanten" />;
 *   if (stand !== "medewerker") return <GeenToegang />;
 *
 * Dit is alleen uitleg voor de gebruiker. De grens zelf is de database: een pagina die dit
 * overslaat, krijgt nog steeds niets.
 */
export type Medewerkersessie = "laden" | "medewerker" | "verlopen" | "geen";

/**
 * Begon deze sessie via een inlogdienst (`oauth` in het token)? Per mail is dat nooit zo.
 * `claims` is de gecontroleerde inhoud van het token, zoals `gebruiker(context)` hem geeft.
 */
export function begonViaDienst(claims: Record<string, unknown> | null): boolean {
  const amr = claims?.amr;
  return (
    Array.isArray(amr) &&
    amr.some(
      (stap: unknown) =>
        typeof stap === "object" && stap !== null && "method" in stap && stap.method === "oauth",
    )
  );
}

/**
 * Wat de database zegt (`is_medewerker()`), met erbij hoe de sessie begon: begon hij via
 * Cloudflare en zegt de database nee, dan zijn de rechten verlopen.
 */
export function standVan(
  claims: Record<string, unknown> | null,
  isMedewerker: boolean | null,
): Medewerkersessie {
  if (!claims) return "geen";
  if (isMedewerker === null) return "laden";
  if (isMedewerker) return "medewerker";
  return begonViaDienst(claims) ? "verlopen" : "geen";
}

/** Het formulier achter de knop voor medewerkers: de server begint de inlog (zie /login). */
export function MedewerkersKnop({ terug, nadruk = true }: { terug: string; nadruk?: boolean }) {
  return (
    <Form method="post" action={`/login?volgende=${encodeURIComponent(terug)}`}>
      <input type="hidden" name="doe" value="dienst" />
      <input type="hidden" name="dienst" value="cloudflare" />
      <Button type="submit" variant={nadruk ? "default" : "outline"}>
        Inloggen voor medewerkers
      </Button>
    </Form>
  );
}

/** De melding met de knop: opnieuw inloggen via Cloudflare, zonder eerst uit te loggen. */
export function OpnieuwAlsMedewerker({ terug }: { terug: string }) {
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-md border p-4 text-sm">
      <p className="font-medium">Log opnieuw in als medewerker</p>
      <p className="text-muted-foreground">
        Je inlog als medewerker is verlopen. Je bent nog wel ingelogd, maar ziet alleen wat een
        klant ziet tot je opnieuw inlogt.
      </p>
      <MedewerkersKnop terug={terug} />
    </div>
  );
}
