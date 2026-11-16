import { expect, test } from "@playwright/test";

/**
 * De server maakt elke pagina: wie een adres opvraagt, krijgt een compleet HTML-document
 * terug, ook zonder JavaScript. Dat is waar deze template om draait (zoekmachines en
 * gedeelde links lezen alleen dat document), dus deze tests vragen de pagina's op zoals
 * een zoekmachine dat doet: zonder browser. Ze gelden met en zonder database.
 */
test("een pagina komt als HTML-document van de server, met titel en manifest", async ({
  request,
}) => {
  const antwoord = await request.get("/");
  expect(antwoord.status()).toBe(200);
  expect(antwoord.headers()["content-type"]).toContain("text/html");
  const html = await antwoord.text();
  expect(html).toContain('<html lang="nl">');
  expect(html).toMatch(/<title>[^<]+<\/title>/);
  expect(html).toContain(
    'rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials"',
  );
  // Geen leeg omhulsel: er staat inhoud in de pagina voordat er een script heeft gedraaid.
  expect(html).toMatch(/<body>.*<(main|p)[ >]/s);
});

test("een adres dat niet bestaat geeft een echte 404, met een nette pagina", async ({
  request,
}) => {
  const antwoord = await request.get("/dit-adres-bestaat-niet");
  expect(antwoord.status()).toBe(404);
  expect(await antwoord.text()).toContain("Pagina niet gevonden");
});

test("de gebouwde bestanden staan naast de server: het manifest is op te halen", async ({
  request,
}) => {
  const antwoord = await request.get("/manifest.webmanifest");
  expect(antwoord.status()).toBe(200);
  expect((await antwoord.json()).start_url).toBe("/");
});
