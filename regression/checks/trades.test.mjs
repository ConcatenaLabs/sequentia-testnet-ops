// The trades surface keeps the trader's page open until nothing of its leaf wallet is moving: a
// refresh not done and not released, or a coin on its way.
//
//   node --test regression/checks/trades.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { stillMoving, settledInTime, inTree, SETTLE_ROUND_MS, statedWaitMs, endWord, waitedInTime, TICKET_MS, OVERRUN } from './trades.mjs'

test('a refresh not done, or a coin moving, keeps the page open', () => {
  assert.deepEqual(stillMoving({ participations: [{ participation: '8e671547088b0000', state: 'pending' }], coins: [{ state: 'live' }] }),
    { participations: ['8e671547088b pending'], coins: 0 })
  assert.deepEqual(stillMoving({ participations: [], coins: [{ state: 'forfeited' }, { state: 'live' }, { state: 'sending' }] }),
    { participations: [], coins: 2 })
})

test('done or released refreshes and live coins let it close', () => {
  const left = stillMoving({ participations: [{ participation: 'a', state: 'released' }, { participation: 'b', state: 'void' },
    { participation: 'c', state: 'forfeiting', released: true }], coins: [{ state: 'live' }, { state: 'spent' }] })
  assert.deepEqual(left, { participations: [], coins: 0 })
})

test('a page whose leaf wallet cannot be read says so', () => {
  assert.equal(stillMoving(null), null)
  assert.deepEqual(stillMoving({}), { participations: [], coins: 0 })
})

test('a trade in the tree is done once it reads Settled; Received alone is a round still to wait for', () => {
  assert.equal(inTree('USDX', 'GOLD'), true)
  assert.equal(inTree('USDX', 'BTC'), false)
  assert.equal(inTree('BTC', 'USDX'), false)
  // Settled within the bound: done.
  assert.deepEqual(settledInTime('USDX', 'GOLD', 'Settled', null), { ok: true, word: 'Settled' })
  // Received, then Settled within SETTLE_ROUND_MS: done.
  assert.deepEqual(settledInTime('USDX', 'GOLD', 'Received, settling', 'Settled'), { ok: true, word: 'Settled' })
  // Received and still settling after SETTLE_ROUND_MS: not done (it passed before this check).
  assert.deepEqual(settledInTime('USDX', 'GOLD', 'Received, settling', 'Received, settling (2 min)'), { ok: false, word: 'Received, settling (2 min)' })
  assert.deepEqual(settledInTime('USDX', 'GOLD', 'Received, settling', null), { ok: false, word: 'Received, settling' })
  // A trade with BTC keeps its bound on Received: the Bitcoin side settles on its own terms.
  assert.deepEqual(settledInTime('USDX', 'BTC', 'Received, settling', null), { ok: true, word: 'Received, settling' })
  // Returned or nothing: not done.
  assert.equal(settledInTime('USDX', 'GOLD', 'Returned: nothing traded.', null).ok, false)
  assert.equal(settledInTime('USDX', 'GOLD', null, null).ok, false)
  assert.equal(SETTLE_ROUND_MS, 150000)
})

test('an indicative ticket is told from a firm one by the wait it states, in the wallet\'s words', () => {
  assert.equal(statedWaitMs('Goes through within about 6 minutes'), 360_000)
  assert.equal(statedWaitMs('20 tSEQ → 3.45 USDX Goes through within about 12 minutes'), 720_000)
  assert.equal(statedWaitMs('Goes through in about a minute'), 60_000)
  // A firm ticket names no wait.
  assert.equal(statedWaitMs('You pay 20 tSEQ You receive 3.45 USDX Fees 0.0001 tSEQ'), null)
  assert.equal(statedWaitMs(''), null)
  assert.equal(statedWaitMs(null), null)
})

test('a trade that waited is done at Settled in the tree, at Received with BTC, and never at Returned', () => {
  assert.equal(endWord('tSEQ', 'USDX', 'Settled'), 'done')
  assert.equal(endWord('tSEQ', 'USDX', 'Received, settling'), null)
  assert.equal(endWord('BTC', 'USDX', 'Received, settling (2 min)'), 'done')
  assert.equal(endWord('USDX', 'BTC', 'Settled'), 'done')
  assert.equal(endWord('tSEQ', 'USDX', 'Returned: nothing traded.'), 'returned')
  assert.equal(endWord('tSEQ', 'USDX', 'Goes through within about 6 minutes'), null)
})

test('a trade that waited passes only with its ticket within the bar and its end within the wait stated', () => {
  const stated = 360_000
  assert.equal(waitedInTime({ ticketMs: 2_500, statedMs: stated, endedMs: 300_000, end: 'done' }), true)
  // The ticket's bar is the firm ticket's: never loosened for a trade that waits.
  assert.equal(waitedInTime({ ticketMs: TICKET_MS + 1, statedMs: stated, endedMs: 300_000, end: 'done' }), false)
  // Past the wait it stated: fails, with the time it ended.
  assert.equal(waitedInTime({ ticketMs: 2_500, statedMs: stated, endedMs: 400_000, end: 'done' }), false)
  // Came back, or not ended when the watch stopped.
  assert.equal(waitedInTime({ ticketMs: 2_500, statedMs: stated, endedMs: 200_000, end: 'returned' }), false)
  assert.equal(waitedInTime({ ticketMs: 2_500, statedMs: stated, endedMs: null, end: null }), false)
  assert.ok(OVERRUN >= 2, 'watched long enough past the stated wait to say when it ended')
})
