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
  let disposed = false
  terminal.loadAddon(fit)
  terminal.open(element)
  const resize = () => {
    if (disposed || !element.clientWidth || !element.clientHeight) return
    fit.fit()
    // Font loading can change DOM-renderer glyph widths without changing the
    // cell count. Redraw the rows even when FitAddon keeps the same dimensions.
    terminal.refresh(0, terminal.rows - 1)
    onResize(terminal.cols, terminal.rows)
  }
  const observer = new ResizeObserver(resize)
  observer.observe(element)
  const data = terminal.onData(onData)
  resize()
  void document.fonts.ready.then(resize)
  return {
    terminal,
    resize,
    dispose() {
      disposed = true
      observer.disconnect()
      data.dispose()
      terminal.dispose()
    },
  }
}
