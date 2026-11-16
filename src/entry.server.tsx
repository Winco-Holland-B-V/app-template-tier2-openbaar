/**
 * Hoe de server een pagina maakt en fouten meldt. React Router zoekt dit bestand op deze
 * plek; de inhoud staat in de template (src/lib/server/document.server.tsx), zodat een
 * verbetering daar elke app bereikt. Dit bestand is van de template: hier komt niets bij.
 */
export { default, handleError, streamTimeout } from "./lib/server/document.server";
