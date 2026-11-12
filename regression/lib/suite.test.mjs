import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Report } from './suite.mjs'

test('the summary prints each count with the lines it counts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'suite-test-'))
  try {
    const r = new Report(dir)
    const log = console.log
    console.log = () => {}
    try {
      r.record('A', 'desktop', 'PASS', 'line a', 'ok')
      r.tally('Trades that waited for a round (an indicative ticket)', 'A')
      r.tally('Trades priced firm', 'B')
      r.tally('Trades priced firm', 'C')
      r.summary()
    } finally { console.log = log }
    const out = readFileSync(join(dir, 'results.txt'), 'utf8')
    assert.match(out, /Trades that waited for a round \(an indicative ticket\): 1 \(A\)/)
    assert.match(out, /Trades priced firm: 2 \(B C\)/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
