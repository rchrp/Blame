import * as React from "react"

export function useElementHeight(
  ref: React.RefObject<HTMLElement | null>,
  visible: boolean
) {
  const [height, setHeight] = React.useState(0)
  React.useLayoutEffect(() => {
    const element = ref.current
    if (!visible || !element) return

    const update = () =>
      setHeight(Math.ceil(element.getBoundingClientRect().height))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element, { box: "border-box" })
    return () => observer.disconnect()
  }, [ref, visible])
  return visible ? height : 0
}
