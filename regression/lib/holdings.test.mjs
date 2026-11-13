// What the trader holds, in words, and what the trade lines need of it.
//
//   node --test regression/lib/holdings.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { atomsOf, units, holdingsOf, holdingWords, holdingsLines, usable, whereWords, lineNeed, heldNeeds, fundedVerdict, priceOf,
  faucetSent, faucetButton, noRowWords, chooserListsHeld, PRICE_MARGIN } from './holdings.mjs'

const USDX = '2a515539da5e6a60caa7766ecd65bac0c10d15717ddd2088844ba58f4d04b9de'
const GOLD = '3a0f9192219db59f8d7f87d93ac6311095dfe1255d149727b87baaa7d2cc71a1'
const TSEQ = 'c8eccacf0953e1931cd31e434d8319101cc36e6c38b0e2104d8687552fae3e40'
const names = { [USDX]: { ticker: 'USDX', precision: 8 }, [GOLD]: { ticker: 'GOLD', precision: 8 }, [TSEQ]: { ticker: 'tSEQ', precision: 8 } }
const comma = { dec: ',', group: '.' }

test('a figure is read as the page wrote it, with its own decimal mark and grouping', () => {
  assert.equal(atomsOf('8,55878127', 8, comma), 855878127n)
  assert.equal(atomsOf('1.234,5', 8, comma), 123450000000n)
  assert.equal(atomsOf('8.55878127', 8), 855878127n)
  assert.equal(atomsOf('500,000', 8), 50000000000000n)
  assert.equal(atomsOf('0.00000097 BTC', 8), 97n)
  assert.equal(atomsOf('12\u202f345,5', 8, { dec: ',', group: '\u202f' }), 1234550000000n)
  // A point where the page's mark is a comma is not this page's figure.
  assert.equal(atomsOf('8.5', 8, { dec: ',', group: '\u202f' }), null)
  assert.equal(atomsOf('', 8), null)
  assert.equal(atomsOf('about', 8), null)
  assert.equal(atomsOf('0.123', 2), null)
  assert.equal(units(855878127n, 8), '8.55878127')
  assert.equal(units(50000000000000n, 8), '500000')
  assert.equal(units(97n, 8), '0.00000097')
  assert.equal(units(1500n, 2), '15')
})

// The trader of the run of 2026-11-12T21:39Z, as its page answered: 8.55 USDX tradable, 127.57
// held for another party's preimage, 8.03 given up in its own round, 0.00000097 BTC.
const snap = {
  lib: {
    arca: { [USDX]: { live: '855878127', awaiting_preimage: '12757487204', given: '803000000' }, [GOLD]: { exiting: '100000' } },
    held: { [USDX]: '1658878127' },
    onchain: { [TSEQ]: '2000000000' },
  },
  places: { spendable: { [USDX]: '855878127' }, arriving: { [USDX]: '0' } },
  page: { [USDX]: { tree: '855878127', onItsWay: '0' }, [TSEQ]: { tree: '0', onItsWay: '0' } },
  btc: { onchain: '97', ark: '0', arkSpendable: '0', arkArriving: '0' },
  names,
  marks: comma,
}
const chooser = [{ hex: 'BTC', ticker: 'BTC', bal: '0,00000097' }, { hex: USDX, ticker: 'USDX', bal: '8,55878127' }, { hex: TSEQ, ticker: 'tSEQ', bal: '20' }]

test('the holdings name, per asset, what can be traded now and where the rest is', () => {
  const list = holdingsOf(snap, chooser)
  assert.deepEqual(list.map((h) => h.ticker), ['BTC', 'GOLD', 'tSEQ', 'USDX'])
  const usdx = list.find((h) => h.ticker === 'USDX')
  assert.equal(usdx.now, 855878127n)
  assert.equal(usdx.preimage, 12757487204n)
  assert.equal(usdx.ownRound, 803000000n)
  assert.equal(holdingWords(usdx), "USDX: can be traded now 8.55878127 · in a round of its own 8.03 · held for another party's preimage 127.57487204 (not the wallet's to spend)")
  // Held on the chain, where the chooser counts it.
  assert.equal(holdingWords(list.find((h) => h.ticker === 'tSEQ')), 'tSEQ: can be traded now 20 · on the chain 20')
  // A state of the library's of its own, in words; the chooser does not list it.
  assert.equal(holdingWords(list.find((h) => h.ticker === 'GOLD')), 'GOLD: can be traded now 0 · on its way home on the chain 0.001')
  assert.equal(holdingWords(list[0]), 'BTC: can be traded now 0.00000097 · on the chain 0.00000097 · in the Bitcoin ark 0 (spendable 0, arriving 0)')
  const lines = holdingsLines('at the start', list)
  assert.equal(lines[0], 'trader: holds (at the start), as its page computes it:')
  assert.ok(lines.slice(1).every((l) => l.startsWith('trader:   ')), 'every line is the trader\'s, which the box run prints')
  assert.deepEqual(holdingsLines('at the end', null), ['trader: holds (at the end): could not be read'])
})

