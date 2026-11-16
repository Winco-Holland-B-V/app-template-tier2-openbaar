# Een webshop op deze stack

Deze template maakt elke pagina op de server. Daardoor kunnen Google, AI-zoekers en WhatsApp
een productpagina lezen, en kan een klant inloggen en zijn eigen prijzen zien. De voorbeeldshop
in de template laat zien hoe dat samen veilig gaat. Het is een **klantportaal**: klanten loggen
in met een code per mail, medewerkers via Cloudflare, en er staat geen deur van Cloudflare
voor het domein.

| Adres | Wie | Wat |
|---|---|---|
| `/` | iedereen | de startpagina: alle zichtbare producten (`/producten` stuurt hierheen door) |
| `/producten/<slug>` | iedereen | één product; een goedgekeurde klant ziet ook zijn eigen prijs en de knop "In winkelwagen" |
| `/login` | iedereen | inloggen: klanten met een code per mail, medewerkers met de knop (zie "Inloggen" hieronder) |
| `/wagen` | goedgekeurde klant | je winkelwagen en de knop "Bestellen" |
| `/bestellingen` | goedgekeurde klant | je eigen bestellingen |
| `/klanten` | medewerker | wie zich heeft aangemeld: zoeken op e-mailadres, filteren, bladeren, goedkeuren, afwijzen en intrekken |
| `/sitemap.xml`, `/robots.txt` | zoekmachines | de lijst met pagina's en de regels |

Wie is ingelogd maar nog niet is goedgekeurd, ziet op `/wagen`, `/bestellingen` en bij een
product "Je account wacht op goedkeuring", en verder wat een bezoeker zonder inlog ziet.

De bestanden: `src/routes/winkel/`, `src/features/winkel/`, `src/routes/sitemap.ts`,
`src/routes/robots.ts` en de migratie `supabase/migrations/20261114120000_voorbeeldshop.sql`.
Het inloggen staat in `src/routes/login.tsx`, `src/routes/login-terug.ts` en
`src/features/auth/`, met de migratie `20261114100000_klantportaal.sql`.
Die zijn van je app: pas ze aan, of gooi ze weg als je geen winkel hebt (zie onderaan).
De voorbeeldgegevens (vijf producten en twee goedgekeurde testklanten met elk een eigen prijs)
staan in `supabase/seed.sql`; die draaien alleen lokaal en in de checks, nooit op een echte
database.

Lees eerst `docs/WERKWIJZE.md`, "Code op de server". Hieronder staan de regels die er voor een
winkel bij komen.

## Regel 1: de prijs en de voorraad bepaalt de database

Bij het bestellen stuurt de pagina alleen "bestel mijn wagen", een sleutel tegen dubbel
klikken en het totaal dat de klant op de wagenpagina zag. De databasefunctie
`bestelling_plaatsen(p_sleutel, p_verwacht_totaal)` doet de rest, in één keer:

- ze rekent de prijs zelf uit (de prijs van deze klant, anders de gewone prijs);
- ze vergelijkt haar eigen totaal met wat de klant zag; is het anders (een medewerker wijzigde
  intussen een prijs, of de wagen veranderde in een ander tabblad), dan plaatst ze niets
  (foutcode `SP004`, met het nieuwe totaal in `detail`) en toont de wagenpagina "De prijs is
  gewijzigd. Bekijk je wagen opnieuw." met het nieuwe bedrag. Het verwachte totaal zet de
  server in een verborgen veld bij het tonen van de wagen; de functie gebruikt het alleen om te
  vergelijken, nooit als prijs. Zo bestelt een klant op rekening nooit een bedrag dat hij niet
  heeft gezien;
- ze controleert de voorraad en boekt hem af; is er te weinig, dan gebeurt er niets;
- dezelfde sleutel twee keer (dubbel klikken, opnieuw versturen) geeft één bestelling. Werd de
  wagen daartussen anders, dan is het nog steeds de eerste bestelling: de bevestiging op
  `/bestellingen` toont daarom welke bestelling het is (datum en regels), en zegt het als er
  nog regels in de wagen liggen die dus niet zijn besteld.

