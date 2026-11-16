import { expect, test } from "@playwright/test";
import { vraagCode, vulCodeIn } from "./inloggen";
import { databaseModus } from "./stack-config";

// Zonder database is er niets om in te loggen; dan geldt e2e/start.spec.ts.
test.skip(databaseModus() === "geen", "deze app heeft geen database; zie e2e/start.spec.ts");
// Na elkaar: beide tests vragen een code aan voor dezelfde klant.
test.describe.configure({ mode: "serial" });

/**
 * De happy path: de route door de app waarop niets misgaat.
 *
 * Waarom juist deze test, en waarom als eerste: breekt de happy path, dan is de
 * app waardeloos. Hij raakt in één keer de hele keten (build, inloggen, database,
 * RLS, UI) en kost je één keer een half uur.
 *
 * Uitbreiden doe je reactief: elke keer dat er in productie iets stukgaat, komt
 * daar een test bij die precies dát geval afdekt.
 *
 * In de template is dat de winkel: een klant uit supabase/seed.sql (goedgekeurd) logt in met
 * de code uit de mail, legt iets in de wagen, bestelt en ziet zijn bestelling terug.
 */
const KLANT = "klant-a@voorbeeld.nl";

test("inloggen, iets in de wagen, bestellen, bestelling terugzien", async ({ page }) => {
  await page.goto("/wagen");

  // Niet ingelogd: je hoort op het inlogscherm te belanden.
  await expect(page.getByRole("heading", { name: "Inloggen" })).toBeVisible();

  const code = await vraagCode(page, KLANT);
  await vulCodeIn(page, code);

  // Na het inloggen kom je waar je heen wilde: de winkelwagen.
  await expect(page.getByRole("heading", { name: "Winkelwagen" })).toBeVisible();
  await expect(page).toHaveURL(/\/wagen$/);

  await page.goto("/producten/theepot-gietijzer");
  await page.getByRole("button", { name: "In winkelwagen" }).click();
  await expect(page.getByRole("status")).toContainText("Ligt in je winkelwagen");

  await page.goto("/wagen");
  await expect(page.getByRole("link", { name: "Theepot gietijzer" })).toBeVisible();
  await page.getByRole("button", { name: "Bestellen" }).click();
  await expect(page.getByText("Bedankt, je bestelling is geplaatst.")).toBeVisible();
  await expect(page.getByTestId("bestelling").first()).toContainText("Theepot gietijzer");

  // En na verversen staat het er nog steeds: het is echt opgeslagen.
  await page.goto("/bestellingen");
  await expect(page.getByTestId("bestelling").first()).toContainText("Theepot gietijzer");
});

test("een verkeerde code geeft een nette melding en geen toegang", async ({ page }) => {
  await page.goto("/login");
  const code = await vraagCode(page, KLANT);
  const fout = code === "0000000000" ? "0000000001" : "0000000000";
  await vulCodeIn(page, fout);

  await expect(page.getByRole("alert")).toContainText("Deze code klopt niet");
  await expect(page.getByRole("heading", { name: "Vul de code in" })).toBeVisible();
  // Geen toegang: de winkelwagen stuurt nog steeds naar de inlogpagina.
  const wagen = await page.request.get("/wagen", { maxRedirects: 0 });
  expect(wagen.status()).toBe(302);

  // Met de goede code alsnog binnen.
  await vulCodeIn(page, "");
  await vulCodeIn(page, code);
  await expect(page.getByRole("heading", { name: "Vul de code in" })).toBeHidden();
});
