# Een bestaande app omzetten naar de openbare template

Deze route zet een app van de gewone tier 2-template (`app-template-tier2`, de schermen worden
in de browser gemaakt) over op deze template (`app-template-tier2-openbaar`, de server maakt
elke pagina). Hij is voor de AI-agent van een bouwer. Lees eerst in `docs/WERKWIJZE.md` het
stuk "Server en browser" en "Code op de server", en `docs/routes/webshop.md`.

Reken op drie soorten werk. Stap 2 tot en met 6 zijn mechanisch: een paar uur, en daarna is
alles groen met elk oud scherm als browser-scherm. Stap 7 (vindbaar maken) is per scherm een
klein stuk werk, en mag later. Stap 8 en 9 (de rechten in de database en de tests daarvan) zijn
het echte werk en het echte risico: die zie je alleen in de databasejob van GitHub.

## Stap 0: Moet dit wel?

Doe het **niet** als:

- alleen medewerkers de app gebruiken (planning, voorraad, administratie). Die blijft op de
  gewone tier 2, achter de deur van Cloudflare. Deze template heeft een server en een open
  domein, en dus meer regels en meer risico, zonder dat zo'n app er iets aan heeft;
- de app al werkt en er een deadline aankomt. Omzetten raakt het inloggen van iedereen; doe
  het in een rustige week, nooit vlak voor een lancering of een seizoenspiek;
- er alleen één pagina open moet (een link die je naar een klant stuurt): dat is `publiek` in
  `toegang.json` van de beheer-repo, op de gewone tier 2.

Doe het **wel** als de app gevonden moet worden in Google of in AI-zoekers, als gedeelde links
een voorbeeld met titel en afbeelding moeten tonen, of als klanten van buiten moeten
inloggen met een code per mail.

Twijfel je, leg het de bouwer voor en stel geen omzetting voor. Zeg erbij wat er voor
gebruikers verandert (stap 10).

Controleer daarna, in de map van de app:

```bash
cat .claude/stack-version
grep '"database"' stack.config.json
grep -v '^\s*//' wrangler.jsonc | grep custom_domain
grep -rlE 'public\.(klanten|is_medewerker|is_goedgekeurde_klant|klant_aanmelden|sessie_via_cloudflare)\b' supabase/migrations
```

1. De versie is dezelfde als die van de openbare template (43 of hoger). Lager: eerst
   `/stagetwo-tier2:updaten` op de gewone template, die pull request mergen, dan hier verder.
   Twee sprongen tegelijk maken elke fout onleesbaar.
2. `"database": true`. Anders: een app zonder eigen database hoort niet op deze template.
3. Een regel met `"custom_domain": true`. Geen uitvoer: je kunt omzetten, maar zonder eigen
   domein is niets vindbaar en kunnen klanten er niet bij. Zeg de bouwer dat de owner een
   domein moet regelen.
4. Geen uitvoer, of alleen `*_klantportaal.sql`. Staat er een ander bestand, dan heeft de app
   al een tabel `klanten` of een functie met een naam van de template. Zie "Een eigen tabel
   klanten" onder stap 8 voordat je verdergaat.

Goed als: de bouwer heeft "ja, omzetten" gezegd en de vier controles kloppen.

## Stap 1: De template naast de app

```bash
T="${TMPDIR:-/tmp}/openbaar-template"
rm -rf "$T"
gh repo clone "$(gh repo view --json owner -q .owner.login)/app-template-tier2-openbaar" "$T" -- --quiet
git -C "$T" checkout --quiet "stack-v$(cat .claude/stack-version)"
git -C "$T" describe --tags
git switch -c omzetten-naar-openbaar
```

Goed als: de laatste regel van `describe` is `stack-v<de versie van de app>`. Begin elk
volgend blok met dezelfde regel `T=...`.

Gaat het mis: zegt `gh` dat de repo niet bestaat, vraag de owner om de kopie van
`app-template-tier2-openbaar` in de organisatie. Bestaat de tag niet, neem dan de nieuwste
tag en werk de app eerst bij tot die versie (stap 0).

## Stap 2 en 3: De bestanden van de template en het skelet

Het mechanische deel doet een script uit de template, in de map van de app:

