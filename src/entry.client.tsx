import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { env } from "@/lib/env";
import { meldFout, startFoutmelding } from "@/lib/fouten";

// Vóór het renderen, zodat ook een fout bij het opstarten in Sentry komt.
startFoutmelding({ dsn: env.VITE_SENTRY_DSN, omgeving: env.VITE_OMGEVING });

// De server heeft de pagina al gemaakt; hier neemt de browser hem over.
startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter onError={meldFout} />
    </StrictMode>,
  );
});
