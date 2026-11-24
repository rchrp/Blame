import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldTitle,
} from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useCodePracticesStore } from "@/components/practices/data/code-practices-store"
import {
  useCodePracticeAnalysis,
  useMarkCodePracticeAnalysisViewed,
} from "@/components/practices/data/use-code-practice-analysis"
import { cn } from "@/lib/utils"
import type {
  CodePractice,
  CodePracticeKey,
} from "@/components/practices/data/code-practices-data"

const practiceLabels: Record<CodePracticeKey, string> = {
  coding_style: "Coding style",
  unit_tests: "Unit tests",
  layered_architecture: "Layered architecture",
  commit_message_convention: "Commit message convention",
}

const practiceDescriptions: Record<CodePracticeKey, string> = {
  coding_style:
    "Write explicit, typed, focused code with deliberate error handling and no temporary, duplicated, or unsafe patterns.",
  unit_tests:
    "Use a TDD loop and ZOMBIES cases for behavior, state, validation, data flows, boundaries, and failures.",
  layered_architecture:
    "Apply Clean, Onion, and Hexagonal Architecture with use cases, domain core, ports, adapters, and inward dependencies.",
  commit_message_convention:
    "Produce exact Conventional Commits such as feat:, fix:, refactor:, docs:, test:, chore:, build:, or ci:.",
}

const codebaseModeLabels: Record<CodePracticeKey, string> = {
  coding_style: "Match codebase",
  unit_tests: "Match codebase",
  layered_architecture: "Match codebase",
  commit_message_convention: "Match codebase",
}

export function PracticesPage() {
  const store = useCodePracticesStore()
  const analysis = useCodePracticeAnalysis()
  useMarkCodePracticeAnalysisViewed(analysis)

  return (
    <div className="project-page-top flex flex-1 flex-col items-center px-4 pb-4 lg:px-6 lg:pb-6">
      <div className="flex w-full max-w-3xl flex-col gap-4">
        <div>
          <h2 className="project-page-title">
            Code practices
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Choose whether the agent should follow this project&apos;s current
            habits or apply a stricter professional standard.
          </p>
        </div>
        {store.loading ? <PracticesLoading /> : null}
        {!store.loading && store.error ? (
          <Alert variant="destructive">
            <AlertDescription>{store.error}</AlertDescription>
          </Alert>
        ) : null}
        {!store.loading && !store.error && !store.practices.length ? (
          <Alert>
            <AlertDescription>
              No code practices were detected for this project yet.
            </AlertDescription>
          </Alert>
        ) : null}
        {!store.loading && !store.error && store.practices.length ? (
          <FieldGroup className="gap-4">
            {store.practices.map((practice) => (
              <PracticeCard
                key={practice.practice}
                practice={practice}
                updating={store.updatingPractice === practice.practice}
                onEnabledChange={(enabled) =>
                  void store.updateEnabled(practice, enabled)
                }
              />
            ))}
          </FieldGroup>
        ) : null}
      </div>
    </div>
  )
}

function PracticeCard({
  onEnabledChange,
  practice,
  updating,
}: {
  onEnabledChange(enabled: boolean): void
  practice: CodePractice
  updating: boolean
}) {
  const practiceId = `practice-${practice.practice}`
  const nextEnabled = !practice.enabled

  const togglePractice = () => {
    if (!updating) onEnabledChange(nextEnabled)
  }

  const togglePracticeFromKeyboard = (
    event: React.KeyboardEvent<HTMLDivElement>
  ) => {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    togglePractice()
  }

  return (
    <Card
      size="sm"
      role="button"
      tabIndex={0}
      aria-labelledby={`${practiceId}-title`}
      className={cn(
        "cursor-pointer rounded-lg transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        "border-foreground/10 bg-background/95"
      )}
      onClick={togglePractice}
      onKeyDown={togglePracticeFromKeyboard}
    >
      <CardContent className="flex flex-col gap-3">
        <Field orientation="horizontal" className="items-start gap-4">
          <FieldContent>
            <div className="flex flex-wrap items-center gap-2">
              <FieldTitle
                id={`${practiceId}-title`}
                className="text-lg font-semibold"
              >
                {practiceLabels[practice.practice]}
              </FieldTitle>
              <Badge
                variant="outline"
                className={cn(
                  practice.detected
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                    : "border-red-500/30 bg-red-500/10 text-red-400"
                )}
              >
                {practice.detected ? "Detected" : "Not detected"}
              </Badge>
            </div>
            <FieldDescription>
              {practiceDescriptions[practice.practice]}
            </FieldDescription>
          </FieldContent>
          <Tabs
            value={practice.enabled ? "pro" : "codebase"}
            onValueChange={(value) => onEnabledChange(value === "pro")}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <TabsList className="h-8 w-60 shrink-0 rounded-lg border border-border bg-muted p-0.5 dark:border-foreground/10 dark:bg-black/55">
              <TabsTrigger
                value="codebase"
                disabled={updating}
                className="rounded-[calc(var(--radius-lg)-2px)] px-2 text-xs text-muted-foreground data-active:bg-background data-active:text-foreground dark:data-active:bg-foreground/10"
              >
                {codebaseModeLabels[practice.practice]}
              </TabsTrigger>
              <TabsTrigger
                value="pro"
                disabled={updating}
                className="rounded-[calc(var(--radius-lg)-2px)] px-2 text-xs text-blue-600 dark:text-blue-300/80 data-active:bg-blue-600 data-active:text-white dark:data-active:bg-blue-500"
              >
                Pro standard
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </Field>
        <Accordion
          type="single"
          collapsible
          onClick={(event) => event.stopPropagation()}
        >
          <AccordionItem value="comment" className="border-none">
            <AccordionTrigger className="py-1 text-xs text-muted-foreground hover:no-underline">
              Detection comment
            </AccordionTrigger>
            <AccordionContent className="pb-0">
              <Alert className="bg-background/60">
                <AlertDescription>{practice.comment}</AlertDescription>
              </Alert>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </CardContent>
    </Card>
  )
}

function PracticesLoading() {
  return (
    <FieldGroup className="gap-4">
      {Array.from({ length: 4 }, (_, index) => (
        <Card key={index} size="sm">
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-5 w-44" />
                <Skeleton className="h-4 w-full max-w-lg" />
              </div>
              <Skeleton className="h-5 w-8 rounded-full" />
            </div>
            <Skeleton className="h-12 w-full" />
          </CardContent>
        </Card>
      ))}
    </FieldGroup>
  )
}
