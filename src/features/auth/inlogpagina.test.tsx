// @vitest-environment node
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";
import type { Inlogstand, Inloguitkomst } from "./inloggen.server";
import { IngelogdAls, Inlogpagina } from "./inlogpagina";
import { fout } from "./mailcode";

/**
 * De inlogpagina zoals de server haar maakt, zonder browser: elk onderdeel is een gewoon
 * formulier dat ook zonder JavaScript werkt. De stappen zelf test inloggen.server.test.ts;
 * hier staat wat er op het scherm komt.
 */
const BASIS = {
  metMail: true,
  knoppen: ["cloudflare" as const],
  robotSleutel: null,
  volgende: "/",
};

/** Wat de pagina nu tekent; `teken` zet het klaar. */
let nu: { stand: Inlogstand; uitkomst?: Inloguitkomst };

function Pagina() {
  return <Inlogpagina stand={nu.stand} uitkomst={nu.uitkomst} merk="Voorbeeldwinkel" />;
}

function teken(stand: Inlogstand, uitkomst?: Inloguitkomst, adres = "/login") {
  nu = { stand, uitkomst };
  const Stub = createRoutesStub([{ path: "/login", Component: Pagina }]);
  return renderToString(<Stub initialEntries={[adres]} />);
}

const formulieren = (pagina: string) =>
  [...pagina.matchAll(/<form[^>]*>[\s\S]*?<\/form>/g)].map((treffer) => treffer[0]);

