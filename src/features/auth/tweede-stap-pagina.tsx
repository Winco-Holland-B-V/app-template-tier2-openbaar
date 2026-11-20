import { Form, Link, useNavigation } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Melding, Pagina } from "@/features/auth/inlogpagina";
import type {
  Accountantwoord,
  Accountstand,
  TweedeStapAntwoord,
} from "@/features/auth/tweede-stap.server";

/**
 * De tweede stap (2FA), getekend: de code na het wachtwoord, en de pagina Mijn account waar een
 * klant hem aan- of uitzet. Gewone formulieren naar de server (tweede-stap.server.ts): ze werken
 * ook zonder JavaScript.
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
      <section className="flex flex-col gap-3 rounded-md border p-4">
        <h2 className="font-medium">Tweede stap (2FA)</h2>
        {stand.aan ? (
          <>
            <p className="text-sm text-muted-foreground">
              Staat aan. Na je wachtwoord vraagt de app om een code uit je authenticator-app.
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
              Staat uit. Zet je hem aan, dan is je wachtwoord alleen niet genoeg: na het inloggen
              vraagt de app ook om een code uit een app op je telefoon.
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
      <Link
        to="/wachtwoord-instellen"
        className="text-sm text-primary underline-offset-4 hover:underline"
      >
        Wachtwoord wijzigen
      </Link>
      <Link to="/" className="text-sm text-primary underline-offset-4 hover:underline">
        Terug
      </Link>
    </Pagina>
  );
}
