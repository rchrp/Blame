import { join } from "node:path";
import { app, nativeImage } from "electron";
import {
  storeResultScreenshots,
  type ImageCodec,
  type ScreenshotCaptureContext,
} from "./agent-screenshot-capture.ts";
import { AgentScreenshotStore } from "./agent-screenshot-store.ts";

let store: AgentScreenshotStore | undefined;

export function agentScreenshotStore() {
  store ??= new AgentScreenshotStore(
    join(app.getPath("userData"), "agent-screenshots"),
  );
  return store;
}

const electronImageCodec: ImageCodec = {
  size(data) {
    return nativeImage.createFromBuffer(data).getSize();
  },
  encode(data, target, format) {
    const image = nativeImage
      .createFromBuffer(data)
      .resize({ ...target, quality: "best" });
    return format === "png" ? image.toPNG() : image.toJPEG(85);
  },
};

export function storePreviewDevtoolsScreenshots(
  result: unknown,
  context: ScreenshotCaptureContext,
) {
  return storeResultScreenshots(
    result,
    context,
    agentScreenshotStore(),
    electronImageCodec,
  );
}
