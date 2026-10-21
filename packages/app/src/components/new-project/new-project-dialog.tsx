import * as React from "react"
import { FolderIcon, LoaderCircleIcon, FolderPlusIcon } from "lucide-react"

import {
  advancedOptionLabels,
  backendOptions,
  codeQualityOptions,
  databaseOptions,
  frontendOptions,
  optionLabel,
  ormOptions,
  packageManagerOptions,
  platformOptions,
  requiresTailwind,
  stylingOptions,
  uiLibraryOptions,
  type AdvancedProjectOption,
  type NewProjectOption,
} from "@/components/new-project/new-project-options"
import {
  useNewProjectWizard,
  type NewProjectStep,
  type NewProjectWizard,
} from "@/components/new-project/use-new-project-wizard"
import { NewProjectProgress } from "./new-project-progress"
import { HostDependenciesDialog } from "@/pages/backlog/host-dependencies-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

export function NewProjectDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const wizard = useNewProjectWizard({ onOpenChange, open })

  return <NewProjectWizardDialog wizard={wizard} open={open} />
}

export function NewProjectWizardDialog({
  wizard,
  open,
}: {
  wizard: NewProjectWizard
  open: boolean
}) {
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!wizard.creating) wizard.setOpen(nextOpen)
        }}
      >
        <WizardDialogSurface wizard={wizard} />
      </Dialog>
      <HostDependenciesDialog {...wizard.hostDependenciesDialog} />
    </>
  )
}

function WizardDialogSurface({ wizard }: { wizard: NewProjectWizard }) {
  return (
    <DialogContent
      className="flex max-h-[min(88svh,52rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
      showCloseButton={!wizard.creating}
      onInteractOutside={(event) => event.preventDefault()}
      onEscapeKeyDown={(event) => {
        if (wizard.creating) event.preventDefault()
      }}
    >
      <WizardBody wizard={wizard} />
      <WizardFooter wizard={wizard} />
    </DialogContent>
  )
}

function WizardBody({ wizard }: { wizard: NewProjectWizard }) {
  return (
    <>
      <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12">
        <DialogTitle>New Project</DialogTitle>
        <DialogDescription>
          Generate a codebase ready for Blame workflows.
        </DialogDescription>
      </DialogHeader>
      <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto overscroll-contain px-5 py-5">
        <StepProgress wizard={wizard} />
        <StepContent wizard={wizard} />
        {wizard.error && wizard.step !== "progress" && (
          <p role="alert" className="text-sm break-words text-destructive">
            {wizard.error}
          </p>
        )}
      </div>
    </>
  )
}

function StepProgress({ wizard }: { wizard: NewProjectWizard }) {
  if (wizard.step === "progress") return null
  return (
    <nav aria-label="Project creation steps">
      <p className="text-xs text-muted-foreground">
        Step {wizard.currentStepIndex + 1} of {wizard.steps.length} ·{" "}
        {stepLabel(wizard.step)}
      </p>
      <div className="grid grid-cols-9 gap-1">
        {wizard.steps.map((step, index) => (
          <WizardStepMarker
            key={step}
            wizard={wizard}
            step={step}
            index={index}
          />
        ))}
      </div>
    </nav>
  )
}

function WizardStepMarker({
  wizard,
  step,
  index,
}: {
  wizard: NewProjectWizard
  step: NewProjectStep
  index: number
}) {
  return (
    <button
      type="button"
      disabled={wizard.creating || index > wizard.currentStepIndex}
      aria-current={step === wizard.step ? "step" : undefined}
      className="group flex h-7 items-center rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
      onClick={() => wizard.setStep(step)}
    >
      <span
        className={cn(
          "h-1.5 w-full rounded-full bg-muted transition-colors group-hover:bg-foreground/20",
          index <= wizard.currentStepIndex &&
            "bg-primary group-hover:bg-primary/80"
        )}
      />
      <span className="sr-only">{stepLabel(step)}</span>
    </button>
  )
}