```bash
T="${TMPDIR:-/tmp}/openbaar-template"
node "$T/scripts/omzetten-naar-openbaar.mjs"
```

Het zet elk bestand uit het manifest van deze template neer en haalt weg wat alleen in het oude
manifest stond (`AGENTS.md` alleen tussen de markeringen), neemt het skelet van het project
over (de config van de build en de tests, `src/root.tsx`, `src/lib/env.ts`, de inlog in
`src/routes/login.tsx` en `src/features/auth/`, `supabase/testrol.sql`), haalt `index.html` en
`src/main.tsx` weg, voegt `package.json` samen (scripts en devDependencies van de template,
`react-router-dom` eruit, `react-router`, `@supabase/ssr` en `isbot` erin), zet in `src/`,
`tests/` en `e2e/` `react-router-dom` om naar `react-router`, neemt `wrangler.jsonc` van de
template met de naam en het eigen domein van de app, en zet de gegenereerde bestanden in
`.gitignore`. Het commit niets. Aan het eind zegt het wat het overschreef en wat er met de
hand moet.

Goed als: het script eindigt met "Met de hand", `git status` toont alleen bestanden uit die
opsomming, `AGENTS.md` heeft boven de markering nog de eigen naam van de app, en
`grep -r react-router-dom src tests e2e` geeft niets.

Gaat het mis:

- "Er staan nog wijzigingen die niet gecommit zijn": commit of bewaar ze eerst; zo is elke
  stap van het script met `git diff` na te kijken en met `git checkout .` terug te draaien.
- "De app staat op versie ...": de versies verschillen; terug naar stap 0 of stap 1.

Kijk daarna met `git diff` naar elk bestand onder "Overschreven": wat de app daarin zelf had
(een eigen regel in `vite.config.ts`, een eigen variabele in `src/lib/env.ts`), zet je terug.

Dan met de hand:

- `src/root.tsx`: zet er terug wat in `index.html` en `src/main.tsx` stond: de titel, de kleur
  (`theme-color`), de favicons in `links`, lettertypen (`import "@fontsource/..."` bovenin).
  Het script heeft ze weggehaald; de oude inhoud zie je met `git show HEAD:index.html` en
  `git show HEAD:src/main.tsx`.
- `src/site.ts`: de naam en de omschrijving van de app.
- `wrangler.jsonc`: kijk of `name` en het eigen domein kloppen. Geen `assets` en geen
  `not_found_handling` meer: de Worker maakt elke pagina.

```bash
pnpm install
```

Goed als: `pnpm install` slaagt.

Gaat het mis: een bibliotheek die zelf `react-router-dom` nodig heeft, houdt hem als
afhankelijkheid; de app importeert hem niet meer.

## Stap 4: Alle schermen als browser-scherm

De eenvoudigste overgang: elk bestaand scherm blijft zoals het was en draait in de browser. De
server stuurt alleen de pagina met een laadregel. Dat gaat met de hulp
`src/lib/browser-scherm.tsx` van de template.

Maak een bestand dat de oude hoofdcomponent doorgeeft. De naam eindigt op `.client.tsx`:
React Router laat zo'n bestand bij het bouwen van de server leeg, zodat de oude schermen (en
alles wat zij importeren: Excel, PDF, een scanner) niet in de Worker komen.

`src/features/oud/app.client.tsx`, één regel, met het pad van de oude hoofdcomponent:

```tsx
export { default } from "@/features/auth/app-met-database";
```

`src/routes/browser-app.tsx`:

```tsx
import OudeApp from "@/features/oud/app.client";
import { browserScherm } from "@/lib/browser-scherm";
import { SITE } from "@/site";

const scherm = browserScherm({ titel: SITE.naam, scherm: OudeApp });
export const clientLoader = scherm.clientLoader;
export const HydrateFallback = scherm.HydrateFallback;
export const meta = scherm.meta;
export const headers = scherm.headers;
export default scherm.Scherm;
```

Schrijf de exports precies zo, één voor één: `export const { ... } = browserScherm(...)` kan
React Router niet lezen.

In `src/routes.ts`, na de routes van de template:

