// LET OP: Deno, niet Node. De kern (controle, stappen) staat in kern.ts.
//
// Een medewerker nodigt een klant uit (klantportaal met accounts). POST met de sessie van
// de medewerker; de functie controleert met dat token of hij medewerker is (is_medewerker), en
// gebruikt de service role alleen voor het account zelf en het koppelen. De Worker van de app
// heeft de service role nooit; deze functie wel (Supabase zet SUPABASE_SERVICE_ROLE_KEY zelf).
//
// De uitnodigingsmail verstuurt Supabase Auth (sjabloon invite, supabase/templates/uitnodiging.html).
// Buiten productie weigert de functie elk ander adres dan het testadres (zie magUitnodigen).

import { richtMail } from "../_shared/mail.ts";
import { CORS, uitnodigen } from "./kern.ts";

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (request.method !== "POST") return json(405, { fout: "Alleen POST" });

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return json(400, { fout: "Geen geldige JSON" });
  }

  const uitkomst = await uitnodigen(request.headers.get("Authorization"), body, {
    url: Deno.env.get("SUPABASE_URL") ?? "",
    anonSleutel: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    serviceSleutel: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    richt: (mail) => richtMail(mail),
    nieuweSleutel: () => crypto.randomUUID(),
    fetch,
  });
  return json(uitkomst.status, uitkomst.body);
});
