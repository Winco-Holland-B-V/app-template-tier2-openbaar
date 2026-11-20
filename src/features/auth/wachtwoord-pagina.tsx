import { Form, Link, useNavigation } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Melding, Pagina, Robotvak, useAanvraag } from "@/features/auth/inlogpagina";
import { useRobotcontrole } from "@/features/auth/robotcontrole";
import { MINIMAAL } from "@/features/auth/wachtwoord";
import type {
  Instelantwoord,
  Instelstand,
  Vergetenantwoord,
  Vergetenstand,
} from "@/features/auth/wachtwoord.server";

/**
 * De pagina's rond het wachtwoord, getekend. Elk onderdeel is een gewoon formulier naar de
 * server (src/features/auth/wachtwoord.server.ts): ze werken ook zonder JavaScript.
 */
export function WachtwoordInstellen({
  stand,
  uitkomst,
  merk,
}: {
  stand: Instelstand;
  uitkomst: Instelantwoord | undefined;
  merk: string;
}) {
  const bezig = useNavigation().state !== "idle";

  if (stand.stap === "link") {
    // Het openen van de pagina doet niets; pas de knop (een POST) wisselt de link om.
    return (
      <Pagina kop={stand.soort === "invite" ? "Welkom" : "Nieuw wachtwoord"} merk={merk}>
        <p className="text-sm text-muted-foreground">
          {stand.soort === "invite"
            ? "Er staat een account voor je klaar. Klik op de knop en kies daarna je wachtwoord."
            : "Klik op de knop en kies daarna een nieuw wachtwoord."}
        </p>
        {uitkomst?.soort === "link" ? <Melding>{uitkomst.melding}</Melding> : null}
        <Form method="post" className="flex flex-col">
          <input type="hidden" name="doe" value="link" />
          <Button type="submit" size="lg" className="h-12 text-base" disabled={bezig}>
            {bezig ? "Bezig…" : "Verder"}
          </Button>
        </Form>
        {uitkomst?.soort === "link" ? (
          <Link to="/wachtwoord-vergeten">Wachtwoord vergeten</Link>
        ) : null}
      </Pagina>
    );
  }

  if (stand.stap === "geen") {
    return (
      <Pagina kop="Wachtwoord instellen" merk={merk}>
        <p className="text-sm text-muted-foreground">
          Open de link uit je mail om een wachtwoord te kiezen. Is de link verlopen, vraag dan een
          nieuwe aan.
        </p>
        <Link
          to="/wachtwoord-vergeten"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          Een nieuwe link aanvragen
        </Link>
      </Pagina>
    );
  }

  return (
    <Pagina kop="Kies je wachtwoord" merk={merk}>
      {stand.adres ? (
        <p className="text-sm text-muted-foreground">
          Voor <span className="font-medium text-foreground">{stand.adres}</span>. Minstens{" "}
          {MINIMAAL} tekens.
        </p>
      ) : null}
      <Form method="post" className="flex flex-col gap-4" noValidate>
        <input type="hidden" name="doe" value="opslaan" />
        {/* Voor de wachtwoordbeheerder van de browser: bij welk adres dit wachtwoord hoort. */}
        <input
          type="email"
          name="gebruikersnaam"
          autoComplete="username"
          value={stand.adres ?? ""}
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
        {uitkomst?.soort === "kiezen" ? <Melding>{uitkomst.melding}</Melding> : null}
        <Button type="submit" size="lg" className="h-12 text-base" disabled={bezig}>
          {bezig ? "Bezig…" : "Opslaan"}
        </Button>
      </Form>
    </Pagina>
  );
}

export function WachtwoordVergeten({
  stand,
  uitkomst,
  merk,
}: {
  stand: Vergetenstand;
  uitkomst: Vergetenantwoord | undefined;
  merk: string;
}) {
  const robot = useRobotcontrole(stand.robotSleutel ?? undefined);
  const aanvraag = useAanvraag(robot);
  const navigatie = useNavigation();
  const bezig = aanvraag.wacht || navigatie.state !== "idle";
  const melding = aanvraag.mislukt?.tekst ?? uitkomst?.melding ?? null;
  return (
    <Pagina kop="Wachtwoord vergeten" merk={merk}>
      {stand.verstuurd ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          Als er een account is op dit adres, krijg je binnen een paar minuten een mail met een link
          om een nieuw wachtwoord te kiezen. Kijk ook bij ongewenste mail.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Vul je e-mailadres in. Je krijgt een mail met een link om een nieuw wachtwoord te kiezen.
        </p>
      )}
      <Form method="post" className="flex flex-col gap-4" onSubmit={aanvraag.verstuur} noValidate>
        <input type="hidden" name="doe" value="vraag" />
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">E-mailadres</Label>
          <Input
            id="email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="h-12 text-base"
            defaultValue={uitkomst?.email ?? ""}
          />
        </div>
        {melding ? <Melding>{melding}</Melding> : null}
        <Robotvak robot={robot} />
        <Button type="submit" size="lg" className="h-12 text-base" disabled={bezig}>
          {bezig ? "Bezig…" : "Stuur een link"}
        </Button>
      </Form>
      <Link to="/login" className="text-sm text-primary underline-offset-4 hover:underline">
        Terug naar inloggen
      </Link>
    </Pagina>
  );
}
