"use client";

import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileCode2,
  Folder,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Bubble,
  BubbleContent,
  BubbleGroup,
  BubbleReactions,
} from "@/components/ui/bubble";
import { Marker, MarkerContent } from "@/components/ui/marker";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
} from "@/components/ui/message";
import {
  parallelAgentProviders,
  ProviderLogo,
} from "@/components/provider-logos";

type ArtifactType = "architecture" | "code" | "commits" | "tests";

type PracticeSlide = {
  artifact: ArtifactType;
  description: string;
  title: string;
};

type PracticeCardProps = {
  isActive: boolean;
  slide: PracticeSlide;
};

type PracticeCarouselHeaderProps = {
  activeIndex: number;
  onSelect: (index: number) => void;
};

const practiceSlides: PracticeSlide[] = [
  {
    artifact: "code",
    description:
      "Write explicit, typed, focused code with deliberate error handling and no temporary, duplicated, or unsafe patterns.",
    title: "Coding style",
  },
  {
    artifact: "tests",
    description:
      "Use a TDD loop and ZOMBIES cases for behavior, state, validation, data flows, boundaries, and failures.",
    title: "Unit tests",
  },
  {
    artifact: "architecture",
    description:
      "Apply Clean, Onion, and Hexagonal Architecture with use cases, domain core, ports, adapters, and inward dependencies.",
    title: "Layered architecture",
  },
  {
    artifact: "commits",
    description:
      "Produce exact Conventional Commits such as feat:, fix:, refactor:, docs:, test:, chore:, build:, or ci:.",
    title: "Commit conventions",
  },
];

const carouselDurationMs = 6500;
const geminiProvider =
  parallelAgentProviders.find((provider) => provider.name === "Google") ??
  parallelAgentProviders[2];
const openAiProvider =
  parallelAgentProviders.find((provider) => provider.name === "OpenAI") ??
  parallelAgentProviders[0];

export function CodePracticesCarousel() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isInteracting, setIsInteracting] = useState(false);
  const isVisible = useCarouselVisibility(rootRef);
  const selectSlide = (index: number) => setActiveIndex(index);

  return (
    <div
      ref={rootRef}
      className="min-w-0"
      onFocusCapture={() => setIsInteracting(true)}
      onBlurCapture={() => setIsInteracting(false)}
      onMouseEnter={() => setIsInteracting(true)}
      onMouseLeave={() => setIsInteracting(false)}
    >
      <PracticeCarouselHeader
        activeIndex={activeIndex}
        onSelect={selectSlide}
      />
      <PracticeCarouselViewport activeIndex={activeIndex} />
      <PracticeCarouselDots
        activeIndex={activeIndex}
        isPaused={!isVisible || isInteracting}
        onSelect={selectSlide}
      />
    </div>
  );
}

function PracticeCarouselHeader({
  activeIndex,
  onSelect,
}: PracticeCarouselHeaderProps) {
  const activeSlide = practiceSlides[activeIndex];
  return (
    <div className="mb-4 flex min-h-20 items-center justify-between gap-4">
      <div aria-live="polite" className="min-w-0">
        <h3 className="text-base text-[#11131a] sm:text-lg">
          {activeSlide.title}
        </h3>
        <p className="mt-1 max-w-xl text-xs leading-5 text-[#11131a]/48 sm:text-sm">
          {activeSlide.description}
        </p>
      </div>
      <div className="flex gap-2">
        <CarouselButton
          direction="previous"
          disabled={activeIndex === 0}
          onClick={() => onSelect(activeIndex - 1)}
        />
        <CarouselButton
          direction="next"
          disabled={activeIndex === practiceSlides.length - 1}
          onClick={() => onSelect(activeIndex + 1)}
        />
      </div>
    </div>
  );
}

