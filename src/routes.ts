import { index, layout, type RouteConfig, route } from "@react-router/dev/routes";

/**
 * De routes van deze app: welk adres bij welk bestand in `src/routes/` hoort. Een nieuw
 * scherm krijgt hier een regel, en als het een onderdeel is ook een regel in
 * `src/onderdelen.ts`; `tests/unit/onderdelen.test.ts` wordt rood als je dat vergeet.
 */
export default [
  // De voorbeeldshop: openbare, vindbare pagina's (de lijst op `/` en elk product) en die van
  // de ingelogde klant. Zie docs/routes/webshop.md. Zonder database toont de layout de
  // startpagina van een verse app.
  layout("routes/winkel/layout.tsx", [
    index("routes/winkel/producten.tsx"),
    route("producten", "routes/winkel/naar-start.ts"),
    route("producten/:slug", "routes/winkel/product.tsx"),
    route("wagen", "routes/winkel/wagen.tsx"),
    route("bestellingen", "routes/winkel/bestellingen.tsx"),
    // Voor medewerkers: klanten goedkeuren.
    route("klanten", "routes/winkel/klanten.tsx"),
  ]),
  // Inloggen: de pagina met haar formulieren, en het adres waar de inlogdienst naar terugkomt.
  route("login", "routes/login.tsx"),
  route("login/terug", "routes/login-terug.ts"),
  // Klantportaal met accounts (`cloudflare,wachtwoord`): wachtwoord kiezen of vergeten, de
  // tweede stap (2FA) na het wachtwoord, en Mijn account. Zonder wachtwoord bestaan ze niet (404).
  route("wachtwoord-instellen", "routes/wachtwoord-instellen.tsx"),
  route("wachtwoord-vergeten", "routes/wachtwoord-vergeten.tsx"),
  route("tweede-stap", "routes/tweede-stap.tsx"),
  route("account", "routes/account.tsx"),
  // Voor zoekmachines: geen scherm, alleen een bestand.
  route("sitemap.xml", "routes/sitemap.ts"),
  route("robots.txt", "routes/robots.ts"),
] satisfies RouteConfig;
