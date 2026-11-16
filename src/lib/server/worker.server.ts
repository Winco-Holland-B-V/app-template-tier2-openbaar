import { createRequestHandler, RouterContextProvider, type ServerBuild } from "react-router";
import {
  NIET_INDEXEREN,
  nieuweNonce,
  ROBOTS_DICHT,
  ROBOTS_OPEN,
  vanEigenSite,
  zetBeveiliging,
} from "./beveiliging.server";
import { NIET_BEWAREN, zetCache } from "./cache.server";
import { meldServerfout } from "./fouten.server";
import { type Instellingen, isProductie, leesInstellingen } from "./instellingen.server";
import { type Verzoek, verzoekContext } from "./verzoek.server";

/**
 * De Worker van de template: elk verzoek aan de servercode gaat hier doorheen, vóór en na
 * React Router. Hier staat wat voor elke app en elke route moet gelden, zodat geen route het
 * kan vergeten:
 *
 *   - een schrijvend verzoek van een andere site wordt geweigerd;
 *   - elk verzoek krijgt zijn eigen toestand (de Supabase-client, de gebruiker); niets
 *     daarvan staat op moduleniveau;
 *   - de cacheregel: met een sessie altijd `private, no-store` (cache.server.ts);
 *   - de beveiligingsheaders, met een Content-Security-Policy op elke pagina;
 *   - op elk adres dat niet het echte domein is: `noindex` en een robots.txt die alles
 *     weigert;
 *   - de bindingen van Cloudflare (`env`) gaan niet door naar de app. Er horen er ook geen
 *     te zijn: gegevens en geheimen staan in Supabase.
 *
 * Dit bestand is van de template en komt met elke versie mee.
 */
type Afhandelaar = (request: Request, context: RouterContextProvider) => Promise<Response>;

type Opties = {
  afhandelaar: Afhandelaar;
  instellingen: Instellingen;
  wachtOp: (werk: Promise<unknown>) => void;
};

/** Het vaste adres waar zoekmachines hun regels ophalen. */
const ROBOTS = "/robots.txt";

function platTekst(tekst: string, status: number): Response {
  return new Response(tekst, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** Eén verzoek, van binnenkomst tot antwoord. Los te testen, zonder Cloudflare. */
export async function behandel(request: Request, opties: Opties): Promise<Response> {
  const { afhandelaar, instellingen, wachtOp } = opties;
  const adres = new URL(request.url);
  const verzoek: Verzoek = {
    request,
    instellingen,
    productie: isProductie(adres, instellingen),
    nonce: nieuweNonce(),
    supabase: null,
    gebruiker: undefined,
    ingelogd: false,
    cookiesUit: [],
    openbaarCache: null,
    antwoordKlaar: false,
    wachtOp,
  };

  let antwoord: Response;
  if (!vanEigenSite(request)) {
    antwoord = platTekst("Verzoek geweigerd: het komt niet van deze app zelf.", 403);
  } else if (adres.pathname === ROBOTS && !verzoek.productie) {
    antwoord = platTekst(ROBOTS_DICHT, 200);
  } else {
    const context = new RouterContextProvider();
    context.set(verzoekContext, verzoek);
    try {
      antwoord = await afhandelaar(request, context);
    } catch (fout) {
      meldServerfout(fout, {
        request,
        dsn: instellingen.sentryDsn,
        omgeving: instellingen.omgeving,
        wachtOp,
      });
      antwoord = platTekst("Er ging iets mis.", 500);
    }
    if (adres.pathname === ROBOTS && antwoord.status === 404) {
      antwoord = platTekst(ROBOTS_OPEN, 200);
    }
  }

  // Een eigen kopie van de headers: die van een antwoord uit `fetch` zijn niet te wijzigen.
  const headers = new Headers(antwoord.headers);
  for (const cookie of verzoek.cookiesUit) headers.append("Set-Cookie", cookie);
  verzoek.antwoordKlaar = true;
  try {
    zetCache(headers, request, antwoord, verzoek);
  } catch {
    headers.set("Cache-Control", NIET_BEWAREN);
  }
  zetBeveiliging(headers, { adres, nonce: verzoek.nonce, instellingen });
  if (!verzoek.productie) headers.set("X-Robots-Tag", NIET_INDEXEREN);
  return new Response(request.method === "HEAD" ? null : antwoord.body, {
    status: antwoord.status,
    statusText: antwoord.statusText,
    headers,
  });
}

/**
 * Maakt de Worker. `workers/app.ts` roept dit aan met de gebouwde app en de openbare
 * waarden uit de build; meer staat daar niet.
 */
export function maakWorker({
  build,
  mode,
  omgeving,
}: {
  build: () => Promise<ServerBuild>;
  mode: string;
  omgeving: Record<string, unknown>;
}): { fetch: (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> } {
  const afhandelaar = createRequestHandler(build, mode);
  const instellingen = leesInstellingen(omgeving, mode);
  return {
    fetch(request, _env, ctx) {
      return behandel(request, {
        afhandelaar,
        instellingen,
        wachtOp: (werk) => ctx.waitUntil(werk),
      });
    },
  };
}
