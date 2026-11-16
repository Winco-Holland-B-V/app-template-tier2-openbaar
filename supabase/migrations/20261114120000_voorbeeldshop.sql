-- De voorbeeldshop: producten, een prijs per klant, een winkelwagen en bestellingen.
--
-- Drie regels, die voor elke webshop op deze stack gelden (docs/routes/webshop.md):
--
--   1. De prijs en de voorraad bepaalt de database. De browser en de server sturen bij het
--      bestellen alleen "bestel mijn wagen" en een sleutel tegen dubbel klikken; de prijs
--      rekent bestelling_plaatsen() zelf uit, en de voorraad boekt hij in dezelfde
--      transactie af.
--   2. Een anonieme bezoeker leest de catalogus alleen via openbare_producten(): zichtbare
--      producten met de basisprijs, verder niets. Geen tabel staat open voor `anon`.
--   3. Een goedgekeurde klant ziet alleen zijn eigen prijs, wagen en bestellingen.
--
-- De winkel is een klantportaal (de migratie `klantportaal` hiervoor, en
-- `"klantportaal": true` in stack.config.json). Iedereen kan per mail een account maken, dus
-- een account alleen geeft niets. Elke regel hieronder gaat langs een van de twee poorten:
--
--   public.is_goedgekeurde_klant()   een medewerker heeft dit account als klant goedgekeurd;
--   public.is_medewerker()           de sessie is via Cloudflare begonnen.
--
-- Wie alleen is ingelogd, ziet wat een bezoeker zonder inlog ziet: de openbare catalogus.
-- Een medewerker beheert de producten en de klantprijzen en ziet alle bestellingen.
--
-- Bedragen staan overal in hele centen (integer), nooit als kommagetal.

-- Een aanmelding afwijzen. De tabel klanten komt uit het klantportaal en blijft precies zoals
-- de template hem maakt: de databasecontrole vergelijkt zijn kolommen en rechten met de
-- template (scripts/lib/klantportaal-basis.json), want daar hangt de goedkeuring aan. Een
-- afwijzing staat daarom in een eigen tabel ernaast, alleen voor medewerkers. Een afgewezen
-- account is niet goedgekeurd, dus is_goedgekeurde_klant() blijft nee, en komt bij een
-- volgende inlog niet opnieuw op de wachtlijst: klant_aanmelden() laat een bestaande regel
-- staan, en de afwijzing blijft bestaan. De pagina /klanten leest klanten_overzicht en
-- wijzigt via klant_beoordelen(), zodat goedkeuren en afwijzen samen in één transactie gaan.
create table public.klant_afwijzingen (
  user_id uuid primary key references public.klanten (user_id) on delete cascade,
  afgewezen_op timestamptz not null default now()
);

revoke all on public.klant_afwijzingen from public, anon, authenticated;
alter table public.klant_afwijzingen enable row level security;
grant select, insert, update, delete on public.klant_afwijzingen to authenticated;
create policy "klant_afwijzingen_medewerker"
  on public.klant_afwijzingen
  for all
  to authenticated
  using ((select public.is_medewerker()))
  with check ((select public.is_medewerker()));

-- Klanten met hun stand, voor de pagina /klanten. Met security_invoker: de policies van
-- klanten en klant_afwijzingen gelden gewoon, dus alleen een medewerker ziet hier iets van
-- een ander. Goedgekeurd gaat voor: wie goedgekeurd is, staat nooit als afgewezen.
create view public.klanten_overzicht
with (security_invoker = true)
as
select
  k.user_id,
  k.e_mail,
  k.goedgekeurd,
  (a.user_id is not null and not k.goedgekeurd) as afgewezen,
  k.aangemeld_op
from public.klanten k
left join public.klant_afwijzingen a on a.user_id = k.user_id;

revoke all on public.klanten_overzicht from public, anon, authenticated;
grant select on public.klanten_overzicht to authenticated;

