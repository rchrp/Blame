import {
  ArrowUpRightIcon,
  CircleIcon,
  EraserIcon,
  MousePointer2Icon,
  PencilIcon,
  RectangleHorizontalIcon,
  Redo2Icon,
  SlidersHorizontalIcon,
  Trash2Icon,
  TypeIcon,
  Undo2Icon,
} from "lucide-react"
import type { ComponentProps } from "react"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { AnnotationTool } from "./annotation-model"

const tools = [
  {
    tool: "select",
    label: "Select and move",
    key: "V",
    icon: MousePointer2Icon,
  },
  { tool: "pen", label: "Draw", key: "P", icon: PencilIcon },
  { tool: "arrow", label: "Arrow", key: "A", icon: ArrowUpRightIcon },
  {
    tool: "rectangle",
    label: "Rectangle",
    key: "R",
    icon: RectangleHorizontalIcon,
  },
  { tool: "ellipse", label: "Ellipse", key: "O", icon: CircleIcon },
  { tool: "text", label: "Text", key: "T", icon: TypeIcon },
  { tool: "eraser", label: "Erase annotation", key: "E", icon: EraserIcon },
] as const
const colors = [
  ["Red", "#ef4444"],
  ["Orange", "#f97316"],
  ["Yellow", "#facc15"],
  ["Green", "#22c55e"],
  ["Blue", "#3b82f6"],
  ["Purple", "#a855f7"],
  ["White", "#ffffff"],
  ["Black", "#171717"],
]
export const toolShortcuts = Object.fromEntries(
  tools.map(({ key, tool }) => [key.toLowerCase(), tool])
) as Record<string, AnnotationTool>
export function AnnotationButton({
  label,
  children,
  className,
  ...props
}: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          className={cn("size-10 shrink-0", className)}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
export function AnnotationToolbar({
  tool,
  color,
  width,
  onTool,
  onColor,
  onWidth,
  onUndo,
  onRedo,
  onDelete,
  canUndo,
  canRedo,
  selected,
  disabled,
}: {
  tool: AnnotationTool
  color: string
  width: number
  onTool: (tool: AnnotationTool) => void
  onColor: (color: string) => void
  onWidth: (width: number) => void
  onUndo: () => void
  onRedo: () => void
  onDelete: () => void
  canUndo: boolean
  canRedo: boolean
  selected: boolean
  disabled: boolean
}) {
  return (
    <TooltipProvider>
      <div
        role="group"
        aria-label="Annotation tools"
        className="flex max-w-full min-w-0 flex-wrap items-center justify-center gap-0.5 rounded-xl bg-popover/80 p-1.5 shadow-lg backdrop-blur-xl"
      >
        {tools.map(({ tool: value, label, key, icon: Icon }) => (
          <AnnotationButton
            key={value}
            label={`${label} (${key})`}
            aria-pressed={tool === value}
            disabled={disabled}
            className={
              tool === value
                ? "bg-muted text-foreground"
                : "text-muted-foreground"
            }
            onClick={() => onTool(value)}
          >
            <Icon className="size-4.5" />
          </AnnotationButton>
        ))}
        <span className="mx-1 h-5 w-px bg-border" />
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Annotation color"
              className="size-10"
              disabled={disabled}
            >
              <span
                className="size-5 rounded-full border border-foreground/25"
                style={{ backgroundColor: color }}
              />
            </Button>
          </PopoverTrigger>
          <PopoverContent side="top" className="w-56 p-3">
            <p className="mb-2 text-sm font-medium">Color</p>
            <div className="grid grid-cols-4 gap-2">
              {colors.map(([name, value]) => (
                <button
                  type="button"
                  key={name}
                  aria-label={name}
                  aria-pressed={color === value}
                  onClick={() => onColor(value)}
                  className={cn(
                    "flex size-10 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    color === value && "bg-muted ring-1 ring-ring"
                  )}
                >
                  <span
                    className="size-6 rounded-full border border-foreground/25"
                    style={{ backgroundColor: value }}
                  />
                </button>
              ))}
            </div>
            <label className="mt-3 flex items-center justify-between text-sm">
              Custom color
              <input
                aria-label="Custom annotation color"
                type="color"
                value={color}
                onChange={(event) => onColor(event.target.value)}
                className="h-8 w-10 cursor-pointer rounded border-0 bg-transparent"
              />
            </label>
          </PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Stroke width"
              className="size-10"
              disabled={disabled}
            >
              <SlidersHorizontalIcon />
            </Button>
          </PopoverTrigger>
          <PopoverContent side="top" className="w-48 p-3">
            <p className="mb-2 text-sm font-medium">Stroke width</p>
            <div className="flex gap-2">
              {[3, 6, 10].map((value, index) => (
                <Button
                  type="button"
                  key={value}
                  variant={width === value ? "secondary" : "ghost"}
                  size="icon"
                  aria-label={["Thin", "Medium", "Thick"][index]}
                  aria-pressed={width === value}
                  onClick={() => onWidth(value)}
                >
                  <span
                    className="rounded-full bg-current"
                    style={{ width: value + 2, height: value + 2 }}
                  />
                </Button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <span className="mx-1 h-5 w-px bg-border" />
        <AnnotationButton
          label="Undo (⌘/Ctrl Z)"
          disabled={disabled || !canUndo}
          onClick={onUndo}
        >
          <Undo2Icon />
        </AnnotationButton>
        <AnnotationButton
          label="Redo (⌘/Ctrl Shift Z)"
          disabled={disabled || !canRedo}
          onClick={onRedo}
        >
          <Redo2Icon />
        </AnnotationButton>
        <AnnotationButton
          label="Delete selected annotation"
          disabled={disabled || !selected}
          onClick={onDelete}
        >
          <Trash2Icon />
        </AnnotationButton>
      </div>
    </TooltipProvider>
  )
}