```ts
index("routes/browser-app.tsx", { id: "start" }), // een vangroute telt `/` niet mee
route("*", "routes/browser-app.tsx"),
```

De oude hoofdcomponent houdt zijn eigen router (`<Routes>`); haal daar `/login` uit (die is
nu van de server) en laat elke verwijzing "naar /login" staan. Een scherm dat de app toonde
zonder database (de startpagina van een verse app), toon je in het oude scherm zelf.

Goed als: `pnpm typecheck` geeft alleen nog fouten over de database (stap 8) en over de
voorbeeldwinkel (stap 6), en `pnpm build` slaagt.

Gaat het mis:

- "browser-scherm: het scherm is op de server geladen": je importeert het scherm niet uit een
  `.client`-bestand. `guard:server` zegt welk route-bestand.
- "@/lib/supabase is de client van de browser" bij de build: ergens importeert een route of
  `src/root.tsx` een oud scherm rechtstreeks. Alleen via het `.client`-bestand.

## Stap 5: Kleine botsingen

- `document.body.append(el)` wordt `document.body.appendChild(el)`: de typen van Cloudflare
  (`wrangler types`) kennen een eigen `append`.
- `src/routes/sitemap.ts` en `src/routes/robots.ts`: zet er de eigen openbare pagina's in, en
  in `robots.ts` de paden die niet bezocht hoeven te worden.
- `src/onderdelen.ts`: draai `node scripts/lib/onderdelen.mjs` en zet elk pad in `ONDERDELEN`
  of in `GEEN_ONDERDEEL`. Een vangroute en bestanden zoals `/robots.txt` telt hij niet mee.
- Tests van de oude inlogpagina (een `login-page.test.tsx`, een test over de inloglus) gaan
  weg met de oude inlogpagina.