function StepContent({ wizard }: { wizard: NewProjectWizard }) {
  if (wizard.step === "location") return <LocationStep wizard={wizard} />
  if (wizard.step === "platform") return <PlatformStep wizard={wizard} />
  if (wizard.step === "frontend") return <FrontendStep wizard={wizard} />
  if (wizard.step === "styling") return <StylingStep wizard={wizard} />
  if (wizard.step === "backend") return <BackendStep wizard={wizard} />
  if (wizard.step === "data") return <DataStep wizard={wizard} />
  if (wizard.step === "quality") return <QualityStep wizard={wizard} />
  if (wizard.step === "advanced") return <AdvancedStep wizard={wizard} />
  if (wizard.step === "progress") return <NewProjectProgress {...wizard} />
  return <SummaryStep wizard={wizard} />
}

function LocationStep({ wizard }: { wizard: NewProjectWizard }) {
  return (
    <StepFrame
      title="Location"
      description="Choose where Blame should create the project."
    >
      <div className="grid gap-4 rounded-xl border bg-background/45 p-4">
        <Field>
          <FieldLabel htmlFor="new-project-parent">Parent folder</FieldLabel>
          <FieldDescription>
            Pick the folder that will contain the generated project.
          </FieldDescription>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <Input
              id="new-project-parent"
              className="h-9 bg-background/70"
              value={wizard.parentPath}
              placeholder="/path/to/projects"
              onChange={(event) =>
                wizard.setParentPath(event.currentTarget.value)
              }
            />
            <Button
              type="button"
              variant="outline"
              className="h-9"
              onClick={() => void wizard.chooseParentPath()}
            >
              <FolderIcon />
              Browse
            </Button>
          </div>
        </Field>
        <Field>
          <FieldLabel htmlFor="new-project-name">Project name</FieldLabel>
          <FieldDescription>
            Use a short, readable folder name for the new codebase.
          </FieldDescription>
          <Input
            id="new-project-name"
            className="h-9 bg-background/70"
            value={wizard.projectName}
            placeholder="my-blame-project"
            onChange={(event) =>
              wizard.setProjectName(event.currentTarget.value)
            }
          />
        </Field>
        <ProjectPathPreview wizard={wizard} />
      </div>
      {!wizard.createProjectAvailable ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          Project generation requires the desktop app and a connected AI model.
        </p>
      ) : null}
    </StepFrame>
  )
}

function ProjectPathPreview({ wizard }: { wizard: NewProjectWizard }) {
  const parentPath = wizard.parentPath.trim() || "/path/to/projects"
  const projectName = wizard.projectName.trim() || "my-blame-project"

  return (
    <div className="grid gap-1 rounded-lg bg-muted/35 p-3">
      <span className="text-xs font-medium text-foreground/70">
        Project path
      </span>
      <span className="truncate font-mono text-xs text-foreground/60">
        {parentPath}/{projectName}
      </span>
    </div>
  )
}

function PlatformStep({ wizard }: { wizard: NewProjectWizard }) {
  return (
    <StepFrame
      title="Platform"
      description="Choose the kind of project to generate."
    >
      <OptionGrid
        options={platformOptions}
        value={wizard.configuration.platform}
        onChange={wizard.setPlatform}
      />
    </StepFrame>
  )
}

function FrontendStep({ wizard }: { wizard: NewProjectWizard }) {
  return (
    <StepFrame
      title="Frontend framework"
      description="The frontend choice drives the rest of the wizard."
    >
      <OptionGrid
        options={frontendOptions}
        value={wizard.configuration.frontend}
        onChange={wizard.setFrontend}
      />
    </StepFrame>
  )
}

function StylingStep({ wizard }: { wizard: NewProjectWizard }) {
  const uiOptions = uiLibraryOptions(wizard.configuration.frontend)

  return (
    <StepFrame
      title="Styling and UI"
      description="Configure styling separately from the component library."
    >
      <OptionGrid
        options={stylingOptions.map((option) => ({
          ...option,
          disabled:
            wizard.configuration.frontend === "none" ||
            (option.value !== "tailwind" &&
              requiresTailwind(wizard.configuration.uiLibrary)),
        }))}
        value={wizard.configuration.styling}
        onChange={wizard.setStyling}
      />
      <SelectField
        label="UI library"
        options={uiOptions}
        value={wizard.configuration.uiLibrary}
        onChange={wizard.setUiLibrary}
      />
    </StepFrame>
  )
}

