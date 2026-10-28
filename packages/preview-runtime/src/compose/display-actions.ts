/** A fixed argument vector; no shell interpolation or arbitrary exec. */
export function displayActionCommand(input: Record<string, unknown>): string[] {
  const coordinate = (key: string) => {
    const value = input[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 3840) throw new Error(`Invalid screen coordinate ${key}.`);
    return String(Math.round(value));
  };
  const text = (key: string, limit: number) => { const value = input[key]; if (typeof value !== "string" || value.length > limit || value.includes("\0")) throw new Error(`Invalid ${key}.`); return value; };
  switch (input.action) {
    case "screenshot": return ["blame-display", "shot", "--base64"];
    case "resolution": { const width = Number(input.width), height = Number(input.height); if (![[1280,800],[1440,900],[1920,1080]].some(([w,h]) => w === width && h === height)) throw new Error("Choose a supported screen size."); return ["blame-display", "resolution", String(width), String(height)]; }
    case "windows": return ["blame-display", "windows"];
    case "click": {
      const button = { left: "1", middle: "2", right: "3" }[String(input.button ?? "left")];
      if (!button) throw new Error("Choose a left, middle or right click.");
      return ["blame-display", "click", coordinate("x"), coordinate("y"), button, input.double === true ? "2" : "1"];
    }
    case "type": return ["blame-display", "type", text("text", 64000)];
    case "key": return ["blame-display", "key", text("keys", 100)];
    case "scroll": {
      const delta = Number(input.deltaY); if (!Number.isInteger(delta) || Math.abs(delta) > 1000) throw new Error("Scroll at most 1000 pixels.");
      return ["blame-display", "scroll", String(delta)];
    }
    case "drag": return ["blame-display", "drag", coordinate("x"), coordinate("y"), coordinate("toX"), coordinate("toY")];
    default: throw new Error("Unknown screen action.");
  }
}

export function displayActionResult(action: unknown, result: { exitCode: number; stdout: string; stderr: string }) {
  if (result.exitCode) return { status: "failed", message: result.stderr.slice(-2000) || "The screen action failed. Restart the app and try again." };
  if (action === "screenshot") return { status: "ready", content: [{ type: "image", mimeType: "image/png", data: result.stdout.trim() }] };
  return { status: "ready", message: result.stdout.slice(-64000) || "Done" };
}
