-- Wat de testgebruiker mag: lokaal, in de browsertests (e2e/global-setup.ts) en op de
-- testdatabase (elke nacht, door Testdatabase verversen in de beheer-repo). Nooit op productie:
-- dit is geen migratie, en guard:rls weigert een migratie die de testgebruiker noemt.
--
-- In een app van deze template is de testgebruiker een goedgekeurde klant: lokaal kijken en de
-- browsertests zien zo de schermen voor klanten. Medewerker kan hij niet zijn: medewerkerrechten
-- komen alleen uit een inlog via Cloudflare (public.sessie_via_cloudflare()), nooit uit een
-- wachtwoord of een e-mailadres. Schermen voor medewerkers bekijk je op de preview met de knop
-- voor medewerkers; zie docs/routes/lokaal-kijken.md.
--
-- Mag vaker draaien. Heeft de app eigen rollen voor klanten, zet die er hieronder bij.
insert into public.klanten (user_id, e_mail, goedgekeurd)
select id, email, true from auth.users where email = 'testgebruiker@stagetwo.nl'
on conflict (user_id) do update set goedgekeurd = true;
