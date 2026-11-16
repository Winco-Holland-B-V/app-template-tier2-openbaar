import { describe, it } from "vitest";
import { controleerAfscherming } from "./lib/afscherming";

/**
 * De A/B-test van de tabel `klanten` uit de migratie van het klantportaal. Bij een klantportaal
 * is een A/B-test per tabel verplicht (guard:rls-tests), en `klanten` is van de template: hij
 * blijft staan als een app het voorbeeld weghaalt. Daarom staat deze test los van
 * tests/rls/klantportaal.test.ts, dat ook de voorbeeldwinkel gebruikt.
 *
 * Deze test is van de template en komt met elke versie mee.
 */
describe("klanten: A/B", () => {
  it("klant B ziet, wijzigt en verwijdert de regel van klant A niet", async () => {
    await controleerAfscherming({
      tabel: "klanten",
      sleutel: "user_id",
      maakRijAlsA: async (a) => {
        const { error } = await a.client.rpc("klant_aanmelden");
        if (error) throw new Error(`A kon zich niet aanmelden: ${error.message}`);
        return a.id;
      },
    });
  });
});
