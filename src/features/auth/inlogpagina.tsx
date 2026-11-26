import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Form, Link, useNavigation, useSubmit } from "react-router";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Inlogstand, Inloguitkomst } from "@/features/auth/inloggen.server";
import { KNOPTEKST, type Knopdienst } from "@/features/auth/inlogknoppen";
import {
  CODE_LENGTE,
  type Fout,
  fout as foutMet,
  isFoutVanDienst,
  isHeleCode,
  leesCode,
  wachtNog,
} from "@/features/auth/mailcode";
import { isBewijsVorm, type Robotcontrole, useRobotcontrole } from "@/features/auth/robotcontrole";
import { cn } from "@/lib/utils";

/**
 * De inlogpagina, getekend. Klanten vullen hun e-mailadres in en krijgen een code van acht
 * cijfers; medewerkers loggen in via Cloudflare. Elk onderdeel is een gewoon formulier dat
 * naar de server gaat (src/features/auth/inloggen.server.ts): de pagina werkt dus ook zonder
 * JavaScript. Met JavaScript gaat het vlotter: tien cijfers typen is genoeg, de knop voor een
 * nieuwe code telt af, en de controle tegen robots draait mee.
 *
 * In de stand `vooraf` (accounts bestaan vooraf, zie inlogdienst.ts) vraagt de klant met
 * "Stuur me een code" een code aan, en staan daaronder "Doorgaan met Google" (als dat aan staat)
 * en klein "Inloggen met wachtwoord". De link uit de mail logt daar meteen in: een scriptje
 * verstuurt het formulier, zonder JavaScript staat er één knop.
 *
 * Deze pagina staat open voor iedereen en geeft niemand rechten: dat doet de database.
 */
type Props = {
  stand: Inlogstand;
  /** Wat het laatst verstuurde formulier teruggaf, als dat geen omleiding was. */
  uitkomst: Inloguitkomst | undefined;
  /** De naam van de app, boven het formulier: zo ziet iemand bij wie hij inlogt. */
  merk: string;
};

export function Pagina({
  kop,
  merk,
  children,
}: {
  kop: string;
  merk: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-5 py-10">
      {merk ? (
        <p data-testid="merknaam" className="pb-4 text-center text-xl font-semibold tracking-tight">
          {merk}
        </p>
      ) : null}
      <h1 className="text-2xl font-semibold tracking-tight">{kop}</h1>
      {children}
    </main>
  );
}

