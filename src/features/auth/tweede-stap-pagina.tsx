import { Form, Link, useNavigation } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KNOPTEKST } from "@/features/auth/inlogknoppen";
import { Melding, Pagina } from "@/features/auth/inlogpagina";
import type {
  Accountantwoord,
  Accountstand,
  TweedeStapAntwoord,
} from "@/features/auth/tweede-stap.server";
import { MINIMAAL } from "@/features/auth/wachtwoord";

/**
 * De tweede stap (2FA), getekend: de code na het wachtwoord, en de pagina Mijn account waar een
 * klant hem aan- of uitzet. Gewone formulieren naar de server (tweede-stap.server.ts): ze werken
 * ook zonder JavaScript. In de stand vooraf staat het wachtwoord ook op Mijn account.
 */

function Codeveld() {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="code">Code uit je authenticator-app</Label>
      <Input
        id="code"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 ]*"
        maxLength={7}
        className="h-12 text-center text-lg tracking-widest"
        autoFocus
      />
    </div>
  );
}

export function TweedeStap({
  uitkomst,
  merk,
}: {
  uitkomst: TweedeStapAntwoord | undefined;
  merk: string;
}) {
  const bezig = useNavigation().state !== "idle";
  return (
    <Pagina kop="Tweede stap" merk={merk}>
      <p className="text-sm text-muted-foreground">
        Open je authenticator-app en vul de code van zes cijfers in.
      </p>
      <Form method="post" className="flex flex-col gap-4" noValidate>
        <Codeveld />
        {uitkomst ? <Melding>{uitkomst.melding}</Melding> : null}
        <Button type="submit" size="lg" className="h-12 text-base" disabled={bezig}>
          {bezig ? "Bezig…" : "Verder"}
        </Button>
      </Form>
      <p className="text-sm text-muted-foreground">
        Telefoon kwijt of een nieuwe telefoon? Neem contact op met je contactpersoon; die zet de
        tweede stap voor je uit.
      </p>
      <Form method="post" action="/login">
        <input type="hidden" name="doe" value="uitloggen" />
        <button type="submit" className="text-sm text-primary underline-offset-4 hover:underline">
          Uitloggen
        </button>
      </Form>
    </Pagina>
  );
}

