import assert from "node:assert/strict"
import { test } from "node:test"
import { attachmentFormat, hasDocumentPreview } from "./attachment-format.ts"

test("recognizes document formats without browser MIME metadata", () => {
  for (const [name, expected] of [
    ["Report.PDF", "pdf"],
    ["notes.docx", "word"],
    ["budget.XLSX", "spreadsheet"],
    ["data.tsv", "csv"],
    ["README.md", "markdown"],
    ["paper.tex", "latex"],
    ["recording.m4a", "audio"],
  ]) {
    assert.equal(attachmentFormat({ name, type: "" }), expected)
  }
  assert.equal(
    attachmentFormat({ name: "download", type: "application/pdf" }),
    "pdf"
  )
})

test("does not parse legacy binary documents, audio or executables as text", () => {
  for (const name of [
    "legacy.doc",
    "legacy.xls",
    "slides.ppt",
    "file.exe",
    "recording.wav",
  ]) {
    assert.equal(hasDocumentPreview({ name, type: "" }), false)
  }
  assert.equal(
    hasDocumentPreview(
      { name: "legacy.doc", type: "" },
      "Existing extracted content"
    ),
    true
  )
  assert.equal(
    hasDocumentPreview(
      { name: "recording.wav", type: "audio/wav" },
      "Transcript"
    ),
    false
  )
  assert.equal(
    hasDocumentPreview({ name: "document.html", type: "text/html" }),
    true
  )
})
