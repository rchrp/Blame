"use client";

import {
  BadgeCheck,
  Circle,
  CircleCheck,
  Play,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import {
  HarnessReceipt,
  verifiedTextClassName,
} from "@/components/harness-receipt";
import {
  harnessSteps,
  harnessStory,
  type TraceStep,
} from "@/components/harness-trace-data";

const stepDurationMs = 4600;
const lastStep = harnessSteps.length - 1;

type Autoplay = "idle" | "playing" | "stopped";
type StepState = "current" | "done" | "pending" | "verified";

// The run plays once when the trace scrolls into view and stops on the
// verified finish. Any click hands control to the visitor.
export function HarnessTrace() {
  const traceRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [autoplay, setAutoplay] = useState<Autoplay>("idle");
  const isInView = useTraceVisibility(traceRef, setAutoplay);
  const isRunning = autoplay === "playing" && activeIndex < lastStep;

  useEffect(() => {
    if (!isRunning || !isInView) return;
    const timer = window.setTimeout(
      () => setActiveIndex((index) => Math.min(index + 1, lastStep)),
      stepDurationMs,
    );
    return () => window.clearTimeout(timer);
  }, [activeIndex, isInView, isRunning]);

  const select = (index: number) => {
    setActiveIndex(index);
    setAutoplay("stopped");
  };
  const replay = () => {
    setActiveIndex(0);
    setAutoplay("playing");
  };

  return (
    <div
      ref={traceRef}
      className="overflow-hidden rounded-[2rem] border border-white/12 bg-[#0a0a0c] shadow-[0_24px_80px_rgba(0,0,0,0.28)]"
    >
      <TraceHeader
        hasPlayed={autoplay !== "idle"}
        isRunning={isRunning}
        isVerified={activeIndex === lastStep}
        onReplay={replay}
      />
      <ol>
        {harnessSteps.map((step, index) => (
          <TraceRow
            key={step.tool}
            isExpanded={index === activeIndex}
            progressKey={isRunning && isInView ? activeIndex : null}
            state={stepState(index, activeIndex)}
            step={step}
            onSelect={() => select(index)}
          />
        ))}
      </ol>
    </div>
  );
}

function TraceHeader({
  hasPlayed,
  isRunning,
  isVerified,
  onReplay,
}: {
  hasPlayed: boolean;
  isRunning: boolean;
  isVerified: boolean;
  onReplay: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 border-b border-white/10 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-7">
      <div className="min-w-0">
        <p className="text-xs uppercase tracking-[0.18em] text-white/40">
          User story
        </p>
        <p className="mt-1.5 text-base text-white/90 sm:text-lg">
          {harnessStory}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <RunStatus
          hasPlayed={hasPlayed}
          isRunning={isRunning}
          isVerified={isVerified}
        />
        {!isRunning && (
          <button
            type="button"
            onClick={onReplay}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-sm text-white/60 transition hover:bg-white/[0.06] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
          >
            {hasPlayed ? (
              <RotateCcw className="size-3.5" />
            ) : (
              <Play className="size-3.5 fill-current" />
            )}
            {hasPlayed ? "Replay" : "Play the run"}
          </button>
        )}
      </div>
    </div>
  );
}

function RunStatus({
  hasPlayed,
  isRunning,
  isVerified,
}: {
  hasPlayed: boolean;
  isRunning: boolean;
  isVerified: boolean;
}) {
  if (isVerified) {
    return (
      <span
        className={`harness-status-in inline-flex min-h-9 items-center gap-1.5 rounded-full bg-[oklch(0.75_0.17_150/0.12)] px-3.5 text-sm ${verifiedTextClassName}`}
      >
        <BadgeCheck className="size-4" />
        Verified
      </span>
    );
  }

  return (
    <span className="inline-flex min-h-9 items-center gap-2 rounded-full bg-white/[0.06] px-3.5 text-sm text-white/72">
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full bg-[#9fd7ff] ${isRunning ? "harness-pulse" : ""}`}
      />
      {isRunning ? "Agent working" : hasPlayed ? "Paused" : "Ready"}
    </span>
  );
}

function TraceRow({
  isExpanded,
  onSelect,
  progressKey,
  state,
  step,
}: {
  isExpanded: boolean;
  onSelect: () => void;
  progressKey: number | null;
  state: StepState;
  step: TraceStep;
}) {
  const id = useId();
  const panelId = `${id}-panel`;
  const buttonId = `${id}-button`;

  return (
    <li className="relative border-t border-white/[0.07] first:border-t-0">
      <h3 className="font-sans">
        <button
          id={buttonId}
          type="button"
          aria-controls={panelId}
          aria-expanded={isExpanded}
          onClick={onSelect}
          className="group grid w-full grid-cols-[auto_1fr_auto] items-center gap-4 px-5 py-4 text-left transition hover:bg-white/[0.025] focus:outline-none focus-visible:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/30 sm:gap-5 sm:px-7 sm:py-5"
        >
          <StepIcon state={state} />
          <span className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-5">
            <code className="shrink-0 font-mono text-xs font-normal text-white/42 sm:w-24">
              {step.tool}
            </code>
            <span
              className={`font-display text-base leading-snug transition sm:text-lg ${state === "pending" ? "text-white/46 group-hover:text-white/72" : "text-white"}`}
            >
              {step.title}
            </span>
          </span>
          <span
            className={`hidden font-sans text-sm font-normal md:block ${state === "verified" ? verifiedTextClassName : "text-white/42"} ${state === "pending" ? "invisible" : ""}`}
          >
            {step.summary}
          </span>
        </button>
      </h3>
      <div
        id={panelId}
        role="region"
        aria-labelledby={buttonId}
        className="harness-panel grid"
        data-expanded={isExpanded}
      >
        <div className="min-h-0 overflow-hidden" inert={!isExpanded || undefined}>
          <div className="grid gap-6 px-5 pb-7 sm:px-7 lg:grid-cols-[0.8fr_1.2fr] lg:gap-12 lg:pb-9 lg:pl-[4.25rem]">
            <div>
              <p className="inline-flex items-center gap-2 text-sm text-[#9fd7ff]">
                <ShieldCheck className="size-4" />
                {step.guardLabel}
              </p>
              <p className="mt-3 max-w-md text-[0.9375rem] leading-7 text-white/62">
                {step.guard}
              </p>
            </div>
            <HarnessReceipt step={step} />
          </div>
        </div>
      </div>
      {progressKey !== null && isExpanded && (
        <span
          key={progressKey}
          aria-hidden="true"
          className="harness-progress absolute inset-x-0 bottom-0 h-px origin-left bg-[#9fd7ff]/70"
          style={{ "--harness-step-duration": `${stepDurationMs}ms` } as CSSProperties}
        />
      )}
    </li>
  );
}

function StepIcon({ state }: { state: StepState }) {
  switch (state) {
    case "verified":
      return <BadgeCheck className={`size-5 ${verifiedTextClassName}`} />;
    case "done":
      return <CircleCheck className="size-5 text-[#9fd7ff]" />;
    case "current":
      return (
        <span className="grid size-5 place-items-center rounded-full border border-[#9fd7ff]/60">
          <span className="size-2 rounded-full bg-[#9fd7ff]" />
        </span>
      );
    case "pending":
      return <Circle className="size-5 text-white/18" />;
  }
}

function stepState(index: number, activeIndex: number): StepState {
  if (index < activeIndex) return "done";
  if (index > activeIndex) return "pending";
  return index === lastStep ? "verified" : "current";
}

function useTraceVisibility(
  ref: React.RefObject<HTMLDivElement | null>,
  setAutoplay: (update: (autoplay: Autoplay) => Autoplay) => void,
) {
  const [isInView, setIsInView] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const observer = new IntersectionObserver(
      ([entry]) => {
        const visible = Boolean(entry?.isIntersecting);
        setIsInView(visible);
        if (visible && !reducedMotion.matches) {
          setAutoplay((autoplay) => (autoplay === "idle" ? "playing" : autoplay));
        }
      },
      { threshold: 0.35 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, setAutoplay]);

  return isInView;
}
