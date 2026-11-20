-- Klantportaal met accounts (uitgave 46): uitnodigen, wachtwoord en een tweede stap (2FA).
--
-- Een klantportaal kent twee manieren waarop klanten inloggen (`klantportaal_inloggen` in
-- toegang.json van de beheer-repo):
--
--   code     de klant meldt zich zelf aan met een code per mail; een medewerker keurt hem
--            goed (20261114100000_klantportaal.sql). De standaard.
--   account  niemand maakt zelf een account. Een medewerker nodigt een klant uit, de klant
--            kiest een wachtwoord, en kan zelf een tweede stap met een authenticator-app
--            aanzetten. Een uitgenodigde klant is meteen goedgekeurd.
--
-- Deze migratie legt het deel van `account` in de database. Bij `code` doet ze niets: de tabel
-- blijft leeg en de functies worden niet aangeroepen. De eis van de tweede stap in
-- is_goedgekeurde_klant() geldt voor beide, maar bij `code` kan niemand een factor aanzetten
-- (de inrichting zet TOTP alleen bij `account` aan).
--
-- Hoe een account ontstaat, met de minste rechten per stap:
--   1. een medewerker (is_medewerker) vult in de app een adres in;
--   2. de Edge Function `klant-uitnodigen` zet het adres met het token van die medewerker op
--      public.klant_uitnodigingen (RLS: alleen medewerkers), met een eigen, geheime sleutel;
--   3. dezelfde functie vraagt Supabase Auth met de service role om het account met een
--      uitnodigingsmail, en geeft de sleutel mee in de gegevens van het account;
--   4. de hook before-user-created van de inrichting laat een nieuw account per mail alleen door
--      als klantaccount_toestaan() hieronder ja zegt: het adres met die sleutel staat op de lijst;
--   5. klant_uitnodiging_afronden() zet het account goedgekeurd op public.klanten. Alleen de
--      service role mag die functie uitvoeren.
--
-- Waarom een wachtwoord nu wel kan: bij `code` (iedereen kan zich aanmelden) kon een vreemde het
-- adres van een klant aanmelden met een eigen wachtwoord. Bij `account` kan niemand zelf een
-- account maken, dus dat gat bestaat daar niet.

create table public.klant_uitnodigingen (
  id uuid primary key default gen_random_uuid(),
  e_mail text not null
    check (e_mail = lower(btrim(e_mail)) and e_mail like '%_@_%'),
  naam text,
  -- Het geheim van deze uitnodiging: alleen de Edge Function kent het (zij maakt het), en de
  -- hook vergelijkt het. Niemand kan het lezen via de API (geen select op deze kolom).
  sleutel uuid not null unique,
  uitgenodigd_door uuid default auth.uid() references auth.users (id) on delete set null,
  uitgenodigd_op timestamptz not null default now(),
  user_id uuid references auth.users (id) on delete set null,
  afgerond_op timestamptz
);

create index klant_uitnodigingen_e_mail on public.klant_uitnodigingen (e_mail);

comment on table public.klant_uitnodigingen is
  'Wie een medewerker als klant heeft uitgenodigd (klantportaal met accounts). Een nieuw account per mail komt alleen door met de sleutel van een open uitnodiging.';

alter table public.klant_uitnodigingen enable row level security;

revoke all on public.klant_uitnodigingen from public, anon, authenticated;
grant select (id, e_mail, naam, uitgenodigd_door, uitgenodigd_op, user_id, afgerond_op)
  on public.klant_uitnodigingen to authenticated;
grant insert (e_mail, naam, sleutel) on public.klant_uitnodigingen to authenticated;
grant delete on public.klant_uitnodigingen to authenticated;

create policy "klant_uitnodigingen_medewerker"
  on public.klant_uitnodigingen
  for all
  to authenticated
  using ((select public.is_medewerker()))
  with check ((select public.is_medewerker()));

-- Mag dit nieuwe account bestaan? Voor de hook before-user-created die de inrichting zet (die
-- weigert eerst de adressen van medewerkers en laat Cloudflare door; zie beheer/lib/toegang.mjs).
-- Ja bij een account per mail met de sleutel van een open uitnodiging van hoogstens een
-- kwartier oud. Nee bij al het andere: aanmelden via /auth/v1/signup, een inlogcode op een nieuw
-- adres, een anoniem account of een andere inlogdienst.
create function public.klantaccount_toestaan(event jsonb)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(event -> 'user' -> 'app_metadata' ->> 'provider', '') = 'email'
    and exists (
      select 1
        from public.klant_uitnodigingen u
       where u.e_mail = lower(btrim(coalesce(event -> 'user' ->> 'email', '')))
         and u.sleutel::text = coalesce(event -> 'user' -> 'user_metadata' ->> 'uitnodiging', '')
         and u.afgerond_op is null
         and u.uitgenodigd_op > now() - interval '15 minutes'
    )