test('where the page and the library disagree, both are printed', () => {
  const s = { ...snap, places: { spendable: { [USDX]: '300000000' }, arriving: { [USDX]: '200000000' } }, page: { [USDX]: { tree: '855878127', onItsWay: '0' } } }
  const usdx = holdingsOf(s, chooser).find((h) => h.ticker === 'USDX')
  const w = holdingWords(usdx)
  assert.match(w, /of it in the tree: 8\.55878127 by the page, 3 spendable by the library/)
  assert.match(w, /on its way 0 by the page, 2 by the library/)
})

test('BTC on Lightning is what of the Trade tab\'s BTC figure is neither the chain nor the ark', () => {
  const s = { ...snap, btc: { onchain: '1000', ark: '5000', arkSpendable: '4000', arkArriving: '1000' } }
  const btc = holdingsOf(s, [{ hex: 'BTC', ticker: 'BTC', bal: '0,00007' }])[0]
  assert.equal(holdingWords(btc), 'BTC: can be traded now 0.00007 · on the chain 0.00001 · in the Bitcoin ark 0.00005 (spendable 0.00004, arriving 0.00001) · on Lightning 0.00002 (the rest of the figure)')
  assert.equal(usable(btc), 8000n)
})

test('without the chooser, what can be traded now is the tree and the chain, and says so', () => {
  const usdx = holdingsOf(snap, null).find((h) => h.ticker === 'USDX')
  assert.equal(usdx.now, null)
  assert.match(holdingWords(usdx), /can be traded now 8\.55878127 \(the tree and the chain, not the Trade tab\)/)
  assert.equal(usable(usdx), 855878127n + 803000000n)
})

test('what a line can count on: tradable now, its own round and what is on its way; never another party\'s coins', () => {
  const list = holdingsOf(snap, chooser)
  assert.equal(usable(list.find((h) => h.ticker === 'USDX')), 855878127n + 803000000n)
  assert.equal(usable(null), 0n)
})

test('a SKIP says whether the wallet holds none, or holds it where it cannot be spent yet', () => {
  const list = holdingsOf(snap, chooser)
  assert.equal(whereWords(null, 100n, 'GOLD'), 'the wallet holds no GOLD')
  assert.equal(whereWords(list.find((h) => h.ticker === 'GOLD'), 100000n), 'the wallet holds GOLD only where it cannot be spent yet: 0.001 on its way home on the chain')
  assert.equal(whereWords(list.find((h) => h.ticker === 'USDX'), 1000000000n),
    "the wallet can trade 8.55878127 USDX now, less than the 10 the line pays; the rest is where it cannot be spent yet: 8.03 in a round of its own, 127.57487204 held for another party's preimage")
  const none = holdingsOf({ ...snap, lib: { arca: { [GOLD]: { given: '120000' } } }, places: null, page: {} }, [])
  assert.equal(whereWords(none.find((h) => h.ticker === 'GOLD'), 100000n), 'the wallet holds GOLD only where it cannot be spent yet: 0.0012 in a round of its own')
})

const prices = { USDX: { price: 1 }, GOLD: { price: 3884.7 }, SEQ: { price: 0.1748 }, tBTC: { price: 71319.95 } }

test('a line\'s need is what it pays: the amount it states, or what it receives at the feed\'s price and a margin', () => {
  assert.equal(priceOf(prices, 'BTC'), 71319.95)
  assert.equal(priceOf(prices, 'tSEQ'), 0.1748)
  assert.equal(priceOf(prices, 'EURX'), null)
  assert.deepEqual(lineNeed({ id: 'WW-TRADE-USDX-GOLD-BUY', pay: 'USDX', get: 'GOLD', payAmount: '5' }, prices),
    { id: 'WW-TRADE-USDX-GOLD-BUY', pay: 'USDX', atoms: 500000000n, from: 'held', how: '5 USDX' })
  const g = lineNeed({ id: 'DX-TRADE-USDX-GOLD-BUY', pay: 'USDX', get: 'GOLD', getAmount: '0.001' }, prices)
  assert.equal(g.atoms, BigInt(Math.ceil(0.001 * 3884.7 * PRICE_MARGIN * 1e8)))
  assert.equal(g.how, 'about 4.8558 USDX (0.001 GOLD at 3885 USDX, and 25% over)')
  // A sale pays what the purchase before it bought.
  assert.equal(lineNeed({ id: 'WW-TRADE-BTC-USDX-SELL', pay: 'BTC', get: 'USDX', payAmount: '0.00004' }, prices).from, 'bought')
  // No price: the need is not counted, and says why.
  const n = lineNeed({ id: 'DX-TRADE-TSEQ-USDX-BUY', pay: 'USDX', get: 'tSEQ', getAmount: '20' }, null)
  assert.equal(n.atoms, null)
  assert.equal(n.how, 'what 20 tSEQ costs (no price for tSEQ)')
})

