import { app } from "electron";
import { initializeDesktopTelemetry } from "./desktop-telemetry";
import { privacyPreferences } from "./privacy-settings";

// The agent worker inherits this environment, so it stays off there too.
if (!privacyPreferences().telemetry) process.env.OTEL_SDK_DISABLED = "true";
initializeDesktopTelemetry(app.getVersion(), app.isPackaged);

await import("./index");
