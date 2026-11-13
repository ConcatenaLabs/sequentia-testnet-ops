import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Report, faucetToken } from './suite.mjs'

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

test('the faucet token: the file named, else the laptop\'s, else none (the box\'s own file is read only as a last resort)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'suite-token-'))
  try {
    const tok = 'x'.repeat(40)
    const named = join(dir, 'named.token'); writeFileSync(named, tok + '\n')
    assert.equal(faucetToken({ FAUCET_EXEMPT_TOKEN_FILE: named }, dir), tok)
    // A file named and absent: none, never another file.
    assert.equal(faucetToken({ FAUCET_EXEMPT_TOKEN_FILE: join(dir, 'absent') }, dir), null)
    mkdirSync(join(dir, '.config/sequentia'), { recursive: true })
    writeFileSync(join(dir, '.config/sequentia/faucet-exempt.token'), 'y'.repeat(40))
    assert.equal(faucetToken({}, dir), 'y'.repeat(40))
    // Too short to be the token.
    writeFileSync(named, 'short')
    assert.equal(faucetToken({ FAUCET_EXEMPT_TOKEN_FILE: named }, dir), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
