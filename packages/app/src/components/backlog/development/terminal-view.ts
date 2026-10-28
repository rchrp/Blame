import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"

/** Shared terminal rendering and fit behavior for host and preview terminals. */
export function createTerminalView(
  element: HTMLElement,
  onResize: (cols: number, rows: number) => void,
  onData: (data: string) => void
) {
  const terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily:
      "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
    fontSize: 12,
    fontWeight: 400,
    letterSpacing: 0,
    lineHeight: 1.1,
    scrollback: 10000,
    theme: {
      background: "#09090b",
      cursor: "#f4f4f5",
      selectionBackground: "#3f3f46",
      foreground: "#f4f4f5",
    },
  })
  const fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.open(element)
  const resize = () => {
    if (!element.clientWidth || !element.clientHeight) return
    fit.fit()
    onResize(terminal.cols, terminal.rows)
  }
  const observer = new ResizeObserver(resize)
  observer.observe(element)
  const data = terminal.onData(onData)
  resize()
  return {
    terminal,
    resize,
    dispose() {
      observer.disconnect()
      data.dispose()
      terminal.dispose()
    },
  }
}
