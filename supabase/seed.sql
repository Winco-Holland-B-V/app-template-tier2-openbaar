-- Voorbeeldgegevens voor de lokale database en de checks in GitHub. Dit bestand draait
-- alleen bij `supabase start` en `pnpm db:reset` op je eigen computer of in CI; nooit op de
-- testdatabase of productie (die krijgen alleen de migraties).
--
-- Een handvol producten, en twee goedgekeurde testklanten met elk een eigen prijs voor de
-- koffiebonen.
-- Zo zie je lokaal en in de browsertests dat de prijs van de één nooit bij de ander komt.
--
--   klant-a@voorbeeld.nl  wachtwoord voorbeeldshop-klant-a  koffiebonen voor 11,00
--   klant-b@voorbeeld.nl  wachtwoord voorbeeldshop-klant-b  koffiebonen voor 12,50
--   zonder inlog                                             koffiebonen voor 14,95

insert into public.producten
  (id, slug, naam, omschrijving, afbeelding, basisprijs_centen, voorraad, zichtbaar)
values
  ('5e7a0000-0000-4000-8000-000000000001', 'koffiebonen-huismelange',
   'Koffiebonen huismelange',
   'Een kilo hele bonen, middelzwaar gebrand. Vol en rond, met een tikje chocolade.',
   '/voorbeeldshop/koffiebonen.png', 1495, 1000, true),
  ('5e7a0000-0000-4000-8000-000000000002', 'theepot-gietijzer',
   'Theepot gietijzer',
   'Gietijzeren theepot van 0,8 liter met een zeefje van roestvrij staal.',
   '/voorbeeldshop/theepot.png', 3950, 1000, true),
  ('5e7a0000-0000-4000-8000-000000000003', 'mok-steengoed',
   'Mok steengoed',
   'Handgemaakte mok van 300 ml. Kan in de vaatwasser en de magnetron.',
   '/voorbeeldshop/mok.png', 1250, 1000, true),
  ('5e7a0000-0000-4000-8000-000000000004', 'melkopschuimer',
   'Melkopschuimer',
   'Opschuimer op een batterij, voor warme en koude melk.',
   '/voorbeeldshop/melkopschuimer.png', 1895, 3, true),
  ('5e7a0000-0000-4000-8000-000000000005', 'proefpakket-najaar',
   'Proefpakket najaar',
   'Nog niet te koop: staat klaar voor de najaarsactie.',
   '/voorbeeldshop/proefpakket.png', 2450, 50, false)
on conflict (id) do nothing;

-- De twee testklanten, met een wachtwoord zodat de inlogpagina en de tests ze kunnen
-- gebruiken. Zo maakt Supabase zelf ook een gebruiker aan; de lege velden moeten een lege
-- tekst zijn, geen null.
insert into auth.users
  (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
   raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
   confirmation_token, recovery_token, email_change_token_new, email_change,
   email_change_token_current, phone_change, phone_change_token, reauthentication_token)
values
  ('00000000-0000-0000-0000-000000000000', '5e7a0000-0000-4000-8000-0000000000a1',
   'authenticated', 'authenticated', 'klant-a@voorbeeld.nl',
   extensions.crypt('voorbeeldshop-klant-a', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{}', now(), now(),
   '', '', '', '', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '5e7a0000-0000-4000-8000-0000000000b2',
   'authenticated', 'authenticated', 'klant-b@voorbeeld.nl',
   extensions.crypt('voorbeeldshop-klant-b', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{}', now(), now(),
   '', '', '', '', '', '', '', '')
on conflict (id) do nothing;

insert into auth.identities
  (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
values
  ('5e7a0000-0000-4000-8000-0000000001a1', '5e7a0000-0000-4000-8000-0000000000a1',
   '5e7a0000-0000-4000-8000-0000000000a1', 'email',
   '{"sub":"5e7a0000-0000-4000-8000-0000000000a1","email":"klant-a@voorbeeld.nl","email_verified":true}',
   now(), now(), now()),
  ('5e7a0000-0000-4000-8000-0000000001b2', '5e7a0000-0000-4000-8000-0000000000b2',
   '5e7a0000-0000-4000-8000-0000000000b2', 'email',
   '{"sub":"5e7a0000-0000-4000-8000-0000000000b2","email":"klant-b@voorbeeld.nl","email_verified":true}',
   now(), now(), now())
on conflict do nothing;

-- De twee testklanten zijn aangemeld en goedgekeurd: zonder goedkeuring mag een account niets
-- (docs/routes/webshop.md). In een echte app meldt een klant zich aan door in te loggen en
-- keurt een medewerker hem goed op /klanten.
insert into public.klanten (user_id, e_mail, goedgekeurd)
values
  ('5e7a0000-0000-4000-8000-0000000000a1', 'klant-a@voorbeeld.nl', true),
  ('5e7a0000-0000-4000-8000-0000000000b2', 'klant-b@voorbeeld.nl', true)
on conflict (user_id) do nothing;

insert into public.klantprijzen (klant_id, product_id, prijs_centen)
values
  ('5e7a0000-0000-4000-8000-0000000000a1', '5e7a0000-0000-4000-8000-000000000001', 1100),
  ('5e7a0000-0000-4000-8000-0000000000b2', '5e7a0000-0000-4000-8000-000000000001', 1250)
on conflict (klant_id, product_id) do nothing;
