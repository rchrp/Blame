"use client";

import {
  BadgeCheck,
  BookOpenText,
  FileSearch,
  Pause,
  Play,
  ShieldCheck,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { HarnessScene, type HarnessSceneId } from "@/components/harness-scenes";

type HarnessStep = {
  caption: string;
  icon: LucideIcon;
  label: string;
  name: string;
  scene: HarnessSceneId;
  tool: string;
};

const stepDurationMs = 4200;

const harnessStory = "Add a discount to the checkout total";

const harnessSteps: HarnessStep[] = [
  {
    tool: "search_code",
    name: "Search",
    label: "By structure, not text",
    icon: FileSearch,
    scene: "search",
    caption: "Finds the real calculateTotal function, not every line that mentions it.",
  },
  {
    tool: "read_code",
    name: "Read",
    label: "Just what it needs",
    icon: BookOpenText,
    scene: "read",
    caption: "Reads just that function. The rest of the big file stays an outline.",
  },
  {
    tool: "edit_code",
    name: "Edit",
    label: "Only what it read",
    icon: ShieldCheck,
    scene: "edit",
    caption: "Edits only the code it read. If the file changed since, the edit is refused.",
  },
  {
    tool: "run_task",
    name: "Run",
    label: "Honest test results",
    icon: SquareTerminal,
    scene: "run",
    caption: "A failing test stays failed, even when the script says it passed.",
  },
  {
    tool: "finish_task",
    name: "Finish",
    label: "Re-checked at the end",
    icon: BadgeCheck,
    scene: "finish",
    caption: "Re-runs the required checks on the final code, then hands it back.",
  },
];

// The five harness tools as tabs above a small screen that walks through one
// story, a tool at a time. It loops while visible and pauses on hover, on
// focus, with its button, or from the start when motion is reduced.
export function HarnessShowcase() {
  const showcaseRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const [activeIndex, setActiveIndex] = useState(0);
  const [pausedByUser, setPausedByUser] = useState<boolean | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [hasFocusWithin, setHasFocusWithin] = useState(false);
  const isInView = useInView(showcaseRef);
  const reducedMotion = useReducedMotion();
  // An explicit Play or Pause wins over hover and focus, which only hold the
  // walkthrough until the visitor decides.
  const isPlaying =
    isInView &&
    (pausedByUser === null
      ? !reducedMotion && !isHovered && !hasFocusWithin
      : !pausedByUser);
  const activeStep = harnessSteps[activeIndex]!;

  useEffect(() => {
    if (!isPlaying) return;
    const timer = window.setTimeout(
      () => setActiveIndex((index) => (index + 1) % harnessSteps.length),
      stepDurationMs,
    );
    return () => window.clearTimeout(timer);
  }, [activeIndex, isPlaying]);

  // Picking a tool stops the rotation so it stays on screen; Play resumes.
  const selectTab = (index: number, focus = false) => {
    setActiveIndex(index);
    setPausedByUser(true);
    if (focus) tabRefs.current[index]?.focus();
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const last = harnessSteps.length - 1;
    const next = {
      ArrowLeft: activeIndex === 0 ? last : activeIndex - 1,
      ArrowRight: activeIndex === last ? 0 : activeIndex + 1,
      End: last,
      Home: 0,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectTab(next, true);
  };

  return (
    <div
      ref={showcaseRef}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setIsHovered(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") setIsHovered(false);
      }}
      onFocus={() => setHasFocusWithin(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setHasFocusWithin(false);
        }
      }}
    >
      <div
        role="tablist"
        aria-label="Light Semantic Harness tools"
        className="mx-auto grid max-w-5xl grid-cols-5 gap-2 sm:gap-6"
      >
        {harnessSteps.map((step, index) => (
          <HarnessTab
            key={step.tool}
            id={`${id}-tab-${index}`}
            isActive={index === activeIndex}
            isPlaying={isPlaying}
            panelId={`${id}-panel`}
            step={step}
            tabRef={(element) => {
              tabRefs.current[index] = element;
            }}
            onKeyDown={onTabKeyDown}
            onSelect={() => selectTab(index)}
          />
        ))}
      </div>
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-${activeIndex}`}
        className="mx-auto mt-10 max-w-3xl overflow-hidden rounded-[1.75rem] border border-white/12 bg-[#0a0a0c] shadow-[0_24px_80px_rgba(0,0,0,0.32)] sm:mt-12"
      >
        <div className="flex items-center justify-between gap-4 border-b border-white/[0.08] px-5 py-3 sm:px-6">
          <p className="min-w-0 truncate text-sm text-white/60">
            <span className="hidden text-white/48 sm:inline">Story · </span>
            {harnessStory}
          </p>
          <button
            type="button"
            onClick={() => setPausedByUser(isPlaying)}
            aria-label={isPlaying ? "Pause the walkthrough" : "Play the walkthrough"}
            className="grid size-8 shrink-0 place-items-center rounded-full text-white/56 transition hover:bg-white/[0.08] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
          >
            {isPlaying ? (
              <Pause className="size-3.5 fill-current" />
            ) : (
              <Play className="size-3.5 fill-current" />
            )}
          </button>
        </div>
        <div key={activeIndex} className="h-[17.5rem] px-6 sm:h-[19rem]">
          <HarnessScene scene={activeStep.scene} />
        </div>
        <div className="grid border-t border-white/[0.08]">
          {harnessSteps.map((step, index) => (
            <p
              key={index === activeIndex ? `caption-${index}` : step.tool}
              aria-hidden={index !== activeIndex}
              className={`px-6 py-4 text-center text-[0.9375rem] leading-6 text-white/80 [grid-area:1/1] sm:text-base ${index === activeIndex ? "harness-scene-item" : "invisible"}`}
            >
              {step.caption}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

function HarnessTab({
  id,
  isActive,
  isPlaying,
  onKeyDown,
  onSelect,
  panelId,
  step,
  tabRef,
}: {
  id: string;
  isActive: boolean;
  isPlaying: boolean;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onSelect: () => void;
  panelId: string;
  step: HarnessStep;
  tabRef: (element: HTMLButtonElement | null) => void;
}) {
  const Icon = step.icon;
  return (
    <button
      ref={tabRef}
      id={id}
      type="button"
      role="tab"
      aria-selected={isActive}
      aria-controls={panelId}
      tabIndex={isActive ? 0 : -1}
      onClick={onSelect}
      onKeyDown={onKeyDown}
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

function useInView(ref: React.RefObject<HTMLDivElement | null>) {
  const [isInView, setIsInView] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setIsInView(Boolean(entry?.isIntersecting)),
      { threshold: 0.35 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return isInView;
}

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

function useReducedMotion() {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(reducedMotionQuery);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(reducedMotionQuery).matches,
    () => false,
  );
}
