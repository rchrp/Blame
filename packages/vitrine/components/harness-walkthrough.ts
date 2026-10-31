"use client";

import {
  BadgeCheck,
  BookOpenText,
  FileSearch,
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
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { HarnessSceneId } from "@/components/harness-scenes";

export type HarnessStep = {
  caption: string;
  icon: LucideIcon;
  label: string;
  name: string;
  scene: HarnessSceneId;
  tool: string;
};

export const stepDurationMs = 4200;

export const harnessSteps: HarnessStep[] = [
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

const navigationKeys: Record<string, (index: number, last: number) => number> = {
  ArrowDown: (index, last) => (index === last ? 0 : index + 1),
  ArrowLeft: (index, last) => (index === 0 ? last : index - 1),
  ArrowRight: (index, last) => (index === last ? 0 : index + 1),
  ArrowUp: (index, last) => (index === 0 ? last : index - 1),
  End: (_index, last) => last,
  Home: () => 0,
};

// Shared behaviour of the harness walkthrough: it loops while visible, holds
// on hover or focus until the visitor decides, stops on a tool they pick, and
// starts paused when motion is reduced. An explicit Play or Pause always wins.
export function useHarnessWalkthrough() {
  const containerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLElement | null)[]>([]);
  const id = useId();
  const [activeIndex, setActiveIndex] = useState(0);
  const [pausedByUser, setPausedByUser] = useState<boolean | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [hasFocusWithin, setHasFocusWithin] = useState(false);
  const isInView = useInView(containerRef);
  const reducedMotion = useReducedMotion();
  const isPlaying =
    isInView &&
    (pausedByUser === null
      ? !reducedMotion && !isHovered && !hasFocusWithin
      : !pausedByUser);

  useEffect(() => {
    if (!isPlaying) return;
    const timer = window.setTimeout(
      () => setActiveIndex((index) => (index + 1) % harnessSteps.length),
      stepDurationMs,
    );
    return () => window.clearTimeout(timer);
  }, [activeIndex, isPlaying]);

  const select = (index: number, focus = false) => {
    setActiveIndex(index);
    setPausedByUser(true);
    if (focus) tabRefs.current[index]?.focus();
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const move = navigationKeys[event.key];
    if (!move) return;
    event.preventDefault();
    select(move(activeIndex, harnessSteps.length - 1), true);
  };

  const tabId = (index: number) => `${id}-tab-${index}`;
  const panelId = `${id}-panel`;

  return {
    activeIndex,
    activeStep: harnessSteps[activeIndex]!,
    isPlaying,
    select,
    togglePlay: () => setPausedByUser(isPlaying),
    containerProps: {
      ref: containerRef,
      onPointerEnter: (event: PointerEvent<HTMLElement>) => {
        if (event.pointerType === "mouse") setIsHovered(true);
      },
      onPointerLeave: (event: PointerEvent<HTMLElement>) => {
        if (event.pointerType === "mouse") setIsHovered(false);
      },
      onFocus: () => setHasFocusWithin(true),
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setHasFocusWithin(false);
        }
      },
    },
    getTabProps: (index: number) => ({
      id: tabId(index),
      role: "tab" as const,
      "aria-selected": index === activeIndex,
      "aria-controls": panelId,
      tabIndex: index === activeIndex ? 0 : -1,
      onClick: () => select(index),
      onKeyDown: onTabKeyDown,
      ref: (element: HTMLElement | null) => {
        tabRefs.current[index] = element;
      },
    }),
    panelProps: {
      id: panelId,
      role: "tabpanel" as const,
      "aria-labelledby": tabId(activeIndex),
    },
    playButtonProps: {
      type: "button" as const,
      onClick: () => setPausedByUser(isPlaying),
      "aria-label": isPlaying ? "Pause the walkthrough" : "Play the walkthrough",
    },
  };
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
