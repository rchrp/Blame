// Turns a release's notes, as GitHub writes them, into the Markdown the app's
// renderer reads, and picks the picture shown at the top of What's new.

const releasesRepository = "rchrp/Blame"

export type ReleaseNotesImage = { alt: string; url: string }

export type ReleaseNotesView = {
  body: string
  cover?: ReleaseNotesImage
}

const htmlComment = /<!--[\s\S]*?-->/g
const markdownImage =
  /!\[([^\]\n]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"\n]*")?\s*\)/g
const htmlImage = /<img\b[^>]*>/gi
// Inline code and existing links keep their text as written.
const protectedSpan = /(`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\))/
const bareUrl = /(^|[\s(])(https?:\/\/[^\s<>]+)/g
const mention =
  /(^|\s)@([A-Za-z\d](?:[A-Za-z\d-]{0,37}[A-Za-z\d])?)(?=$|[\s.,;:!?)])/g
const trailingPunctuation = /[.,;:!?'"*_]+$/

export function releaseNotesView(markdown: string): ReleaseNotesView {
  let cover: ReleaseNotesImage | undefined
  let fenced = false
  const lines = markdown
    .replace(/\r\n?/g, "\n")
    .replace(htmlComment, "")
    .split("\n")
    .map((line) => {
      if (line.startsWith("```")) {
        fenced = !fenced
        return line
      }
      if (fenced) return line
      const text = replaceImages(line, (image) => {
        if (cover || !isReleaseAssetUrl(image.url))
          return `[${image.alt || "Image"}](${image.url})`
        cover = image
        return ""
      })
      // GitHub lists with `*`; the renderer reads `-` lists.
      return linkText(text.replace(/^(\s*)[*+]\s+/, "$1- ")).trimEnd()
    })
  const body = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return cover ? { body, cover } : { body }
}

/**
 * Images load only from the release's own downloads, where the updater
 * already downloads from: any other address would contact a new host.
 */
export function isReleaseAssetUrl(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    return false
  if (url.hostname === "download.blame.so") return true
  return (
    url.hostname === "github.com" &&
    url.pathname.startsWith(`/${releasesRepository}/releases/download/`)
  )
}

export function releasePageUrl(version: string) {
  return `https://github.com/${releasesRepository}/releases/tag/v${version}`
}

function replaceImages(
  line: string,
  replace: (image: ReleaseNotesImage) => string
) {
  return line
    .replace(markdownImage, (_image, alt: string, url: string) =>
      replace({ alt: alt.trim(), url })
    )
    .replace(htmlImage, (tag) => {
      const url = htmlAttribute(tag, "src")
      if (!url) return ""
      return replace({ alt: htmlAttribute(tag, "alt")?.trim() ?? "", url })
    })
}

function htmlAttribute(tag: string, name: string) {
  return tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1]
}

function linkText(line: string) {
  return line
    .split(protectedSpan)
    .map((part, index) => (index % 2 ? part : linkMentions(linkUrls(part))))
    .join("")
}

function linkUrls(text: string) {
  return text.replace(bareUrl, (match, before: string, candidate: string) => {
    const url = trimUrl(candidate)
    if (!/^https?:\/\/[^/]/.test(url)) return match
    return `${before}[${urlLabel(url)}](${url})${candidate.slice(url.length)}`
  })
}

// Keeps the sentence's punctuation, and a closing parenthesis it opened, out
// of the link.
function trimUrl(candidate: string) {
  let url = candidate.replace(trailingPunctuation, "")
  while (url.endsWith(")") && count(url, ")") > count(url, "("))
    url = url.slice(0, -1).replace(trailingPunctuation, "")
  return url
}

function count(value: string, character: string) {
  return value.split(character).length - 1
}

function urlLabel(url: string) {
  const reference = url.match(
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:pull|issues)\/(\d+)$/
  )
  if (reference) return `#${reference[1]}`
  const comparison = url.match(
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/compare\/([^/?#]+)$/
  )
  if (comparison) return comparison[1]!
  return url.replace(/^https?:\/\//, "").replace(/[[\]]/g, "")
}

function linkMentions(text: string) {
  return text.replace(
    mention,
    (_mention, before: string, login: string) =>
      `${before}[@${login}](https://github.com/${login})`
  )
}