function CarouselButton({
  direction,
  disabled,
  onClick,
}: {
  direction: "next" | "previous";
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = direction === "next" ? ChevronRight : ChevronLeft;
  return (
    <button
      type="button"
      aria-label={`${direction === "next" ? "Next" : "Previous"} practice`}
      disabled={disabled}
      onClick={onClick}
      className="grid size-10 place-items-center rounded-full bg-[#11131a]/8 text-[#11131a] transition hover:bg-[#11131a]/14 focus:outline-none focus:ring-2 focus:ring-[#3545ad]/40 disabled:cursor-default disabled:opacity-25"
    >
      <Icon className="size-4" />
    </button>
  );
}

function PracticeCarouselViewport({ activeIndex }: { activeIndex: number }) {
  const trackStyle = {
    transform: `translateX(-${activeIndex * 100}%)`,
  };
  return (
    <div className="overflow-hidden rounded-[1.75rem] shadow-[0_28px_80px_rgba(42,40,91,0.18)] ring-1 ring-black/[0.06]">
      <div
        className="flex transition-transform duration-500 ease-out"
        style={trackStyle}
      >
        {practiceSlides.map((slide, index) => (
          <PracticeCard
            key={slide.title}
            isActive={activeIndex === index}
            slide={slide}
          />
        ))}
      </div>
    </div>
  );
}

function PracticeCard({ isActive, slide }: PracticeCardProps) {
  return (
    <article
      aria-label={slide.title}
      aria-hidden={!isActive}
      inert={!isActive}
      className="w-full shrink-0 bg-white"
    >
      <ComparisonSlider artifact={slide.artifact} title={slide.title} />
    </article>
  );
}

function ComparisonSlider({
  artifact,
  title,
}: {
  artifact: ArtifactType;
  title: string;
}) {
  const [position, setPosition] = useState(50);
  const updatePosition = (event: ChangeEvent<HTMLInputElement>) => {
    setPosition(Number(event.target.value));
  };
  const overlayStyle = {
    clipPath: `inset(0 ${100 - position}% 0 0)`,
    WebkitClipPath: `inset(0 ${100 - position}% 0 0)`,
  };
  return (
    <div className="relative h-[420px] bg-[#f3f3f5] sm:h-[450px]">
      <ArtifactLayer artifact={artifact} isPro />
      <ArtifactLayer artifact={artifact} isPro={false} style={overlayStyle} />
      <ComparisonDivider position={position} />
      <ComparisonRange
        position={position}
        title={title}
        onChange={updatePosition}
      />
      <ComparisonLabels />
    </div>
  );
}

function ComparisonRange({
  onChange,
  position,
  title,
}: {
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  position: number;
  title: string;
}) {
  return (
    <input
      type="range"
      min="4"
      max="96"
      value={position}
      onChange={onChange}
      aria-label={`Compare other agents and pro standard for ${title}`}
      className="absolute inset-0 z-20 h-full w-full cursor-ew-resize opacity-0"
    />
  );
}

function ComparisonDivider({ position }: { position: number }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 z-10 w-px -translate-x-1/2 bg-white/80 shadow-[0_0_0_1px_rgba(17,19,26,0.12)]"
      style={{ left: `${position}%` }}
    >
      <span className="absolute left-1/2 top-1/2 grid h-11 w-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white text-[9px] tracking-[-0.12em] text-[#11131a]/45 shadow-lg ring-1 ring-black/10">
        ⋮⋮
      </span>
    </div>
  );
}

function ComparisonLabels() {
  return (
    <div className="pointer-events-none absolute inset-x-4 bottom-4 z-30 flex items-center justify-between">
      <span className="rounded-full bg-[#8e8e93] px-3 py-1.5 text-[10px] uppercase tracking-[0.08em] text-white shadow-sm">
        Other
      </span>
      <span className="bg-primary text-primary-foreground rounded-full px-3 py-1.5 text-[10px] uppercase tracking-[0.08em] shadow-sm">
        Pro standard
      </span>
    </div>
  );
}

function ArtifactLayer({
  artifact,
  isPro,
  style,
}: {
  artifact: ArtifactType;
  isPro: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`absolute inset-0 overflow-hidden ${isPro ? "bg-[#eceeff]" : "bg-[#f2f2f4]"}`}
      style={style}
    >
      <div className="h-full w-full px-4 pb-16 pt-5 sm:px-7 sm:pt-7">
        <PracticeArtifact artifact={artifact} isPro={isPro} />
      </div>
    </div>
  );
}

function PracticeArtifact({
  artifact,
  isPro,
}: {
  artifact: ArtifactType;
  isPro: boolean;
}) {
  if (artifact === "code") return <CodeArtifact isPro={isPro} />;
  if (artifact === "tests") return <TestConversation isPro={isPro} />;
  if (artifact === "architecture")
    return <ArchitectureArtifact isPro={isPro} />;
  return <CommitArtifact isPro={isPro} />;
}

const otherCode = [
  "const f=(x:any)=>{",
  " let r=[]",
  " for(let i=0;i<x.length;i++)",
  "  if(x[i].active)",
  "   r.push({n:x[i].name,",
  "    v:x[i].score*2})",
  " return r",
  "}",
];