-- Goedkeuren, afwijzen of de goedkeuring intrekken, in één transactie. Met de rechten van de
-- medewerker zelf (security invoker): de policies van het klantportaal beslissen, en wie geen
-- medewerker is, wijzigt niets (dan volgt een fout, 42501).
create function public.klant_beoordelen(p_klant uuid, p_doe text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_gewijzigd integer;
begin
  if p_doe not in ('goedkeuren', 'afwijzen', 'intrekken') then
    raise exception 'Onbekende beoordeling.' using errcode = '22023';
  end if;
  update public.klanten
     set goedgekeurd = (p_doe = 'goedkeuren')
   where user_id = p_klant;
  get diagnostics v_gewijzigd = row_count;
  if v_gewijzigd <> 1 then
    raise exception 'Alleen een medewerker beoordeelt een klant.' using errcode = '42501';
  end if;
  if p_doe = 'afwijzen' then
    insert into public.klant_afwijzingen (user_id) values (p_klant)
      on conflict (user_id) do nothing;
  elsif p_doe = 'goedkeuren' then
    delete from public.klant_afwijzingen where user_id = p_klant;
  end if;
end;
$$;

create table public.producten (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 80),
  naam text not null check (char_length(naam) between 1 and 120),
  omschrijving text not null default '' check (char_length(omschrijving) <= 2000),
  -- Een pad in de app (/voorbeeldshop/koffie.png) of een adres in Supabase Storage. Vierkant,
  -- 800 bij 800 pixels: de pagina's rekenen daarop voor width en height. Geen backslash, spatie
  -- of stuurteken: een browser leest `/\elders.example/x.png` als `//elders.example/x.png`, een
  -- adres op een ander domein.
  afbeelding text check (
    afbeelding is null
    or (afbeelding ~ '^(/[^/]|https://)' and afbeelding !~ '[\\[:space:][:cntrl:]]')
  ),
  basisprijs_centen integer not null check (basisprijs_centen >= 0),
  voorraad integer not null default 0 check (voorraad >= 0),
  zichtbaar boolean not null default false,
  bijgewerkt_op timestamptz not null default now()
);

comment on table public.producten is
  'De catalogus. Anoniem alleen via openbare_producten(); ingelogd alleen zichtbare producten.';

create function public.producten_bijgewerkt()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.bijgewerkt_op := now();
  return new;
end;
$$;

-- Alleen bij een wijziging die een bezoeker ziet; een bestelling (voorraad) telt niet mee,
-- anders verandert de datum in de sitemap bij elke verkoop.
create trigger producten_bijgewerkt
  before update of slug, naam, omschrijving, afbeelding, basisprijs_centen, zichtbaar
  on public.producten
  for each row execute function public.producten_bijgewerkt();

-- De prijs van één klant voor één product. Ontbreekt de regel, dan geldt de basisprijs.
create table public.klantprijzen (
  id uuid primary key default gen_random_uuid(),
  -- Een prijs is er alleen voor wie zich als klant heeft aangemeld (tabel klanten).
  klant_id uuid not null references public.klanten (user_id) on delete cascade,
  product_id uuid not null references public.producten (id) on delete cascade,
  prijs_centen integer not null check (prijs_centen >= 0),
  unique (klant_id, product_id)
);

create table public.winkelwagen_regels (
  id uuid primary key default gen_random_uuid(),
  klant_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  product_id uuid not null references public.producten (id) on delete cascade,
  aantal integer not null check (aantal between 1 and 99),
  unique (klant_id, product_id)
);

create table public.bestellingen (
  id uuid primary key default gen_random_uuid(),
  klant_id uuid not null references auth.users (id) on delete cascade,
  -- Gemaakt door de server bij het tonen van de wagen; twee keer klikken stuurt dezelfde.
  sleutel uuid not null,
  totaal_centen bigint not null check (totaal_centen >= 0),
  geplaatst_op timestamptz not null default now(),
  unique (klant_id, sleutel)
);

create index bestellingen_klant_geplaatst_idx on public.bestellingen (klant_id, geplaatst_op desc);

create table public.bestelregels (
  id uuid primary key default gen_random_uuid(),
  bestelling_id uuid not null references public.bestellingen (id) on delete cascade,
  product_id uuid references public.producten (id) on delete set null,
  -- De naam en prijs op het moment van bestellen: een latere wijziging verandert de bon niet.
  naam text not null,
  aantal integer not null check (aantal between 1 and 99),
  stukprijs_centen integer not null check (stukprijs_centen >= 0)
);

