import type { ExecutionTelemetryCohorts } from "@blame/agent-runtime";
import {
  ATTR_BLAME_AGENT_ROLE,
  ATTR_BLAME_AGENT_STRATEGY,
  ATTR_BLAME_EXECUTION_KIND,
  ATTR_BLAME_MULTI_AGENT_ENABLED,
  ATTR_BLAME_MULTI_AGENT_USED,
  ATTR_BLAME_REPOSITORY_LANGUAGE,
  ATTR_BLAME_REPOSITORY_SIZE_BUCKET,
  ATTR_BLAME_TASK_COMPLEXITY_BUCKET,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  boundedMetricDimensionName,
  semanticGenAiProviderName,
} from "@blame/telemetry";

const repositoryLanguageCohorts = new Set([
  "c",
  "cpp",
  "csharp",
  "css",
  "dart",
  "go",
  "html",
  "java",
  "javascript",
  "kotlin",
  "mixed",
  "other",
  "php",
  "python",
  "ruby",
  "rust",
  "shell",
  "swift",
  "typescript",
  "vue",
]);
const repositorySizeCohorts = new Set([
  "small",
  "medium",
  "large",
  "very_large",
]);
const taskComplexityCohorts = new Set(["small", "medium", "large"]);

// Workspace execution attributes, bounded to known values so telemetry
// dimensions keep a fixed cardinality.
export function executionCohortAttributes(
  cohorts: ExecutionTelemetryCohorts | undefined,
) {
  const workspaceAttributes = { [ATTR_BLAME_EXECUTION_KIND]: "workspace" };
  if (!cohorts) return workspaceAttributes;
  const strategy = boundedAgentStrategy(cohorts.agentStrategy);
  return {
    ...workspaceAttributes,
    [ATTR_BLAME_AGENT_ROLE]: "lead",
    [ATTR_BLAME_AGENT_STRATEGY]: strategy,
    [ATTR_BLAME_MULTI_AGENT_ENABLED]: strategy === "multi_agent",
    [ATTR_BLAME_MULTI_AGENT_USED]: false,
    [ATTR_BLAME_REPOSITORY_LANGUAGE]: boundedRepositoryLanguage(
      cohorts.repositoryLanguage,
    ),
    [ATTR_BLAME_REPOSITORY_SIZE_BUCKET]: boundedCohortValue(
      cohorts.repositorySizeBucket,
      repositorySizeCohorts,
    ),
    [ATTR_BLAME_TASK_COMPLEXITY_BUCKET]: boundedCohortValue(
      cohorts.taskComplexityBucket,
      taskComplexityCohorts,
    ),
    [ATTR_GEN_AI_PROVIDER_NAME]: semanticGenAiProviderName(cohorts.providerId),
    [ATTR_GEN_AI_REQUEST_MODEL]: boundedMetricDimensionName(cohorts.modelId),
  };
}

function boundedAgentStrategy(value: string) {
  return value === "multi_agent" ? value : "single_agent";
}

function boundedRepositoryLanguage(value: string | undefined) {
  if (!value) return undefined;
  return repositoryLanguageCohorts.has(value) ? value : "other";
}

function boundedCohortValue(value: string | undefined, allowed: Set<string>) {
  return value && allowed.has(value) ? value : undefined;
}
