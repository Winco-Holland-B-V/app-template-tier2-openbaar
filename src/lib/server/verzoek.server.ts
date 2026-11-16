import type { createServerClient } from "@supabase/ssr";
import { createContext, type RouterContextProvider } from "react-router";
import type { Database } from "@/lib/database.types";
import type { Instellingen } from "./instellingen.server";

/**
 * Alles wat bij één verzoek hoort. Een Worker deelt zijn modules tussen alle verzoeken en
 * alle bezoekers; wat op moduleniveau staat (een `let` bovenin een bestand), is dus van
 * iedereen tegelijk. Daarom staat de toestand van een verzoek hier: de Worker maakt er voor
 * elk verzoek een nieuwe (zie worker.server.ts) en geeft hem via `context` aan elke loader
 * en action.
 *
 * Dit bestand is van de template en komt met elke versie mee.
 */
export type ServerSupabase = ReturnType<typeof createServerClient<Database>>;

/** De ingelogde gebruiker, zoals de server hem heeft gecontroleerd. */
export type Gebruiker = {
  id: string;
  email: string | null;
  /** De gecontroleerde inhoud van het token (rol, inlogmethode, eigen velden). */
  claims: Record<string, unknown>;
};

export type Verzoek = {
  request: Request;
  instellingen: Instellingen;
  /** Is dit het echte adres van de app? Zie isProductie. */
  productie: boolean;
  /** Eenmalige code voor de Content-Security-Policy van dit ene antwoord. */
  nonce: string;
  /** De Supabase-client van dit verzoek; pas gemaakt als een loader erom vraagt. */
  supabase: ServerSupabase | null;
  /** Uitkomst van `gebruiker()`: undefined = nog niet gevraagd, null = niet ingelogd. */
  gebruiker: Promise<Gebruiker | null> | undefined;
  /** Is er in dit verzoek een ingelogde gebruiker gevonden? */
  ingelogd: boolean;
  /** Cookies die Supabase wil zetten (een ververste sessie); de Worker zet ze op het antwoord. */
  cookiesUit: string[];
  /** Vroeg een route om een openbare cache? Het aantal seconden, anders null. */
  openbaarCache: number | null;
  /** Is het antwoord al onderweg? Dan kan er geen cookie meer bij. */
  antwoordKlaar: boolean;
  /** Werk dat na het antwoord nog af moet (een fout melden). */
  wachtOp: (werk: Promise<unknown>) => void;
};

export const verzoekContext = createContext<Verzoek | null>(null);

/** Het verzoek waar deze loader of action bij hoort. */
export function verzoekUit(context: Readonly<RouterContextProvider>): Verzoek {
  const verzoek = context.get(verzoekContext);
  if (!verzoek) {
    throw new Error(
      "Deze servercode draait buiten de Worker van de template (workers/app.ts). Daar hoort elk verzoek doorheen te gaan: die maakt de toestand per verzoek en zet de beveiliging op het antwoord.",
    );
  }
  return verzoek;
}
