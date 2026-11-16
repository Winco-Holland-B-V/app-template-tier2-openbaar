import { type ComponentType, lazy, Suspense, useEffect, useState } from "react";
import { paginaMeta } from "@/lib/vindbaar/meta";

/**
 * Een browser-scherm: een pagina die alleen in de browser bestaat. De server stuurt het
 * HTML-document met een laadregel; de browser laadt daarna het scherm en toont het.
 *
 * Wanneer: voor alles wat alleen in de browser kan (de camera, een barcodescanner, printen,
 * een Excel- of PDF-bestand maken, een bestand van het apparaat lezen), en als eerste stap bij
 * het omzetten van een bestaande app (docs/routes/omzetten-naar-openbaar.md): elk oud scherm
 * werkt dan meteen, zonder dat de server het hoeft te kunnen maken.
 *
 * Zo gebruik je het, in een route in src/routes/:
 *
 *   // src/features/voorraad/scanner.client.tsx (de naam eindigt op .client), één regel:
 *   //   export { default } uit het scherm zelf (scanner.tsx, naast dit bestand)
 *
 *   // src/routes/scanner.tsx
 *   //   import Scanner uit src/features/voorraad/scanner.client
 *   //   import { browserScherm } uit src/lib/browser-scherm
 *
 *   const scherm = browserScherm({ titel: "Voorraad scannen", scherm: Scanner });
 *   export const clientLoader = scherm.clientLoader;
 *   export const HydrateFallback = scherm.HydrateFallback;
 *   export const meta = scherm.meta;
 *   export const headers = scherm.headers;
 *   export default scherm.Scherm;
 *
 * Waarom het bestand op `.client.tsx` eindigt: React Router laat zo'n bestand bij het bouwen
 * van de server leeg. Alles wat het scherm importeert (een Excel-bibliotheek, een PDF-maker,
 * een scanner) komt dan niet in de Worker, die een grens aan zijn grootte heeft (zie
 * docs/WERKWIJZE.md, "Server en browser"). Komt het scherm toch op de server aan, dan weigert
 * deze hulp bij het starten, met uitleg.
 *
 * Een heel zwaar scherm laad je pas als het nodig is, met `laad` in plaats van `scherm`:
 *
 *   // src/features/rapport/rapport.client.ts: laadRapport laadt het scherm met een
 *   // dynamische import van rapport.tsx, naast dit bestand.
 *
 *   const scherm = browserScherm({ titel: "Rapport", laad: laadRapport });
 *
 * De standaard: niet in zoekmachines (`noindex`, in de pagina en als header), en geen
 * openbare cache (de Worker zet op elk antwoord `private, no-store`, en deze route vraagt
 * niets anders). Wil je een vindbaar scherm, dan is dit niet de goede hulp: geef het een
 * route met een `loader` en `meta` (docs/routes/webshop.md).
 *
 * Dit bestand is van de template en komt met elke versie mee.
 */

type Scherm = ComponentType;

export type BrowserSchermOpties = {
  /** De titel in het tabblad. */
  titel: string;
  /** Een zin over de pagina; zoekmachines komen er niet, maar een gedeelde link toont hem. */
  omschrijving?: string;
  /** De tekst terwijl het scherm laadt. */
  laadtekst?: string;
} & (
  | {
      /** Het scherm, geïmporteerd uit een bestand dat op `.client.tsx` eindigt. */
      scherm: Scherm | undefined;
      laad?: never;
    }
  | {
      /** Laadt het scherm pas als het nodig is; staat in een bestand dat op `.client.ts` eindigt. */
      laad: (() => Promise<{ default: Scherm }>) | undefined;
      scherm?: never;
    }
);

/** Waar als deze code in de browser draait, niet op de server. */
export function inDeBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/**
 * Waar zodra de pagina in de browser draait en de server klaar is met zijn deel. Voor een
 * stukje van een server-pagina dat alleen in de browser kan (een kaart, een knop voor de
 * camera): toon tot dan iets eenvoudigs.
 */
export function useInDeBrowser(): boolean {
  const [klaar, setKlaar] = useState(false);
  useEffect(() => setKlaar(true), []);
  return klaar;
}

export const OP_DE_SERVER =
  "browser-scherm: het scherm is op de server geladen. Importeer het uit een bestand waarvan de naam op .client.tsx (of .client.ts) eindigt, zodat het niet in de Worker komt. Zie src/lib/browser-scherm.tsx.";

/**
 * Maakt de onderdelen van een route die alleen in de browser bestaat. Zet ze één voor één
 * als export in het route-bestand (zie boven); `export const { ... } = browserScherm(...)`
 * kan React Router niet lezen.
 */
export function browserScherm(opties: BrowserSchermOpties) {
  const { titel, omschrijving = titel, laadtekst = "Bezig met laden…" } = opties;
  const bron = opties.scherm ?? opties.laad;
  // Op de server is een .client-bestand leeg: `scherm` en `laad` zijn er dan niet. Zijn ze er
  // wel, dan zit de code van het scherm in de Worker.
  if (!inDeBrowser() && bron !== undefined) throw new Error(OP_DE_SERVER);
  if (inDeBrowser() && bron === undefined) {
    throw new Error(`browser-scherm "${titel}": geef \`scherm\` of \`laad\` mee.`);
  }

  const Inhoud: Scherm | null = opties.laad ? lazy(opties.laad) : (opties.scherm ?? null);

  /** Niets op de server: de browser haalt zelf wat het scherm nodig heeft. */
  async function clientLoader() {
    return null;
  }
  clientLoader.hydrate = true as const;

  return {
    clientLoader,
    /** Wat de server stuurt, en wat de browser toont tot het scherm er is. */
    // biome-ignore lint/correctness/noComponentHookFactories: één keer per route-bestand gemaakt, bij het laden; daarna altijd hetzelfde onderdeel.
    HydrateFallback: () => <Laden tekst={laadtekst} />,
    meta: () => paginaMeta({ titel, omschrijving, zoekmachines: false }),
    headers: () => ({ "X-Robots-Tag": "noindex, nofollow" }),
    // biome-ignore lint/correctness/noComponentHookFactories: zie boven.
    Scherm: () => <MetLaadregel inhoud={Inhoud} laadtekst={laadtekst} />,
  };
}

function Laden({ tekst }: { tekst: string }) {
  return (
    <p className="p-6 text-sm text-muted-foreground" role="status">
      {tekst}
    </p>
  );
}

function MetLaadregel({ inhoud: Inhoud, laadtekst }: { inhoud: Scherm | null; laadtekst: string }) {
  if (Inhoud === null) return <Laden tekst={laadtekst} />;
  return (
    <Suspense fallback={<Laden tekst={laadtekst} />}>
      <Inhoud />
    </Suspense>
  );
}