const proCode = [
  "type Member = {",
  "  name: string",
  "  score: number",
  "  isActive: boolean",
  "}",
  "",
  "export function rankMembers(",
  "  members: Member[],",
  ") {",
  "  return members",
  "    .filter(isActive)",
  "    .map(toRanking)",
  "}",
];

function CodeArtifact({ isPro }: { isPro: boolean }) {
  const lines = isPro ? proCode : otherCode;
  return (
    <div className="mx-auto flex h-full w-full max-w-xl flex-col justify-center px-2 sm:px-8">
      <pre className="overflow-hidden font-mono text-[9px] leading-[1.85] text-[#2b2e38] sm:text-[11px]">
        {lines.map((line, index) => (
          <code key={`${line}-${index}`} className="block whitespace-pre">
            <span className="mr-3 inline-block w-4 select-none text-right text-black/20">
              {index + 1}
            </span>
            {line}
          </code>
        ))}
      </pre>
      <ArtifactStatus isPro={isPro} />
    </div>
  );
}

function ArtifactStatus({ isPro }: { isPro: boolean }) {
  return (
    <div
      className={`mt-5 text-[10px] ${isPro ? "text-emerald-700" : "text-red-700"}`}
    >
      {isPro ? "✓ Typed · lint clean" : "7 warnings · any used"}
    </div>
  );
}

type ConversationMessage = {
  align: "start" | "end";
  author: "agent" | "user";
  footer?: string;
  messages: string[];
  reaction?: string;
};

type ConversationBubbleProps = {
  isPro: boolean;
  message: ConversationMessage;
};

const otherConversation: ConversationMessage[] = [
  {
    align: "end" as const,
    author: "user" as const,
    messages: [
      "Refactor billing.ts without changing behavior. This project has no tests yet.",
    ],
  },
  {
    align: "start" as const,
    author: "agent" as const,
    messages: ["Done. Everything looks good."],
  },
  {
    align: "end" as const,
    author: "user" as const,
    messages: [
      "Checkout is broken. There weren't even tests to catch this. 😤",
    ],
  },
  {
    align: "start" as const,
    author: "agent" as const,
    footer: "Not verified",
    messages: ["You've reached your usage limit."],
  },
];

const proConversation: ConversationMessage[] = [
  {
    align: "end" as const,
    author: "user" as const,
    messages: [
      "Refactor billing.ts without changing behavior. This project has no tests yet.",
    ],
  },
  {
    align: "start" as const,
    author: "agent" as const,
    footer: "Verified",
    messages: [
      "Done and verified.",
      "I added focused coverage first. All 18 new tests pass and checkout behavior is preserved.",
    ],
  },
  {
    align: "end" as const,
    author: "user" as const,
    messages: ["Perfect — safe and tested. Thanks!"],
    reaction: "👍",
  },
];

function TestConversation({ isPro }: { isPro: boolean }) {
  const messages = isPro ? proConversation : otherConversation;
  return (
    <div className="mx-auto flex h-full w-full max-w-md flex-col justify-center px-1 sm:px-5">
      <Marker role="status" className="mb-3">
        <MarkerContent>
          {isPro ? "18 tests added and passing" : "No test suite"}
        </MarkerContent>
      </Marker>
      <div className="flex flex-col gap-3">
        {messages.map((message, index) => (
          <ConversationBubble
            key={`${message.author}-${index}`}
            isPro={isPro}
            message={message}
          />
        ))}
      </div>
    </div>
  );
}

function ConversationBubble({ isPro, message }: ConversationBubbleProps) {
  return (
    <Message align={message.align}>
      <MessageAvatar className="[&_[data-slot=avatar]]:size-5 sm:[&_[data-slot=avatar]]:size-7">
        <ConversationAvatar author={message.author} isPro={isPro} />
      </MessageAvatar>
      <MessageContent>
        <BubbleGroup
          className={message.align === "end" ? "items-end" : undefined}
        >
          {message.messages.map((text) => (
            <Bubble
              key={text}
              variant={message.author === "agent" ? "muted" : "default"}
              className="px-2 py-1.5 text-[9px] leading-3 sm:px-3 sm:py-2 sm:text-xs sm:leading-4"
            >
              <BubbleContent>{text}</BubbleContent>
            </Bubble>
          ))}
          {message.reaction && (
            <BubbleReactions aria-label="Reaction: thumbs up">
              <span>{message.reaction}</span>
            </BubbleReactions>
          )}
        </BubbleGroup>
        {message.footer && <MessageFooter>{message.footer}</MessageFooter>}
      </MessageContent>
    </Message>
  );
}

