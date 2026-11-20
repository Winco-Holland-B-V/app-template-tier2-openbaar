import { z } from "zod";

/**
 * De regels voor een wachtwoord, voor de server (wachtwoord.server.ts) en de pagina samen.
 * Tien tekens is ook de grens bij Supabase (`minimum_password_length` in supabase/config.toml;
 * in productie zet de inrichting dezelfde). 72 is de grens van bcrypt: wat langer is, telt niet mee.
 */
export const MINIMAAL = 10;
export const MAXIMAAL = 72;

export const wachtwoordSchema = z
  .object({ wachtwoord: z.string(), herhaling: z.string() })
  .superRefine(({ wachtwoord, herhaling }, ctx) => {
    if (wachtwoord.length < MINIMAAL) {
      ctx.addIssue({
        code: "custom",
        message: `Kies een wachtwoord van minstens ${MINIMAAL} tekens.`,
      });
    } else if (new TextEncoder().encode(wachtwoord).length > MAXIMAAL) {
      ctx.addIssue({
        code: "custom",
        message: `Kies een wachtwoord van hoogstens ${MAXIMAAL} tekens.`,
      });
    } else if (wachtwoord !== herhaling) {
      ctx.addIssue({ code: "custom", message: "De twee wachtwoorden zijn niet gelijk." });
    }
  });

/** De eerste fout in gewone taal, of null als het wachtwoord goed is. */
export function controleerWachtwoord(wachtwoord: string, herhaling: string): string | null {
  const uitkomst = wachtwoordSchema.safeParse({ wachtwoord, herhaling });
  return uitkomst.success
    ? null
    : (uitkomst.error.issues[0]?.message ?? "Dit wachtwoord kan niet.");
}

/** De soorten links die naar /wachtwoord-instellen gaan: de uitnodiging en wachtwoord vergeten. */
const linkSchema = z.object({
  token_hash: z.string().regex(/^[A-Za-z0-9_-]{8,200}$/),
  type: z.enum(["invite", "recovery"]),
});
export type Wachtwoordlink = { tokenHash: string; type: "invite" | "recovery" };

/** De link uit de mail, uit het adres van de pagina. Null als hij er niet (goed) in staat. */
export function leesWachtwoordlink(zoekdeel: string): Wachtwoordlink | null {
  const params = new URLSearchParams(zoekdeel);
  const uitkomst = linkSchema.safeParse({
    token_hash: params.get("token_hash"),
    type: params.get("type"),
  });
  return uitkomst.success
    ? { tokenHash: uitkomst.data.token_hash, type: uitkomst.data.type }
    : null;
}
