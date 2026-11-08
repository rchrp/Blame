// The home page's two demo videos. Each one stays off until its files are in
// public/media and its `enabled` flag is true. While a video is off:
// - the hero shows the interactive backlog mockup instead of the loop;
// - the full demo's section is left out of the story.
// If a video is on but its files fail to load, the page falls back the same
// way, so it never shows a broken player.
//
// To turn a video on:
// 1. Export it at 1680 x 1050 (16:10), 30 fps or less, then encode it twice
//    and save its first frame as the poster, for example with ffmpeg and
//    cwebp (brew install ffmpeg webp):
//      ffmpeg -i in.mov -an -c:v libsvtav1 -preset 6 -crf 38 -pix_fmt yuv420p -movflags +faststart demo-loop-av1.mp4
//      ffmpeg -i in.mov -an -c:v libx264 -preset slow -crf 24 -pix_fmt yuv420p -movflags +faststart demo-loop-h264.mp4
//      ffmpeg -i in.mov -frames:v 1 poster.png && cwebp -q 82 poster.png -o demo-loop-poster.webp
//    The loop plays muted, so drop its audio (-an); the full demo keeps
//    its audio, if it has any.
//    The AV1 type below (`av01.0.08M.08`: Main profile, level 4.0, 8-bit)
//    covers up to 2048 x 1088 at 30 fps; a larger or faster video needs a
//    higher level. A video of another size needs its own `width` and
//    `height`, which give its frame on the page its shape.
// 2. Put the three files in public/media under the names below.
// 3. Set `enabled: true`, then check the page with and without reduced
//    motion.

export type DemoVideo = {
  enabled: boolean;
  // What the video shows, for screen readers.
  label: string;
  poster: string;
  sources: readonly { src: string; type: string }[];
  // The video's size in pixels.
  width: number;
  height: number;
};

const av1Type = 'video/mp4; codecs="av01.0.08M.08"';
const h264Type = "video/mp4";

function demoVideo(name: string, enabled: boolean, label: string): DemoVideo {
  return {
    enabled,
    label,
    poster: `/media/${name}-poster.webp`,
    // The browser plays the first source it supports: AV1, then H.264.
    sources: [
      { src: `/media/${name}-av1.mp4`, type: av1Type },
      { src: `/media/${name}-h264.mp4`, type: h264Type },
    ],
    width: 1680,
    height: 1050,
  };
}

// The hero's 16 s muted loop: three stories' previews side by side.
export const heroLoopVideo = demoVideo(
  "demo-loop",
  true,
  "Three agents work on three stories in Blame, each story's preview showing its own running copy of the app.",
);

// The full demo, about 35 s, played with the browser's controls.
export const fullDemoVideo = demoVideo(
  "demo-full",
  true,
  "Blame's full demo, from planning stories in the backlog to reviewing and merging them.",
);