- Toont een scherm afbeeldingen van een ander domein (productfoto's van een leverancier) of
  gebruikt het WebAssembly (veel barcodescanners), zet dat dan in `stack.config.json`:

  ```json
  "browser": {
    "afbeeldingen_van": { "https://beeld.leverancier.nl": "productfoto's van de leverancier" },
    "webassembly": "de barcodescanner in het magazijn"
  }
  ```

  Elk adres met een reden. Scripts van een ander domein mogen nooit; zie `docs/WERKWIJZE.md`,
  "Server en browser". Zonder deze regel blijven die afbeeldingen leeg en weigert de scanner,
  en dat zie je alleen in een browser.

Goed als: `pnpm typecheck` en `pnpm lint` geven alleen nog fouten over de database.

## Stap 6: De voorbeeldwinkel weg

De app krijgt bij stap 2 en 3 niets van de voorbeeldwinkel mee, maar wat er toch staat, gaat
weg: `src/routes/winkel/`, `src/features/winkel/`, `public/voorbeeldshop/`, de migratie
`*_voorbeeldshop.sql`, `e2e/voorbeeldshop-*.spec.ts` en `tests/rls/voorbeeldshop.test.ts`.
De tests van de template leunen daar niet op (`tests/unit/echte-app.test.ts` bewaakt dat in
de template).

Zet in `stack.config.json` welke pagina's de browsertests van de serverlaag gebruiken:

```json
"browsertest": { "openbare_pagina": "/", "pagina_met_inlog": "/account" }
```

De openbare pagina is er een die om een openbare cache vraagt (stap 7); de pagina met inlog
stuurt een bezoeker zonder sessie naar `/login`. Heeft de app ze nog niet, laat de regel dan
weg: de tests slaan dat deel over en zeggen waarom. Zet daar nooit een test voor uit
(`guard:testlat` ziet dat).

Goed als: `pnpm check` geeft alleen nog fouten over de database.

## Stap 7: Vindbaar maken, per scherm (mag later)

Fase één is klaar als alles groen is met de oude schermen als browser-scherm. Pas daarna,
eventueel in een volgende pull request, krijgt elk scherm dat gevonden moet worden een eigen
route met een loader en `meta`, vóór de vangroute in `src/routes.ts`:

```tsx
export async function loader({ context }: Route.LoaderArgs) {
  openbaarCache(context, { seconden: 300 }); // alleen als de pagina voor iedereen gelijk is
  return { adres: vindbaarAdres(context).adres };
}
export const meta: Route.MetaFunction = ({ loaderData }) =>
  paginaMeta({ site: SITE, titel: "...", omschrijving: "...", adres: loaderData?.adres });
```

Het scherm zelf kan in de browser blijven: gebruik `useInDeBrowser()` uit
`@/lib/browser-scherm` om tot dan een eenvoudige versie te tonen.

Regels die hier vaak misgaan:

- **Een loader wijzigt niets.** Een bestaande databasefunctie die ook iets bijhoudt ("geopend
  op", een teller) mag niet in een loader: WhatsApp, Google en virusscanners openen de link
  ook. Maak een aparte functie die alleen leest, voor `anon`, met alleen de velden van het
  voorbeeld.
- **Een link per klant** (een code in het adres) krijgt `zoekmachines: false`, geen
  `openbaarCache`, en komt niet in de sitemap.
- **Zonder database** (`heeftServerDatabase(context)` is false) geeft de loader een leeg
  voorbeeld in plaats van een fout.

Controle:

```bash
pnpm build
npx vite preview --port 4319 --strictPort &
curl -s http://127.0.0.1:4319/<pad> | grep -E '<title>|og:'
curl -sI http://127.0.0.1:4319/<pad> | grep -i cache-control
kill %1
```

Gebruik een eigen poort: staat 4173 al open, dan krijg je stilletjes de pagina van een ander
project.

Goed als: de HTML van de server heeft titel, omschrijving, `og:`-tags en canonical, en
`Cache-Control` is `public, max-age=...` alleen op een pagina die voor iedereen gelijk is.

## Stap 8: De rechten in de database

Zet in `stack.config.json` `"klantportaal": true`, haal `open_tabellen` weg (een klantportaal
kent ze niet) en draai `node scripts/guard-rls.mjs`. Dat geeft de complete lijst. Schrijf één
migratie, `supabase/migrations/<tijd>_klantportaal.sql`:

1. De inhoud van de migratie `*_klantportaal.sql` van de template, ongewijzigd:
   `sessie_via_cloudflare()`, `is_medewerker()`, `is_goedgekeurde_klant()`,
   `klant_aanmelden()` en de tabel `klanten`. Pas die basis niet aan, ook geen kolom of recht
   erbij in `klanten`: de databasecontrole vergelijkt hem met de template (de tekst van de
   functies, de trigger, de kolommen en de rechten). Wil de app iets bij een klant bewaren, dan
   in een eigen tabel ernaast, zoals `klant_afwijzingen` in de voorbeeldwinkel.
2. De eigen rolfuncties van de app (`is_beheerder()`, `is_inkoper()`) worden eigen poorten, met
   een reden in `klantportaal_poorten`. Een eigen poort heeft een vaste vorm: `language sql`,
   zonder argumenten, één uitdrukking met een poort van de template als harde eis
   (`select public.is_medewerker() and exists (...)`). Een functie die geen ja of nee geeft
   (`mijn_rol()`, `mijn_bedrijf_id()`) is geen poort: die krijgt de poort in haar eigen `where`
   en staat met een reden in `klantportaal_vrije_functies`. Gooi elke regel weg die een recht
   aan een e-mailadres of een koppeling (`auth.identities`) hangt zonder sessie via Cloudflare.
3. Per tabel één poort, voluit geschreven (geen `do`-lus: de guard leest de tekst):

   ```sql
   create policy "<tabel>_poort" on public.<tabel> as restrictive for all to authenticated
     using (public.is_medewerker() or public.is_goedgekeurde_klant())
     with check (public.is_medewerker() or public.is_goedgekeurde_klant());
   ```

4. Elke policy met `using (true)` voor `authenticated`: `drop policy` en meteen dezelfde naam
   opnieuw, met de poort.
5. Elke view zonder `security_invoker`: opnieuw maken met `with (security_invoker = true)`. Moet
   hij de tabellen toch zelf lezen (zoals `wagen_overzicht`, die de voorraad verbergt), zet de
   poort dan als harde eis in de `where` en de view met een reden in
   `klantportaal_vrije_functies`. Een view die voor iedereen met een account open stond, is na
   de omzetting voor iemand met alleen een e-mailadres dicht; dat is de bedoeling.
6. Elke `security definer`-functie die een ingelogde gebruiker mag aanroepen: met een reden in
   `klantportaal_vrije_functies`, en de poort zelf erin (`language sql`: één select met de
   poort in de `where`; `plpgsql`: begin met `if not public.is_goedgekeurde_klant() then raise
   ...`). Een functie voor bezoekers zonder inlog (een link met een code) staat ook in
   `klantportaal_openbaar`; Supabase geeft `anon` elke nieuwe functie, dus trek dat bij de rest
   in (`revoke execute ... from public, anon`).
7. Elke tabel krijgt een A/B-test in `tests/rls/` (`controleerAfscherming`): bij een
   klantportaal is `guard:rls-tests` zonder die test rood, ook voor een tabel van medewerkers
   (dan maakt `admin` de rij van A).

Elke naam die je in een van de drie lijsten zet, bevestig je in de PR-tekst met de regel
`Bevestigd: klantportaal vrijgegeven: <naam>`; zonder die regel is `guard:rls` rood. Lees
eerst wat de functie of view teruggeeft: geen controle kan zien wat hij doet.

**Een eigen aanmelding.** Na elke inlog per mail roept de server `klant_aanmelden()` aan: die
zet het account op de lijst `klanten`, niet goedgekeurd. Heeft de app een eigen stap (een
account koppelen aan een bedrijf), schrijf dan een eigen functie die eerst
`public.klant_aanmelden()` aanroept en daarna de eigen stap doet, zet hem met een reden in
`klantportaal_vrije_functies`, en zet de naam in `stack.config.json`:

```json
"klantportaal_aanmelden": "relatie_aanmelden"
```

`guard:rls` controleert dat die functie bestaat. Zonder die regel blijft het
`klant_aanmelden`.

**Een eigen tabel `klanten`.** Heeft de app al een tabel `klanten` met een andere betekenis
(een klantenbestand, debiteuren), dan botst die met de tabel van de template. Hernoem eerst
die van de app, in een eigen pull request vóór de omzetting (`alter table public.klanten
rename to relaties;`, de code en de types mee), en laat `public.klanten` aan de template.
Een eigen "goedgekeurd" (een account dat aan een bedrijf hangt) wordt een eigen poort,
bijvoorbeeld `is_klant_van_bedrijf()`, die `public.is_goedgekeurde_klant()` aanroept en de
eigen koppeling controleert, met een reden in `klantportaal_poorten`. Geef de tabel van de
template geen andere naam en herschrijf `is_goedgekeurde_klant()` niet.

**Let op bij het hernoemen van een eigen tabel `klanten`.** `alter table ... rename` past
policies, views, sleutels en triggers vanzelf aan, maar niet de tekst van een functie. Een functie
met `klanten%rowtype`, `from klanten` of `public.klanten` in haar body wijst na het hernoemen nog
steeds naar de naam `klanten`, en dus straks naar de tabel van de template: zonder foutmelding,
met de verkeerde gegevens. Zoek ze op (`grep -rn "klanten" supabase/migrations`, en in de
database `select proname from pg_proc where prosrc ~ '\mklanten\M'`) en schrijf elke gevonden
functie in dezelfde migratie opnieuw met `create or replace`, met de nieuwe naam.

Tot de databasejob de types maakt: draai na de push `pnpm db:types:uit-ci`.

Goed als: `node scripts/guard-rls.mjs`, `node scripts/guard-rls-tests.mjs` en
`node scripts/guard-migrations.mjs` zijn groen (zet de bevestigingsregels lokaal in `PR_BODY`).
De sluitende controle draait in de databasejob op de database zelf
(`tests/rls/open-policies.test.ts`); het logboek daarvan noemt wat er is vrijgegeven.

Gaat het mis: de guard leest de tekst, niet het gedrag. Een view die met de poort ineens leeg
is voor een klant, of een functie die een poort aanroept maar hem niet eist, ziet hij niet.
Dat zie je pas in stap 9.

## Stap 9: Tests in de database en in de browser

- **RLS-tests** (`tests/rls/`): een test die een medewerker nadoet met een wachtwoord of een
  koppeling in `auth.identities`, doet nu een sessie via Cloudflare na. De hulp daarvoor komt
  met het manifest mee: `tests/rls/lib/sessies.ts` en `tests/rls/lib/inlogdienst-nep.ts`.
  Tests die het oude model beschrijven ("een klant via Cloudflare is klant"), herschrijf je
  naar het nieuwe ("per mail is iedereen klant; zonder goedkeuring niets"). Zet per tabel een
  test erbij: alleen een e-mailadres ziet niets.
- **Edge Functions** werken door met het token van de gebruiker; wie daar RLS of een
  rolfunctie gebruikt, volgt de nieuwe poorten vanzelf.
- **Browsertests** (`e2e/`): inloggen als medewerker gaat met `e2e/medewerker.ts`, als klant
  met de code uit de mail (`e2e/inloggen.ts`).
- **De testgebruiker** is een goedgekeurde klant (`supabase/testrol.sql` van de template),
  nooit medewerker. Een `testrol.sql` die hem beheerder maakte, geeft hem nu niets: schermen
  voor medewerkers bekijk je op de preview met de knop voor medewerkers. Zie
  `docs/routes/lokaal-kijken.md`.

Goed als: de databasejob en de browsertests in de pull request zijn groen.

## Stap 10: Afronden

```bash
PR_BODY="Bevestigd: templatebestanden gewijzigd" pnpm check
pnpm build
```

Eén pull request, als concept, met in de tekst:

- **wat er voor gebruikers verandert**: iedereen logt één keer opnieuw in (de sessie staat nu
  in een cookie); klanten loggen in met een code per mail, medewerkers met de knop voor
  Cloudflare; het adres van de app blijft hetzelfde;
- de migratie met haar `-- uitleg:`-regels, en welke tabellen nu een poort hebben;
- welke schermen browser-scherm bleven en welke vindbaar werden;
- wat er in `browser` in `stack.config.json` staat, en waarom.

**Wat de owner daarna doet.** Na de merge, in de beheer-repo: de deur van Cloudflare voor het
eigen domein uitzetten, de inlog per mail (de code) aanzetten in Supabase, en
`VITE_INLOGDIENST` op `cloudflare,mailcode` zetten (met `"klantportaal_inloggen": "account"` in
`toegang.json`: `cloudflare,wachtwoord`, zie "Klantaccounts" in `docs/WERKWIJZE.md`). Zolang dat niet gebeurd is, toont de app
in productie "Deze app is nog niet ingericht" in plaats van een inlogformulier dat nergens
werkt. Dat is werk van de owner, niet van de bouwer: zeg het de bouwer, en wacht er niet op.

## Valkuilen

| Wat | Waarom het misgaat | Wat je doet |
|---|---|---|
| Een teller of "geopend op" in een loader | Een loader draait ook als WhatsApp of Google de link opent, en ook vanaf een andere site | Een aparte functie die alleen leest; bijwerken in een `action` |
| Een view die voor iedereen met een account open stond | Op een open domein heeft iedereen op internet een account | `security_invoker = true`, of de poort in de `where` en een reden in `klantportaal_vrije_functies` |
| Een kolom erbij in `klanten` | De databasecontrole vergelijkt `klanten` met de template | Een eigen tabel ernaast, zoals `klant_afwijzingen` |
| Een oud scherm rechtstreeks geïmporteerd in een route | Het scherm en alles wat het importeert, komt in de Worker | Altijd via een `.client.tsx`-bestand en `browserScherm` |
| De Worker wordt groot | Elke start leest de hele Worker in; de grens van Cloudflare is ruim (64 MB), maar elke megabyte maakt de eerste pagina trager | Zware bibliotheken alleen in browser-schermen; meet met `pnpm build` en `ls -l dist/server/assets` |
| Afbeeldingen van een leverancier blijven leeg | De Content-Security-Policy staat ze niet toe | `browser.afbeeldingen_van` in `stack.config.json`, met een reden |
| Een tabel `klanten` van de app zelf | Botst met de tabel van de template | Eerst hernoemen, in een eigen pull request |
| De testgebruiker ziet de schermen voor medewerkers niet | Medewerker kan alleen via Cloudflare | De preview, met de knop voor medewerkers |
