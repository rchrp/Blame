"use client";

import { useEffect, useState } from "react";

import {
  isServiceStatus,
  statusPageUrl,
  type ServiceStatus,
} from "@/lib/service-status";

const statusDisplay: Record<ServiceStatus, { color: string; label: string }> = {
  operational: { color: "#22c55e", label: "All systems operational" },
  degraded: { color: "#f59e0b", label: "Degraded performance" },
  downtime: { color: "#f43f5e", label: "Service outage" },
  maintenance: { color: "#60a5fa", label: "Under maintenance" },
  unknown: { color: "rgb(255 255 255 / 0.35)", label: "System status" },
};

// Pages are prerendered, so the status is fetched once the page is open:
// a prerendered status could be an hour old.
export function ServiceStatusLink() {
  const [status, setStatus] = useState<ServiceStatus>("unknown");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/status", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { status?: unknown } | null) => {
        if (isServiceStatus(body?.status)) setStatus(body.status);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const { color, label } = statusDisplay[status];
  return (
    <a
      className="inline-flex shrink-0 items-center gap-2.5 text-xs text-white/52 transition hover:text-white"
      href={statusPageUrl}
    >
      <span
        aria-hidden="true"
        className="h-2 w-2 rounded-full"
        style={{
          backgroundColor: color,
          boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 24%, transparent)`,
        }}
      />
      {label}
    </a>
  );
}
