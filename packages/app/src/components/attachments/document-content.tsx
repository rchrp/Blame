import { useState } from "react"
import { usePlatform } from "@/context/platform"
import { MarkdownPreview } from "@/components/backlog/drawer/markdown-preview"
import type { DocumentPreview, PreviewSheet } from "./attachment-types"
import "./document-preview.css"

export function DocumentContent({
  data,
  thumbnail = false,
}: {
  data: DocumentPreview
  thumbnail?: boolean
}) {
  const platform = usePlatform()
  if (data.kind === "pdf")
    return <img alt="" src={data.thumbnail} className="h-auto w-full" />
  if (data.kind === "spreadsheet")
    return <SpreadsheetContent sheets={data.sheets} thumbnail={thumbnail} />
  if (data.kind === "html")
    return (
      <div
        className="attachment-document p-6 sm:p-10"
        dangerouslySetInnerHTML={{
          __html: thumbnail ? (data.thumbnailHtml ?? data.html) : data.html,
        }}
      />
    )
  if (data.kind === "markdown")
    return (
      <div
        className="attachment-document p-6 sm:p-10"
        onClickCapture={(event) => {
          const link = (event.target as HTMLElement).closest("a")
          if (!link) return
          event.preventDefault()
          event.stopPropagation()
          const href = link.getAttribute("href") ?? ""
          if (!/^https?:\/\//i.test(href)) return
          if (platform.openExternalLink) platform.openExternalLink(href)
          else window.open(href, "_blank", "noopener,noreferrer")
        }}
      >
        <MarkdownPreview
          markdown={thumbnail ? data.text.slice(0, 3000) : data.text}
          placeholder="Empty document"
        />
      </div>
    )
  return (
    <pre className="m-0 p-5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-slate-800 select-text">
      {thumbnail ? data.text.slice(0, 3000) : data.text || "Empty document"}
    </pre>
  )
}

function SpreadsheetContent({
  sheets,
  thumbnail,
}: {
  sheets: PreviewSheet[]
  thumbnail: boolean
}) {
  const [selected, setSelected] = useState(0)
  const sheet = sheets[selected] ?? sheets[0]
  const [page, setPage] = useState(0)
  const rows = sheet?.rows ?? []
  const columns = Math.max(1, ...rows.map((row) => row.length))
  const visible = thumbnail
    ? rows.slice(0, 12)
    : rows.slice(page * 100, (page + 1) * 100)
  return (
    <div className="flex min-h-full flex-col text-slate-800">
      {!thumbnail && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 text-sm">
          <label className="flex items-center gap-2">
            Sheet
            <select
              aria-label="Worksheet"
              className="max-w-48 rounded border border-slate-300 bg-white p-1.5 focus-visible:outline-2 focus-visible:outline-blue-600"
              value={selected}
              onChange={(event) => {
                setSelected(Number(event.target.value))
                setPage(0)
              }}
            >
              {sheets.map((item, index) => (
                <option key={index} value={index}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {rows.length > 100 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-40"
                disabled={page === 0}
                onClick={() => setPage((value) => value - 1)}
              >
                Previous rows
              </button>
              <span className="tabular-nums">
                {page * 100 + 1}–{Math.min((page + 1) * 100, rows.length)}
              </span>
              <button
                type="button"
                className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-40"
                disabled={(page + 1) * 100 >= rows.length}
                onClick={() => setPage((value) => value + 1)}
              >
                Next rows
              </button>
            </div>
          )}
        </div>
      )}
      <div className="overflow-auto">
        <table className="w-full border-collapse text-left text-xs tabular-nums">
          <thead>
            <tr>
              <th className="border border-slate-200 bg-slate-100 p-2" />
              {Array.from({ length: columns }, (_, index) => (
                <th
                  key={index}
                  scope="col"
                  className="min-w-24 border border-slate-200 bg-slate-100 px-3 py-2 font-medium"
                >
                  {columnName(index)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, index) => (
              <tr key={index}>
                <th
                  scope="row"
                  className="border border-slate-200 bg-slate-50 px-3 py-2 font-normal text-slate-500"
                >
                  {page * 100 + index + 1}
                </th>
                {Array.from({ length: columns }, (_, column) => (
                  <td
                    key={column}
                    className="max-w-80 min-w-24 border border-slate-200 px-3 py-2 break-words whitespace-pre-wrap select-text"
                  >
                    {row[column] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <p className="p-8 text-center text-sm text-slate-600">
            Empty worksheet
          </p>
        )}
      </div>
    </div>
  )
}

function columnName(index: number) {
  return index < 26
    ? String.fromCharCode(65 + index)
    : `A${String.fromCharCode(65 + index - 26)}`
}
