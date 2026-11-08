// Uploads the home page's demo videos to the vitrine's public media bucket
// (OVH Object Storage), then writes lib/demo-media-manifest.json: the public
// URLs that lib/demo-media.ts plays.
//
//   pnpm upload:demo-media             upload what's missing, write the manifest
//   pnpm upload:demo-media --dry-run   print what it would do, change nothing
//
// The MP4s come from media-source/, the bucket settings from .env.media or
// the environment (see .env.media.example). Both are gitignored. Only this
// script needs credentials: the site just links to the files' public URLs.
//
// Each key carries the first 8 hex digits of its file's SHA-256, so a new
// recording gets a new URL and the year-long immutable cache never serves a
// stale file. A key already in the bucket isn't uploaded again. The manifest
// is written only once every URL answers anonymously with the right type and
// with byte ranges (Safari needs them), so the site never links to a file it
// can't play.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HeadObjectCommand,
  PutObjectAclCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceFolder = join(packageRoot, "media-source");
const envFile = join(packageRoot, ".env.media");
const manifestFile = join(packageRoot, "lib/demo-media-manifest.json");

// The files lib/demo-media.ts plays: each video in AV1, then in H.264.
const names = [
  "demo-loop-av1",
  "demo-loop-h264",
  "demo-full-av1",
  "demo-full-h264",
];

const contentType = "video/mp4";
const cacheControl = "public, max-age=31536000, immutable";
const usage = "Usage: pnpm upload:demo-media [--dry-run]";

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const unknown = args.filter((arg) => arg !== "--dry-run");
  if (unknown.length > 0) {
    throw new Error(`Unknown argument: ${unknown.join(" ")}\n${usage}`);
  }
  const dryRun = args.includes("--dry-run");

  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const bucket = readSettings({ credentials: !dryRun });
  const videos = await readVideos(bucket);

  console.log(
    `${dryRun ? "Dry run: nothing is uploaded or written.\n" : ""}` +
      `Bucket ${bucket.name} at ${bucket.endpoint} (${bucket.region})\n`,
  );

  // Without credentials, a dry run can't ask the bucket what it holds.
  const client = bucket.credentials ? s3Client(bucket) : undefined;
  for (const video of videos) {
    video.stored = client ? await storedSize(client, bucket, video) : undefined;
  }

  if (dryRun) {
    for (const video of videos) {
      const state = !client
        ? "would upload, unless already there (no credentials to check)"
        : video.stored
          ? "already there, skipped"
          : "would upload";
      printVideo(video, state);
    }
    const manifest = manifestFor(videos);
    const unchanged = (await currentManifest()) === manifest;
    console.log(
      `\nlib/demo-media-manifest.json ${unchanged ? "stays as it is" : "would become"}:\n${manifest}`,
    );
    return;
  }

  for (const video of videos) {
    if (!video.stored) await upload(client, bucket, video);
    printVideo(video, video.stored ? "already there, skipped" : "uploaded");
  }

  console.log("\nChecking the public URLs without credentials...");
  const failures = [];
  for (const video of videos) {
    let problems = await publicProblems(video);
    // A file without the public-read ACL, if the bucket dropped it or the
    // file was put there by hand: give it one.
    if (problems.some((problem) => problem.startsWith("403"))) {
      await client.send(
        new PutObjectAclCommand({
          Bucket: bucket.name,
          Key: video.key,
          ACL: "public-read",
        }),
      );
      problems = await publicProblems(video);
    }
    if (problems.length === 0) console.log(`  ok  ${video.url}`);
    else failures.push(`${video.url}\n    ${problems.join("\n    ")}`);
  }
  if (failures.length > 0) {
    throw new Error(
      `These files can't be played from the site yet, so the manifest is unchanged:\n  ${failures.join("\n  ")}`,
    );
  }

  const manifest = manifestFor(videos);
  if ((await currentManifest()) === manifest) {
    console.log("\nlib/demo-media-manifest.json is already up to date.");
    return;
  }
  await writeFile(manifestFile, manifest);
  console.log(
    "\nWrote lib/demo-media-manifest.json. Commit it, and set `enabled: true` in lib/demo-media.ts for a video that is still off.",
  );
}

// The bucket settings. A dry run can do without the credentials.
function readSettings({ credentials }) {
  const setting = (name) => process.env[`VITRINE_MEDIA_S3_${name}`]?.trim() ?? "";
  const needed = ["ENDPOINT", "REGION", "BUCKET"];
  const keys = ["ACCESS_KEY_ID", "SECRET_ACCESS_KEY"];
  const missing = [...needed, ...(credentials ? keys : [])].filter(
    (name) => !setting(name),
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.map((name) => `VITRINE_MEDIA_S3_${name}`).join(", ")}.\n` +
        "Put them in packages/vitrine/.env.media (gitignored): see .env.media.example.",
    );
  }

  const endpoint = setting("ENDPOINT").replace(/\/+$/, "");
  if (!endpoint.startsWith("https://")) {
    throw new Error(
      "VITRINE_MEDIA_S3_ENDPOINT must be an https:// URL: the site, served over HTTPS, can't play videos from plain HTTP.",
    );
  }
  const pathStyle = setting("FORCE_PATH_STYLE").toLowerCase();
  if (!["", "true", "false"].includes(pathStyle)) {
    throw new Error("VITRINE_MEDIA_S3_FORCE_PATH_STYLE must be true or false.");
  }
  const name = setting("BUCKET");
  // A bucket in the host name must be a valid DNS label, without dots, which
  // the endpoint's wildcard certificate wouldn't cover.
  if (pathStyle !== "true" && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) {
    throw new Error(
      `The bucket name ${name} can't go in a host name (lowercase letters, digits and hyphens only). Rename the bucket or set VITRINE_MEDIA_S3_FORCE_PATH_STYLE=true.`,
    );
  }

  return {
    credentials: keys.every((key) => setting(key))
      ? {
          accessKeyId: setting("ACCESS_KEY_ID"),
          secretAccessKey: setting("SECRET_ACCESS_KEY"),
        }
      : undefined,
    endpoint,
    forcePathStyle: pathStyle === "true",
    name,
    region: setting("REGION"),
  };
}

