declare module "@novnc/novnc/core/rfb.js" {
  export default class RFB {
    constructor(target: HTMLElement, url: string)
    scaleViewport: boolean
    resizeSession: boolean
    focus(): void
    disconnect(): void
    clipboardPasteFrom(text: string): void
    addEventListener(name: string, listener: (event: Event) => void): void
  }
}
