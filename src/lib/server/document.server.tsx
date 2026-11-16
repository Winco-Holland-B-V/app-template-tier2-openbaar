import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import {
  type EntryContext,
  type HandleErrorFunction,
  type RouterContextProvider,
  ServerRouter,
} from "react-router";
import { meldServerfout } from "./fouten.server";
import { verzoekContext } from "./verzoek.server";

/**
 * Hoe de server een pagina maakt en wat hij doet met een fout. `src/entry.server.tsx` geeft
 * dit alleen door; React Router zoekt het daar.
 *
 * Het verschil met de standaard van React Router: elk script in de pagina krijgt de
 * eenmalige code van dit antwoord (`nonce`), zodat de Content-Security-Policy alle andere
 * scripts kan weigeren, en fouten gaan naar Sentry.
 *
 * Dit bestand is van de template en komt met elke versie mee.
 */
export const streamTimeout = 5_000;

export default async function handleRequest(
  request: Request,
  status: number,
  headers: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider,
): Promise<Response> {
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, { status, headers });
  }
  const nonce = loadContext.get(verzoekContext)?.nonce;
  let klaar = false;
  let antwoordStatus = status;
  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} nonce={nonce} />,
    {
      nonce,
      signal: AbortSignal.timeout(streamTimeout + 1000),
      onError(fout: unknown) {
        antwoordStatus = 500;
        // Een fout vóór het begin van de pagina meldt React Router zelf (handleError);
        // een fout tijdens het streamen alleen wij.
        if (klaar) handleError(fout, { request, context: loadContext, params: {} });
      },
    },
  );
  klaar = true;
  // Zoekmachines krijgen de hele pagina in één keer, niet in stukken.
  const userAgent = request.headers.get("user-agent");
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) await body.allReady;
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(body, { status: antwoordStatus, headers });
}

/** Een fout in een loader, een action of bij het maken van de pagina. */
export const handleError: HandleErrorFunction = (fout, { request, context }) => {
  const verzoek = context.get(verzoekContext);
  meldServerfout(fout, {
    request,
    dsn: verzoek?.instellingen.sentryDsn ?? null,
    omgeving: verzoek?.instellingen.omgeving ?? null,
    wachtOp: verzoek?.wachtOp ?? (() => {}),
  });
};
