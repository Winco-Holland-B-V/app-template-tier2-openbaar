import { NIET_INGERICHT } from "@/lib/env";

/**
 * Kan de app niet starten (meestal: een omgevingsvariabele klopt niet, zie lib/env.ts), dan
 * staat dat op het scherm in plaats van een witte pagina of een kale serverfout. De server
 * maakt dit scherm zelf (src/root.tsx), op elk adres. De tekst komt als tekst in de pagina,
 * nooit als HTML, en noemt alleen namen van openbare variabelen.
 */
export function Startfout({ tekst }: { tekst: string }) {
  const kop = tekst.startsWith(NIET_INGERICHT) ? NIET_INGERICHT : "Deze app kan niet starten";
  return (
    <main role="alert" className="mx-auto max-w-2xl p-6">
      <h1 className="text-xl font-semibold">{kop}</h1>
      <pre className="mt-3 whitespace-pre-wrap font-sans text-sm">{tekst}</pre>
    </main>
  );
}