test('WW-TRADER-FUNDED names each line\'s amount against what the trader can count on', () => {
  const needs = [
    lineNeed({ id: 'WW-TRADE-USDX-GOLD-BUY', pay: 'USDX', get: 'GOLD', payAmount: '5' }, prices),
    lineNeed({ id: 'WW-TRADE-BTC-USDX-BUY', pay: 'USDX', get: 'BTC', payAmount: '10' }, prices),
    lineNeed({ id: 'WW-TRADE-USDX-GOLD-SELL', pay: 'GOLD', get: 'USDX', payAmount: '0.001' }, prices),
  ]
  assert.equal(heldNeeds(needs).get('USDX').atoms, 1500000000n)
  assert.equal(heldNeeds(needs).has('GOLD'), false, 'a sale\'s asset comes from the purchase before it')
  // 8.55878127 tradable now and 8.03 back from its own round: enough for 15.
  const list = holdingsOf(snap, chooser)
  const v = fundedVerdict(needs, list)
  assert.equal(v.ok, true)
  assert.deepEqual(v.short, [])
  assert.match(v.detail, /^USDX: the lines need 15 \(WW-TRADE-USDX-GOLD-BUY 5 USDX; WW-TRADE-BTC-USDX-BUY 10 USDX\); the trader can count on 16\.58878127 \(the wallet can trade 8\.55878127 USDX now; the rest is where/)
  const rich = holdingsOf({ ...snap, page: { [USDX]: { tree: '50000000000000', onItsWay: '0' } } }, [{ hex: USDX, ticker: 'USDX', bal: '500.000' }])
  const ok = fundedVerdict(needs, rich, [{ ok: true, words: 'USDX: asked the public faucet page for it' }])
  assert.equal(ok.ok, true)
  assert.match(ok.detail, /Top-up: USDX: asked the public faucet page for it$/)
})

test('the trader that held 8.55 USDX is short of the 15 the lines pay', () => {
  const needs = [lineNeed({ id: 'A', pay: 'USDX', get: 'GOLD', payAmount: '15' }, prices)]
  const list = holdingsOf({ ...snap, lib: { ...snap.lib, arca: { [USDX]: { live: '855878127', awaiting_preimage: '12757487204' } } } }, chooser)
  const v = fundedVerdict(needs, list)
  assert.equal(v.ok, false)
  assert.match(v.detail, /can count on 8\.55878127 .*short by 6\.44121873$/)
})

test('the faucet\'s reply is read for what it sent; tSEQ is its request with no asset', () => {
  assert.deepEqual(faucetSent('Sent 500,000 USDX. It is in your wallet in seconds.'), { amount: '500000', ticker: 'USDX' })
  assert.deepEqual(faucetSent('Sent 0.001 BTC. It arrives after a Bitcoin block.'), { amount: '0.001', ticker: 'BTC' })
  assert.equal(faucetSent('USDX: This wallet has already received its USDX from the faucet.'), null)
  assert.equal(faucetButton('USDX'), '#assets button[data-asset="USDX"]')
  assert.equal(faucetButton('tSEQ'), '#assets button[data-asset=""]')
})

test('a trade accepted and never listed says so: the ticket, when, how long, what the site showed', () => {
  const w = noRowWords({ head: 'buy 20 of tSEQ-USDX: waited for a round, dialog in 6.3 s', ticket: 'You pay about 3.52 USDX\n You receive 20 tSEQ  Goes through within about 6 minutes',
    approvedAt: Date.UTC(2026, 10, 12, 21, 47, 32, 400), afterMs: 1080000, site: 'Your trade is under way. Follow it under Your orders.' })
  assert.equal(w, 'buy 20 of tSEQ-USDX: waited for a round, dialog in 6.3 s: accepted at 2026-11-12T21:47:32Z and no row for it in the Trade tab 1080.0 s later; the ticket: "You pay about 3.52 USDX You receive 20 tSEQ Goes through within about 6 minutes"; the site showed "Your trade is under way. Follow it under Your orders."')
  assert.doesNotMatch(noRowWords({ head: 'x', ticket: '', approvedAt: 0, afterMs: 1000 }), /site showed/)
})

test('the Trade tab lists what the wallet holds once it shows each asset the library can spend now', () => {
  assert.deepEqual(chooserListsHeld(snap, chooser), { ok: true, missing: [], expected: ['USDX'] })
  // The restore ended and the chooser lists only BTC: the wallet's gap (sequentia-web-wallet #767).
  assert.deepEqual(chooserListsHeld(snap, [{ hex: 'BTC', ticker: 'BTC', bal: '' }]), { ok: false, missing: ['USDX'], expected: ['USDX'] })
  // Before the library has answered, nothing is known yet.
  assert.equal(chooserListsHeld({ ...snap, lib: null }, chooser).ok, false)
  // A wallet that can spend nothing: listed at once.
  assert.equal(chooserListsHeld({ ...snap, places: { spendable: {} } }, []).ok, true)
})
