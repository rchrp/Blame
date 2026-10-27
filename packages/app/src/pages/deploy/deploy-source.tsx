import { navigate } from "@/components/navigation/navigation"
import { Button } from "@/components/ui/button"
import type { LocalDeployPreflight } from "./use-deploy-page"

export function DeploymentSource({
  preflight,
}: {
  preflight?: LocalDeployPreflight
}) {
  return (
    <aside className="min-w-0 rounded-xl border bg-muted/15 p-5">
      <h3 className="font-medium">Deployment source</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        The current workspace is checked again before publishing.
      </p>
      {preflight ? (
        <SourceDetails preflight={preflight} />
      ) : (
        <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
          Initialize this project in Blame to detect its framework and build
          configuration.
        </p>
      )}
    </aside>
  )
}

function SourceDetails({ preflight }: { preflight: LocalDeployPreflight }) {
  const details = deploymentSourceItems(preflight)
  return (
    <>
      <dl className="mt-4 divide-y">
        {details.map(({ label, value }) => (
          <div
            key={label}
            className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2.5 text-sm"
          >
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 text-right font-medium break-all">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 border-t pt-4 text-xs leading-relaxed text-muted-foreground">
        Local changes are included. Secret files are excluded from the upload.
      </p>
    </>
  )
}

export function DeploymentReadiness({
  preflight,
}: {
  preflight?: LocalDeployPreflight
}) {
  const compatibility = preflight?.manifest.compatibility
  const { title, description } = deploymentReadinessCopy(preflight)
  return (
    <div className="py-4">
      <h3 className="font-heading text-xl font-semibold">{title}</h3>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
      {!preflight && (
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => navigate("/backlog")}
        >
          Open backlog
        </Button>
      )}
      {compatibility?.status === "conditional" && (
        <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">
          {compatibility.warnings[0]?.message ??
            "Review the deployment requirements before publishing."}
        </p>
      )}
    </div>
  )
}

function deploymentSourceItems(preflight: LocalDeployPreflight) {
  const { manifest, snapshot } = preflight
  return [
    { label: "Branch", value: snapshot.sourceBranch ?? "Detached HEAD" },
    { label: "Revision", value: snapshot.sourceRevision.slice(0, 7) },
    { label: "Framework", value: manifest.framework ?? "Automatic detection" },
    { label: "Root directory", value: manifest.rootDirectory || "." },
    { label: "Files to publish", value: snapshot.fileCount.toLocaleString() },
    {
      label: "Local changes",
      value: snapshot.localChangeCount.toLocaleString(),
    },
  ]
}

function deploymentReadinessCopy(preflight?: LocalDeployPreflight) {
  if (!preflight)
    return {
      title: "Set up the preview environment first",
      description:
        "Open Preview Environment and analyze the project to prepare your production build.",
    }
  if (preflight.manifest.compatibility.status === "unsupported")
    return {
      title: "Resolve compatibility issues",
      description:
        "Review the issue above before publishing this project to Vercel.",
    }
  return {
    title: "Ready for your first deployment",
    description:
      "Publish the current workspace to production. Review the source and destination before confirming the deployment.",
  }
}