export function Account({
  stand,
  uitkomst,
  merk,
}: {
  stand: Accountstand;
  uitkomst: Accountantwoord | undefined;
  merk: string;
}) {
  const bezig = useNavigation().state !== "idle";

  if (uitkomst?.soort === "inschrijven") {
    return (
      <Pagina kop="Tweede stap aanzetten" merk={merk}>
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
          <li>
            Open een authenticator-app op je telefoon (bijvoorbeeld Google Authenticator, Microsoft
            Authenticator of de app Wachtwoorden op een iPhone).
          </li>
          <li>Scan deze code met de app.</li>
          <li>Vul de code van zes cijfers in die de app daarna toont.</li>
        </ol>
        <img
          src={uitkomst.qr}
          alt="QR-code voor je authenticator-app"
          className="mx-auto size-48 rounded-md bg-white p-2"
        />
        <p className="text-xs text-muted-foreground">
          Lukt scannen niet? Vul dan deze sleutel in de app in:{" "}
          <code className="break-all">{uitkomst.geheim}</code>
        </p>
        <Form method="post" className="flex flex-col gap-4" noValidate>
          <input type="hidden" name="doe" value="bevestigen" />
          <input type="hidden" name="factor" value={uitkomst.factorId} />
          <Codeveld />
          <Button type="submit" size="lg" className="h-12 text-base" disabled={bezig}>
            {bezig ? "Bezig…" : "Aanzetten"}
          </Button>
        </Form>
        <Link to="/account" className="text-sm text-primary underline-offset-4 hover:underline">
          Annuleren
        </Link>
      </Pagina>
    );
  }

  return (
    <Pagina kop="Mijn account" merk={merk}>
      {stand.adres ? (
        <p className="text-sm text-muted-foreground">Ingelogd als {stand.adres}</p>
      ) : null}
      {uitkomst?.soort === "melding" ? <Melding>{uitkomst.melding}</Melding> : null}
      {stand.melding ? (
        <p role="status" className="text-sm text-foreground">
          {stand.melding}
        </p>
      ) : null}
      {stand.vooraf ? (
        <WachtwoordVak
          adres={stand.adres}
          melding={uitkomst?.soort === "wachtwoord" ? uitkomst.melding : null}
          bezig={bezig}
        />
      ) : null}
      {stand.vooraf && stand.google ? (
        <section className="flex flex-col gap-2 rounded-md border p-4">
          <h2 className="font-medium">Google</h2>
          <p className="text-sm text-muted-foreground">
            Is je e-mailadres ook een Google-account (Gmail of Google Workspace)? Dan kun je op de
            inlogpagina ook {KNOPTEKST.google} kiezen. Je komt dan in dit account.
          </p>
        </section>
      ) : null}
      <section className="flex flex-col gap-3 rounded-md border p-4">
        <h2 className="font-medium">Tweede stap (2FA)</h2>
        {stand.aan ? (
          <>
            <p className="text-sm text-muted-foreground">
              Staat aan. {stand.vooraf ? "Na het inloggen" : "Na je wachtwoord"} vraagt de app om
              een code uit je authenticator-app.
            </p>
            <Form method="post">
              <input type="hidden" name="doe" value="uitzetten" />
              <Button type="submit" variant="outline" disabled={bezig || !stand.gedaan}>
                Uitzetten
              </Button>
            </Form>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Staat uit. Zet je hem aan, dan is {stand.vooraf ? "inloggen" : "je wachtwoord"} alleen
              niet genoeg: daarna vraagt de app ook om een code uit een app op je telefoon.
            </p>
            <Form method="post">
              <input type="hidden" name="doe" value="aanzetten" />
              <Button type="submit" disabled={bezig}>
                Aanzetten
              </Button>
            </Form>
          </>
        )}
      </section>
      {stand.vooraf ? null : (
        <Link
          to="/wachtwoord-instellen"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          Wachtwoord wijzigen
        </Link>
      )}
      <Link to="/" className="text-sm text-primary underline-offset-4 hover:underline">
        Terug
      </Link>
    </Pagina>
  );
}

/**
 * De stand vooraf: een wachtwoord instellen (ook als er nog geen is) of wijzigen. Wie geen
 * wachtwoord wil, laat dit leeg en logt in met een code per mail.
 */
function WachtwoordVak({
  adres,
  melding,
  bezig,
}: {
  adres: string | null;
  melding: string | null;
  bezig: boolean;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-md border p-4">
      <h2 className="font-medium">Wachtwoord</h2>
      <p className="text-sm text-muted-foreground">
        Liever geen code per mail? Stel een wachtwoord in van minstens {MINIMAAL} tekens. Heb je er
        al een, dan kies je hier een nieuw. De code per mail blijft ook werken.
      </p>
      <Form method="post" className="flex flex-col gap-4" noValidate>
        <input type="hidden" name="doe" value="wachtwoord" />
        {/* Voor de wachtwoordbeheerder van de browser: bij welk adres dit wachtwoord hoort. */}
        <input
          type="email"
          name="gebruikersnaam"
          autoComplete="username"
          value={adres ?? ""}
          readOnly
          hidden
        />
        <div className="flex flex-col gap-2">
          <Label htmlFor="wachtwoord">Nieuw wachtwoord</Label>
          <Input
            id="wachtwoord"
            name="wachtwoord"
            type="password"
            autoComplete="new-password"
            minLength={MINIMAAL}
            className="h-12 text-base"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="herhaling">Nog een keer</Label>
          <Input
            id="herhaling"
            name="herhaling"
            type="password"
            autoComplete="new-password"
            className="h-12 text-base"
          />
        </div>
        {melding ? <Melding>{melding}</Melding> : null}
        <Button type="submit" disabled={bezig}>
          {bezig ? "Bezig…" : "Wachtwoord opslaan"}
        </Button>
      </Form>
    </section>
  );
}
