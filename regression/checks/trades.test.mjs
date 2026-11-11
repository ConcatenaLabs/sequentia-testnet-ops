// The trades surface keeps the trader's page open until nothing of its leaf wallet is moving: a
// refresh not done and not released, or a coin on its way.
//
//   node --test regression/checks/trades.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { stillMoving, settledInTime, inTree, SETTLE_ROUND_MS } from './trades.mjs'

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
