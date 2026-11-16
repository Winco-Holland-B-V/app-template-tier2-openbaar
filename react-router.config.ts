import type { Config } from "@react-router/dev/config";

/**
 * React Router in de framework-stand: de server maakt elke pagina kant-en-klaar, daarna
 * werkt de pagina in de browser als app.
 *
 * De app staat in `src/` (niet in het gebruikelijke `app/`) en de build in `dist/` (niet
 * in `build/`), zoals in de gewone tier 2-template: zo blijven de guards, de tests en de
 * uitleg voor beide templates gelijk, en verhuist een bestaande tier 2-app met weinig moeite.
 */
export default {
  appDirectory: "src",
  buildDirectory: "dist",
  ssr: true,
} satisfies Config;
