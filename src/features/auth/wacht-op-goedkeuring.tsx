import { Link } from "react-router";
import type { Klantstand } from "@/features/auth/medewerkersessie.server";

/**
 * Wat iemand ziet die is ingelogd maar (nog) niet mag bestellen. Bij een klantportaal kan
 * iedereen per mail een account maken; pas na goedkeuring door een medewerker geeft de
 * database iets. Zonder deze uitleg ziet een nieuwe klant alleen lege schermen.
 */
export function WachtOpGoedkeuring({ stand }: { stand: Exclude<Klantstand, "goedgekeurd"> }) {
  if (stand === "medewerker") {
    return (
      <p className="mt-4 rounded-md border p-3 text-sm" role="status">
        Je bent ingelogd als medewerker. Een winkelwagen, eigen prijzen en bestellingen zijn er
        alleen voor klanten.{" "}
        <Link className="underline underline-offset-4" to="/klanten">
          Naar de klanten
        </Link>
      </p>
    );
  }
  return (
    <div className="mt-4 rounded-md border p-3 text-sm" role="status" data-testid="wacht">
      <p className="font-medium">Je account wacht op goedkeuring</p>
      <p className="mt-1 text-muted-foreground">
        Zodra een medewerker je account heeft goedgekeurd, zie je hier je eigen prijzen en kun je
        bestellen. Je hoeft niets te doen.
      </p>
    </div>
  );
}
