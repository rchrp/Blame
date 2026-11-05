import assert from "node:assert/strict";
import test from "node:test";

import { opaqueWindowArgument, windowBlurArguments } from "./window-blur.ts";

test("macOS and Windows keep the translucent window", () => {
  assert.deepEqual(windowBlurArguments("darwin", {}), []);
  assert.deepEqual(windowBlurArguments("win32", {}), []);
});

test("Hyprland keeps the translucent window", () => {
  const env = { HYPRLAND_INSTANCE_SIGNATURE: "abc_123" };
  assert.deepEqual(windowBlurArguments("linux", env), []);
});

test("GNOME and KDE get an opaque window", () => {
  for (const desktop of ["GNOME", "KDE"]) {
    assert.deepEqual(
      windowBlurArguments("linux", { XDG_CURRENT_DESKTOP: desktop }),
      [opaqueWindowArgument],
    );
  }
});
