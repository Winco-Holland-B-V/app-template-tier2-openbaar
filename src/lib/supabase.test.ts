import { describe, expect, it, vi } from "vitest";
import { sessieCookieNaam } from "@/lib/server/sessie-cookie";

const createBrowserClient = vi.fn().mockReturnValue({});
vi.mock("@supabase/ssr", () => ({ createBrowserClient }));

describe("supabase-client van de browser", () => {
  it("gebruikt de PKCE-flow en zet de sessie in een cookie, niet in de opslag van de browser", async () => {
    await import("./supabase");
    expect(createBrowserClient).toHaveBeenCalledTimes(1);
    const opties = createBrowserClient.mock.calls[0]?.[2];
    expect(opties.auth).toEqual(expect.objectContaining({ flowType: "pkce" }));
    // De sessie staat in een cookie met SameSite=Lax, dezelfde instellingen als de server.
    expect(opties.cookieOptions).toEqual(
      expect.objectContaining({ path: "/", sameSite: "lax", httpOnly: false }),
    );
    // Met dezelfde naam als de server: hier (http op de eigen computer) zonder voorvoegsel,
    // over https `__Host-sb-...` (zie src/lib/server/sessie-cookie.ts).
    expect(opties.cookieOptions.name).toBe(
      sessieCookieNaam(
        String(import.meta.env.VITE_SUPABASE_URL),
        window.location.protocol === "https:",
      ),
    );
  });
});
