import assert from "node:assert/strict"
import test from "node:test"

import {
  isReleaseAssetUrl,
  releaseNotesView,
  releasePageUrl,
} from "./release-notes.ts"

const asset = "https://github.com/rchrp/Blame/releases/download/v1.3.0"

test("turns GitHub's generated notes into the app's Markdown", () => {
  const notes = [
    "<!-- Release notes generated using configuration in .github/release.yml at main -->",
    "",
    "## What's Changed",
    "* Show the release notes after an update by @octocat in https://github.com/rchrp/Blame/pull/40",
    "* Fix the beta channel (https://github.com/rchrp/Blame/issues/41).",
    "",
    "",
    "",
    "**Full Changelog**: https://github.com/rchrp/Blame/compare/v1.2.0...v1.3.0",
  ].join("\r\n")

  assert.deepEqual(releaseNotesView(notes), {
    body: [
      "## What's Changed",
      "- Show the release notes after an update by [@octocat](https://github.com/octocat) in [#40](https://github.com/rchrp/Blame/pull/40)",
      "- Fix the beta channel ([#41](https://github.com/rchrp/Blame/issues/41)).",
      "",
      "**Full Changelog**: [v1.2.0...v1.3.0](https://github.com/rchrp/Blame/compare/v1.2.0...v1.3.0)",
    ].join("\n"),
  })
})

test("takes the first image from the release's assets as the cover", () => {
  const notes = [
    `![Agents at work](${asset}/whats-new.gif)`,
    "",
    "## Highlights",
    "- Faster previews",
    "![Elsewhere](https://example.com/a.png)",
    `<img width="800" alt="Second" src="${asset}/b.png" />`,
  ].join("\n")

  assert.deepEqual(releaseNotesView(notes), {
    body: [
      "## Highlights",
      "- Faster previews",
      "[Elsewhere](https://example.com/a.png)",
      `[Second](${asset}/b.png)`,
    ].join("\n"),
    cover: { alt: "Agents at work", url: `${asset}/whats-new.gif` },
  })
})

test("never loads an image from another host", () => {
  assert.deepEqual(
    releaseNotesView(
      '<img src="https://github.com/user-attachments/assets/1234">\n![](https://example.com/x.gif)'
    ),
    {
      body: "[Image](https://github.com/user-attachments/assets/1234)\n[Image](https://example.com/x.gif)",
    }
  )
})

test("leaves code and existing links alone", () => {
  const notes = [
    "See [the docs](https://blame.so/docs) and `https://example.com @someone`.",
    "```",
    "* not a list https://example.com",
    "```",
  ].join("\n")
  assert.deepEqual(releaseNotesView(notes), { body: notes })
})

test("accepts images only from the release's own downloads", () => {
  assert.equal(isReleaseAssetUrl(`${asset}/a.gif`), true)
  assert.equal(
    isReleaseAssetUrl("https://download.blame.so/latest/a.gif"),
    true
  )
  assert.equal(
    isReleaseAssetUrl(`${asset.replace("https", "http")}/a.gif`),
    false
  )
  assert.equal(
    isReleaseAssetUrl(`${asset}/../../../../user-attachments/a`),
    false
  )
  assert.equal(
    isReleaseAssetUrl("https://download.blame.so.example.com/a.gif"),
    false
  )
  assert.equal(
    isReleaseAssetUrl("https://github.com/user-attachments/assets/1"),
    false
  )
  assert.equal(isReleaseAssetUrl("not a url"), false)
})

test("links each version to its GitHub release", () => {
  assert.equal(
    releasePageUrl("1.3.0-beta.1"),
    "https://github.com/rchrp/Blame/releases/tag/v1.3.0-beta.1"
  )
})