**Lees de wagen één keer, onder slot.** Een klant kan tijdens het bestellen in een ander
tabblad iets in zijn wagen leggen. Leest een functie de wagen voor het totaal, voor de regels,
voor de voorraad en voor het legen elk opnieuw, dan krijgt hij een bon van één euro met een
volle wagen aan regels, en is de voorraad wel afgeboekt. `bestelling_plaatsen()` doet het
daarom zo, en zo bouw je elke functie die een wagen, een mandje of een offerte omzet:

1. eerst het slot per klant (`pg_advisory_xact_lock`); elke schrijfactie op de wagen wacht op
   hetzelfde slot (de trigger `wagen_slot_per_klant`), ook een insert of update rechtstreeks
   via de API;
2. dan de wagenregels **één keer** lezen, met `for update` en in een vaste volgorde, in een
   lijst;
3. de producten op slot, in dezelfde vaste volgorde, met `for no key update` en niet met
   `for update`. Elke wagenregel zet via zijn foreign key een licht slot op het product
   (`for key share`); `for update` botst daarmee, en dan kan één klant die zijn eigen wagen
   in een omgekeerde volgorde vult en leegt, de bestellingen van anderen laten vastlopen. `for
   no key update` houdt elke andere schrijver op die rijen net zo goed tegen (een tweede
   bestelling, een prijswijziging, het weghalen van het product) en is precies het slot dat
   het afboeken van de voorraad toch vraagt (PostgreSQL, "Explicit Locking", rijsloten);
4. prijs, totaal, bestelregels, voorraadcontrole, afboeken en het legen van de wagen allemaal
   uit die ene lijst; bij het legen precies de gelezen regels (op sleutel én aantal), zodat
   een regel die er tussendoor bij kwam in de wagen blijft;
5. aan het eind de controle dat het totaal van de bon de som van zijn regels is; klopt dat niet,
   dan gaat alles terug.

Een deadlock is daarmee tussen klanten verholpen, maar niet uit te sluiten: een medewerker die
veel producten in één keer wijzigt of weghaalt, kan een bestelling laten stranden (`40P01`). De
bestelling is dan helemaal teruggedraaid; de wagenpagina probeert het met dezelfde sleutel één
keer opnieuw en zegt anders "Bestellen lukte even niet. Probeer het opnieuw." Nooit een kale
fout.

In de wagen mag een klant alleen het aantal wijzigen (`grant update (aantal)`): met een eigen
`product_id` zou hij een verborgen product in zijn wagen kunnen zetten. De RLS-tests bewaken
het slot, de kolomrechten en de race (150 keer tegelijk bestellen en de wagen wijzigen).

Een prijs, een korting of een totaal uit de browser of uit de servercode gebruik je dus nooit.
Ook niet "even" in een action: wat de browser stuurt, kan iedereen veranderen. Een klant kan
een bestelling ook niet achteraf wijzigen: bestellingen en bestelregels zijn voor hem alleen
te lezen.

Bedragen staan overal in **hele centen** (`1495`, niet `14.95`). Op het scherm worden het
euro's met `euro()` uit `src/features/winkel/geld.ts`.

## Regel 2: een openbare pagina toont nooit een klantprijs

Er zijn twee wegen naar de catalogus, en die blijven gescheiden:

- **Openbaar**: de functie `openbare_producten()`. Alleen zichtbare producten, de gewone prijs,
  en of er voorraad is (niet hoeveel). Dit is de enige weg voor een bezoeker zonder inlog;
  geen tabel staat voor hem open. Alles wat in JSON-LD, in de sitemap of in een gedeelde
  link terechtkomt, komt hier vandaan.
- **Van de klant**: de tabel `klantprijzen`. De regels in de database geven elke
  goedgekeurde klant alleen zijn eigen regels, en wie niet is goedgekeurd niets.
