import { expect, type Page } from "@playwright/test";
import { wachtOpInlogmail } from "../tests/lib/mailvanger";
import { TEST_USER } from "./test-user";

/**
 * Inloggen in een browsertest, zoals een gebruiker dat doet: via het formulier op `/login`.
 * Zonder adres is het de e2e-gebruiker; global-setup.ts maakt die aan (en geeft hem de rol uit
 * supabase/testrol.sql, als dat bestand er is).
 *
 * Welke weg het wordt, zegt de inlogpagina zelf:
 *
 *   - een klantportaal (`VITE_INLOGDIENST=cloudflare,mailcode`, zo draait de browsertest van de
 *     template): het adres invullen en de code van tien cijfers uit de lokale mailvanger
 *     overtypen. Er is geen omweg: geen wachtwoord, geen sessie die de test zelf klaarzet;
 *   - `VITE_INLOGDIENST=wachtwoord` (een app die haar browsertest zo bouwt): het formulier met
 *     e-mailadres en wachtwoord. Dan is `wachtwoord` nodig voor een andere gebruiker dan de
 *     e2e-gebruiker.
 *
 * `javascript: false` voor een browser zonder JavaScript: dan typt de test de code en klikt hij
 * zelf op Inloggen (met JavaScript verstuurt de pagina de code vanzelf).
 */
export async function inloggen(
  page: Page,
  o: { email?: string; wachtwoord?: string; javascript?: boolean } = {},
): Promise<void> {
  const email = o.email ?? TEST_USER.email;
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Inloggen" })).toBeVisible();

  if ((await page.getByLabel("Wachtwoord").count()) > 0) {
    await page.getByLabel("E-mailadres").fill(email);
    await page.getByLabel("Wachtwoord").fill(o.wachtwoord ?? TEST_USER.password);
    await page.getByRole("button", { name: "Inloggen" }).click();
    await expect(page.getByRole("heading", { name: "Inloggen" })).toBeHidden();
    return;
  }

  const code = await vraagCode(page, email);
  await vulCodeIn(page, code, o.javascript ?? true);
  await expect(page.getByRole("heading", { name: "Vul de code in" })).toBeHidden();
}

/**
 * Vult het adres in en geeft de code uit de mail. Supabase stuurt per adres niet vaker dan
 * eens per seconde; zegt de pagina "te veel pogingen", dan nog één keer na een korte pauze.
 */
export async function vraagCode(page: Page, email: string): Promise<string> {
  const leesMail = await wachtOpInlogmail({ email, mailUrl: process.env.SUPABASE_MAIL_URL });
  const codestap = page.getByRole("heading", { name: "Vul de code in" });
  for (let poging = 0; poging < 4; poging++) {
    await page.getByLabel("E-mailadres").fill(email);
    // Het antwoord van de server afwachten: met JavaScript `/login.data`, zonder `/login`.
    const [antwoord] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === "POST" && /^\/login(\.data)?$/.test(new URL(r.url()).pathname),
      ),
      page.getByRole("button", { name: "Doorgaan" }).click(),
    ]);
    if (antwoord.status() !== 429) break;
    await expect(page.getByText("Te veel pogingen")).toBeVisible();
    await page.waitForTimeout(1500);
  }
  await expect(codestap).toBeVisible();
  return (await leesMail()).code;
}

/** Typt de code; zonder JavaScript klikt de test daarna zelf op Inloggen. */
export async function vulCodeIn(page: Page, code: string, javascript = true): Promise<void> {
  await page.getByLabel("Code van tien cijfers").fill(code);
  if (!javascript) await page.getByRole("button", { name: "Inloggen" }).click();
}