create index bestelregels_bestelling_idx on public.bestelregels (bestelling_id);

-- Supabase geeft `anon` en `authenticated` standaard alle rechten op een nieuwe tabel. Hier
-- gaat alles eerst dicht; daarna komt per tabel alleen terug wat nodig is.
revoke all on public.producten, public.klantprijzen, public.winkelwagen_regels,
  public.bestellingen, public.bestelregels from public, anon, authenticated;

alter table public.producten enable row level security;
alter table public.klantprijzen enable row level security;
alter table public.winkelwagen_regels enable row level security;
alter table public.bestellingen enable row level security;
alter table public.bestelregels enable row level security;

-- Producten: alleen een medewerker leest en beheert de tabel. Een klant leest de catalogus via
-- openbare_producten() (met "op voorraad" ja of nee) en zijn wagen via wagen_overzicht, net
-- als iedereen: de tabel zelf zou hem de exacte voorraad laten zien, en hoeveel er nog is,
-- is bedrijfsinformatie van de winkel.
grant select, insert, update, delete on public.producten to authenticated;
create policy "producten_beheer_medewerker"
  on public.producten
  for all
  to authenticated
  using ((select public.is_medewerker()))
  with check ((select public.is_medewerker()));

-- Klantprijzen: een goedgekeurde klant leest alleen zijn eigen regels. Een prijs zetten doet
-- een medewerker.
grant select, insert, update, delete on public.klantprijzen to authenticated;
create policy "klantprijzen_select_eigen"
  on public.klantprijzen
  for select
  to authenticated
  using ((select public.is_goedgekeurde_klant()) and (select auth.uid()) = klant_id);

create policy "klantprijzen_beheer_medewerker"
  on public.klantprijzen
  for all
  to authenticated
  using ((select public.is_medewerker()))
  with check ((select public.is_medewerker()));

-- Is dit product te koop? Voor de policy van de wagen. De functie leest de tabel zelf
-- (security definer) en antwoordt daarom alleen aan wie door een poort mag. Ze staat met een
-- reden in klantportaal_vrije_functies (stack.config.json), in de vaste vorm van een vrije
-- functie: één select met de poort als harde eis in de where. Zonder poort geeft hij geen
-- rij, dus null, en dan laat de policy niets door.
create function public.product_te_koop(p_product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
           select 1 from public.producten p where p.id = p_product_id and p.zichtbaar
         )
   where public.is_goedgekeurde_klant() or public.is_medewerker()
$$;

-- Winkelwagen: de eigen regels van een goedgekeurde klant, alleen met een product dat te koop
-- is. Het aantal is het enige wat je mag wijzigen; een prijs staat er niet in.
grant select, insert, delete on public.winkelwagen_regels to authenticated;
grant update (aantal) on public.winkelwagen_regels to authenticated;

create policy "winkelwagen_select_eigen"
  on public.winkelwagen_regels
  for select
  to authenticated
  using ((select public.is_goedgekeurde_klant()) and (select auth.uid()) = klant_id);

create policy "winkelwagen_insert_eigen"
  on public.winkelwagen_regels
  for insert
  to authenticated
  with check (
    (select public.is_goedgekeurde_klant())
    and (select auth.uid()) = klant_id
    and public.product_te_koop(product_id)
  );

create policy "winkelwagen_update_eigen"
  on public.winkelwagen_regels
  for update
  to authenticated
  using ((select public.is_goedgekeurde_klant()) and (select auth.uid()) = klant_id)
  with check ((select public.is_goedgekeurde_klant()) and (select auth.uid()) = klant_id);

create policy "winkelwagen_delete_eigen"
  on public.winkelwagen_regels
  for delete
  to authenticated
  using ((select public.is_goedgekeurde_klant()) and (select auth.uid()) = klant_id);

