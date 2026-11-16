import { beforeEach, describe, expect, it, vi } from "vitest";

const init = vi.fn();
const captureException = vi.fn();
vi.mock("@sentry/react", () => ({ init, captureException }));

/** Elke test een verse module, zodat "al gestart" niet doorlekt naar de volgende. */
async function laad() {
  vi.resetModules();
  return import("./fouten");
}

describe("startFoutmelding", () => {
  beforeEach(() => {
    init.mockReset();
  });

  it("start Sentry niet zonder DSN, en geeft dan gewoon terug", async () => {
    const { startFoutmelding } = await laad();
    expect(startFoutmelding({})).toBe(false);
    expect(startFoutmelding({ dsn: "" })).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });

  it("start Sentry één keer met een DSN, als productie zonder VITE_OMGEVING", async () => {
    const { startFoutmelding } = await laad();
    const dsn = "https://abc123@o1.ingest.de.sentry.io/42";
    expect(startFoutmelding({ dsn })).toBe(true);
    expect(startFoutmelding({ dsn })).toBe(true);
    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ dsn, environment: "productie" }));
  });

  it("stuurt geen persoonsgegevens mee (het equivalent van sendDefaultPii: false)", async () => {
    const { startFoutmelding } = await laad();
    startFoutmelding({ dsn: "https://abc123@o1.ingest.sentry.io/42" });
    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        dataCollection: expect.objectContaining({
          userInfo: false,
          cookies: false,
          httpHeaders: false,
          httpBodies: [],
          urlQueryParams: false,
        }),
      }),
    );
  });

  it("geeft de omgeving test mee op de preview", async () => {
    const { startFoutmelding } = await laad();
    startFoutmelding({ dsn: "https://abc123@o1.ingest.sentry.io/42", omgeving: "test" });
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ environment: "test" }));
  });

  it("laat de app niet crashen bij een ongeldige DSN, maar waarschuwt", async () => {
    const { startFoutmelding } = await laad();
    init.mockImplementation(() => {
      throw new Error("Invalid Sentry Dsn: geen-dsn");
    });
    const waarschuwing = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => startFoutmelding({ dsn: "geen-dsn" })).not.toThrow();
    expect(startFoutmelding({ dsn: "geen-dsn" })).toBe(false);
    expect(waarschuwing).toHaveBeenCalled();
    waarschuwing.mockRestore();
  });
});

describe("meldFout", () => {
  const dsn = "https://abc123@o1.ingest.de.sentry.io/42";

  beforeEach(() => {
    init.mockReset();
    captureException.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("stuurt een fout die React Router opving door naar Sentry", async () => {
    const { meldFout, startFoutmelding } = await laad();
    startFoutmelding({ dsn });
    const fout = new Error("kapot");
    meldFout(fout);
    expect(captureException).toHaveBeenCalledWith(fout);
  });

  it("stuurt niets zonder Sentry, maar zet de fout wel in de console", async () => {
    const { meldFout } = await laad();
    meldFout(new Error("kapot"));
    expect(captureException).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it("meldt een adres dat niet bestaat (404) niet als storing, een serverfout (500) wel", async () => {
    const { meldFout, startFoutmelding } = await laad();
    startFoutmelding({ dsn });
    // Zo geeft React Router een antwoord met een foutstatus door.
    const antwoord = (status: number) => ({ status, statusText: "", internal: true, data: "" });
    meldFout(antwoord(404));
    expect(captureException).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    meldFout(antwoord(500));
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
