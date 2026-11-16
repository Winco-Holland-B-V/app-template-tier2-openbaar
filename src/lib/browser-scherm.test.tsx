import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { browserScherm } from "./browser-scherm";

/**
 * Het browser-scherm in de browser (jsdom). Op de server: tests/unit/browser-scherm-server.test.tsx,
 * en wat er in de Worker komt: tests/unit/gebouwd.test.ts. Deze test is van de template.
 */
afterEach(cleanup);

function Scanner() {
  return <h1>Scanner</h1>;
}

describe("browserScherm in de browser", () => {
  it("toont het scherm, met een laadregel voor de server en niet in zoekmachines", () => {
    const scherm = browserScherm({ titel: "Voorraad scannen", scherm: Scanner });
    render(<scherm.Scherm />);
    expect(screen.getByRole("heading", { name: "Scanner" })).toBeInTheDocument();
    render(<scherm.HydrateFallback />);
    expect(screen.getByRole("status")).toHaveTextContent("Bezig met laden");
    expect(scherm.clientLoader.hydrate).toBe(true);
    expect(scherm.meta()).toContainEqual({ name: "robots", content: "noindex, nofollow" });
    expect(scherm.meta()).toContainEqual({ title: "Voorraad scannen" });
    expect(scherm.headers()).toEqual({ "X-Robots-Tag": "noindex, nofollow" });
  });

  it("laadt een zwaar scherm pas als het nodig is", async () => {
    const scherm = browserScherm({
      titel: "Rapport",
      laadtekst: "Het rapport wordt geladen…",
      laad: async () => ({ default: () => <h1>Rapport</h1> }),
    });
    render(<scherm.Scherm />);
    expect(screen.getByRole("status")).toHaveTextContent("Het rapport wordt geladen");
    expect(await screen.findByRole("heading", { name: "Rapport" })).toBeInTheDocument();
  });

  it("zonder scherm in de browser: een duidelijke fout", () => {
    expect(() => browserScherm({ titel: "Leeg", scherm: undefined })).toThrow(/geef `scherm`/);
  });

  it("de clientLoader haalt niets op", async () => {
    const scherm = browserScherm({ titel: "x", scherm: Scanner });
    expect(await scherm.clientLoader()).toBeNull();
  });
});
