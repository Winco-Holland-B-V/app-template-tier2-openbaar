import { isRouteErrorResponse } from "react-router";

/**
 * Fouten in de servercode naar Sentry, als er een DSN is (`VITE_SENTRY_DSN`); zonder DSN
 * alleen in het logboek van Cloudflare. De schermen in de browser melden hun eigen fouten
 * (src/lib/fouten.ts); dit is hetzelfde voor wat op de server misgaat.
 *
 * Bewust zonder het pakket van Sentry: dat vraagt in een Worker een Node-instelling die de
 * servercode ook bij omgevingsvariabelen laat. Eén verzoek naar Sentry met de fout en waar
 * hij optrad is genoeg, en er gaan geen persoonsgegevens mee: geen cookies, geen headers,
 * geen parameters uit het adres, geen gebruiker.
 *
 * Dit bestand is van de template en komt met elke versie mee.
 */
type Dsn = { adres: string; sleutel: string };

/** `https://<sleutel>@<host>/<project>` wordt het adres waar Sentry fouten aanneemt. */
export function leesDsn(dsn: string | null): Dsn | null {
  if (!dsn) return null;
  try {
    const url = new URL(dsn);
    const project = url.pathname.replace(/^\/+|\/+$/g, "");
    if (url.protocol !== "https:" || !url.username || !/^[0-9]+$/.test(project)) return null;
    return { adres: `https://${url.host}/api/${project}/envelope/`, sleutel: url.username };
  } catch {
    return null;
  }
}

/**
 * Is dit een storing? Een adres dat niet bestaat, een weigering (een antwoord met een
 * 4xx-status), een omleiding en een verzoek dat de bezoeker zelf afbrak zijn dat niet.
 */
export function isStoring(fout: unknown, request: Request): boolean {
  if (request.signal.aborted) return false;
  if (fout instanceof Response) return fout.status >= 500;
  if (isRouteErrorResponse(fout)) return fout.status >= 500;
  if (fout instanceof Error && fout.name === "AbortError") return false;
  return true;
}

type Frame = { function?: string; filename?: string; lineno?: number; colno?: number };

/** De regels van een stack (V8-vorm) als frames, de oudste aanroep eerst zoals Sentry wil. */
export function framesUit(stack: string | undefined): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const regel of stack.split("\n")) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(regel);
    if (!m) continue;
    frames.push({
      ...(m[1] ? { function: m[1] } : {}),
      filename: m[2],
      lineno: Number(m[3]),
      colno: Number(m[4]),
    });
  }
  return frames.reverse().slice(-50);
}

function willekeurigId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/** Het bericht voor Sentry (een "envelope" met één fout). */
export function sentryBericht(
  fout: unknown,
  { request, omgeving, nu = new Date() }: { request: Request; omgeving: string | null; nu?: Date },
): { id: string; tekst: string } {
  const echt = isRouteErrorResponse(fout)
    ? new Error(`${fout.status} ${fout.statusText}`)
    : fout instanceof Error
      ? fout
      : new Error(typeof fout === "string" ? fout : "Onbekende fout in de servercode");
  const adres = new URL(request.url);
  const id = willekeurigId();
  const gebeurtenis = {
    event_id: id,
    timestamp: nu.getTime() / 1000,
    platform: "javascript",
    level: "error",
    environment: omgeving ?? "productie",
    tags: { runtime: "cloudflare-worker", kant: "server" },
    // Alleen het pad: parameters in het adres kunnen persoonsgegevens zijn.
    request: { method: request.method, url: `${adres.origin}${adres.pathname}` },
    exception: {
      values: [
        {
          type: echt.name || "Error",
          value: echt.message,
          mechanism: { type: "generic", handled: false },
          stacktrace: { frames: framesUit(echt.stack) },
        },
      ],
    },
  };
  const tekst = [
    JSON.stringify({ event_id: id, sent_at: nu.toISOString() }),
    JSON.stringify({ type: "event" }),
    JSON.stringify(gebeurtenis),
  ].join("\n");
  return { id, tekst };
}

/**
 * Meldt een fout uit de servercode. Schrijft hem altijd in het logboek en stuurt hem naar
 * Sentry als er een geldige DSN is. Faalt het versturen, dan blijft het daarbij: een fout
 * bij het melden mag het antwoord aan de bezoeker nooit raken.
 */
export function meldServerfout(
  fout: unknown,
  {
    request,
    dsn,
    omgeving,
    wachtOp,
    verstuur = fetch,
  }: {
    request: Request;
    dsn: string | null;
    omgeving: string | null;
    wachtOp: (werk: Promise<unknown>) => void;
    verstuur?: typeof fetch;
  },
): boolean {
  if (!isStoring(fout, request)) return false;
  console.error(isRouteErrorResponse(fout) && fout.data ? fout.data : fout);
  const doel = leesDsn(dsn);
  if (!doel) return false;
  const { tekst } = sentryBericht(fout, { request, omgeving });
  const adres = `${doel.adres}?sentry_key=${encodeURIComponent(doel.sleutel)}&sentry_version=7&sentry_client=stagetwo-worker%2F1`;
  wachtOp(
    verstuur(adres, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body: tekst,
    }).then(
      () => undefined,
      () => undefined,
    ),
  );
  return true;
}