function BackendStep({ wizard }: { wizard: NewProjectWizard }) {
  return (
    <StepFrame
      title="Backend framework"
      description="Choose the backend shape Blame should scaffold."
    >
      <OptionGrid
        options={backendOptions(wizard.configuration.frontend)}
        value={wizard.configuration.backend}
        onChange={wizard.setBackend}
      />
    </StepFrame>
  )
}

function DataStep({ wizard }: { wizard: NewProjectWizard }) {
  return (
    <StepFrame
      title="Database and ORM"
      description="Pick the persistence layer for the generated project."
    >
      <OptionGrid
        options={databaseOptions}
        value={wizard.configuration.database}
        onChange={wizard.setDatabase}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="ORM / query layer"
          options={ormOptions(
            wizard.configuration.backend,
            wizard.configuration.database
          )}
          value={wizard.configuration.orm}
          onChange={wizard.setOrm}
        />
        <SelectField
          label="Package manager / runtime"
          options={packageManagerOptions(wizard.configuration.backend)}
          value={wizard.configuration.packageManager}
          onChange={wizard.setPackageManager}
        />
      </div>
    </StepFrame>
  )
}

function QualityStep({ wizard }: { wizard: NewProjectWizard }) {
  return (
    <StepFrame
      title="Code quality"
      description="Configure linting, formatting and project hygiene."
    >
      <OptionGrid
        options={codeQualityOptions(
          wizard.configuration.frontend,
          wizard.configuration.backend
        )}
        value={wizard.configuration.codeQuality}
        onChange={wizard.setCodeQuality}
      />
    </StepFrame>
  )
}

function AdvancedStep({ wizard }: { wizard: NewProjectWizard }) {
  const options = Object.entries(advancedOptionLabels) as Array<
    [AdvancedProjectOption, string]
  >

  return (
    <StepFrame
      title="Advanced options"
      description="Enable the project extras Blame should prepare."
    >
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map(([value, label]) => (
          <label
            key={value}
            className="flex items-center justify-between gap-3 rounded-lg border p-3"
          >
            <span className="text-sm font-medium">{label}</span>
            <Switch
              checked={wizard.configuration.advancedOptions.includes(value)}
              onCheckedChange={() => wizard.toggleAdvancedOption(value)}
            />
          </label>
        ))}
      </div>
    </StepFrame>
  )
}

function SummaryStep({ wizard }: { wizard: NewProjectWizard }) {
  const items = summaryItems(wizard)

  return (
    <StepFrame
      title="Ready to create your project?"
      description="Review your stack. Blame will generate the codebase, install dependencies, and verify the project."
    >
      <dl className="grid min-w-0 gap-x-8 sm:grid-cols-2">
        {items.map((item) => (
          <div
            key={item.label}
            className={cn(
              "min-w-0 border-b py-3",
              item.label === "Path" && "sm:col-span-2"
            )}
          >
            <dt className="text-xs text-muted-foreground">{item.label}</dt>
            <dd className="mt-1 text-sm font-medium break-all">{item.value}</dd>
          </div>
        ))}
      </dl>
    </StepFrame>
  )
}

function WizardFooter({ wizard }: { wizard: NewProjectWizard }) {
  return (
    <DialogFooter className="mx-0 mb-0 shrink-0 gap-2 rounded-b-xl bg-muted/30 px-5 py-4">
      {wizard.step === "progress" ? (
        <ProgressFooter wizard={wizard} />
      ) : (
        <WizardNavigation wizard={wizard} />
      )}
    </DialogFooter>
  )
}

function ProgressFooter({ wizard }: { wizard: NewProjectWizard }) {
  if (wizard.creating)
    return (
      <p
        role="status"
        className="w-full py-1 text-center text-sm text-muted-foreground"
      >
        Your project will open automatically when ready.
      </p>
    )
  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => wizard.setStep("summary")}
    >
      Back to summary
    </Button>
  )
}