describe("de inlogpagina, kant-en-klaar van de server", () => {
  it("het begin: een adresveld voor klanten en de knop voor medewerkers, elk een formulier met POST", () => {
    const pagina = teken({ ...BASIS, stap: "adres", email: "", fout: null });
    expect(pagina).toContain("Voorbeeldwinkel");
    expect(pagina).toContain("Inloggen</h1>");
    expect(pagina).toContain("Je krijgt een mail met een code van tien cijfers.");
    expect(pagina).toContain("Werk je hier? Gebruik de knop Inloggen voor medewerkers.");
    const lijst = formulieren(pagina);
    expect(lijst).toHaveLength(2);
    for (const formulier of lijst) {
      expect(formulier).toContain('method="post"');
      expect(formulier).toContain('action="/login"');
    }
    expect(lijst[0]).toContain('name="doe" value="vraag"');
    expect(lijst[0]).toContain('name="email"');
    expect(lijst[1]).toContain('name="doe" value="dienst"');
    expect(lijst[1]).toContain('name="dienst" value="cloudflare"');
    // Zonder sleutel geen controle tegen robots op de pagina.
    expect(pagina).not.toContain("robotcontrole");
  });

  it("het pad waar de bezoeker heen wilde blijft in het adres van elk formulier", () => {
    const pagina = teken(
      { ...BASIS, stap: "adres", email: "", fout: null, volgende: "/wagen" },
      undefined,
      "/login?volgende=%2Fwagen",
    );
    for (const formulier of formulieren(pagina)) {
      expect(formulier).toContain('action="/login?volgende=%2Fwagen"');
    }
  });

  it("een fout bij het adres staat bij het veld; het ingevulde adres blijft staan, als tekst", () => {
    const pagina = teken(
      { ...BASIS, stap: "adres", email: "", fout: null },
      {
        soort: "adres",
        email: '"><script>alert(1)</script>',
        fout: fout("adres"),
      },
    );
    expect(pagina).toContain("Dit lijkt geen geldig e-mailadres.");
    expect(pagina).not.toContain("<script>alert(1)</script>");
    expect(pagina).toContain("&lt;script&gt;");
  });

  it("een weigering van de inlogdienst staat los van het adresveld", () => {
    const pagina = teken({ ...BASIS, stap: "adres", email: "", fout: fout("bevestig-adres") });
    expect(pagina).toContain("Je e-mailadres moet nog één keer bevestigd worden.");
    expect(pagina).not.toContain('id="email-fout"');
  });

  it("de code: het veld voor de telefoon, het adres erbij, opnieuw sturen en een ander adres als formulier", () => {
    const pagina = teken({
      ...BASIS,
      stap: "code",
      email: "klant@voorbeeld.nl",
      verstuurdOp: 1_700_000_000_000,
      wachtNog: 0,
      fout: null,
      melding: "Er is een nieuwe code verstuurd.",
    });
    expect(pagina).toContain("Vul de code in</h1>");
    expect(pagina).toContain("klant@voorbeeld.nl");
    expect(pagina).toContain('autoComplete="one-time-code"');
    expect(pagina).toContain('inputMode="numeric"');
    expect(pagina).toContain("Er is een nieuwe code verstuurd.");
    const doe = formulieren(pagina).map((f) => /name="doe" value="([^"]+)"/.exec(f)?.[1]);
    expect(doe).toEqual(["code", "opnieuw", "ander-adres"]);
    expect(formulieren(pagina)[0]).toContain('name="email" value="klant@voorbeeld.nl"');
    // Zonder JavaScript is de knop voor een nieuwe code gewoon te gebruiken.
    expect(formulieren(pagina)[1]).not.toContain('disabled=""');
  });

  it("een foute code houdt de pagina op de code, ook als het geheugen van de pagina al leeg is", () => {
    const pagina = teken(
      { ...BASIS, stap: "adres", email: "", fout: null },
      {
        soort: "code",
        email: "klant@voorbeeld.nl",
        verstuurdOp: null,
        fout: fout("code"),
      },
    );
    expect(pagina).toContain("Vul de code in</h1>");
    expect(pagina).toContain("Deze code klopt niet.");
  });

  it("de link uit de mail: een knop in een formulier naar hetzelfde adres, met de waarschuwing als de mail hier niet is aangevraagd", () => {
    const adres = "/login?token_hash=pkce_0123456789abcdef&type=email";
    const vreemd = teken({ ...BASIS, stap: "link", hierAangevraagd: false }, undefined, adres);
    expect(vreemd).toContain("Heb je deze mail zelf aangevraagd?");
    expect(vreemd).toContain("dan kom je in het account van die ander");
    const [formulier] = formulieren(vreemd);
    expect(formulier).toContain('method="post"');
    expect(formulier).toContain('action="/login?token_hash=pkce_0123456789abcdef&amp;type=email"');
    expect(formulier).toContain('name="doe" value="link"');

    const zelf = teken({ ...BASIS, stap: "link", hierAangevraagd: true }, undefined, adres);
    expect(zelf).toContain("Je bent er bijna.");
    expect(zelf).not.toContain("link-waarschuwing");
  });

  it("naar de inlogdienst: zonder JavaScript stuurt de browser zelf door, en er staat een link", () => {
    const naar =
      "https://abcdefghijklmnopqrst.supabase.co/auth/v1/authorize?provider=custom%3Acloudflare&code_challenge=x";
    const pagina = teken(
      { ...BASIS, stap: "adres", email: "", fout: null },
      {
        soort: "naar-dienst",
        naar,
      },
    );
    const veilig = naar.replaceAll("&", "&amp;");
    expect(pagina).toContain(
      `<noscript><meta http-equiv="refresh" content="0;url=${veilig}"/></noscript>`,
    );
    expect(pagina).toContain(`href="${veilig}"`);
  });

  it("al ingelogd: verder, uitloggen als formulier, en de knop voor medewerkers alleen als die zin heeft", () => {
    const klant = teken({
      ...BASIS,
      stap: "ingelogd",
      adres: "klant@voorbeeld.nl",
      medewerkersknop: true,
      volgende: "/wagen",
    });
    expect(klant).toContain("Je bent al ingelogd</h1>");
    expect(klant).toContain("klant@voorbeeld.nl");
    expect(klant).toContain('href="/wagen"');
    const doe = formulieren(klant).map((f) => /name="doe" value="([^"]+)"/.exec(f)?.[1]);
    expect(doe).toEqual(["dienst", "uitloggen"]);

    const medewerker = teken({
      ...BASIS,
      stap: "ingelogd",
      adres: "baas@klant.nl",
      medewerkersknop: false,
    });
    expect(medewerker).not.toContain("Inloggen voor medewerkers");
  });

  it("met de controle tegen robots: het vak voor Turnstile en een regel voor wie geen JavaScript heeft", () => {
    const pagina = teken({
      ...BASIS,
      robotSleutel: "1x00000000000000000000AA",
      stap: "adres",
      email: "",
      fout: null,
    });
    expect(pagina).toContain('data-testid="robotcontrole"');
    expect(pagina).toContain("Zet JavaScript aan om een code aan te vragen");
  });

  it("alleen lokaal en in de tests: het formulier met een wachtwoord, en de testlogin zonder wachtwoord in de pagina", () => {
    const pagina = teken({
      ...BASIS,
      metMail: false,
      knoppen: [],
      stap: "wachtwoord",
      testlogin: "testgebruiker@stagetwo.nl",
      fout: null,
    });
    const doe = formulieren(pagina).map((f) => /name="doe" value="([^"]+)"/.exec(f)?.[1]);
    expect(doe).toEqual(["testlogin", "wachtwoord"]);
    expect(pagina).toContain("testgebruiker@stagetwo.nl");
    expect(formulieren(pagina)[0]).not.toContain('type="password"');
  });
});

describe("IngelogdAls", () => {
  it("toont het adres, en niets als er niet net is ingelogd", () => {
    expect(renderToString(<IngelogdAls adres="klant@voorbeeld.nl" />)).toContain(
      "klant@voorbeeld.nl",
    );
    expect(renderToString(<IngelogdAls adres={null} />)).toBe("");
  });
});
