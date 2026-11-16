import type { RouterContextProvider } from "react-router";
import { GEEN_BROWSER_REGELS, type Instellingen } from "../../src/lib/server/instellingen.server";
import { behandel } from "../../src/lib/server/worker.server";

/** Hulp voor de tests van de servercode (src/lib/server/). Van de template. */
export const INSTELLINGEN: Instellingen = {
  mode: "production",
  supabaseUrl: "https://abcdefghijklmnopqrst.supabase.co",
  supabaseAnonKey: "sb_publishable_alleen_voor_tests",
  schema: "public",
  sentryDsn: null,
  omgeving: null,
  productiedomein: "shop.klant.nl",
  turnstileSitekey: null,
  browser: GEEN_BROWSER_REGELS,
};

export type Route = (
  request: Request,
  context: RouterContextProvider,
) => Promise<Response> | Response;

export const html = (tekst: string, init: ResponseInit = {}) =>
  new Response(`<!doctype html><html><body>${tekst}</body></html>`, {
    ...init,
    headers: { "Content-Type": "text/html; charset=utf-8", ...init.headers },
  });

/** Stuurt één verzoek door de Worker van de template, met `route` op de plek van React Router. */
export function vraag(
  adres: string,
  route: Route,
  {
    init,
    instellingen = INSTELLINGEN,
    wachtOp = () => {},
  }: {
    init?: RequestInit;
    instellingen?: Instellingen;
    wachtOp?: (werk: Promise<unknown>) => void;
  } = {},
): Promise<Response> {
  return behandel(new Request(adres, init), {
    afhandelaar: async (request, context) => route(request, context),
    instellingen,
    wachtOp,
  });
}

function base64url(tekst: string): string {
  return Buffer.from(tekst).toString("base64url");
}

/**
 * Een token in JWT-vorm met een zelfgekozen inhoud en een handtekening die nergens op
 * slaat: zo ziet een nagemaakt token eruit. Op het moment van draaien samengesteld, zodat er
 * geen tekst in git staat die op een echte sleutel lijkt.
 */
export function nepJwt(inhoud: Record<string, unknown>, alg = "HS256"): string {
  return [
    base64url(JSON.stringify({ alg, typ: "JWT" })),
    base64url(JSON.stringify(inhoud)),
    base64url("nep-handtekening-alleen-voor-tests"),
  ].join(".");
}

/**
 * Het sessiecookie zoals @supabase/ssr het schrijft, voor het project in INSTELLINGEN. Over
 * https (alle tests hier) heet het `__Host-sb-<project>-auth-token`; zie sessie-cookie.ts.
 */
export function sessieCookie(
  inhoud: Record<string, unknown>,
  alg = "HS256",
  naam = "__Host-sb-abcdefghijklmnopqrst-auth-token",
): string {
  const over = Math.floor(Date.now() / 1000) + 3600;
  const sessie = {
    access_token: nepJwt(
      { exp: over, aud: "authenticated", role: "authenticated", ...inhoud },
      alg,
    ),
    refresh_token: "nep-verversing",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: over,
    user: {
      id: inhoud.sub,
      email: inhoud.email,
      role: "authenticated",
      app_metadata: { rol: "beheerder" },
    },
  };
  return `${naam}=base64-${base64url(JSON.stringify(sessie))}`;
}
