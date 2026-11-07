// Secondary windows (such as the status pip) open with a `view` parameter.
export function isSecondaryWindow() {
  return new URLSearchParams(window.location.search).get("view") !== null
}
