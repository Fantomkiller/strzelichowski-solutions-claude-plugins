import { test, expect } from 'claude-code/testing'

import { colorOf, contextScore, limitScore } from '../hooks/scale'

const H = 3_600_000
// Within a hundredth (or the given tolerance) of the expected value.
const near = (actual: number, expected: number, tolerance = 0.01) => Math.abs(actual - expected) <= tolerance
const at = (now: number, ms: number) => new Date(now + ms).toISOString()

test('the scale runs green, yellow, orange, red', () => {
  expect(colorOf(0)).toMatch(/^#[0-9a-f]{6}$/)
  const [r0, g0] = [parseInt(colorOf(0).slice(1, 3), 16), parseInt(colorOf(0).slice(3, 5), 16)]
  const [r1, g1] = [parseInt(colorOf(1).slice(1, 3), 16), parseInt(colorOf(1).slice(3, 5), 16)]
  expect(g0).toBeGreaterThan(r0) // green
  expect(r1).toBeGreaterThan(g1) // red
  const [r5, g5] = [parseInt(colorOf(0.5).slice(1, 3), 16), parseInt(colorOf(0.5).slice(3, 5), 16)]
  expect(Math.abs(r5 - g5)).toBeLessThan(10) // yellow in the middle
})

test('the context warms from half the reminder threshold to the compaction one', () => {
  expect(contextScore(20, 60, 65)).toBe(0)
  expect(near(contextScore(45, 60, 65), 15 / 35)).toBe(true)
  expect(contextScore(65, 60, 65)).toBe(1)
})

test('a limit used faster than its window warms and says when it runs out', () => {
  const now = 0
  // The screenshot's case: 54% of 5 hours with 3h33m left.
  const fast = limitScore('five_hour', 54, at(now, 3 * H + 33 * 60_000), now)
  expect(fast.score).toBeGreaterThan(0.85)
  expect(fast.score).toBeLessThan(1) // pace alone never reaches red
  expect(near((fast.limitInMs ?? 0) / 60_000, 74, 1)).toBe(true)
  // 66% of the week with 2d5h left: about on pace, warm from its own usage.
  const week = limitScore('seven_day', 66, at(now, 53 * H), now)
  expect(near(week.score, (66 - 30) / 65)).toBe(true)
  expect(week.limitInMs).toBeUndefined()
})

test('early in a window the pace is not read', () => {
  expect(limitScore('five_hour', 8, at(0, 4.8 * H), 0)).toEqual({ score: 0 })
})