- **Hoeveel er op voorraad is**, ziet alleen een medewerker. Ook een goedgekeurde klant leest
  de tabel `producten` niet: hij krijgt "op voorraad" ja of nee (de catalogus) en "genoeg voor
  dit aantal" (de view `wagen_overzicht`). Ook de melding bij te weinig voorraad (`SP002`)
  noemt alleen het product: "Van X is niet genoeg op voorraad; pas het aantal aan." Eerlijk
  is wel: met dat ja of nee kan een klant de voorraad uithoren door het aantal in zijn wagen
  te halveren en opnieuw te kijken (tot 99 per regel, dus in ongeveer zeven pogingen). Dat is
  niet dicht te zetten zonder hem "genoeg voor dit aantal" te onthouden; zie "Keuzes per
  winkel".

Een pagina mag beide tonen ("Jouw prijs € 11,00, normaal € 14,95"), maar de JSON-LD bevat
altijd de gewone prijs. Een klantprijs in JSON-LD kan bij Google of in een cache belanden.

## Regel 3: wat in een cache mag

Een openbare pagina vraagt met `openbaarCache(context, { seconden: 300 })` om een cache. De
Worker geeft die alleen als de bezoeker geen cookie heeft en niemand is ingelogd. Zodra een
klant is ingelogd, is hetzelfde adres `private, no-store`, wat de route ook vraagt. Zo kan
de pagina met de prijs van klant A nooit bij klant B of bij een bezoeker uitkomen.

| Pagina | Zonder inlog | Ingelogd |
|---|---|---|
| `/`, `/producten/<slug>` | 5 minuten openbaar | nooit bewaard |
| `/sitemap.xml` | 1 uur | nooit bewaard |
| `/robots.txt` | 1 dag | nooit bewaard |
| `/wagen`, `/bestellingen`, `/klanten` | (stuurt naar het inloggen) | nooit bewaard |
| `/login`, `/login/terug` | nooit bewaard | nooit bewaard |

Zet zelf nooit `Cache-Control`. Een product dat je wijzigt, is dus hoogstens vijf minuten oud
te zien.

## Regel 4: elke pagina vindbaar, in drie regels

Twee hulpfuncties van de template doen het werk: `paginaMeta` (`src/lib/vindbaar/meta.ts`)
en de JSON-LD-functies (`src/lib/vindbaar/json-ld.ts`). Het volledige adres van de pagina
haalt de loader met `vindbaarAdres(context)` (`src/lib/vindbaar/adres.server.ts`); dat wijst
altijd naar het echte domein, ook op een preview.

```tsx
export async function loader({ context }: Route.LoaderArgs) {
  openbaarCache(context, { seconden: 300 });
  return { adres: vindbaarAdres(context).adres /* , je eigen gegevens */ };
}

export const meta: Route.MetaFunction = ({ loaderData }) =>
  paginaMeta({ site: SITE, titel: "Over ons", omschrijving: "Wie we zijn.", adres: loaderData?.adres });
```

Daarmee heeft de pagina een titel, een omschrijving, een canonical, de `og:`-tags voor een
gedeelde link en `twitter:card`. Voor een product komt er `jsonLd: [productLd({...}),
kruimelpadLd([...])]` bij; voor een lijst `itemListLd`. De naam van de site staat in
`src/site.ts`.

Een openbare pagina moet daarna in de sitemap: één regel in `src/routes/sitemap.ts`. Een pagina
die niet in Google hoort (een account, een wagen), krijgt `zoekmachines: false` en een regel
`Disallow` in `src/routes/robots.ts`.

Buiten het echte domein (workers.dev, de previews, je eigen computer) zet de Worker op elk
antwoord `noindex` en geeft hij een `robots.txt` die alles weigert. Een preview komt dus nooit in
Google, ook niet als je hier iets vergeet.

## Regel 5: snel op een telefoon

- Haal de gegevens van een pagina in de loader, in één keer (`Promise.all` als het er twee
  zijn). Niet in de browser na het laden: dat is een tweede wachttijd.
