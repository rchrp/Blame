import assert from "node:assert/strict"
import test from "node:test"

import {
  budgetDollars,
  budgetMicroUsd,
  epicModelRange,
  epicTitleFromGoal,
  formatMicroUsd,
} from "./epic-data.ts"

test("an epic's title is the goal's first line, without markdown marks", () => {
  assert.equal(
    epicTitleFromGoal("\n## Add dark mode\nEverywhere"),
    "Add dark mode"
  )
  assert.equal(epicTitleFromGoal("- Ship the export\n"), "Ship the export")
  const long = epicTitleFromGoal(
    "Rework the billing page so that every plan shows its price, its limits and the date of the next invoice"
  )
  assert.ok(long.length <= 81)
  assert.ok(long.endsWith("…"))
  assert.ok(!long.includes("invoice"))
})

test("a budget is typed in dollars and kept in micro-dollars", () => {
  assert.equal(budgetMicroUsd("20"), 20_000_000)
  assert.equal(budgetMicroUsd("$1,250.5"), 1_250_500_000)
  assert.equal(budgetMicroUsd(""), undefined)
  assert.equal(budgetMicroUsd("0"), undefined)
  assert.equal(budgetMicroUsd("ten"), undefined)
  assert.equal(budgetDollars(12_345_678), "12.35")
  assert.equal(budgetDollars(undefined), "")
  assert.equal(formatMicroUsd(3_200_000), "$3.20")
})

test("the model range defaults to the whole scale and is kept in order", () => {
  assert.deepEqual(epicModelRange({}), { min: 0, max: 1 })
  assert.deepEqual(epicModelRange({ modelRange: { min: 0.8, max: 0.2 } }), {
    min: 0.2,
    max: 0.8,
  })
})
