import { CircleCheck, Link2, OctagonX } from "lucide-react";
import { Fragment } from "react";
import type {
  DiffLine,
  TraceBody,
  TraceStep,
} from "@/components/harness-trace-data";

export const verifiedTextClassName = "text-[oklch(0.8_0.17_150)]";

const keywords = new Set([
  "async",
  "await",
  "catch",
  "const",
  "export",
  "function",
  "if",
  "let",
  "return",
  "throw",
  "true",
  "try",
  "while",
]);
const tokenPattern =
  /(\b(?:async|await|catch|const|export|function|if|let|return|throw|true|try|while)\b|\b\d+\b)/;

// What one harness tool call recorded, drawn like the tool calls in the app.
// Every receipt shares the tallest one's height on wide screens, so the trace
// keeps its size while it plays.
export function HarnessReceipt({ step }: { step: TraceStep }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-2xl lg:min-h-[21.5rem] border border-white/[0.08] bg-[#050506] shadow-[0_18px_50px_rgba(0,0,0,0.35)]">
      <div className="flex min-w-0 items-center gap-3 border-b border-white/[0.06] px-4 py-2.5 font-mono text-xs">
        <span className="shrink-0 text-white/72">{step.tool}</span>
        <span className="truncate text-white/40">{step.target}</span>
      </div>
      <div className="overflow-x-auto px-4 py-4 font-mono text-[0.75rem] leading-6 text-white/80 sm:text-[0.8125rem]">
        <ReceiptBody body={step.body} />
      </div>
    </div>
  );
}

function ReceiptBody({ body }: { body: TraceBody }) {
  switch (body.kind) {
    case "hits":
      return (
        <ul className="space-y-3">
          {body.hits.map((hit) => (
            <li key={hit.location}>
              <div className="flex items-center gap-2 text-white/40">
                <span className="rounded-md bg-[#9fd7ff]/10 px-1.5 text-[0.6875rem] leading-5 text-[#9fd7ff]">
                  {hit.kind}
                </span>
                {hit.location}
              </div>
              <div className="whitespace-pre">
                <Code text={hit.code} />
              </div>
            </li>
          ))}
        </ul>
      );
    case "code":
      return (
        <ol className="whitespace-pre">
          {body.lines.map((line, index) => (
            <li key={index} className="flex gap-4">
              <span className="w-6 shrink-0 select-none text-right tabular-nums text-white/24">
                {body.startLine + index}
              </span>
              <span>
                <Code text={line} />
              </span>
            </li>
          ))}
        </ol>
      );
    case "diff":
      return (
        <>
          <p className="mb-4 flex items-center gap-2 rounded-lg bg-[oklch(0.65_0.2_25/0.13)] px-3 py-2 font-sans text-[0.8125rem] text-[oklch(0.84_0.09_25)]">
            <OctagonX className="size-4 shrink-0" />
            {body.refused}
          </p>
          <div className="min-w-max whitespace-pre">
            {body.lines.map((line, index) => (
              <DiffRow key={index} line={line} />
            ))}
          </div>
        </>
      );
    case "terminal":
      return (
        <>
          <div className="whitespace-pre">
            {body.lines.map((line, index) => (
              <div key={index} className="min-h-6">
                {line.startsWith("✓") ? (
                  <>
                    <span className={verifiedTextClassName}>✓</span>
                    {line.slice(1)}
                  </>
                ) : (
                  line
                )}
              </div>
            ))}
          </div>
          <p className="mt-3 flex items-center gap-2 border-t border-white/[0.06] pt-3 font-sans text-[0.8125rem] text-white/48">
            <Link2 className="size-3.5 shrink-0" />
            {body.binding}
          </p>
        </>
      );
    case "checks":
      return (
        <ul className="space-y-3.5 font-sans">
          {body.checks.map((check) => (
            <li key={check.label} className="flex gap-3">
              <CircleCheck
                className={`mt-1 size-4 shrink-0 ${verifiedTextClassName}`}
              />
              <div>
                <p className="text-sm text-white/90">{check.label}</p>
                <p className="text-[0.8125rem] leading-5 text-white/50">
                  {check.detail}
                </p>
              </div>
            </li>
          ))}
        </ul>
      );
  }
}

const diffRowStyles: Record<DiffLine["type"], string> = {
  add: "bg-[oklch(0.75_0.17_150/0.1)] text-[oklch(0.9_0.08_150)]",
  context: "text-white/62",
  hunk: "text-[#9fd7ff]/60",
  remove: "bg-[oklch(0.65_0.2_25/0.12)] text-[oklch(0.86_0.07_25)]",
};

const diffMarkers: Record<DiffLine["type"], string> = {
  add: "+",
  context: " ",
  hunk: "",
  remove: "-",
};

function DiffRow({ line }: { line: DiffLine }) {
  return (
    <div className={`-mx-4 flex gap-3 px-4 ${diffRowStyles[line.type]}`}>
      <span className="w-2 shrink-0 select-none">{diffMarkers[line.type]}</span>
      <span>{line.text}</span>
    </div>
  );
}

function Code({ text }: { text: string }) {
  return text.split(tokenPattern).map((part, index) => {
    if (keywords.has(part)) {
      return (
        <span key={index} className="text-[#c4b5fd]">
          {part}
        </span>
      );
    }
    if (/^\d+$/.test(part)) {
      return (
        <span key={index} className="text-[#f7cf83]">
          {part}
        </span>
      );
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}