- Een afbeelding krijgt `width` en `height`. De belangrijkste (bovenaan) laadt meteen met
  `fetchPriority="high"`; de rest met `loading="lazy"`. `ProductAfbeelding` doet dat.
- Geen lettertypen van een andere site en geen zware scripts (chat, tracking) zonder
  overleg: elk ervan maakt de eerste weergave trager.
- Formulieren (in de wagen, bestellen) zijn gewone formulieren met een action. Ze werken
  zonder JavaScript; met JavaScript blijft de pagina staan en verschijnt de uitkomst ernaast.

## Betalen

Betalen zit er niet standaard in: de voorbeeldshop werkt op rekening. Een betaalprovider
(Mollie, Stripe) heeft een geheime sleutel en stuurt berichten terug (een webhook). Beide
horen in een **Supabase Edge Function**, met de sleutel als geheim; nooit in de Worker. Hoe
dat gaat staat in `docs/WERKWIJZE.md` (sleutels van andere systemen). Het zetten van die
sleutel doet de owner. Bouw dit pas als een klant erom vraagt.

## Regel 4: een account alleen geeft niets

Iedereen op internet kan op `/login` een e-mailadres invullen en heeft dan een account.
"Ingelogd" betekent in een klantportaal dus niets. Daarom gaat elke regel in de database langs
een van twee poorten (de migratie `klantportaal`):

- `public.is_goedgekeurde_klant()`: een medewerker heeft dit account goedgekeurd. Alleen dan
  is er een eigen prijs, een wagen en een bestelling. `bestelling_plaatsen()` weigert zelf
  ook, met "Je account is nog niet goedgekeurd".
- `public.is_medewerker()`: de sessie is via Cloudflare begonnen, hoogstens twaalf uur
  geleden. Alleen dan beheer je producten en klantprijzen, zie je alle bestellingen en keur je
  klanten goed.

Per mail is een medewerker gewoon klant, ook op zijn werkadres: wie bij die mailbox kan, mag
daarmee geen medewerker zijn. De schakelaar `"klantportaal": true` in `stack.config.json` laat
`pnpm guard:rls` elke nieuwe policy, functie en view op die poort controleren, en in de
databasejob nog eens op de database zelf. Vier namen staan bewust vrij, met de reden erbij in
`klantportaal_vrije_functies`: `openbare_producten()` (de catalogus, ook in
`klantportaal_openbaar` omdat bezoekers zonder account hem lezen), `product_te_koop()`,
`bestelling_plaatsen()` en de view `wagen_overzicht`. De laatste drie hebben de poort zelf in
zich, als harde eis. Zet je zelf een naam op zo'n lijst, dan bevestigt de pull request dat met
`Bevestigd: klantportaal vrijgegeven: <naam>`. Elke tabel heeft een A/B-test in
`tests/rls/voorbeeldshop.test.ts`; bij een klantportaal is die verplicht. Meer uitleg:
`docs/WERKWIJZE.md`, het stuk over het klantportaal.

De server besluit hier niets over. Een pagina vraagt de database wat deze sessie is
(`klantstand(context, wie)` en `medewerkersessie(context, wie)` uit
`src/features/auth/medewerkersessie.server.ts`) om de juiste uitleg te tonen, en leest daarna
met de sessie van de bezoeker. Slaat een pagina die vraag over, dan geeft de database nog
steeds niets.

## Inloggen

De inlogpagina `/login` maakt de server, en elk onderdeel is een gewoon formulier: het werkt
ook zonder JavaScript.

- **Klant**: e-mailadres invullen, de code van tien cijfers uit de mail overtypen. De mail
  bevat ook een link; die toont eerst een knop, en waarschuwt als de mail niet in deze browser
  is aangevraagd. Een nieuwe klant staat daarna op de lijst van `/klanten`, niet goedgekeurd.
- **Medewerker**: de knop "Inloggen voor medewerkers". De server begint de inlog bij Cloudflare
  en maakt hem af op `/login/terug`.
