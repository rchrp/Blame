import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { createMDX } from "fumadocs-mdx/next";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import uploadedDemoMedia from "./lib/demo-media-manifest.json";
import {
  markdownPagePaths,
  markdownRoutePath,
  markdownUrlPath,
} from "./lib/markdown-paths";
import { publisherBuildEnvironment } from "./lib/publisher";

// The demo videos' public URLs in the media bucket, by file name.
const demoMediaUrls: Record<string, string> = uploadedDemoMedia;

const packageRoot = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(packageRoot, "../..");

// Files in public/ keep their names when they change, so Next.js serves them
// with max-age=0 and browsers ask for them again on every visit. A day of
// cache, then a week of stale-while-revalidate, lets a new version reach
// visitors within a day.
const publicAssetCacheControl =
  "public, max-age=86400, stale-while-revalidate=604800";
const publicAssetFolders = [
  "agents",
  "icons",
  "media",
  "research",
  "social",
  "story",
];

const nextConfig: NextConfig = {
  // The Docker image runs .next/standalone: the server and only the
  // node_modules files it uses, traced from the workspace root.
  output: "standalone",
  outputFileTracingRoot: workspaceRoot,
  poweredByHeader: false,
  // Workspace packages that ship TypeScript sources.
  transpilePackages: ["@blame/hero-scene", "@blame/pricing-card"],
  turbopack: {
    root: workspaceRoot,
  },
  // The plan page was /pricing until the plan became Blame Cloud: old links
  // and bookmarks keep working.
  async redirects() {
    return [
      { source: "/pricing", destination: "/cloud", permanent: true },
      { source: "/pricing.md", destination: "/cloud.md", permanent: true },
      // The demo videos moved to the media bucket (lib/demo-media.ts): links
      // to their old paths, like the README's, follow them there. A new
      // recording gets a new URL, so these redirects aren't permanent.
      ...Object.entries(demoMediaUrls).map(([name, url]) => ({
        source: `/media/${name}.mp4`,
        destination: url,
        permanent: false,
      })),
    ];
  },
  // Every page's Markdown version for AI agents: /cloud.md, /index.md,
  // and for the docs /docs.md, /docs/install.md...
  async rewrites() {
    return [
      ...markdownPagePaths.map((path) => ({
        source: markdownUrlPath(path),
        destination: markdownRoutePath(path),
      })),
      { source: "/docs.md", destination: "/md/docs" },
      { source: "/docs/:path*/:page.md", destination: "/md/docs/:path*/:page" },
    ];
  },
  async headers() {
    return [
      ...publicAssetFolders.map((folder) => `/${folder}/:path*`),
      "/favicon.ico",
    ].map((source) => ({
      source,
      headers: [{ key: "Cache-Control", value: publicAssetCacheControl }],
    }));
  },
};

// Fumadocs MDX compiles the docs (content/docs) and its defineDocs macro.
const withMDX = createMDX();

export default function vitrineConfig(phase: string) {
  return withMDX({
    ...nextConfig,
    // The publisher's legal details (lib/publisher.ts), inlined at build time.
    // A production build fails when one is missing.
    env: publisherBuildEnvironment({
      required: phase === PHASE_PRODUCTION_BUILD,
    }),
  });
}