function ConversationAvatar({
  author,
  isPro,
}: {
  author: "agent" | "user";
  isPro: boolean;
}) {
  if (author === "agent") return <AgentAvatar isPro={isPro} />;
  return (
    <Avatar className="bg-[#8e8e93]">
      <AvatarFallback>ME</AvatarFallback>
    </Avatar>
  );
}

function AgentAvatar({ isPro }: { isPro: boolean }) {
  if (!isPro) {
    return (
      <Avatar className="bg-white ring-1 ring-black/8">
        <ProviderLogo
          provider={geminiProvider}
          className="size-full p-1.5 text-[#4285f4]"
        />
      </Avatar>
    );
  }
  return (
    <Avatar className="bg-[#11131a]">
      <ProviderLogo
        provider={openAiProvider}
        className="size-full p-1.5 text-white"
      />
    </Avatar>
  );
}

type TreeEntry = {
  kind: "file" | "folder";
  label: string;
  lines?: number;
  level: number;
};

const otherTree: TreeEntry[] = [
  { kind: "folder", label: "app", level: 0 },
  { kind: "file", label: "page.tsx", level: 1, lines: 4812 },
];

const proTree: TreeEntry[] = [
  { kind: "folder", label: "src", level: 0 },
  { kind: "folder", label: "features", level: 1 },
  { kind: "folder", label: "checkout", level: 2 },
  { kind: "folder", label: "components", level: 3 },
  { kind: "file", label: "checkout-form.tsx", level: 4, lines: 148 },
  { kind: "folder", label: "domain", level: 3 },
  { kind: "file", label: "order.ts", level: 4, lines: 72 },
  { kind: "folder", label: "services", level: 3 },
  { kind: "file", label: "submit-order.ts", level: 4, lines: 96 },
  { kind: "folder", label: "store", level: 3 },
  { kind: "file", label: "checkout-store.ts", level: 4, lines: 84 },
  { kind: "file", label: "page.tsx", level: 1, lines: 42 },
];

function ArchitectureArtifact({ isPro }: { isPro: boolean }) {
  const entries = isPro ? proTree : otherTree;
  return (
    <div className="mx-auto flex h-full w-full max-w-md flex-col justify-center px-2 sm:px-8">
      <div className="space-y-0.5">
        {entries.map((entry) => (
          <TreeRow key={`${entry.level}-${entry.label}`} entry={entry} />
        ))}
      </div>
      <ArchitectureStatus isPro={isPro} />
    </div>
  );
}

function TreeRow({ entry }: { entry: TreeEntry }) {
  const Icon = entry.kind === "folder" ? Folder : FileCode2;
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 rounded-md py-1 text-[9px] text-[#24262e] sm:text-[10px]"
      style={{ paddingLeft: `${Math.min(entry.level, 3) * 8}px` }}
    >
      <Icon
        className={`size-3 shrink-0 ${entry.kind === "folder" ? "text-[#5263cf]" : "text-black/35"}`}
      />
      <span className="truncate">{entry.label}</span>
      {entry.lines && (
        <span className="ml-auto shrink-0 text-[8px] text-black/32">
          {entry.lines} lines
        </span>
      )}
    </div>
  );
}

function ArchitectureStatus({ isPro }: { isPro: boolean }) {
  return (
    <div
      className={`mt-4 text-[10px] ${isPro ? "text-emerald-700" : "text-red-700"}`}
    >
      {isPro
        ? "Focused modules · clear boundaries"
        : "UI · data · logic · state in one file"}
    </div>
  );
}

const otherCommits = [
  { hash: "8fa21c4", message: "fix" },
  { hash: "11d9a20", message: "wip again" },
  { hash: "cb730ad", message: "stuff" },
  { hash: "49e1db8", message: "final final" },
];

const proCommits = [
  { hash: "a84cf12", message: "feat(checkout): add optimistic order flow" },
  { hash: "39bd1e8", message: "test(billing): cover expired card failure" },
  { hash: "d270f91", message: "refactor(api): isolate payment gateway" },
  { hash: "572ae60", message: "fix(cart): preserve quantity on retry" },
];

function CommitArtifact({ isPro }: { isPro: boolean }) {
  const commits = isPro ? proCommits : otherCommits;
  return (
    <div className="mx-auto flex h-full w-full max-w-md flex-col justify-center px-2 sm:px-8">
      <div>
        {commits.map((commit, index) => (
          <CommitRow
            key={commit.hash}
            commit={commit}
            isLast={index === commits.length - 1}
            isPro={isPro}
          />
        ))}
      </div>
      <CommitStatus isPro={isPro} />
    </div>
  );
}

