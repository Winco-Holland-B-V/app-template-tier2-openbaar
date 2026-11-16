// @vitest-environment node
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { browserScherm, inDeBrowser, OP_DE_SERVER } from "../../src/lib/browser-scherm";

/**
 * Het browser-scherm op de server. Een bestand dat op `.client.tsx` eindigt, is op de server
 * leeg (React Router), dus het scherm is daar `undefined`: de server stuurt alleen de
 * laadregel. Is het scherm er op de server wél, dan zit zijn code in de Worker; dan weigert de
 * hulp, in plaats van stil een te grote Worker te maken. Deze test is van de template.
 */
describe("browserScherm op de server", () => {
  it("weet dat hij op de server draait", () => {
    expect(inDeBrowser()).toBe(false);
  });

  it("zonder scherm (het .client-bestand is leeg): alleen de laadregel", () => {
    const scherm = browserScherm({ titel: "Scanner", scherm: undefined });
    const html = renderToString(<scherm.HydrateFallback />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Bezig met laden");
    expect(renderToString(<scherm.Scherm />)).toContain("Bezig met laden");
  });

  it("met een scherm dat niet uit een .client-bestand komt: weigert bij het starten", () => {
    expect(() => browserScherm({ titel: "Scanner", scherm: () => <p>zwaar</p> })).toThrow(
      OP_DE_SERVER,
    );
    expect(() =>
      browserScherm({ titel: "Rapport", laad: async () => ({ default: () => <p>zwaar</p> }) }),
    ).toThrow(/\.client/);
  });
});