-- Bestellingen en bestelregels: alleen lezen. Een goedgekeurde klant ziet de eigen, een
-- medewerker ziet ze allemaal. Ze ontstaan uitsluitend in bestelling_plaatsen().
grant select on public.bestellingen, public.bestelregels to authenticated;

create policy "bestellingen_select_eigen"
  on public.bestellingen
  for select
  to authenticated
  using (
    ((select public.is_goedgekeurde_klant()) and (select auth.uid()) = klant_id)
    or (select public.is_medewerker())
  );

create policy "bestelregels_select_eigen"
  on public.bestelregels
  for select
  to authenticated
  using (
    (
      (select public.is_goedgekeurde_klant())
      and exists (
        select 1 from public.bestellingen b
         where b.id = bestelling_id and b.klant_id = (select auth.uid())
      )
    )
    or (select public.is_medewerker())
  );

-- De wagen met naam en prijs, voor de pagina /wagen. De view leest de tabellen zelf (zonder
-- security_invoker): een klant leest de tabel producten niet, en zou anders de exacte voorraad
-- zien. Daarom staan de grenzen hier in de vraag zelf: alleen de eigen regels, alleen voor een
-- goedgekeurde klant (de poort), alleen zichtbare producten, alleen de eigen prijs, en van de
-- voorraad alleen of er genoeg is voor dit aantal.
-- De prijsregel (klantprijs, anders basisprijs) is dezelfde als in bestelling_plaatsen().
-- Een product dat intussen niet meer te koop is, blijft als regel staan (`te_koop` is dan
-- false, zonder naam en prijs), zodat de klant ziet waarom bestellen niet lukt en hem kan
-- weghalen.
create view public.wagen_overzicht
as
select
  w.id,
  w.product_id,
  p.slug,
  p.naam,
  p.afbeelding,
  w.aantal,
  coalesce(k.prijs_centen, p.basisprijs_centen) as stukprijs_centen,
  p.id is not null as te_koop,
  coalesce(p.voorraad >= w.aantal, false) as genoeg_voorraad
from public.winkelwagen_regels w
left join public.producten p on p.id = w.product_id and p.zichtbaar
left join public.klantprijzen k on k.product_id = w.product_id and k.klant_id = w.klant_id
where w.klant_id = (select auth.uid())
  and (select public.is_goedgekeurde_klant());

revoke all on public.wagen_overzicht from public, anon, authenticated;
grant select on public.wagen_overzicht to authenticated;

-- Het slot per klant op de wagen. Elke schrijfactie op winkelwagen_regels (wagen_toevoegen,
-- en ook een insert, update of delete rechtstreeks via de API) wacht eerst op hetzelfde slot
-- als bestelling_plaatsen(). Zo verandert de wagen niet terwijl een bestelling hem leest.
-- Per statement, vóór er een rij wordt aangeraakt: dan komt het slot van de klant altijd vóór
-- de sloten op rijen. Elke regel in een wagen zet via de foreign key een licht slot op zijn
-- product (`for key share`); daarom zet bestelling_plaatsen() de producten op slot met
-- `for no key update` en niet met `for update`, dat met dat lichte slot botst (zie daar). Zo
-- lopen klanten niet op elkaar vast, ook niet als iemand zijn wagen in een vreemde volgorde
-- vult. Helemaal uitsluiten kan de database een deadlock niet: een medewerker die veel
-- producten in één keer wijzigt of weghaalt, kan een bestelling laten stranden (40P01). De
-- pagina /wagen probeert dan één keer opnieuw.
-- Zonder ingelogde gebruiker (een beheerder, de seed) is er geen klant en dus geen slot.
create function public.wagen_slot_per_klant()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is not null then
    perform pg_advisory_xact_lock(hashtextextended('winkelwagen:' || auth.uid()::text, 0));
  end if;
  return null;
end;
$$;

create trigger wagen_slot_per_klant
  before insert or update or delete on public.winkelwagen_regels
  for each statement execute function public.wagen_slot_per_klant();

