import type { SecurityFinding, SecuritySeverity } from "@blame/agent-runtime"
import type { ReactNode } from "react"
import {
  ArrowDownIcon,
  CheckIcon,
  ExternalLinkIcon,
  ShieldCheckIcon,
  XIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

export function SecurityFindingDrawer({
  finding,
  open,
  adding,
  onAddToBacklog,
  onOpenChange,
}: {
  finding?: SecurityFinding
  open: boolean
  adding: boolean
  onAddToBacklog(finding: SecurityFinding): void
  onOpenChange(open: boolean): void
}) {
  return (
    <Drawer
      autoFocus
      direction="right"
      handleOnly
      open={open}
      onOpenChange={onOpenChange}
    >
      <DrawerContent className="inset-y-2 right-2 h-[calc(100svh-1rem)] overflow-hidden rounded-xl border bg-[oklch(1_0_0)] text-foreground data-[vaul-drawer-direction=right]:w-[min(76rem,calc(100vw-1rem))] data-[vaul-drawer-direction=right]:sm:max-w-none dark:bg-[oklch(0.16_0_0)]">
        {finding ? (
          <>
            <DrawerClose asChild>
              <Button
                className="absolute top-5 right-5 z-20 border bg-background/90 shadow-sm"
                size="icon-sm"
                variant="outline"
              >
                <XIcon />
                <span className="sr-only">Close finding</span>
              </Button>
            </DrawerClose>
            <DrawerHeader className="shrink-0 gap-3 border-b px-5 py-5 pr-16 sm:px-6 sm:py-6 sm:pr-16">
              <div className="flex flex-wrap items-center gap-2">
                <SeverityBadge severity={finding.severity} />
                <Badge variant="outline">{finding.confidence} confidence</Badge>
                <Badge variant="outline" className="font-mono">
                  {finding.id}
                </Badge>
              </div>
              <div className="max-w-4xl">
                <DrawerTitle className="text-xl leading-snug sm:text-2xl">
                  {finding.title}
                </DrawerTitle>
                <DrawerDescription className="mt-2 max-w-3xl text-sm leading-relaxed">
                  {finding.rootCause.summary}
                </DrawerDescription>
              </div>
            </DrawerHeader>
            <ScrollArea className="min-h-0 flex-1">
              <div className="grid min-w-0 gap-7 p-5 sm:p-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.8fr)] lg:gap-9">
                <div className="min-w-0 space-y-7">
                  <FindingSection title="Attack path">
                    <div className="rounded-xl border bg-muted/20 p-4">
                      {finding.attackPath.map((step, index) => (
                        <div key={`${step.label}-${index}`}>
                          <div className="flex items-start gap-3">
                            <span className="mt-1.5 size-2 shrink-0 rounded-full bg-blue-500" />
                            <div className="min-w-0">
                              <p className="text-sm font-medium">
                                {step.label}
                              </p>
                              {step.location ? (
                                <LocationLabel location={step.location} />
                              ) : null}
                            </div>
                          </div>
                          {index < finding.attackPath.length - 1 ? (
                            <ArrowDownIcon className="my-1.5 ml-0.5 size-4 text-muted-foreground" />
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </FindingSection>
                  <FindingSection title="Evidence">
                    <div className="space-y-4">
                      {finding.evidence.map((evidence, index) => (
                        <div
                          key={`${evidence.summary}-${index}`}
                          className="min-w-0 space-y-2 rounded-xl border bg-muted/10 p-4"
                        >
                          <p className="text-sm leading-relaxed text-muted-foreground">
                            {evidence.summary}
                          </p>
                          {evidence.location ? (
                            <LocationLabel location={evidence.location} />
                          ) : null}
                          {evidence.code ? (
                            <pre className="max-w-full overflow-x-auto rounded-lg border bg-black/90 p-3 text-xs text-neutral-100">
                              <code>{evidence.code}</code>
                            </pre>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </FindingSection>
                  <FindingSection title="Validation">
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {finding.validation.rationale}
                    </p>
                    {finding.validation.counterEvidence.length ? (
                      <div className="mt-3 rounded-xl border bg-muted/20 p-4">
                        <p className="mb-2 text-xs font-medium">
                          Counter-evidence considered
                        </p>
                        <ul className="space-y-1.5 text-xs leading-relaxed text-muted-foreground">
                          {finding.validation.counterEvidence.map((item) => (
                            <li key={item}>• {item}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </FindingSection>
                </div>
                <aside className="min-w-0 space-y-7 lg:border-l lg:pl-8">
                  <FindingSection title="Impact">
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {finding.impact}
                    </p>
                  </FindingSection>
                  <FindingSection title="Affected locations">
                    <div className="space-y-2">
                      {finding.affectedLocations.map((location) => (
                        <div
                          key={`${location.path}:${location.startLine ?? 0}`}
                          className="min-w-0 rounded-lg border bg-muted/20 px-3 py-2.5"
                        >
                          <LocationLabel location={location} />
                        </div>
                      ))}
                    </div>
                  </FindingSection>
                  <FindingSection title="Remediation">
                    <p className="text-sm leading-relaxed">
                      {finding.remediation.summary}
                    </p>
                    {finding.remediation.guidance?.length ? (
                      <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
                        {finding.remediation.guidance.map((item) => (
                          <li key={item} className="flex gap-2">
                            <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
                            <span className="min-w-0">{item}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </FindingSection>
                  <FindingSection title="Standards">
                    <div className="flex flex-wrap gap-1.5">
                      {[
                        ...(finding.taxonomy.cwe ?? []),
                        ...(finding.taxonomy.owasp ?? []),
                        ...(finding.taxonomy.asvs ?? []),
                      ].map((standard) => (
                        <Badge key={standard} variant="outline">
                          {standard}
                        </Badge>
                      ))}
                    </div>
                  </FindingSection>
                </aside>
              </div>
            </ScrollArea>
            <DrawerFooter className="shrink-0 border-t bg-popover px-5 py-4 sm:px-6">
              <Button
                className="sm:self-end sm:px-8"
                disabled={adding || Boolean(finding.backlogStoryId)}
                onClick={() => onAddToBacklog(finding)}
              >
                {finding.backlogStoryId ? (
                  <>
                    <ExternalLinkIcon /> Added to backlog
                  </>
                ) : (
                  <>
                    <ShieldCheckIcon /> {adding ? "Adding…" : "Add to backlog"}
                  </>
                )}
              </Button>
            </DrawerFooter>
          </>
        ) : null}
      </DrawerContent>
    </Drawer>
  )
}

export function SeverityBadge({ severity }: { severity: SecuritySeverity }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "uppercase",
        severity === "critical" &&
          "border-red-500/30 bg-red-500/10 text-red-500",
        severity === "high" &&
          "border-orange-500/30 bg-orange-500/10 text-orange-500",
        severity === "medium" &&
          "border-amber-500/30 bg-amber-500/10 text-amber-500",
        severity === "low" && "border-blue-500/30 bg-blue-500/10 text-blue-500"
      )}
    >
      {severity}
    </Badge>
  )
}

function FindingSection({
  children,
  title,
}: {
  children: ReactNode
  title: string
}) {
  return (
    <section className="min-w-0">
      <h3 className="mb-2.5 font-heading text-sm font-semibold">{title}</h3>
      {children}
    </section>
  )
}

function LocationLabel({
  location,
}: {
  location: { path: string; startLine?: number; symbol?: string }
}) {
  return (
    <p className="font-mono text-xs break-words text-muted-foreground">
      {location.path}
      {location.startLine ? `:${location.startLine}` : ""}
      {location.symbol ? ` · ${location.symbol}` : ""}
    </p>
  )
}