$$;

comment on function public.klantaccount_toestaan(jsonb) is
  'Voor de hook before-user-created bij een klantportaal met accounts: alleen een account per mail met de sleutel van een open uitnodiging. Alleen voor supabase_auth_admin.';

-- Supabase Auth roept de hook aan als supabase_auth_admin: die moet het schema in kunnen en de
-- functie mogen uitvoeren (meer niet; de functie leest de lijst met de rechten van haar eigenaar).
grant usage on schema public to supabase_auth_admin;
revoke all on function public.klantaccount_toestaan(jsonb) from public, anon, authenticated;
grant execute on function public.klantaccount_toestaan(jsonb) to supabase_auth_admin;

-- Na de uitnodiging: het account goedgekeurd als klant. Alleen voor de service role (de Edge
-- Function klant-uitnodigen). Een account dat ook via een inlogdienst binnenkomt (een
-- medewerker), wordt nooit klant. Wil de app de klant aan iets eigens koppelen (een bedrijf),
-- dan doet ze dat in een eigen functie of trigger op public.klanten.
create function public.klant_uitnodiging_afronden(p_sleutel uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_adres text;
  v_id uuid;
  gebruiker uuid;
begin
  select u.e_mail, u.id into v_adres, v_id
    from public.klant_uitnodigingen u
   where u.sleutel = p_sleutel
     and u.afgerond_op is null
   for update;
  if not found then
    raise exception 'Deze uitnodiging bestaat niet of is al afgerond.' using errcode = 'P0002';
  end if;

  select a.id into gebruiker
    from auth.users a
   where lower(a.email) = v_adres
     and not exists (
       select 1 from auth.identities i where i.user_id = a.id and i.provider <> 'email'
     );
  if gebruiker is null then
    raise exception 'Er is geen klantaccount voor deze uitnodiging.' using errcode = 'P0002';
  end if;

  insert into public.klanten (user_id, e_mail, goedgekeurd)
  values (gebruiker, v_adres, true)
  on conflict (user_id) do update set goedgekeurd = true;

  update public.klant_uitnodigingen
     set user_id = gebruiker,
         afgerond_op = now()
   where id = v_id;

  return gebruiker;
end
$$;

comment on function public.klant_uitnodiging_afronden(uuid) is
  'Zet het uitgenodigde account goedgekeurd op klanten. Alleen de service role (Edge Function klant-uitnodigen).';

revoke all on function public.klant_uitnodiging_afronden(uuid) from public, anon, authenticated;
grant execute on function public.klant_uitnodiging_afronden(uuid) to service_role;

-- De tweede stap (2FA). Heeft een klant een bevestigde factor (een authenticator-app), dan is
-- hij alleen klant in een sessie die die stap heeft gedaan (`aal2` in het token). Zo kan wie
-- alleen het wachtwoord kent niets lezen, ook niet rechtstreeks bij Supabase: de eis staat in
-- de database, niet alleen op het scherm. `aal` zet Supabase Auth in elk token; het token is
-- ondertekend, de gebruiker kan het niet wijzigen. De factoren staan in auth.mfa_factors, waar
-- de gebruiker niet zelf bij kan.
--
-- Telefoon kwijt: de owner van de app haalt de factor weg in Supabase (Authentication, Users,
-- de gebruiker, Multi-Factor Authentication). Een klant kan dat niet zelf zonder de tweede stap.
--
-- Dit vervangt de functie uit 20261114100000_klantportaal.sql; de rest is gelijk.
create or replace function public.is_goedgekeurde_klant()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
      from auth.users u
     where u.id = auth.uid()
       and u.banned_until > now()
  )
  and exists (
    select 1
      from public.klanten k
     where k.user_id = auth.uid()
       and k.goedgekeurd
  )
  and exists (
    select 1
      from auth.sessions s
     where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
       and s.user_id = auth.uid()
  )
  and (
    coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
    or not exists (
      select 1
        from auth.mfa_factors f
       where f.user_id = auth.uid()
         and f.status = 'verified'
    )
  )
$$;

comment on function public.is_goedgekeurde_klant() is
  'Heeft een medewerker dit account als klant goedgekeurd, is het niet geblokkeerd, bestaat de sessie nog, en heeft de sessie de tweede stap gedaan als de klant die heeft aangezet? Gebruik deze functie in policies voor wat alleen een goedgekeurde klant mag.';

revoke all on function public.is_goedgekeurde_klant() from public, anon, authenticated;
grant execute on function public.is_goedgekeurde_klant() to authenticated;