-- Iets in de wagen leggen, of er meer van. Draait met de rechten van de klant zelf
-- (security invoker): de policies hierboven gelden gewoon, en de trigger hierboven zet het
-- slot per klant.
create function public.wagen_toevoegen(p_product_id uuid, p_aantal integer default 1)
returns integer
language sql
security invoker
set search_path = ''
as $$
  insert into public.winkelwagen_regels (klant_id, product_id, aantal)
  values (auth.uid(), p_product_id, least(greatest(p_aantal, 1), 99))
  on conflict (klant_id, product_id)
  do update set aantal = least(public.winkelwagen_regels.aantal + excluded.aantal, 99)
  returning aantal
$$;

-- De catalogus voor iedereen, ook zonder inlog: dit is de enige weg voor `anon`. Alleen
-- zichtbare producten, alleen de velden die op een openbare pagina mogen, met de basisprijs
-- en of er voorraad is (niet hoeveel). Nooit een klantprijs: deze functie kijkt niet naar
-- wie er vraagt.
create function public.openbare_producten(p_slug text default null)
returns table (
  id uuid,
  slug text,
  naam text,
  omschrijving text,
  afbeelding text,
  basisprijs_centen integer,
  op_voorraad boolean,
  bijgewerkt_op timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.slug, p.naam, p.omschrijving, p.afbeelding, p.basisprijs_centen,
         p.voorraad > 0, p.bijgewerkt_op
    from public.producten p
   where p.zichtbaar
     and (p_slug is null or p.slug = p_slug)
   order by p.naam
   limit 500
$$;

-- Bestellen: de wagen van de ingelogde klant wordt een bestelling, in één transactie.
--
--   * De prijs komt uit de database (klantprijs, anders basisprijs). Er is geen parameter
--     voor een prijs of een klant: je bestelt altijd je eigen wagen, tegen je eigen prijs.
--   * Te weinig voorraad, of een product dat niet meer te koop is: niets gebeurt.
--   * Dezelfde sleutel twee keer (dubbel klikken, opnieuw versturen): dezelfde bestelling,
--     geen tweede.
--   * p_verwacht_totaal is het totaal in centen dat de klant op de wagenpagina zag (de server
--     zet het in het formulier). Het is alleen een vergelijking, nooit een prijs: wijkt het
--     totaal dat de functie zelf uitrekent af (een medewerker wijzigde intussen een prijs, of
--     de wagen veranderde in een ander tabblad), dan plaatst de functie niets. Zo bestelt een
--     klant nooit voor een bedrag dat hij niet heeft gezien.
--
-- De belangrijkste regel voor wie dit nabouwt: LEES DE WAGEN ÉÉN KEER, ONDER SLOT. Een klant
-- kan tijdens het bestellen in een ander tabblad iets in zijn wagen leggen. Leest de functie
-- de wagen voor het totaal, de regels, de voorraad en het legen elk opnieuw, dan krijgt hij
-- een bon van één euro met een volle wagen aan regels. Daarom hieronder: eerst het slot per
-- klant, dan de wagenregels één keer in een lijst, en alles daarna rekent alleen met die lijst.
--
-- Fouten hebben een eigen code, zodat de pagina een nette melding kan geven:
--   SP001 de wagen is leeg, SP002 te weinig voorraad, SP003 niet meer te koop, SP004 het
--   totaal is anders dan de klant zag (het nieuwe totaal in centen staat in `detail`).
--   SP009 de bon klopt niet met zijn regels: een fout in deze functie, nooit van de klant.
-- De melding bij SP002 noemt het product, niet hoeveel er nog is: de voorraad ziet alleen een
-- medewerker (docs/routes/webshop.md, "Keuzes per winkel").
create function public.bestelling_plaatsen(p_sleutel uuid, p_verwacht_totaal bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Eerst de poort, in de vaste vorm van een vrije functie (klantportaal_vrije_functies in
  -- stack.config.json): alleen een goedgekeurde klant mag bestellen; een account alleen is
  -- niet genoeg, en zonder inlog is er geen klant. Pas daarna het blok met de variabelen.
  if not public.is_goedgekeurde_klant() then
    raise exception 'Je account is nog niet goedgekeurd.' using errcode = '42501';
  end if;
  declare
    v_klant uuid := auth.uid();
    v_bestelling uuid;
    -- De ene lezing van de wagen: per regel de sleutel, het product en het aantal.
    v_regel_ids uuid[];
    v_product_ids uuid[];
    v_aantallen integer[];
    -- Wat de functie per regel uitrekent, in dezelfde volgorde.
    v_namen text[] := '{}';
    v_stukprijzen integer[] := '{}';
    v_totaal bigint := 0;
    v_product record;
    v_klantprijs integer;
    v_geleegd integer;
  begin
  if v_klant is null then
    raise exception 'Log eerst in om te bestellen.' using errcode = '42501';
  end if;
  if p_sleutel is null then
    raise exception 'De bestelling mist haar sleutel.' using errcode = '22023';
  end if;
  if p_verwacht_totaal is null then
    raise exception 'De bestelling mist het totaal dat de klant zag.' using errcode = '22023';
  end if;

  -- Stap 1. Het slot per klant. Elke schrijfactie op de wagen van deze klant (de trigger
  -- wagen_slot_per_klant hierboven) en een tweede bestelling wachten tot deze klaar is.
  perform pg_advisory_xact_lock(hashtextextended('winkelwagen:' || v_klant::text, 0));

  -- Stap 2. Dezelfde sleutel al gebruikt? Dan is dat de bestelling (dubbel klikken).
  select b.id into v_bestelling
    from public.bestellingen b
   where b.klant_id = v_klant and b.sleutel = p_sleutel;
  if found then
    return v_bestelling;
  end if;

  -- Stap 3. De wagen lezen, één keer: de eigen regels op slot (`for update`), in een vaste
  -- volgorde, in drie lijsten. Vanaf hier leest de functie de tabel winkelwagen_regels niet
  -- meer; ze werkt alleen met deze lijsten. Hier wel `for update`: stap 8 haalt deze rijen
  -- weg, en dat vraagt dit slot toch; alleen deze klant komt aan zijn eigen regels.
  select array_agg(w.id order by w.product_id),
         array_agg(w.product_id order by w.product_id),
         array_agg(w.aantal order by w.product_id)
    into v_regel_ids, v_product_ids, v_aantallen
    from (
      select r.id, r.product_id, r.aantal
        from public.winkelwagen_regels r
       where r.klant_id = v_klant
       order by r.product_id
         for update
    ) w;

  if v_regel_ids is null then
    raise exception 'Je winkelwagen is leeg.' using errcode = 'SP001';
  end if;

  -- Stap 4. De producten op slot, in dezelfde vaste volgorde: een andere klant die hetzelfde
  -- product bestelt, wacht tot deze klaar is, en de voorraad kan niet onder nul.
  -- `for no key update`, niet `for update`: het houdt elke andere schrijver op deze rijen net
  -- zo goed tegen (een tweede bestelling, een prijswijziging, het weghalen van het product),
  -- maar botst niet met het lichte slot (`for key share`) dat de foreign key van een wagenregel
  -- of bestelregel op het product zet. Met `for update` kon één klant die zijn eigen wagen in
  -- een omgekeerde volgorde vulde en leegde, de bestellingen van anderen laten vastlopen
  -- (deadlock). De afboeking in stap 7 is een update die de sleutel niet raakt en vraagt
  -- daarom precies dit slot; de functie houdt het dus al vast.
  perform 1
     from public.producten p
    where p.id = any (v_product_ids)
    order by p.id
      for no key update;

  -- Stap 5. Per regel: te koop, genoeg voorraad, de prijs van deze klant. Naam en prijs gaan
  -- in de lijsten naast de regel; het totaal telt mee.
  for i in 1 .. cardinality(v_regel_ids) loop
    select p.naam, p.zichtbaar, p.voorraad, p.basisprijs_centen
      into v_product
      from public.producten p
     where p.id = v_product_ids[i];
    if not found or not v_product.zichtbaar then
      raise exception '% is niet meer te koop.', coalesce(v_product.naam, 'Een product')
        using errcode = 'SP003';
    end if;
    if v_product.voorraad < v_aantallen[i] then
      raise exception 'Van % is niet genoeg op voorraad; pas het aantal aan.', v_product.naam
        using errcode = 'SP002';
    end if;

    select k.prijs_centen into v_klantprijs
      from public.klantprijzen k
     where k.klant_id = v_klant and k.product_id = v_product_ids[i];

    v_namen := v_namen || v_product.naam;
    v_stukprijzen := v_stukprijzen || coalesce(v_klantprijs, v_product.basisprijs_centen);
    v_totaal := v_totaal + v_aantallen[i]::bigint * v_stukprijzen[i];
  end loop;

  -- Stap 5b. Het totaal dat de klant zag. Alleen een vergelijking: de prijs blijft die van
  -- hierboven. Anders: niets plaatsen, en het nieuwe totaal teruggeven voor de melding.
  if v_totaal <> p_verwacht_totaal then
    raise exception 'De prijs is gewijzigd. Bekijk je wagen opnieuw.'
      using errcode = 'SP004', detail = v_totaal::text;
  end if;

  -- Stap 6. De bon en zijn regels, uit de lijsten.
  insert into public.bestellingen (klant_id, sleutel, totaal_centen)
  values (v_klant, p_sleutel, v_totaal)
  returning id into v_bestelling;

  insert into public.bestelregels (bestelling_id, product_id, naam, aantal, stukprijs_centen)
  select v_bestelling, g.product_id, g.naam, g.aantal, g.stukprijs
    from unnest(v_product_ids, v_namen, v_aantallen, v_stukprijzen)
           as g (product_id, naam, aantal, stukprijs);

  -- Stap 7. De voorraad afboeken, met de aantallen uit de lijsten.
  update public.producten p
     set voorraad = p.voorraad - g.aantal
    from unnest(v_product_ids, v_aantallen) as g (product_id, aantal)
   where p.id = g.product_id;

  -- Stap 8. Precies de gelezen regels uit de wagen, op sleutel én aantal. Een regel die er
  -- intussen bij kwam, blijft staan voor een volgende bestelling.
  delete from public.winkelwagen_regels w
   using unnest(v_regel_ids, v_aantallen) as g (id, aantal)
   where w.id = g.id and w.aantal = g.aantal and w.klant_id = v_klant;
  get diagnostics v_geleegd = row_count;
  if v_geleegd <> cardinality(v_regel_ids) then
    raise exception 'De winkelwagen veranderde tijdens het bestellen.' using errcode = 'SP009';
  end if;

  -- Stap 9. De controle: het totaal van de bon is de som van zijn regels. Klopt dat niet,
  -- dan gaat de hele bestelling terug (de voorraad en de wagen ook).
  if v_totaal is distinct from (
    select coalesce(sum(r.aantal::bigint * r.stukprijs_centen), 0)
      from public.bestelregels r
     where r.bestelling_id = v_bestelling
  ) then
    raise exception 'Het totaal van de bon klopt niet met de regels.' using errcode = 'SP009';
  end if;

  return v_bestelling;
  end;
end;
$$;

-- Ook functies krijgen van Supabase standaard rechten voor iedereen. Dicht, en dan per
-- functie alleen wie hem nodig heeft.
revoke all on function public.producten_bijgewerkt() from public, anon, authenticated;
revoke all on function public.wagen_slot_per_klant() from public, anon, authenticated;
revoke all on function public.product_te_koop(uuid) from public, anon, authenticated;
revoke all on function public.wagen_toevoegen(uuid, integer) from public, anon, authenticated;
revoke all on function public.openbare_producten(text) from public, anon, authenticated;
revoke all on function public.bestelling_plaatsen(uuid, bigint) from public, anon, authenticated;
revoke all on function public.klant_beoordelen(uuid, text) from public, anon, authenticated;

grant execute on function public.product_te_koop(uuid) to authenticated;
grant execute on function public.wagen_toevoegen(uuid, integer) to authenticated;
grant execute on function public.openbare_producten(text) to anon, authenticated;
grant execute on function public.bestelling_plaatsen(uuid, bigint) to authenticated;
grant execute on function public.klant_beoordelen(uuid, text) to authenticated;