- **Uitloggen** en de knop voor medewerkers staan ook op `/login` voor wie al is ingelogd; de
  link "Account" in de kop van de winkel gaat daarheen.

Na het inloggen gaat de bezoeker naar de pagina waar hij heen wilde (`?volgende=`, alleen een
pad binnen de app) en staat er kort bovenin op welk adres hij binnen is. Welke manieren van
inloggen aan staan, komt uit `VITE_INLOGDIENST` (`cloudflare,mailcode`; de inrichting zet dat).
Lokaal en met de testgebruiker is het `wachtwoord`; een klantportaal in productie kent dat niet.

Een scherm voor medewerkers bouw je zoals `src/routes/winkel/klanten.tsx`: `vereisGebruiker`,
dan `medewerkersessie(context, wie)`, en bij `"verlopen"` de melding
`<OpnieuwAlsMedewerker terug="/pad" />` in plaats van een leeg scherm.

## Keuzes per winkel

Vier dingen regelt de voorbeeldshop bewust niet, omdat het antwoord per klant verschilt. Vraag
ze na voordat een winkel live gaat:

- **Een maximum per bestelling of per dag.** De voorbeeldshop werkt op rekening: een
  goedgekeurde klant kan in één keer de hele voorraad bestellen, en dan is het product voor
  iedereen uitverkocht. Voor een groothandel is dat gewoon; voor een winkel met schaarse
  artikelen niet. Wil de klant een grens, zet die dan in `bestelling_plaatsen()` (een aantal
  per regel, een bedrag per bestelling, of een totaal per klant per dag), met een eigen
  foutcode zoals de andere.
- **De voorraad tonen aan klanten.** Standaard ziet alleen een medewerker hoeveel er is. Wil
  de winkel het aantal wél tonen, zet het dan bewust aan: een eigen kolom in de view
  `wagen_overzicht` en, als je wilt, het getal terug in de melding bij `SP002`.
- **Meer dan een e-mailadres bij het aanmelden.** Op `/klanten` ziet een medewerker nu alleen
  het adres. Daarop goedkeuren is een gok. Vraag bij het aanmelden ook de bedrijfsnaam en het
  klantnummer (in een eigen tabel naast `klanten`, zoals `klant_afwijzingen`, ingevuld via een
  eigen aanmeldfunctie: `klanten` zelf blijft die van de template), zodat de medewerker iemand
  herkent of eerst kan bellen.
- **Adressen die op elkaar lijken.** `inkoop@bakkerij-jansen.nl` en
  `inkoop@bakkerij-jansen.n1` of `inkoop@bakkerlj-jansen.nl` zien er in een lijst hetzelfde uit,
  en een adres kan letters uit een ander schrift bevatten. Leer medewerkers het hele adres te
  lezen en bij twijfel te bellen; een winkel met veel aanmeldingen kan het domein naast een
  lijst van bekende klantdomeinen leggen en een afwijkend domein laten opvallen.

## Geen winkel nodig?

Let op: de browsertests van de template (`e2e/server-beveiliging.spec.ts` en
`e2e/server-sessie.spec.ts`) gebruiken de winkel als proefpagina's (`/`, een productpagina en
`/wagen`, met de tabellen `producten` en `klantprijzen`). Haal je de winkel weg, dan worden
die rood; `guard:testlat` laat ze niet overslaan. Laat in dat geval de winkel staan en geef je
eigen schermen een eigen adres.

Wil je hem toch weg: haal de regels voor `/`, `/producten`, `/wagen`, `/bestellingen` en `/klanten` uit
`src/routes.ts` en `src/onderdelen.ts`, en gooi `src/routes/winkel/` en `src/features/winkel/` weg. De tabellen
blijven dan bestaan tot een migratie ze opruimt (`drop table`, zie
`docs/routes/databasewijziging.md`). De hulpfuncties voor vindbaarheid en de sitemap blijven
bruikbaar voor elke openbare pagina.
