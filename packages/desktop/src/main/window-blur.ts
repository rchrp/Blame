// The flag that tells the renderer to paint its surfaces opaque.
export const opaqueWindowArgument = "--blame-opaque-window";

// CSS cannot blur what lies behind the window, so the translucent sidebar
// reads well only where the system blurs it: macOS vibrancy, Windows acrylic,
// or a Linux compositor that blurs every translucent window, as Hyprland
// does. GNOME offers windows no blur, and KWin blurs only windows that ask
// through a Wayland protocol Chromium does not speak.
function systemBlursBehindWindow(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
) {
  if (platform !== "linux") return true;
  return !!env.HYPRLAND_INSTANCE_SIGNATURE;
}

export function windowBlurArguments(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
) {
  return systemBlursBehindWindow(platform, env) ? [] : [opaqueWindowArgument];
}