function WizardNavigation({ wizard }: { wizard: NewProjectWizard }) {
  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={!wizard.canGoBack}
        onClick={wizard.goBack}
      >
        Back
      </Button>
      {wizard.step === "summary" ? (
        <CreateProjectButton wizard={wizard} />
      ) : (
        <Button
          type="button"
          disabled={!wizard.canGoNext}
          onClick={wizard.goNext}
        >
          Continue
        </Button>
      )}
    </>
  )
}

function OptionGrid<T extends string>({
  onChange,
  options,
  value,
}: {
  onChange: (value: T) => void
  options: NewProjectOption<T>[]
  value: T
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={option.disabled}
          data-selected={value === option.value}
          className="grid gap-1 rounded-lg border p-3 text-left transition-colors disabled:opacity-50 data-[selected=true]:border-primary data-[selected=true]:bg-primary/5"
          onClick={() => onChange(option.value)}
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            {option.label}
            {option.recommended ? (
              <Badge variant="secondary">Recommended</Badge>
            ) : null}
          </span>
          <span className="text-xs text-muted-foreground">
            {option.description}
          </span>
        </button>
      ))}
    </div>
  )
}

function SelectField<T extends string>({
  label,
  onChange,
  options,
  value,
}: {
  label: string
  onChange: (value: T) => void
  options: NewProjectOption<T>[]
  value: T
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Select
        value={value}
        onValueChange={(nextValue) => onChange(nextValue as T)}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription>
        {options.find((option) => option.value === value)?.description}
      </FieldDescription>
    </Field>
  )
}

function StepFrame({
  children,
  description,
  title,
}: {
  children: React.ReactNode
  description: string
  title: string
}) {
  return (
    <section className="grid gap-4">
      <div className="grid gap-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  )
}

function summaryItems(wizard: NewProjectWizard) {
  const configuration = wizard.configuration
  return [
    { label: "Path", value: `${wizard.parentPath}/${wizard.projectName}` },
    {
      label: "Frontend",
      value: optionLabel(frontendOptions, configuration.frontend),
    },
    {
      label: "Styling",
      value: optionLabel(stylingOptions, configuration.styling),
    },
    {
      label: "UI library",
      value: optionLabel(
        uiLibraryOptions(configuration.frontend),
        configuration.uiLibrary
      ),
    },
    {
      label: "Backend",
      value: optionLabel(
        backendOptions(configuration.frontend),
        configuration.backend
      ),
    },
    {
      label: "Database",
      value: optionLabel(databaseOptions, configuration.database),
    },
    {
      label: "ORM",
      value: optionLabel(
        ormOptions(configuration.backend, configuration.database),
        configuration.orm
      ),
    },
    {
      label: "Package manager",
      value: optionLabel(
        packageManagerOptions(configuration.backend),
        configuration.packageManager
      ),
    },
    {
      label: "Code quality",
      value: optionLabel(
        codeQualityOptions(configuration.frontend, configuration.backend),
        configuration.codeQuality
      ),
    },
  ]
}

function stepLabel(step: NewProjectStep) {
  if (step === "location") return "Location"
  if (step === "platform") return "Platform"
  if (step === "frontend") return "Frontend"
  if (step === "styling") return "Styling"
  if (step === "backend") return "Backend"
  if (step === "data") return "Data"
  if (step === "quality") return "Quality"
  if (step === "advanced") return "Advanced"
  if (step === "progress") return "Progress"
  return "Summary"
}

function CreateProjectButton({ wizard }: { wizard: NewProjectWizard }) {
  return (
    <Button
      type="button"
      disabled={wizard.creating || !wizard.createProjectAvailable}
      onClick={() => void wizard.createProject()}
    >
      {wizard.creating ? (
        <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
      ) : (
        <FolderPlusIcon />
      )}
      {wizard.creating ? "Checking requirements…" : "Create project"}
    </Button>
  )
}
