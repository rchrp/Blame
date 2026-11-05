import * as React from "react"

import { usePlatform } from "@/context/platform"

// True while the Blame window is focused and on screen. It follows the
// window's own focus from the desktop, not the page's: a click into a native
// preview blurs the page while the window stays focused.
export function useWindowActive() {
  const controls = usePlatform().windowControls
  const [focused, setFocused] = React.useState(true)
  const [shown, setShown] = React.useState(
    () => document.visibilityState !== "hidden"
  )

  React.useEffect(() => {
    const update = () => setShown(document.visibilityState !== "hidden")
    document.addEventListener("visibilitychange", update)
    return () => document.removeEventListener("visibilitychange", update)
  }, [])

  React.useEffect(() => {
    if (!controls?.onFocused) return
    let active = true
    void controls.isFocused?.().then((value) => {
      if (active) setFocused(value)
    })
    const remove = controls.onFocused(setFocused)
    return () => {
      active = false
      remove()
    }
  }, [controls])

  return focused && shown
}
