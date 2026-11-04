import { codeExcerpt } from "@/components/backlog/shared/excerpt-model"
import {
  nodeElement,
  type TextSelection,
} from "@/components/backlog/shared/selection-excerpt-actions"

// Pierre renders files and diffs inside the open shadow root of this element.
export const pierreShadowHostSelector = "diffs-container"

const lineSelector = "[data-line]"

// Lines carry their number in the file in data-line.
export function selectedCodeExcerpt(
  path: string,
  { range, text }: TextSelection
) {
  return codeExcerpt({ lineNumbers: selectedLineNumbers(range), path, text })
}

function selectedLineNumbers(range: Range) {
  const common = nodeElement(range.commonAncestorContainer)
  if (!common) return []
  const enclosingLine = common.closest(lineSelector)
  if (enclosingLine) return [lineNumber(enclosingLine)]
  return Array.from(common.querySelectorAll(lineSelector))
    .filter((line) => range.intersectsNode(line) && selectedTextIn(range, line))
    .map(lineNumber)
}

// The part of the selection inside one line: empty when the selection only
// touches its edge, as a triple click does with the next line.
function selectedTextIn(range: Range, line: Element) {
  const lineRange = line.ownerDocument.createRange()
  lineRange.selectNodeContents(line)
  if (range.compareBoundaryPoints(Range.START_TO_START, lineRange) > 0) {
    lineRange.setStart(range.startContainer, range.startOffset)
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, lineRange) < 0) {
    lineRange.setEnd(range.endContainer, range.endOffset)
  }
  return lineRange.toString()
}

function lineNumber(line: Element) {
  return Number(line.getAttribute("data-line"))
}
