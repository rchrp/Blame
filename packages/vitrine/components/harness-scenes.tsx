import {
  BadgeCheck,
  CircleCheck,
  CircleX,
  FileText,
  OctagonX,
  Search,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

// One simple picture per harness tool, drawn on a single borderless surface
// that keeps the same size for every tool, content centred, outcome last.
// Shapes stand in for code so it reads at a glance.

export type HarnessSceneId = "search" | "read" | "edit" | "run" | "finish";

const accentText = "text-[#9fd7ff]";
const passText = "text-[oklch(0.8_0.17_150)]";
const failText = "text-[oklch(0.78_0.14_25)]";

export function HarnessScene({ scene }: { scene: HarnessSceneId }) {
  switch (scene) {
    case "search":
      return <SearchScene />;
    case "read":
      return <ReadScene />;
    case "edit":
      return <EditScene />;
    case "run":
      return <RunScene />;
    case "finish":
      return <FinishScene />;
  }
}

function SearchScene() {
  return (
    <Surface>
      <Item index={0} className="flex items-center gap-3 pb-3 text-white/90">
        <Search className="size-4 text-white/56" />
        calculateTotal
      </Item>
      <Item
        index={1}
        className="-mx-2 flex items-center justify-between gap-4 rounded-xl bg-[#9fd7ff]/[0.12] px-3 py-2.5"
      >
        <span className="text-white">
          <span className="hidden sm:inline">function </span>calculateTotal
        </span>
        <span className={`flex shrink-0 items-center gap-1.5 text-xs sm:text-sm ${accentText}`}>
          <CircleCheck className="size-3.5" />
          cart.ts, line 24
        </span>
      </Item>
      {["Mentioned in a comment", "Mentioned in a test name"].map((text, index) => (
        <Item
          key={text}
          index={index + 2}
          className="flex items-center justify-between gap-4 pt-3 text-white/56"
        >
          <span className="line-through decoration-white/30">{text}</span>
          <span className="text-xs sm:text-sm">skipped</span>
        </Item>
      ))}
    </Surface>
  );
}

const fileLines = [72, 86, 64, 92, 58, 80, 44];
const readRange = [1, 5];

function ReadScene() {
  return (
    <Surface title={<FileTitle />}>
      {fileLines.map((width, index) => {
        const isRead = index >= readRange[0] && index <= readRange[1];
        return (
          <Item
            key={index}
            index={isRead ? 1 : 0}
            className={`-mx-5 px-5 py-[6px] ${isRead ? "bg-[#9fd7ff]/[0.1]" : ""}`}
          >
            <CodeBar width={width} tone={isRead ? "read" : "idle"} />
          </Item>
        );
      })}
      <Outcome index={2} className={accentText} icon={CircleCheck}>
        Read one function, version recorded
      </Outcome>
    </Surface>
  );
}

const editLines: { tone: "add" | "idle" | "remove"; width: number }[] = [
  { tone: "idle", width: 70 },
  { tone: "idle", width: 52 },
  { tone: "remove", width: 64 },
  { tone: "add", width: 82 },
  { tone: "add", width: 64 },
  { tone: "idle", width: 40 },
];

function EditScene() {
  return (
    <Surface title={<FileTitle />}>
      {editLines.map((line, index) => (
        <Item
          key={index}
          index={line.tone === "idle" ? 0 : index - 1}
          className={`-mx-5 flex items-center gap-3 px-5 py-[6px] ${lineBackground[line.tone]}`}
        >
          <span
            aria-hidden="true"
            className={`flex h-2 w-2 items-center text-xs ${lineMarkerColor[line.tone]}`}
          >
            {lineMarker[line.tone]}
          </span>
          <CodeBar width={line.width} tone={line.tone} />
        </Item>
      ))}
      <Outcome index={5} className={passText} icon={CircleCheck}>
        Unchanged since it was read, edit applied
      </Outcome>
    </Surface>
  );
}

function RunScene() {
  return (
    <Surface
      title={
        <span className="flex w-full items-center justify-between gap-4">
          <span>Test script</span>
          <span>exited with code 0</span>
        </span>
      }
    >
      <Item index={1} className="flex items-center gap-3 py-1.5 text-white/72">
        <CircleCheck className={`size-4 shrink-0 ${passText}`} />
        13 tests passed
      </Item>
      <Item index={2} className="flex items-center gap-3 py-1.5 text-white/90">
        <CircleX className={`size-4 shrink-0 ${failText}`} />
        1 test failed in cart.test.ts
      </Item>
      <Outcome index={3} className={failText} icon={OctagonX}>
        Recorded as a failure, not a pass
      </Outcome>
    </Surface>
  );
}

const finishChecks = [
  "Types check on the final code",
  "Tests pass after the last edit",
  "No required check missing or stale",
];

function FinishScene() {
  return (
    <Surface>
      <div className="space-y-3.5">
        {finishChecks.map((check, index) => (
          <Item key={check} index={index} className="flex items-center gap-3 text-white/86">
            <CircleCheck className={`size-4 shrink-0 ${passText}`} />
            {check}
          </Item>
        ))}
      </div>
      <Outcome index={3} className={passText} icon={BadgeCheck}>
        Verified
      </Outcome>
    </Surface>
  );
}

function Surface({ children, title }: { children: ReactNode; title?: ReactNode }) {
  return (
    <div className="harness-scene-item mx-auto flex h-full w-full max-w-md flex-col justify-center rounded-[1.25rem] bg-white/[0.045] px-5 py-4 text-sm sm:max-w-[30rem] sm:text-[0.9375rem]">
      {title && (
        <div className="flex items-center gap-2 pb-2.5 text-xs text-white/56 sm:text-[0.8125rem]">
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

function FileTitle() {
  return (
    <>
      <FileText className="size-3.5" />
      cart.ts
    </>
  );
}

function Outcome({
  children,
  className,
  icon: Icon,
  index,
}: {
  children: ReactNode;
  className: string;
  icon: typeof CircleCheck;
  index: number;
}) {
  return (
    <Item index={index} className={`flex items-center gap-2 pt-4 text-sm ${className}`}>
      <Icon className="size-4 shrink-0" />
      {children}
    </Item>
  );
}

const lineBackground = {
  add: "bg-[oklch(0.75_0.17_150/0.1)]",
  idle: "",
  remove: "bg-[oklch(0.65_0.2_25/0.12)]",
};
const lineMarker = { add: "+", idle: "", remove: "−" };
const lineMarkerColor = {
  add: passText,
  idle: "",
  remove: "text-[oklch(0.75_0.16_25)]",
};
const barColor = {
  add: "bg-[oklch(0.8_0.17_150/0.55)]",
  idle: "bg-white/[0.1]",
  read: "bg-[#9fd7ff]/60",
  remove: "bg-[oklch(0.7_0.19_25/0.5)]",
};

function CodeBar({ tone, width }: { tone: keyof typeof barColor; width: number }) {
  return (
    <span
      aria-hidden="true"
      className={`block h-2 rounded-full ${barColor[tone]}`}
      style={{ width: `${width}%` }}
    />
  );
}

function Item({
  children,
  className = "",
  index,
}: {
  children: ReactNode;
  className?: string;
  index: number;
}) {
  return (
    <div
      className={`harness-scene-item ${className}`}
      style={{ "--harness-item": index } as CSSProperties}
    >
      {children}
    </div>
  );
}
