import {
  BadgeCheck,
  CircleCheck,
  CircleX,
  FileText,
  OctagonX,
  Search,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

// One simple picture per harness tool for the showcase screen. Shapes stand
// in for code, so the screen reads at a glance.

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
    <SceneColumn>
      <Item index={0} className="flex items-center gap-3 rounded-xl border border-white/12 bg-white/[0.05] px-4 py-3">
        <Search className="size-4 text-white/50" />
        <span className="text-sm text-white/90">calculateTotal</span>
      </Item>
      <Item index={1} className="flex items-center justify-between gap-4 rounded-xl bg-[#9fd7ff]/[0.12] px-4 py-3">
        <span className="text-sm text-white">
          <span className="hidden sm:inline">function </span>calculateTotal
        </span>
        <span className={`flex shrink-0 items-center gap-1.5 text-xs ${accentText}`}>
          <CircleCheck className="size-3.5" />
          cart.ts, line 24
        </span>
      </Item>
      {["Mentioned in a comment", "Mentioned in a test name"].map((text, index) => (
        <Item
          key={text}
          index={index + 2}
          className="flex items-center justify-between gap-4 px-4 py-1.5 text-sm text-white/50"
        >
          <span className="line-through decoration-white/30">{text}</span>
          <span className="text-xs">skipped</span>
        </Item>
      ))}
    </SceneColumn>
  );
}

const fileLines = [72, 48, 86, 64, 92, 58, 80, 44, 68];
const readRange = [2, 6];

function ReadScene() {
  return (
    <SceneColumn>
      <FileCard>
        {fileLines.map((width, index) => {
          const isRead = index >= readRange[0] && index <= readRange[1];
          return (
            <Item
              key={index}
              index={isRead ? 1 : 0}
              className={`-mx-4 px-4 py-[5px] ${isRead ? "bg-[#9fd7ff]/[0.1]" : ""}`}
            >
              <CodeBar width={width} tone={isRead ? "read" : "idle"} />
            </Item>
          );
        })}
      </FileCard>
      <Item index={2} className={`flex items-center justify-center gap-2 text-sm ${accentText}`}>
        <CircleCheck className="size-4 shrink-0" />
        Read one function, version recorded
      </Item>
    </SceneColumn>
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
    <SceneColumn>
      <FileCard>
        {editLines.map((line, index) => (
          <Item
            key={index}
            index={line.tone === "idle" ? 0 : index - 1}
            className={`-mx-4 flex items-center gap-3 px-4 py-[5px] ${lineBackground[line.tone]}`}
          >
            <span aria-hidden="true" className={`w-2 text-xs ${lineMarkerColor[line.tone]}`}>
              {lineMarker[line.tone]}
            </span>
            <CodeBar width={line.width} tone={line.tone} />
          </Item>
        ))}
      </FileCard>
      <Item index={5} className={`flex items-center justify-center gap-2 text-sm ${passText}`}>
        <CircleCheck className="size-4 shrink-0" />
        Unchanged since it was read, edit applied
      </Item>
    </SceneColumn>
  );
}

function RunScene() {
  return (
    <SceneColumn>
      <Item index={0} className="rounded-xl border border-white/10 bg-black/60 px-5 py-4 text-sm">
        <p className="flex items-center justify-between gap-4 text-white/60">
          <span>Test script</span>
          <span>exited with code 0</span>
        </p>
        <p className="mt-3 flex items-center gap-2 text-white/90">
          <CircleX className={`size-4 shrink-0 ${failText}`} />
          1 test failed in cart.test.ts
        </p>
      </Item>
      <Item index={1} className={`flex items-center justify-center gap-2 text-sm ${failText}`}>
        <OctagonX className="size-4 shrink-0" />
        Recorded as a failure, not a pass
      </Item>
    </SceneColumn>
  );
}

const finishChecks = [
  "Types check on the final code",
  "Tests pass after the last edit",
  "No required check missing or stale",
];

function FinishScene() {
  return (
    <SceneColumn>
      <div className="space-y-2.5">
        {finishChecks.map((check, index) => (
          <Item key={check} index={index} className="flex items-center gap-3 text-sm text-white/86">
            <CircleCheck className={`size-4 shrink-0 ${passText}`} />
            {check}
          </Item>
        ))}
      </div>
      <Item index={3} className="flex justify-center">
        <span className={`inline-flex items-center gap-2 rounded-full bg-[oklch(0.75_0.17_150/0.14)] px-4 py-2 text-sm ${passText}`}>
          <BadgeCheck className="size-4" />
          Verified
        </span>
      </Item>
    </SceneColumn>
  );
}

function SceneColumn({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex h-full w-full max-w-sm flex-col justify-center gap-3">
      {children}
    </div>
  );
}

function FileCard({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
      <Item index={0} className="flex items-center gap-2 border-b border-white/[0.07] px-4 py-2 text-xs text-white/50">
        <FileText className="size-3.5" />
        cart.ts
      </Item>
      <div className="px-4 py-2">{children}</div>
    </div>
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
  idle: "bg-white/[0.09]",
  read: "bg-[#9fd7ff]/60",
  remove: "bg-[oklch(0.7_0.19_25/0.5)]",
};

function CodeBar({
  tone,
  width,
}: {
  tone: keyof typeof barColor;
  width: number;
}) {
  return (
    <span
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
