// Reasoning summaries stream in parts (often "**Title**\n\nBody"), and the
// parts arrive back to back with nothing between them: "…the file.**Next
// step**I will…". Put the missing breaks back, leaving code untouched.

// A bold title: no space just inside its asterisks, unlike "** and **".
const title = String.raw`\*\*(?=\S)[^*\n]{1,80}(?<=\S)\*\*`
const gluedTitle = new RegExp(String.raw`([\w.!?:)])(${title})`, "g")
const titleGluedToText = new RegExp(String.raw`^(${title})(?=[A-Z])`, "gm")
const gluedSentence = /([a-z0-9)][.!?])([A-Z][a-z])/g

export function readableReasoning(text: string) {
  return splitOutside(text, /```[\s\S]*?(?:```|$)/g, (prose) =>
    splitOutside(prose, /`[^`\n]*`/g, fixGluedParts)
  )
}

function fixGluedParts(text: string) {
  return text
    .replace(gluedTitle, "$1\n\n$2")
    .replace(titleGluedToText, "$1\n\n")
    .replace(gluedSentence, "$1 $2")
}

function splitOutside(
  text: string,
  skipped: RegExp,
  transform: (text: string) => string
) {
  let result = ""
  let index = 0
  for (const match of text.matchAll(skipped)) {
    result += transform(text.slice(index, match.index)) + match[0]
    index = match.index + match[0].length
  }
  return result + transform(text.slice(index))
}