async function readVideos(bucket) {
  const paths = names.map((name) => join(sourceFolder, `${name}.mp4`));
  const missing = names.filter((_, index) => !existsSync(paths[index]));
  if (missing.length > 0) {
    throw new Error(
      `Missing from packages/vitrine/media-source/: ${missing.map((name) => `${name}.mp4`).join(", ")}.`,
    );
  }
  return Promise.all(
    names.map(async (name, index) => {
      const body = await readFile(paths[index]);
      const hash = createHash("sha256").update(body).digest("hex").slice(0, 8);
      const key = `demo/${name}.${hash}.mp4`;
      return { body, key, name, stored: undefined, url: publicUrl(bucket, key) };
    }),
  );
}

// Virtual-hosted (https://<bucket>.<endpoint host>/<key>) unless the bucket
// is set to path style (https://<endpoint host>/<bucket>/<key>).
function publicUrl(bucket, key) {
  const url = new URL(bucket.endpoint);
  if (bucket.forcePathStyle) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${bucket.name}/${key}`;
  } else {
    url.hostname = `${bucket.name}.${url.hostname}`;
    url.pathname = `/${key}`;
  }
  return url.href;
}

function s3Client(bucket) {
  return new S3Client({
    credentials: bucket.credentials,
    endpoint: bucket.endpoint,
    forcePathStyle: bucket.forcePathStyle,
    region: bucket.region,
    // Like the API's client: OVH doesn't take the SDK's default checksums.
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
}

// The size of the object already at the video's key, or undefined if none.
async function storedSize(client, bucket, video) {
  try {
    const head = await client.send(
      new HeadObjectCommand({ Bucket: bucket.name, Key: video.key }),
    );
    if (head.ContentLength !== video.body.length) {
      throw new Error(
        `${video.key} is already in the bucket with another size (${head.ContentLength} bytes, not ${video.body.length}). Delete it in the OVH console, then run again.`,
      );
    }
    return head.ContentLength;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404) return undefined;
    throw error;
  }
}

async function upload(client, bucket, video) {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket.name,
      Key: video.key,
      Body: video.body,
      ContentType: contentType,
      CacheControl: cacheControl,
      // OVH has no bucket policies yet: each object is made public itself.
      ACL: "public-read",
    }),
  );
}

// What keeps a browser from playing the file from its public URL, if anything.
async function publicProblems(video) {
  const response = await fetch(video.url, { headers: { Range: "bytes=0-1" } });
  await response.body?.cancel();
  const problems = [];
  const range = response.headers.get("content-range");
  if (response.status !== 206) {
    problems.push(
      response.status === 403
        ? "403: not public (its public-read ACL is missing)"
        : `answers ${response.status} to a byte-range request, not 206`,
    );
  } else if (range !== `bytes 0-1/${video.body.length}`) {
    problems.push(`Content-Range is ${range}, not bytes 0-1/${video.body.length}`);
  }
  if (response.status < 400) {
    const type = response.headers.get("content-type");
    if (type !== contentType) problems.push(`Content-Type is ${type}, not ${contentType}`);
    const cache = response.headers.get("cache-control");
    if (cache !== cacheControl) problems.push(`Cache-Control is ${cache}, not ${cacheControl}`);
  }
  return problems;
}

function manifestFor(videos) {
  const urls = Object.fromEntries(videos.map((video) => [video.name, video.url]));
  return `${JSON.stringify(urls, null, 2)}\n`;
}

async function currentManifest() {
  return existsSync(manifestFile) ? readFile(manifestFile, "utf8") : undefined;
}

function printVideo(video, state) {
  const size = `${(video.body.length / 1e6).toFixed(1)} MB`;
  console.log(`  ${video.name.padEnd(15)} ${size.padStart(7)}  ${video.key.padEnd(33)}  ${state}`);
}

main().catch((error) => {
  // The name and message only: never the request, which holds the signature.
  const status = error?.$metadata?.httpStatusCode;
  const hint =
    status === 403
      ? "\nThe bucket refused the request: check the S3 user's keys and its policy (see .env.media.example)."
      : "";
  console.error(`${error?.name ?? "Error"}: ${error?.message ?? error}${hint}`);
  process.exitCode = 1;
});
