import { useRef, type MouseEvent, type PointerEvent } from "react"

// Full-screen galleries contain their backdrop. Only a click that starts
// and ends on empty space dismisses them, never a drag from the document.
export function useGalleryBackdrop(onClose: () => void) {
  const startedOnBackdrop = useRef(false)
  const isBackdrop = (target: EventTarget) =>
    target instanceof HTMLElement && target.hasAttribute("data-gallery-backdrop")

  return {
    "data-gallery-backdrop": true,
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      startedOnBackdrop.current = event.button === 0 && isBackdrop(event.target)
    },
    onPointerCancel: () => {
      startedOnBackdrop.current = false
    },
    onClick: (event: MouseEvent<HTMLElement>) => {
      if (startedOnBackdrop.current && isBackdrop(event.target)) onClose()
      startedOnBackdrop.current = false
    },
  }
}
