import type { ServiceLaunchPlan } from "../domain/execution-plan.js";

// Development settings for the dependency images whose defaults are sized
// for a production server, applied to local previews only: the Blame Runtime
// VM runs every story's services in a few GiB, while a cloud sandbox runs
// one story. Measured in a 4 GiB VM (2026-11-15), resident memory at rest
// and after creating 40 tables and 200,000 rows:
//
// - MySQL 8.4 and 9: 421 → 181 MiB at rest, 509 → 240 MiB seeded. Almost
//   all of it is the Performance Schema; a 64 MiB buffer pool saves ~25 MiB
//   more once data is loaded (MySQL's default is 128 MiB).
// - Elasticsearch 8: 2.4 → 1.0 GiB. Its JVM heap defaults to half of the
//   VM's memory; 512 MiB is ample for development indexes.
// - OpenSearch 2: 1.47 → 0.93 GiB, for the same reason.
//
// Postgres, PostGIS, MariaDB (no Performance Schema by default), MongoDB
// (its WiredTiger cache only grows with data beyond 256 MiB) and
// Redis/Valkey gained less than 20 MiB of private memory and keep their
// defaults. None of these settings touches durability: the redo log, flush
// policy and data directories stay as the image configures them, so data
// survives a stop of the VM exactly as before.
//
// A setting never replaces one the manifest gives: a service with its own
// command or entrypoint, or with the JVM options already set, is left as
// declared. Only the official images are recognized, since other
// distributions (Bitnami, for one) start differently.

export type DependencyTuning = {
  command?: string[];
  environment?: Record<string, string>;
};

/** Label of a container started with these settings. */
export const dependencyTuningLabel = "blame.dependency-tuning";
export const dependencyTuningVersion = "1";

const jvmHeap = "-Xms512m -Xmx512m";

export function dependencyTuning(
  service: ServiceLaunchPlan,
): DependencyTuning | undefined {
  if (service.kind !== "dependency" || service.user) return undefined;
  const image = officialImageName(service.container.image);
  if (!image) return undefined;
  if (image === "mysql") {
    if (service.command || service.entrypoint) return undefined;
    return {
      command: [
        "mysqld",
        "--performance-schema=OFF",
        "--innodb-buffer-pool-size=64M",
      ],
    };
  }
  const heapVariable =
    image === "elasticsearch" || image === "elasticsearch/elasticsearch"
      ? "ES_JAVA_OPTS"
      : image === "opensearchproject/opensearch"
        ? "OPENSEARCH_JAVA_OPTS"
        : undefined;
  if (!heapVariable || heapVariable in service.environment) return undefined;
  return { environment: { [heapVariable]: jvmHeap } };
}

// `mysql:8.4`, `docker.io/library/mysql@sha256:…` and
// `docker.elastic.co/elasticsearch/elasticsearch:8.17.0` name official
// images; `bitnami/mysql` does not.
function officialImageName(image: string | undefined) {
  if (!image) return undefined;
  const name = image
    .replace(/@.*$/, "")
    .replace(/:[^/]*$/, "")
    .replace(/^(?:docker\.io|registry-1\.docker\.io|index\.docker\.io)\//, "")
    .replace(/^library\//, "")
    .replace(/^docker\.elastic\.co\//, "");
  return [
    "mysql",
    "elasticsearch",
    "elasticsearch/elasticsearch",
    "opensearchproject/opensearch",
  ].includes(name)
    ? name
    : undefined;
}
