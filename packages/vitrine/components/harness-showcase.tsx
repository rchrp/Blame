"use client";

import { Pause, Play } from "lucide-react";
import type { CSSProperties } from "react";
import { HarnessScene } from "@/components/harness-scenes";
import {
  harnessSteps,
  harnessStory,
  stepDurationMs,
  useHarnessWalkthrough,
  type HarnessStep,
} from "@/components/harness-walkthrough";

// The five harness tools as tabs, then the active tool's picture on the
// section background with one sentence under it, and a quiet story and
// play/pause line. No frame around the example.
export function HarnessShowcase() {
  const walkthrough = useHarnessWalkthrough();
  const { activeIndex, activeStep, isPlaying } = walkthrough;

  return (
    <div {...walkthrough.containerProps}>
      <div
        role="tablist"
        aria-label="Light Semantic Harness tools"
        className="mx-auto grid max-w-5xl grid-cols-5 gap-2 sm:gap-6"
      >
        {harnessSteps.map((step, index) => (
          <HarnessTab
            key={step.tool}
            isActive={index === activeIndex}
            isPlaying={isPlaying}
            step={step}
            tabProps={walkthrough.getTabProps(index)}
          />
        ))}
      </div>

      <div {...walkthrough.panelProps} className="mx-auto mt-8 max-w-3xl sm:mt-10">
        {/* The surface keeps one size for every tool, so nothing around it
            moves while the walkthrough plays. */}
        <div key={activeIndex} className="h-[15.5rem] sm:h-[16rem]">
          <HarnessScene scene={activeStep.scene} />
        </div>
        <div className="mx-auto mt-6 grid max-w-xl">
          {harnessSteps.map((step, index) => (
            <p
              key={index === activeIndex ? `caption-${index}` : step.tool}
              aria-hidden={index !== activeIndex}
              className={`text-balance text-center text-[1.0625rem] leading-7 text-white/80 [grid-area:1/1] sm:text-lg ${index === activeIndex ? "harness-scene-item" : "invisible"}`}
            >
              <span className="font-display text-white sm:hidden">
                {step.label}.{" "}
              </span>
              {step.caption}
            </p>
          ))}
        </div>
      </div>

      <div className="mt-5 flex items-center justify-center gap-3">
        <button
          {...walkthrough.playButtonProps}
          className="grid size-8 shrink-0 place-items-center rounded-full bg-white/[0.07] text-white/72 transition hover:bg-white/[0.12] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
        >
          {isPlaying ? (
            <Pause className="size-3 fill-current" />
          ) : (
            <Play className="size-3 translate-x-px fill-current" />
          )}
        </button>
        <p className="min-w-0 text-sm text-white/56">
          Example · <span className="text-white/72">{harnessStory}</span>
        </p>
      </div>
    </div>
  );
}

function HarnessTab({
  isActive,
  isPlaying,
  step,
  tabProps,
}: {
  isActive: boolean;
  isPlaying: boolean;
  step: HarnessStep;
  tabProps: ReturnType<ReturnType<typeof useHarnessWalkthrough>["getTabProps"]>;
}) {
  const Icon = step.icon;
  return (
    <button
      {...tabProps}
      type="button"
      className="group flex flex-col items-center rounded-2xl pb-1 text-center focus:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
    >
      <span
        className={`grid size-12 place-items-center rounded-2xl transition duration-300 sm:size-16 ${isActive ? "bg-[#9fd7ff]/[0.14] text-[#9fd7ff] ring-1 ring-[#9fd7ff]/40" : "bg-white/[0.05] text-white/46 group-hover:bg-white/[0.08] group-hover:text-white/80"}`}
      >
        <Icon className="size-6 sm:size-7" strokeWidth={1.75} />
      </span>
      <span
        className={`mt-3 font-display text-sm transition sm:mt-4 sm:text-lg ${isActive ? "text-white" : "text-white/50 group-hover:text-white/80"}`}
      >
        {step.name}
      </span>
      <span className="mt-1 hidden text-balance text-sm text-white/56 sm:block sm:min-h-10 lg:min-h-0">
        {step.label}
      </span>
      <span className="mt-3 block h-0.5 w-10 overflow-hidden rounded-full bg-white/[0.08] sm:w-14">
        {isActive && (
          <span
            key={isPlaying ? "playing" : "held"}
            className={`block h-full rounded-full ${isPlaying ? "harness-progress bg-[#9fd7ff]" : "bg-[#9fd7ff]/45"}`}
            style={{ "--harness-step": `${stepDurationMs}ms` } as CSSProperties}
          />
        )}
      </span>
    </button>
  );
}
