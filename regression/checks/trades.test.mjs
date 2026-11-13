// The trades surface keeps the trader's page open until nothing of its leaf wallet is moving: a
// refresh not done and not released, or a coin on its way.
//
//   node --test regression/checks/trades.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { btcPurchasesOpen, stillMoving, settledInTime, inTree, SETTLE_ROUND_MS, statedWaitMs, endWord, waitedInTime, TICKET_MS, OVERRUN,
  tabNeed, dexNeed, followedInTime, followedWords, BOUND_MS, arrivedWhole } from './trades.mjs'
import { lineNeed } from '../lib/holdings.mjs'

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

test('a purchase paid with BTC keeps the page open until its BTC is paid and its asset collected', () => {
  const recs = [
    { source: 'btc-gateway', dir: 'buy', state: 'waiting', preimage: false },
    { source: 'btc-gateway', dir: 'buy', state: 'sent', preimage: true, receiveState: 'claiming' },
    { source: 'btc-gateway', dir: 'buy', state: 'sent', preimage: true, receiveState: 'received' },
    { source: 'btc-gateway', dir: 'buy', state: 'settled', preimage: true, receiveState: 'received' },
    { source: 'btc-gateway', dir: 'buy', state: 'returned', preimage: false },
    { source: 'btc-gateway', dir: 'sell', state: 'sent' },
    { source: 'leaf-maker', state: 'sent' },
  ]
  assert.deepEqual(btcPurchasesOpen(recs), { unpaid: 1, unclaimed: 1 })
  assert.deepEqual(btcPurchasesOpen([]), { unpaid: 0, unclaimed: 0 })
  assert.deepEqual(btcPurchasesOpen(null), { unpaid: 0, unclaimed: 0 })
})

test('each line pays what it states: the Trade tab what is paid, SeqDEX a purchase by what it receives', () => {
  assert.deepEqual(tabNeed(['USDX-GOLD-BUY', 'USDX', 'GOLD', '5']), { id: 'WW-TRADE-USDX-GOLD-BUY', pay: 'USDX', get: 'GOLD', payAmount: '5' })
  assert.deepEqual(dexNeed(['USDX-GOLD-BUY', 'GOLD-USDX', 'buy', '0.001']), { id: 'DX-TRADE-USDX-GOLD-BUY', pay: 'USDX', get: 'GOLD', getAmount: '0.001' })
  assert.deepEqual(dexNeed(['TSEQ-USDX-SELL', 'tSEQ-USDX', 'sell', '20']), { id: 'DX-TRADE-TSEQ-USDX-SELL', pay: 'tSEQ', get: 'USDX', payAmount: '20' })
  // The BTC desk's pair is shown USDX-BTC: selling USDX buys BTC, from the trader's own USDX.
  assert.deepEqual(lineNeed(dexNeed(['BTC-USDX-BUY', 'USDX-BTC', 'sell', '10'])), { id: 'DX-TRADE-BTC-USDX-BUY', pay: 'USDX', atoms: 1000000000n, from: 'held', how: '10 USDX' })
  // Buying USDX pays BTC, which the purchase before it bought.
  const n = lineNeed(dexNeed(['BTC-USDX-SELL', 'USDX-BTC', 'buy', '10']), { USDX: { price: 1 }, tBTC: { price: 80000 } })
  assert.equal(n.pay, 'BTC'); assert.equal(n.from, 'bought'); assert.equal(n.atoms, 15625n)
})

test('a firm trade the site calls under way is judged on the time it takes to its end in the Trade tab', () => {
  assert.equal(followedInTime({ end: 'done', endedMs: 40_000, word: 'Settled' }, BOUND_MS), true)
  assert.equal(followedInTime({ end: 'done', endedMs: 70_000, word: 'Settled' }, BOUND_MS), false)
  assert.equal(followedInTime({ end: 'returned', endedMs: 10_000, word: 'Returned: nothing traded.' }, BOUND_MS), false)
  assert.equal(followedInTime({ end: null, endedMs: null, word: 'Received, settling' }, BOUND_MS), false)
  assert.equal(followedWords({ end: 'done', endedMs: 70_000, word: 'Settled' }, BOUND_MS), 'in the wallet\'s Trade tab it reads "Settled" after 70.0 s, past the 60.0 s')
  assert.equal(followedWords({ end: 'done', endedMs: 12_300, word: 'Settled' }, BOUND_MS), 'in the wallet\'s Trade tab it reads "Settled" after 12.3 s, within the 60.0 s')
  assert.equal(followedWords({ end: 'returned', endedMs: 9_000, word: 'Returned' }, BOUND_MS), 'in the wallet\'s Trade tab it reads "Returned" after 9.0 s: nothing traded')
  assert.equal(followedWords({ end: null, endedMs: null, word: 'Received, settling' }, BOUND_MS), `in the wallet's Trade tab it still reads "Received, settling" ${(OVERRUN * 60).toFixed(1)} s after approval, past the 60.0 s`)
})

test('a faucet payment has arrived once the figure rose by it, less the fee of moving it in', () => {
  // 500,000 USDX paid to the address, moved in for 39 atoms (seen live 2026-11-13).
  assert.equal(arrivedWhole(49999999999961n, 50000000000000n), true)
  assert.equal(arrivedWhole(25000000000000n, 50000000000000n), false)
  assert.equal(arrivedWhole(0n, 50000000000000n), false)
  assert.equal(arrivedWhole(5n, null), true)
})
