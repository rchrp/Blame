import assert from "node:assert/strict"
import test from "node:test"

import {
  isFiniteNumber,
  readUiMemory,
  recallForItem,
  rememberForItem,
  writeUiMemory,
} from "./ui-memory.ts"

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  }
}

test("reads back what was written and ignores invalid values", () => {
  const storage = memoryStorage()
  writeUiMemory("width", 720, storage)
  assert.equal(readUiMemory("width", isFiniteNumber, storage), 720)
  writeUiMemory("width", "wide", storage)
  assert.equal(readUiMemory("width", isFiniteNumber, storage), undefined)
})

test("survives broken JSON and a storage that throws", () => {
  const storage = memoryStorage()
  storage.values.set("blame.ui.width", "{")
  assert.equal(readUiMemory("width", isFiniteNumber, storage), undefined)
  const throwing = {
    getItem: () => {
      throw new Error("blocked")
    },
    setItem: () => {
      throw new Error("full")
    },
  }
  assert.doesNotThrow(() => writeUiMemory("width", 1, throwing))
  assert.equal(readUiMemory("width", isFiniteNumber, throwing), undefined)
})

test("keeps one value per item, most recent last, within the limit", () => {
  const storage = memoryStorage()
  for (const id of ["a", "b", "c"])
    rememberForItem("tabs", id, id.toUpperCase(), { limit: 2, storage })
  const isString = (value: unknown): value is string => typeof value === "string"
  assert.equal(recallForItem("tabs", "a", isString, storage), undefined)
  assert.equal(recallForItem("tabs", "c", isString, storage), "C")
  rememberForItem("tabs", "b", "B2", { limit: 2, storage })
  rememberForItem("tabs", "d", "D", { limit: 2, storage })
  assert.equal(recallForItem("tabs", "b", isString, storage), "B2")
  assert.equal(recallForItem("tabs", "c", isString, storage), undefined)
})
