import {
  TaskProgress,
  TaskProgressHeader,
  type TaskProgressItem,
} from "@/components/shared/task-progress"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import type {
  NewProjectWizard,
  ProjectCreationStatus,
} from "./use-new-project-wizard"

const creationPhases = [
  {
    id: "preparing",
    label: "Prepare the workspace",
    description: "Check requirements and create the project folder.",
  },
  {
    id: "generating",
    label: "Generate the codebase",
    description: "Build your project with the selected stack and conventions.",
  },
  {
    id: "installing",
    label: "Install dependencies",
    description: "Set up the packages your project needs.",
  },
  {
    id: "verifying",
    label: "Verify and initialize",
    description: "Check the generated code and prepare it for Blame.",
  },
]

type NewProjectProgressProps = Pick<
  NewProjectWizard,
  "projectName" | "parentPath" | "status" | "logs" | "error"
>

export function NewProjectProgress(props: NewProjectProgressProps) {
  const { projectName, status, error } = props
  const failed = status === "error"
  return (
    <section className="mx-auto w-full max-w-xl min-w-0 py-2">
      <CreationProgressHeader status={status} projectName={projectName} />
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Unable to finish creation</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}
      {!failed && <TaskProgress steps={creationProgressSteps(status)} />}
      <p className="mt-5 border-t pt-4 text-xs break-all text-muted-foreground">
        {props.parentPath}/{projectName}
      </p>
      <GenerationDetails logs={props.logs} />
    </section>
  )
}

function creationProgressSteps(
  status: ProjectCreationStatus
): TaskProgressItem[] {
  const current =
    status === "done"
      ? creationPhases.length
      : creationPhases.findIndex((phase) => phase.id === status)
  return creationPhases.map((phase, index) => ({
    ...phase,
    status:
      index < current ? "completed" : index === current ? "running" : "pending",
  }))
}

function GenerationDetails({ logs }: Pick<NewProjectWizard, "logs">) {
  return (
    <details className="mt-4 rounded-lg border">
      <summary className="cursor-pointer rounded-lg px-4 py-3 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        Generation details
      </summary>
      <pre
        aria-label="Generation output"
        tabIndex={0}
        className="max-h-48 overflow-auto border-t bg-muted/20 p-4 text-xs leading-relaxed break-all whitespace-pre-wrap"
      >
        {logs.length
          ? logs.map((event) => event.data).join("")
          : "Waiting for agent output…"}
      </pre>
    </details>
  )
}

function CreationProgressHeader({
  status,
  projectName,
}: Pick<NewProjectProgressProps, "status" | "projectName">) {
  const failed = status === "error"
  return (
    <TaskProgressHeader
      title={
        failed
          ? "Project creation interrupted"
          : status === "done"
            ? "Your project is ready"
            : `Creating ${projectName || "your project"}`
      }
      description={
        failed
          ? "Review the details below, then try again or adjust your choices in the summary."
          : "Blame is generating and checking your codebase."
      }
      status={failed ? "failed" : status === "done" ? "completed" : "running"}
      statusLabel={
        failed ? "Failed" : status === "done" ? "Ready" : "In progress"
      }
    />
  )
}
