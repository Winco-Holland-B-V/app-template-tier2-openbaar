// Een pad vanaf dit bestand, geen afkorting: zo kan een instelling van de build (een alias)
// er geen ander bestand voor in de plaats zetten.
import { maakWorker } from "../src/lib/server/worker.server";

/**
 * De Worker: het ene stuk servercode van deze app op Cloudflare. Elk verzoek dat geen
 * gebouwd bestand is (een script, een stijlblad, een icoon), komt hier binnen. De Worker van
 * de template (src/lib/server/worker.server.ts) zet de beveiliging erop en geeft het door
 * aan React Router, dat de pagina op de server maakt. De pagina's zelf staan in `src/` (de
 * routes in `src/routes.ts`).
 *
 * Dit bestand is van de template: hier komt geen eigen logica bij. Zo geldt voor elke app
 * dezelfde beveiliging, en bereikt een verbetering daarin elke app bij het bijwerken.
 */
export default maakWorker({
  build: () => import("virtual:react-router/server-build"),
  mode: import.meta.env.MODE,
  omgeving: import.meta.env,
}) satisfies ExportedHandler<Env>;
