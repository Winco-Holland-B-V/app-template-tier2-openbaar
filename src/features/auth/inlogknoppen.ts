/**
 * De inlogdiensten met een knop op de inlogpagina. `cloudflare` is de knop voor medewerkers.
 * Los van inloggen.server.ts, omdat de pagina in de browser de teksten ook nodig heeft.
 */
export const KNOPTEKST = {
  cloudflare: "Inloggen voor medewerkers",
  azure: "Inloggen met Microsoft",
  google: "Inloggen met Google",
} as const;

export type Knopdienst = keyof typeof KNOPTEKST;

export function isKnopdienst(dienst: string): dienst is Knopdienst {
  return Object.hasOwn(KNOPTEKST, dienst);
}
