import { fileURLToPath, URL } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/**
 * De testlogin (`pnpm testlogin`) blijft buiten de gebouwde bestanden; zie
 * scripts/bouwen.mjs, dat `pnpm build` draait. Dit is hetzelfde slot voor wie
 * `vite build` direct aanroept.
 */
export const ALLEEN_DEV = ["VITE_TESTLOGIN_EMAIL", "VITE_TESTLOGIN_WACHTWOORD"];

export default defineConfig(({ command }) => {
  if (command !== "serve") for (const naam of ALLEEN_DEV) process.env[naam] = "";
  return {
    // De plugin van Cloudflare draait de servercode (workers/app.ts) lokaal in de echte
    // Workers-omgeving en bouwt hem samen met de schermen tot één Worker.
    plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), tailwindcss(), reactRouter()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: { port: 5173 },
    preview: { port: 4173 },
  };
});
