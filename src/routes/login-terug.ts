import { terugVanDienst } from "@/features/auth/inloggen.server";
import type { Route } from "./+types/login-terug";

/**
 * Het adres `/login/terug`: hier komt de bezoeker terug van de inlogdienst (Cloudflare, via
 * Supabase). Geen scherm: de server wisselt de code om voor een sessie en stuurt door naar
 * waar de bezoeker heen wilde, of naar `/login` met een vaste melding als het niet lukte. Zie
 * `terugVanDienst` in src/features/auth/inloggen.server.ts.
 */
export function loader({ context, request }: Route.LoaderArgs) {
  return terugVanDienst(context, request);
}
