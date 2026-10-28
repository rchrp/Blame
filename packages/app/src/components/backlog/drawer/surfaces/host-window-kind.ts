import type { ProjectRunConfiguration } from "@blame/agent-runtime"
export function isHostWindowConfiguration(configuration?: ProjectRunConfiguration) { return configuration?.category === "desktop" && configuration.services.length === 0 && !configuration.previewService && !configuration.previewTarget }
