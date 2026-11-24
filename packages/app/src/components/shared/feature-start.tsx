import type { ReactNode } from "react"

type FeatureStartProps = {
  title: string
  description: string
  heading: string
  children: ReactNode
  steps: { title: string; description: string }[]
  footer: string
}

export function FeatureStart({
  title,
  description,
  heading,
  children,
  steps,
  footer,
}: FeatureStartProps) {
  return (
    <div className="project-page-top flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-4 pb-6 lg:px-6">
      <header className="shrink-0">
        <h2 className="project-page-title">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </header>
      <section className="my-auto w-full max-w-5xl self-center py-10 sm:py-16">
        <div className="grid overflow-hidden rounded-xl border bg-card md:grid-cols-[1.1fr_1fr]">
          <div className="flex flex-col items-start gap-5 p-6 sm:p-8 lg:p-10">
            <h3 className="max-w-sm font-heading text-3xl leading-tight font-semibold text-balance">
              {heading}
            </h3>
            {children}
          </div>
          <FeatureSteps steps={steps} />
        </div>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          {footer}
        </p>
      </section>
    </div>
  )
}

function FeatureSteps({ steps }: { steps: FeatureStartProps["steps"] }) {
  return (
    <ol className="flex flex-col justify-center gap-6 border-t bg-muted/25 p-6 sm:p-8 md:border-t-0 md:border-l lg:p-10">
      {steps.map((step, index) => (
        <li key={step.title} className="flex gap-4">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium text-muted-foreground">
            {index + 1}
          </span>
          <div>
            <p className="text-sm font-medium">{step.title}</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {step.description}
            </p>
          </div>
        </li>
      ))}
    </ol>
  )
}