export function Melding({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}

export function Inlogpagina({ stand, uitkomst, merk }: Props) {
  if (stand.stap === "ingelogd") return <AlIngelogd stand={stand} uitkomst={uitkomst} />;
  if (stand.stap === "link")
    return <LinkStap merk={merk} hierAangevraagd={stand.hierAangevraagd} vanzelf={stand.vooraf} />;
  if (stand.stap === "wachtwoord") {
    return (
      <WachtwoordFormulier
        merk={merk}
        testlogin={stand.testlogin}
        email={uitkomst?.soort === "wachtwoord" ? uitkomst.email : ""}
        melding={
          uitkomst?.soort === "wachtwoord"
            ? uitkomst.melding
            : uitkomst?.soort === "dienst"
              ? null
              : (stand.fout?.tekst ?? null)
        }
        robotSleutel={stand.robotSleutel}
        knoppen={stand.knoppen}
        uitkomst={uitkomst}
        metCode={stand.vooraf ? loginAdres(stand.volgende) : null}
      />
    );
  }

  // Een foute code: de pagina blijft op de code staan, ook als het geheugen van vijf minuten
  // intussen leeg is.
  if (stand.metMail && uitkomst?.soort === "code" && uitkomst.email) {
    return (
      <CodeStap
        merk={merk}
        email={uitkomst.email}
        verstuurdOp={uitkomst.verstuurdOp}
        fout={uitkomst.fout}
        melding={null}
        robotSleutel={stand.robotSleutel}
        vooraf={stand.vooraf}
      />
    );
  }
  if (stand.stap === "code") {
    return (
      <CodeStap
        merk={merk}
        email={stand.email}
        verstuurdOp={stand.verstuurdOp}
        fout={stand.fout}
        melding={stand.melding}
        robotSleutel={stand.robotSleutel}
        vooraf={stand.vooraf}
      />
    );
  }

  const fout =
    uitkomst?.soort === "adres" || uitkomst?.soort === "dienst" ? uitkomst.fout : stand.fout;
  // Een weigering na de knop voor medewerkers gaat niet over het adresveld van de klant.
  const vanDienst = fout !== null && isFoutVanDienst(fout.soort);
  if (stand.vooraf) {
    return (
      <Vooraf stand={stand} uitkomst={uitkomst} merk={merk} fout={fout} vanDienst={vanDienst} />
    );
  }
  return (
    <Pagina kop="Inloggen" merk={merk}>
      {fout && (vanDienst || !stand.metMail) ? <Melding>{fout.tekst}</Melding> : null}
      {stand.metMail ? (
        <AdresStap
          email={uitkomst?.soort === "adres" ? uitkomst.email : stand.email}
          fout={vanDienst ? null : fout}
          robotSleutel={stand.robotSleutel}
        />
      ) : null}
      {stand.metMail && stand.knoppen.includes("cloudflare") ? (
        // Supabase kent één account per adres. Een medewerker die hier zijn werkadres invult,
        // maakt een klantaccount op dat adres en loopt daarna vast bij de knop.
        <p className="text-sm text-muted-foreground">
          Werk je hier? Gebruik de knop Inloggen voor medewerkers.
        </p>
      ) : null}
      {stand.metMail && stand.knoppen.length > 0 ? (
        <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
          <span className="h-px flex-1 bg-border" />
          of
          <span className="h-px flex-1 bg-border" />
        </div>
      ) : null}
      <Dienstknoppen diensten={stand.knoppen} uitkomst={uitkomst} />
    </Pagina>
  );
}

/** Hier zet Turnstile zijn widget neer. Meestal blijft het vak leeg en onzichtbaar. */
export function Robotvak({ robot }: { robot: Robotcontrole | null }) {
  return robot ? (
    <>
      <div ref={robot.vak} data-testid="robotcontrole" className="empty:hidden" />
      <noscript>
        <p className="text-sm text-muted-foreground">
          Zet JavaScript aan om een code aan te vragen: de controle of je geen robot bent heeft dat
          nodig.
        </p>
      </noscript>
    </>
  ) : null;
}

/**
 * Een formulier dat een code aanvraagt. Zonder controle tegen robots is het een gewoon
 * formulier. Met: eerst het bewijs van de controle ophalen en dat meesturen als `captcha`.
 */
export function useAanvraag(robot: Robotcontrole | null) {
  const submit = useSubmit();
  const [wacht, setWacht] = useState(false);
  const [mislukt, setMislukt] = useState<Fout | null>(null);

  async function verstuur(event: FormEvent<HTMLFormElement>) {
    if (!robot) return;
    event.preventDefault();
    if (wacht) return;
    const gegevens = new FormData(event.currentTarget);
    setMislukt(null);
    setWacht(true);
    const bewijs = await robot.haalToken();
    if (!isBewijsVorm(bewijs)) {
      setMislukt(foutMet("robot"));
      setWacht(false);
      return;
    }
    gegevens.set("captcha", bewijs);
    await submit(gegevens, { method: "post" });
    // Elk bewijs werkt één keer: vraag een nieuw aan voor de volgende aanvraag.
    robot.verbruikt();
    setWacht(false);
  }

  return { verstuur, wacht, mislukt };
}

/** Het adres van de inlogpagina, met het pad waar de bezoeker heen wilde (als loginAdres op de server). */
function loginAdres(volgende: string, extra?: string): string {
  const zoek = new URLSearchParams(extra);
  if (volgende !== "/") zoek.set("volgende", volgende);
  const tekst = zoek.toString();
  return tekst ? `/login?${tekst}` : "/login";
}

/**
 * Het begin in de stand `vooraf`: het e-mailadres met "Stuur me een code", daaronder de knoppen
 * (Google als dat aan staat, en die voor medewerkers) en klein "Inloggen met wachtwoord". Een
 * adres zonder account krijgt geen mail; de pagina zegt hetzelfde als bij een bekend adres.
 */
function Vooraf({
  stand,
  uitkomst,
  merk,
  fout,
  vanDienst,
}: {
  stand: Inlogstand;
  uitkomst: Inloguitkomst | undefined;
  merk: string;
  fout: Fout | null;
  vanDienst: boolean;
}) {
  // Google eerst: dat is een knop voor klanten. Die voor medewerkers als laatste.
  const knoppen = [...stand.knoppen].sort(
    (a, b) => Number(a === "cloudflare") - Number(b === "cloudflare"),
  );
  return (
    <Pagina kop="Inloggen" merk={merk}>
      {fout && vanDienst ? <Melding>{fout.tekst}</Melding> : null}
      <AdresStap
        email={
          uitkomst?.soort === "adres" ? uitkomst.email : stand.stap === "adres" ? stand.email : ""
        }
        fout={vanDienst ? null : fout}
        robotSleutel={stand.robotSleutel}
        knoptekst="Stuur me een code"
      />
      {knoppen.length > 0 ? (
        <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
          <span className="h-px flex-1 bg-border" />
          of
          <span className="h-px flex-1 bg-border" />
        </div>
      ) : null}
      <Dienstknoppen diensten={knoppen} uitkomst={uitkomst} />
      {knoppen.includes("google") && knoppen.includes("cloudflare") ? (
        // Supabase koppelt Google aan het account met hetzelfde adres. Bij een medewerker telt
        // zijn account daarna niet meer als medewerker (zie docs/WERKWIJZE.md, "Klantaccounts").
        <p className="text-sm text-muted-foreground">
          {`Medewerker? Log in met de knop ${KNOPTEKST.cloudflare}, niet met Google.`}
        </p>
      ) : null}
      <Link
        to={loginAdres(stand.volgende, "met=wachtwoord")}
        className="text-sm text-primary underline-offset-4 hover:underline"
      >
        Inloggen met wachtwoord
      </Link>
    </Pagina>
  );
}

function AdresStap({
  email,
  fout: vanServer,
  robotSleutel,
  knoptekst = "Doorgaan",
}: {
  email: string;
  fout: Fout | null;
  robotSleutel: string | null;
  knoptekst?: string;
}) {
  const robot = useRobotcontrole(robotSleutel ?? undefined);
  const aanvraag = useAanvraag(robot);
  const navigatie = useNavigation();
  const veld = useRef<HTMLInputElement>(null);
  const fout = aanvraag.mislukt ?? vanServer;
  const bezig = aanvraag.wacht || navigatie.formData?.get("doe") === "vraag";

  useEffect(() => {
    // Bij een fout terug naar het veld, zodat een schermlezer en het toetsenbord daar staan.
    if (fout) veld.current?.focus();
  }, [fout]);

  return (
    <Form method="post" className="flex flex-col gap-4" onSubmit={aanvraag.verstuur} noValidate>
      <input type="hidden" name="doe" value="vraag" />
      <p className="text-sm text-muted-foreground">
        Vul je e-mailadres in. Je krijgt een mail met een code van tien cijfers.
      </p>
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">E-mailadres</Label>
        <Input
          ref={veld}
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          className="h-12 text-base"
          defaultValue={email}
          aria-invalid={fout?.soort === "adres" ? true : undefined}
          aria-describedby={fout ? "email-fout" : undefined}
        />
      </div>
      {fout ? <Melding id="email-fout">{fout.tekst}</Melding> : null}
      <Robotvak robot={robot} />
      <Button type="submit" size="lg" className="h-12 text-base" disabled={bezig}>
        {bezig ? "Bezig…" : knoptekst}
      </Button>
    </Form>
  );
}

function CodeStap({
  merk,
  email,
  verstuurdOp,
  fout,
  melding,
  robotSleutel,
  vooraf,
}: {
  merk: string;
  email: string;
  verstuurdOp: number | null;
  fout: Fout | null;
  melding: string | null;
  robotSleutel: string | null;
  vooraf: boolean;
}) {
  const robot = useRobotcontrole(robotSleutel ?? undefined);
  const aanvraag = useAanvraag(robot);
  const submit = useSubmit();
  const navigatie = useNavigation();
  const [code, setCode] = useState("");
  const [nu, setNu] = useState<number | null>(null);
  const veld = useRef<HTMLInputElement>(null);
  const formulier = useRef<HTMLFormElement>(null);
  const doet = navigatie.formData?.get("doe");
  const bezig = navigatie.state !== "idle" || aanvraag.wacht;
  const toonFout = aanvraag.mislukt ?? fout;
  // Aftellen kan alleen de browser; zonder JavaScript bewaakt de server de wachttijd.
  const rest = nu === null ? 0 : wachtNog(verstuurdOp, nu);

  // biome-ignore lint/correctness/useExhaustiveDependencies: opnieuw focussen bij elke nieuwe fout of melding
  useEffect(() => {
    veld.current?.focus();
  }, [toonFout, melding]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: na een nieuwe code begint de klok opnieuw
  useEffect(() => {
    setNu(Date.now());
  }, [verstuurdOp]);
  useEffect(() => {
    if (rest === 0) return;
    const klok = window.setTimeout(() => setNu(Date.now()), 1000);
    return () => window.clearTimeout(klok);
  }, [rest]);

  function wijzig(invoer: string) {
    const nieuw = leesCode(invoer);
    setCode(nieuw);
    // Alle cijfers getypt of geplakt (of door de telefoon ingevuld): meteen controleren.
    if (isHeleCode(nieuw) && nieuw !== code && !bezig && formulier.current) {
      const gegevens = new FormData(formulier.current);
      gegevens.set("code", nieuw);
      void submit(gegevens, { method: "post" });
    }
  }

  const stilleKnop =
    "h-11 px-0 text-primary underline-offset-4 hover:bg-transparent hover:underline";
  return (
    <Pagina kop="Vul de code in" merk={merk}>
      <p className="text-sm text-muted-foreground">
        Verstuurd naar <span className="font-medium text-foreground">{email}</span>.{" "}
        {vooraf ? "De code werkt een dag." : "De code is een kwartier geldig."} Je kunt ook op de
        link in de mail klikken.
      </p>
      <Form ref={formulier} method="post" className="flex flex-col gap-4" noValidate>
        <input type="hidden" name="doe" value="code" />
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="verstuurd_op" value={verstuurdOp ?? ""} />
        <div className="flex flex-col gap-2">
          <Label htmlFor="code">Code van tien cijfers</Label>
          <Input
            ref={veld}
            id="code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 -]*"
            required
            className="h-14 text-center font-mono text-2xl tracking-[0.25em]"
            placeholder={"•".repeat(CODE_LENGTE)}
            // Zonder JavaScript is dit een gewoon veld; de server haalt de cijfers eruit.
            value={code}
            onChange={(event) => wijzig(event.target.value)}
            aria-invalid={toonFout ? true : undefined}
            aria-describedby={toonFout ? "code-fout" : undefined}
          />
        </div>
        {toonFout ? <Melding id="code-fout">{toonFout.tekst}</Melding> : null}
        {melding ? (
          <p role="status" className="text-sm text-muted-foreground">
            {melding}
          </p>
        ) : null}
        <Button type="submit" size="lg" className="h-12 text-base" disabled={bezig}>
          {doet === "code" ? "Bezig…" : "Inloggen"}
        </Button>
      </Form>
      <div className="flex flex-col gap-1 text-sm">
        <p className="text-muted-foreground">Geen mail gekregen? Kijk ook bij ongewenste mail.</p>
        <div className="flex flex-wrap justify-between gap-x-4">
          <Form method="post" onSubmit={aanvraag.verstuur}>
            <input type="hidden" name="doe" value="opnieuw" />
            {/* Ook deze aanvraag heeft een bewijs van de controle tegen robots nodig. */}
            <Robotvak robot={robot} />
            <Button
              type="submit"
              variant="ghost"
              className={stilleKnop}
              disabled={bezig || rest > 0}
            >
              {doet === "opnieuw" || aanvraag.wacht
                ? "Bezig…"
                : rest > 0
                  ? `Nieuwe code kan over ${rest} s`
                  : "Stuur een nieuwe code"}
            </Button>
          </Form>
          <Form method="post">
            <input type="hidden" name="doe" value="ander-adres" />
            <Button type="submit" variant="ghost" className={stilleKnop} disabled={bezig}>
              Ander e-mailadres
            </Button>
          </Form>
        </div>
      </div>
    </Pagina>
  );
}

/**
 * Binnengekomen via de link uit de mail. Het openen van de pagina doet niets; pas dit
 * formulier (een POST) wisselt de link om. Een mailprogramma of virusscanner die links vooraf
 * opent, verbruikt hem zo niet. Het formulier gaat naar het adres van deze pagina, met de
 * link erin.
 *
 * `vanzelf` (de stand vooraf): de link komt meestal van een medewerker, en de klant hoeft niet
 * nog een keer te klikken. Een scriptje in de browser verstuurt het formulier één keer, zodra de
 * pagina er staat; een linkscanner opent de pagina meestal zonder scripts en verbruikt de link
 * dan niet. Zonder JavaScript staat er één knop. Na het inloggen toont de app kort op welk adres
 * je binnen bent (IngelogdAls).
 */
function LinkStap({
  merk,
  hierAangevraagd,
  vanzelf,
}: {
  merk: string;
  hierAangevraagd: boolean;
  vanzelf: boolean;
}) {
  const bezig = useNavigation().state !== "idle";
  const submit = useSubmit();
  const formulier = useRef<HTMLFormElement>(null);
  const verstuurd = useRef(false);

  useEffect(() => {
    if (!vanzelf || verstuurd.current || !formulier.current) return;
    verstuurd.current = true;
    void submit(formulier.current, { method: "post" });
  }, [vanzelf, submit]);

  return (
    <Pagina kop="Inloggen" merk={merk}>
      {vanzelf ? (
        <p className="text-sm text-muted-foreground">
          Je wordt ingelogd. Gebeurt er niets, klik dan op de knop.
        </p>
      ) : hierAangevraagd ? (
        <p className="text-sm text-muted-foreground">
          Je bent er bijna. Klik op de knop om in te loggen.
        </p>
      ) : (
        // De mail is niet in deze browser aangevraagd. Meestal is dat onschuldig (de link
        // opent in de browser van het mailprogramma), maar een ander kan je ook zíjn link
        // sturen: dan log je in op zijn account en ziet hij wat je daar invult.
        <div
          data-testid="link-waarschuwing"
          className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
        >
          <p className="font-medium">Heb je deze mail zelf aangevraagd?</p>
          <p>
            Log alleen in als je zojuist zelf om deze inlogmail hebt gevraagd. Kreeg je de link van
            iemand anders, dan kom je in het account van die ander: sluit dan deze pagina.
          </p>
        </div>
      )}
      <Form ref={formulier} method="post" className="flex flex-col">
        <input type="hidden" name="doe" value="link" />
        <Button type="submit" size="lg" className="h-12 text-base" disabled={bezig}>
          {bezig ? "Bezig…" : "Inloggen"}
        </Button>
      </Form>
    </Pagina>
  );
}

/**
 * De knoppen van de inlogdiensten. De server begint de inlog en geeft het adres van de dienst
 * terug; de pagina gaat erheen. Zonder JavaScript doet de browser dat zelf (de regel in
 * `noscript`), en anders staat er een link.
 */
function Dienstknoppen({
  diensten,
  uitkomst,
  nadruk = false,
}: {
  diensten: readonly Knopdienst[];
  uitkomst: Inloguitkomst | undefined;
  nadruk?: boolean;
}) {
  const navigatie = useNavigation();
  const naar = uitkomst?.soort === "naar-dienst" ? uitkomst.naar : null;
  const bezig = navigatie.formData?.get("doe") === "dienst" || naar !== null;

  useEffect(() => {
    if (naar) window.location.assign(naar);
  }, [naar]);

  if (diensten.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {diensten.map((dienst) => (
        <Form key={dienst} method="post" className="flex flex-col">
          <input type="hidden" name="doe" value="dienst" />
          <input type="hidden" name="dienst" value={dienst} />
          <Button
            type="submit"
            variant={nadruk ? "default" : "outline"}
            size="lg"
            className="h-12 text-base"
            disabled={bezig}
          >
            {bezig && navigatie.formData?.get("dienst") === dienst ? "Bezig…" : KNOPTEKST[dienst]}
          </Button>
        </Form>
      ))}
      {naar ? (
        <>
          <noscript>
            <meta httpEquiv="refresh" content={`0;url=${naar}`} />
          </noscript>
          <p className="text-sm text-muted-foreground">
            Je wordt doorgestuurd om in te loggen.{" "}
            <a className="underline underline-offset-4" href={naar}>
              Ga verder
            </a>
          </p>
        </>
      ) : null}
      {uitkomst?.soort === "dienst" ? (
        <Melding>Inloggen is niet gelukt. Probeer het opnieuw of vraag je beheerder.</Melding>
      ) : null}
    </div>
  );
}

function AlIngelogd({
  stand,
  uitkomst,
}: {
  stand: Extract<Inlogstand, { stap: "ingelogd" }>;
  uitkomst: Inloguitkomst | undefined;
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-5 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Je bent al ingelogd</h1>
      <p className="text-sm text-muted-foreground">
        Je bent ingelogd als <span className="font-medium text-foreground">{stand.adres}</span>.
      </p>
      <Link to={stand.volgende} className={cn(buttonVariants({ size: "lg" }), "h-12 text-base")}>
        Verder naar de app
      </Link>
      {stand.medewerkersknop ? (
        <Dienstknoppen diensten={["cloudflare"]} uitkomst={uitkomst} />
      ) : null}
      <Form method="post" className="flex flex-col">
        <input type="hidden" name="doe" value="uitloggen" />
        <Button type="submit" variant="ghost">
          Uitloggen
        </Button>
      </Form>
    </main>
  );
}

/**
 * E-mail en wachtwoord: de klanten van dit portaal (`VITE_INLOGDIENST=cloudflare,wachtwoord`,
 * of in de stand vooraf op `/login?met=wachtwoord`), met daaronder de knop voor medewerkers. Een account maakt een medewerker (een uitnodiging
 * per mail); wie zijn wachtwoord kwijt is, vraagt op /wachtwoord-vergeten een nieuw aan. Met
 * `VITE_TURNSTILE_SITEKEY` draait de controle tegen robots mee en gaat het bewijs als
 * `captcha` naar de server. Alleen lokaal (de dev-server) staat de testlogin erboven.
 */
function WachtwoordFormulier({
  merk,
  testlogin,
  email,
  melding,
  robotSleutel,
  knoppen,
  uitkomst,
  metCode,
}: {
  merk: string;
  testlogin: string | null;
  email: string;
  melding: string | null;
  robotSleutel: string | null;
  knoppen: readonly Knopdienst[];
  uitkomst: Inloguitkomst | undefined;
  /** De stand vooraf: het adres van de inlogpagina met de code. Geen "wachtwoord vergeten". */
  metCode: string | null;
}) {
  const robot = useRobotcontrole(robotSleutel ?? undefined);
  const aanvraag = useAanvraag(robot);
  const navigatie = useNavigation();
  const bezig = aanvraag.wacht || navigatie.formData?.get("doe") === "wachtwoord";
  const toon = aanvraag.mislukt?.tekst ?? melding;
  return (
    <Pagina kop="Inloggen" merk={merk}>
      {testlogin ? (
        // Lokaal, met de testdatabase: één klik en je bent binnen als de testgebruiker. Het
        // wachtwoord blijft op de server; in een gebouwde versie is er nooit een testlogin.
        <Form method="post" className="flex flex-col gap-2 rounded-md border border-dashed p-4">
          <input type="hidden" name="doe" value="testlogin" />
          <Button type="submit" disabled={navigatie.state !== "idle"}>
            Inloggen als testgebruiker
          </Button>
          <p className="text-xs text-muted-foreground">
            Alleen op deze computer, met de testdatabase: {testlogin}
          </p>
        </Form>
      ) : null}
      <Form method="post" className="flex flex-col gap-4" onSubmit={aanvraag.verstuur} noValidate>
        <input type="hidden" name="doe" value="wachtwoord" />
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">E-mailadres</Label>
          <Input
            id="email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="h-12 text-base"
            defaultValue={email}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">Wachtwoord</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            className="h-12 text-base"
          />
        </div>
        {toon ? <Melding>{toon}</Melding> : null}
        <Robotvak robot={robot} />
        <Button type="submit" size="lg" className="h-12 text-base" disabled={bezig}>
          {bezig ? "Bezig…" : "Inloggen"}
        </Button>
        {metCode ? (
          // Wachtwoord kwijt: inloggen met een code, en op Mijn account een nieuw instellen.
          <Link to={metCode} className="text-sm text-primary underline-offset-4 hover:underline">
            Wachtwoord vergeten of geen wachtwoord? Log in met een code per mail.
          </Link>
        ) : (
          <Link
            to="/wachtwoord-vergeten"
            className="text-sm text-primary underline-offset-4 hover:underline"
          >
            Wachtwoord vergeten?
          </Link>
        )}
      </Form>
      {knoppen.length > 0 ? (
        <>
          <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
            <span className="h-px flex-1 bg-border" />
            of
            <span className="h-px flex-1 bg-border" />
          </div>
          <Dienstknoppen diensten={knoppen} uitkomst={uitkomst} />
        </>
      ) : null}
    </Pagina>
  );
}

/** Zo lang staat na het inloggen bovenin op welk adres je bent ingelogd. */
export const INGELOGD_ALS_MS = 10_000;

/**
 * Kort na het inloggen: op welk adres ben je binnen? Wie via een link van een ander in het
 * verkeerde account terechtkomt, ziet het hier meteen. Zonder JavaScript blijft de regel
 * staan tot de volgende pagina.
 */
export function IngelogdAls({ adres }: { adres: string | null }) {
  const [verborgen, setVerborgen] = useState<string | null>(null);
  useEffect(() => {
    if (!adres) return;
    const klok = window.setTimeout(() => setVerborgen(adres), INGELOGD_ALS_MS);
    return () => window.clearTimeout(klok);
  }, [adres]);

  if (!adres || verborgen === adres) return null;
  return (
    <p
      role="status"
      data-testid="ingelogd-als"
      className="bg-muted px-3 py-2 text-center text-sm text-foreground"
    >
      Je bent ingelogd als <span className="font-medium">{adres}</span>.
    </p>
  );
}