function CommitRow({
  commit,
  isLast,
  isPro,
}: {
  commit: { hash: string; message: string };
  isLast: boolean;
  isPro: boolean;
}) {
  return (
    <div className="relative flex min-h-12 gap-2.5">
      {!isLast && (
        <span className="absolute left-[5px] top-3 h-full w-px bg-black/15" />
      )}
      <span
        className={`relative z-[1] mt-1 size-3 shrink-0 rounded-full border-2 border-white/80 ${isPro ? "bg-primary" : "bg-black/30"}`}
      />
      <div className="min-w-0">
        <p className="line-clamp-2 text-[9px] leading-3.5 text-[#11131a]/78 sm:text-[11px]">
          {commit.message}
        </p>
        <p className="mt-0.5 text-[8px] text-black/32">
          {commit.hash}
        </p>
      </div>
    </div>
  );
}

function CommitStatus({ isPro }: { isPro: boolean }) {
  return (
    <div
      className={`mt-4 flex items-center gap-1.5 text-[10px] ${isPro ? "text-emerald-700" : "text-red-700"}`}
    >
      {isPro && <CheckCircle2 className="size-3" />}
      {isPro
        ? "Conventional commits · release ready"
        : "No intent · no usable history"}
    </div>
  );
}

function PracticeCarouselDots({
  activeIndex,
  isPaused,
  onSelect,
}: {
  activeIndex: number;
  isPaused: boolean;
  onSelect: (index: number) => void;
}) {
  const showNext = () => onSelect((activeIndex + 1) % practiceSlides.length);
  return (
    <div className="mt-5 flex justify-center">
      <div className="flex items-center gap-2 rounded-full bg-[#11131a]/8 p-2.5">
        {practiceSlides.map((slide, index) => (
          <PracticeDot
            key={slide.title}
            index={index}
            isActive={activeIndex === index}
            isPaused={isPaused}
            onComplete={showNext}
            onSelect={onSelect}
          />
        ))}
      </div>
      <PracticeProgressStyles />
    </div>
  );
}

function PracticeDot({
  index,
  isActive,
  isPaused,
  onComplete,
  onSelect,
}: {
  index: number;
  isActive: boolean;
  isPaused: boolean;
  onComplete: () => void;
  onSelect: (index: number) => void;
}) {
  return (
    <button
      type="button"
      aria-label={`Show practice ${index + 1}`}
      aria-current={isActive ? "true" : undefined}
      onClick={() => onSelect(index)}
      className={`relative h-2 overflow-hidden rounded-full transition-all focus:outline-none focus:ring-2 focus:ring-primary/40 ${isActive ? "w-8 bg-primary/20" : "w-2 bg-[#11131a]/25 hover:bg-[#11131a]/40"}`}
    >
      {isActive && (
        <PracticeProgress isPaused={isPaused} onComplete={onComplete} />
      )}
    </button>
  );
}

function PracticeProgress({
  isPaused,
  onComplete,
}: {
  isPaused: boolean;
  onComplete: () => void;
}) {
  return (
    <span
      aria-hidden="true"
      onAnimationEnd={onComplete}
      className="practice-progress bg-primary absolute inset-y-0 left-0 rounded-full"
      style={{
        animationDuration: `${carouselDurationMs}ms`,
        animationPlayState: isPaused ? "paused" : "running",
      }}
    />
  );
}

function PracticeProgressStyles() {
  return (
    <style>{`
      .practice-progress {
        animation: fill-practice-progress linear forwards;
        width: 0;
      }
      @keyframes fill-practice-progress {
        to { width: 100%; }
      }
      @media (prefers-reduced-motion: reduce) {
        .practice-progress { animation: none; width: 100%; }
      }
    `}</style>
  );
}

function useCarouselVisibility(ref: React.RefObject<HTMLDivElement | null>) {
  const [isVisible, setIsVisible] = useState(false);
  useEffect(() => observeVisibility(ref.current, setIsVisible), [ref]);
  return isVisible;
}

function observeVisibility(
  element: HTMLDivElement | null,
  setIsVisible: (value: boolean) => void,
) {
  if (!element || typeof IntersectionObserver === "undefined") {
    setIsVisible(true);
    return;
  }
  const observer = new IntersectionObserver(
    ([entry]) => setIsVisible(Boolean(entry?.isIntersecting)),
    { threshold: 0.3 },
  );
  observer.observe(element);
  return () => observer.disconnect();
}
