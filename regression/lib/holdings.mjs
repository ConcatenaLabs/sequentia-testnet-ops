// What the trader wallet holds, read from its page the way the wallet computes it, and what the
// trade lines need of it.
//
// A trade line that fails because the wallet had too little to trade says nothing about trading,
// and the run must say so: the trades surface prints what the trader holds at its start and its
// end, one line per asset in plain words and figures, and a line of its own (WW-TRADER-FUNDED)
// says whether the trader holds what the trade lines need. The figures come from the page's own
// answers, never from the phrase or a key:
//
// - what can be traded now: the Trade tab's figure, as its asset chooser shows it (the page's
//   `userHeld`: the wallet's coins on the chain, in the tree and on Lightning that a trade can pay
//   from now, and for BTC its Bitcoin ark's spendable part);
// - of it, in the tree: the page's own figure (`__leavesApi.leafAtoms`) beside the library's
//   (`coin_places.spendable`), both printed when they differ;
// - in a round of the wallet's own: its coins it gave up in its own refresh (the library's `given`
//   and `forfeited`), which come back as new coins once the round is through;
// - on its way: the coins the library places as arriving (received past the instant limit, not
//   final yet, on their way home), as the page reads them (`onItsWay`) beside the library's;
// - held for another party's preimage: coins received under a hash the wallet did not make
//   (`awaiting_preimage`), in no figure, never the wallet's to spend until that preimage comes;
// - on the chain: the library's own coins on Sequentia (`sequentia_onchain`);
// - BTC on each rail: the page's Bitcoin on-chain balance and its Bitcoin ark (spendable and
//   arriving, `__btcHeld`), and what of the Trade tab's BTC figure is neither (Lightning).
//
// Every amount is in atoms here; the words give it in the asset's units, with a point.

export const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }

// The page's own answers, as plain data (atoms as strings). Needs the page's test hooks
// (window.SEQ_TEST_HOOKS, set by openTrader).
export const HOLDINGS_READ = `(()=>{
  const L = window.__leavesApi, S = L && L.state;
  const s = (v)=>{ try { return String(v ?? 0) } catch { return '0' } };
  const B = S && S.balance;
  const lib = B ? { arca: B.arca || {}, held: B.held || null, onchain: B.sequentia_onchain || {} } : null;
  let places = null;
  if (S && S.places) {
    places = { spendable: S.places.spendable || {}, arriving: {} };
    for (const c of (S.places.coins || [])) if (c && c.place === 'arriving' && c.kind !== 'board')
      places.arriving[c.asset] = s(BigInt(places.arriving[c.asset] || 0) + BigInt(c.value || 0));
  }
  const assets = new Set([...Object.keys((lib && lib.arca) || {}), ...Object.keys((lib && lib.held) || {}),
    ...Object.keys((lib && lib.onchain) || {}), ...Object.keys((places && places.spendable) || {}), ...Object.keys((places && places.arriving) || {})]);
  try { for (const h of L.leafAssets()) assets.add(h) } catch {}
  const page = {};
  for (const h of assets) { try { page[h] = { tree: s(L.leafAtoms(h)), onItsWay: s(L.onItsWay ? L.onItsWay(h) : 0) } } catch {} }
  let reg = {}; try { reg = JSON.parse(localStorage.getItem('swk.registryCache') || '{}') } catch {}
  const names = {}; for (const h of assets) if (reg[h] && reg[h].ticker) names[h] = { ticker: reg[h].ticker, precision: reg[h].precision };
  let marks = { dec: '.', group: ',' };
  try { const p = new Intl.NumberFormat().formatToParts(12345.5); marks = { dec: (p.find((x)=>x.type==='decimal')||{}).value || '.', group: (p.find((x)=>x.type==='group')||{}).value || '' } } catch {}
  return { lib, places, page, btc: window.__btcHeld || null, names, marks,
    open: !!(L && L.isOpen && L.isOpen()), restoring: !!(L && L.restoring && L.restoring()) };
})()`

// The Trade tab's asset chooser (You pay), opened and read as a person reads it: each row's asset
// and the figure beside it, then closed. Needs the Trade tab shown. -> [{ hex, ticker, bal }] or
// null when there is no chooser.
export const CHOOSER_READ = `(async()=>{
  const b = document.querySelector('#userComposerRoot #ucPay'); if (!b) return null;
  b.click(); await new Promise((r)=>setTimeout(r, 600));
  const rows = [...document.querySelectorAll('.swpop .swopt')].map((o)=>({ hex: o.dataset.hex || '',
    ticker: (((o.querySelector('.swopt-tk') || {}).firstChild || {}).textContent || '').trim(),
    bal: ((o.querySelector('.swopt-bal .b') || {}).textContent || '').trim() }));
  const i = document.querySelector('.swpop-search input');
  (i || document).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise((r)=>setTimeout(r, 200));
  return rows;
})()`

// A figure as the page shows it ("8,55878127", "1.234,5", "500,000"), with the page's decimal
// mark and grouping (`marks`), in atoms of `precision` decimals; null when it is no number.
export function atomsOf (text, precision, marks = { dec: '.', group: ',' }) {
  const dec = marks.dec || '.', group = marks.group || ''
  let t = String(text ?? '').trim()
  if (group) t = t.split(group).join('')
  // Grouping by a space the locale writes as a narrow or no-break space; the figure is the first
  // word, before any ticker.
  t = t.replace(/[\u00a0\u202f]/g, '').split(/[ \t\n]+/)[0] || ''
  if (dec !== '.') { if (t.includes('.')) return null; t = t.split(dec).join('.') }
  if (!/^\d+(\.\d+)?$/.test(t)) return null
  const [i, f = ''] = t.split('.')
  if (f.length > precision) return null
  return BigInt(i) * 10n ** BigInt(precision) + BigInt((f + '0'.repeat(precision)).slice(0, precision) || '0')
}

// Atoms in an asset's units, with a point, trailing zeros dropped.
export function units (atoms, precision = 8) {
  let a = big(atoms); const neg = a < 0n; if (neg) a = -a
  const base = 10n ** BigInt(precision)
  let s = (a / base).toString()
  if (precision > 0) { const f = (a % base).toString().padStart(precision, '0').replace(/0+$/, ''); if (f) s += '.' + f }
  return (neg ? '-' : '') + s
}

// The library's coin states, in words, for what is held but in none of the places above.
const STATE_WORDS = {
  offered: 'offered in a trade under way', sending: 'being paid out', exiting: 'on its way home on the chain',
  spent_elsewhere: 'held out as spent from another device', returning: 'owed back by the operator', kept_safe: 'kept safe on the chain',
}
const OWN_ROUND = ['given', 'forfeited']
const COUNTED_ELSEWHERE = new Set(['live', 'operator-confirmed', 'pending', 'awaiting_preimage', ...OWN_ROUND])

// What the trader holds, per asset, from the page's answers (`snap`, HOLDINGS_READ) and the
// chooser's rows (CHOOSER_READ; null when it was not read). -> [{ hex, ticker, precision, now,
// nowText, tree: { page, lib }, ownRound, onItsWay: { page, lib }, preimage, onchain, other, btc }],
// BTC first, then by ticker; atoms as BigInt (null where nothing was read).
export function holdingsOf (snap, chooser = null) {
  const s = snap || {}
  const names = s.names || {}
  const marks = s.marks || { dec: '.', group: ',' }
  const rows = new Map()
  const row = (hex) => {
    if (!rows.has(hex)) {
      const n = names[hex] || {}
      const c = (chooser || []).find((r) => r.hex === hex)
      rows.set(hex, { hex, ticker: n.ticker || (c && c.ticker) || hex.slice(0, 8) + '…', precision: Number.isInteger(n.precision) ? n.precision : 8,
        now: null, nowText: null, tree: { page: null, lib: null }, ownRound: 0n, onItsWay: { page: null, lib: null }, preimage: 0n, onchain: 0n, other: {} })
    }
    return rows.get(hex)
  }
  const lib = s.lib
  if (lib) {
    for (const [hex, states] of Object.entries(lib.arca || {})) {
      const r = row(hex)
      for (const [st, v] of Object.entries(states || {})) {
        if (OWN_ROUND.includes(st)) r.ownRound += big(v)
        else if (st === 'awaiting_preimage') r.preimage += big(v)
        else if (!COUNTED_ELSEWHERE.has(st) && big(v) > 0n) r.other[st] = (r.other[st] || 0n) + big(v)
      }
    }
    for (const [hex, v] of Object.entries(lib.onchain || {})) row(hex).onchain += big(v)
  }
  if (s.places) {
    for (const [hex, v] of Object.entries(s.places.spendable || {})) row(hex).tree.lib = big(v)
    for (const [hex, v] of Object.entries(s.places.arriving || {})) row(hex).onItsWay.lib = big(v)
    for (const r of rows.values()) { if (r.tree.lib == null) r.tree.lib = 0n; if (r.onItsWay.lib == null) r.onItsWay.lib = 0n }
  }
  for (const [hex, p] of Object.entries(s.page || {})) { const r = row(hex); r.tree.page = big(p.tree); r.onItsWay.page = big(p.onItsWay) }
  for (const c of chooser || []) {
    if (!c || !c.hex || c.hex === 'BTC') continue
    const r = row(c.hex)
    r.nowText = c.bal || '0'
    r.now = c.bal ? atomsOf(c.bal, r.precision, marks) : 0n
  }
  // An asset the chooser was read for and does not list: nothing of it can be traded now.
  if (chooser) for (const r of rows.values()) if (r.now == null) { r.now = 0n; r.nowText = '0' }
  const seq = [...rows.values()].filter((r) => r.now || r.tree.page || r.tree.lib || r.ownRound || r.onItsWay.page || r.onItsWay.lib || r.preimage || r.onchain || Object.keys(r.other).length)
  seq.sort((a, b) => a.ticker.localeCompare(b.ticker))
  // BTC: the chooser's figure (what a trade can pay from now), the chain, the Bitcoin ark.
  const bc = (chooser || []).find((r) => r && r.hex === 'BTC')
  const bh = s.btc || null
  const btc = { hex: 'BTC', ticker: 'BTC', precision: 8, now: bc ? (bc.bal ? atomsOf(bc.bal, 8, marks) : 0n) : (chooser ? 0n : null), nowText: bc ? (bc.bal || '0') : (chooser ? '0' : null),
    btc: bh ? { onchain: big(bh.onchain), ark: bh.ark == null ? null : big(bh.ark), arkSpendable: bh.arkSpendable == null ? null : big(bh.arkSpendable), arkArriving: bh.arkArriving == null ? null : big(bh.arkArriving) } : null,
    tree: { page: null, lib: null }, ownRound: 0n, onItsWay: { page: null, lib: null }, preimage: 0n, onchain: 0n, other: {} }
  return [btc, ...seq]
}

// What of an asset a trade line can count on: what can be traded now, and what comes back to it
// once its own round is through or arrives (the wallet waits for those by itself, and says so on
// an indicative ticket). Coins held for another party's preimage are not the wallet's. Atoms.
export function usable (h) {
  if (!h) return 0n
  if (h.hex === 'BTC') return (h.now ?? 0n) + ((h.btc && h.btc.arkArriving) || 0n)
  const now = h.now ?? ((h.tree.page ?? 0n) + h.onchain)
  return now + h.ownRound + (h.onItsWay.page ?? h.onItsWay.lib ?? 0n)
}

// One asset's line in plain words: what can be traded now, then each other place it is in.
export function holdingWords (h) {
  const u = (a) => units(a, h.precision)
  const parts = []
  if (h.hex === 'BTC') {
    parts.push(`can be traded now ${h.now == null ? 'not read' : u(h.now)}`)
    if (h.btc) {
      parts.push(`on the chain ${u(h.btc.onchain)}`)
      if (h.btc.ark != null) parts.push(`in the Bitcoin ark ${u(h.btc.ark)} (spendable ${u(h.btc.arkSpendable ?? 0n)}, arriving ${u(h.btc.arkArriving ?? 0n)})`)
      else parts.push('the Bitcoin ark not open')
      // The Trade tab's BTC figure is the chain, the ark's spendable part and Lightning together.
      if (h.now != null) { const ln = h.now - h.btc.onchain - (h.btc.arkSpendable ?? 0n); if (ln > 0n) parts.push(`on Lightning ${u(ln)} (the rest of the figure)`) }
    } else parts.push('its rails not read')
    return `${h.ticker}: ${parts.join(' · ')}`
  }
  const tree = h.tree.page != null && h.tree.lib != null && h.tree.page !== h.tree.lib
    ? ` (of it in the tree: ${u(h.tree.page)} by the page, ${u(h.tree.lib)} spendable by the library)` : ''
  parts.push(`can be traded now ${h.now == null ? (h.tree.page == null ? 'not read' : u(h.tree.page + h.onchain) + ' (the tree and the chain, not the Trade tab)') : u(h.now)}${tree}`)
  if (h.ownRound) parts.push(`in a round of its own ${u(h.ownRound)}`)
  const ow = h.onItsWay
  if ((ow.page ?? 0n) || (ow.lib ?? 0n)) parts.push(ow.page != null && ow.lib != null && ow.page !== ow.lib ? `on its way ${u(ow.page)} by the page, ${u(ow.lib)} by the library` : `on its way ${u(ow.page ?? ow.lib)}`)
  if (h.preimage) parts.push(`held for another party's preimage ${u(h.preimage)} (not the wallet's to spend)`)
  if (h.onchain) parts.push(`on the chain ${u(h.onchain)}`)
  for (const [st, v] of Object.entries(h.other)) parts.push(`${STATE_WORDS[st] || st} ${u(v)}`)
  return `${h.ticker}: ${parts.join(' · ')}`
}

// The holdings as the run prints them: a head line and one line per asset.
export function holdingsLines (when, list) {
  if (!list) return [`trader: holds (${when}): could not be read`]
  return [`trader: holds (${when}), as its page computes it:`, ...list.map((h) => 'trader:   ' + holdingWords(h))]
}

// Why a line that needed `atoms` of an asset could not run: the wallet holds none of it, or holds
// it where it cannot be spent yet (and where), or holds less than the line pays.
export function whereWords (h, atoms = null, ticker = null) {
  const t = (h && h.ticker) || ticker || 'it'
  if (!h) return `the wallet holds no ${t}`
  const u = (a) => units(a, h.precision)
  const now = h.now ?? 0n
  const away = []
  if (h.hex === 'BTC') {
    if (h.btc && h.btc.arkArriving) away.push(`${u(h.btc.arkArriving)} arriving in the Bitcoin ark`)
  } else {
    if (h.ownRound) away.push(`${u(h.ownRound)} in a round of its own`)
    const ow = h.onItsWay.page ?? h.onItsWay.lib ?? 0n
    if (ow) away.push(`${u(ow)} on its way`)
    if (h.preimage) away.push(`${u(h.preimage)} held for another party's preimage`)
    for (const [st, v] of Object.entries(h.other)) away.push(`${u(v)} ${STATE_WORDS[st] || st}`)
  }
  if (!now && !away.length) return `the wallet holds no ${t}`
  if (!now) return `the wallet holds ${t} only where it cannot be spent yet: ${away.join(', ')}`
  const need = atoms != null && now < atoms ? `, less than the ${u(atoms)} the line pays` : ''
  return `the wallet can trade ${u(now)} ${t} now${need}${away.length ? `; the rest is where it cannot be spent yet: ${away.join(', ')}` : ''}`
}

// ---- what the trade lines need ----
// The trader keeps one asset of its own (STOCK); every other asset a line pays it bought in the
// line before. A line's need is what it pays: the amount the line states when it states what is
// paid, else (a SeqDEX purchase names what it receives) that amount at the price feed's rates
// (/prices) and a margin over them, as a price "about".
export const STOCK = 'USDX'
export const PRICE_MARGIN = 1.25
// The price feed's ticker for an asset (BTC is tBTC there, the Sequence token SEQ).
const FEED = { BTC: ['BTC', 'tBTC'], tSEQ: ['SEQ', 'tSEQ'] }
export function priceOf (prices, ticker) {
  for (const k of FEED[ticker] || [ticker]) { const v = prices && prices[k]; const p = v && typeof v === 'object' ? v.price : v; if (Number(p) > 0) return Number(p) }
  return null
}
// Decimal text (as the lines state amounts) in atoms of 8 decimals; every asset the lines trade has 8.
export const atoms8 = (text) => atomsOf(String(text), 8)
// One line's need: { id, pay, atoms (null when no price), from: 'held' | 'bought', how }.
export function lineNeed ({ id, pay, get, payAmount = null, getAmount = null }, prices = null) {
  const from = pay === STOCK ? 'held' : 'bought'
  if (payAmount != null) return { id, pay, atoms: atoms8(payAmount), from, how: `${payAmount} ${pay}` }
  const pp = priceOf(prices, pay), pg = priceOf(prices, get)
  if (!pp || !pg) return { id, pay, atoms: null, from, how: `what ${getAmount} ${get} costs (no price for ${pg ? pay : get})` }
  const units = Number(getAmount) * pg / pp * PRICE_MARGIN
  const atoms = BigInt(Math.ceil(units * 1e8))
  return { id, pay, atoms, from, how: `about ${unitsWords(atoms)} ${pay} (${getAmount} ${get} at ${round(pg / pp)} ${pay}, and ${Math.round((PRICE_MARGIN - 1) * 100)}% over)` }
}
const round = (x) => (x >= 100 ? Math.round(x).toString() : x >= 1 ? x.toFixed(2) : x.toPrecision(3))
const unitsWords = (a) => { const s = units(a, 8); const [i, f = ''] = s.split('.'); return f.length > 4 ? i + '.' + f.slice(0, 4) : s }

// What the lines need of each asset the trader holds of its own (`from: 'held'`), with the lines.
// -> Map(ticker -> { atoms, lines: [need], unknown: [need] })
export function heldNeeds (needs) {
  const m = new Map()
  for (const n of needs) {
    if (n.from !== 'held') continue
    if (!m.has(n.pay)) m.set(n.pay, { atoms: 0n, lines: [], unknown: [] })
    const e = m.get(n.pay)
    if (n.atoms == null) e.unknown.push(n)
    else { e.atoms += n.atoms; e.lines.push(n) }
  }
  return m
}

// The verdict of WW-TRADER-FUNDED: for each asset the lines pay from what the trader holds, what
// they need against what it can count on (usable). -> { ok, short: [ticker], detail }
export function fundedVerdict (needs, holdings, topups = []) {
  const want = heldNeeds(needs)
  const short = [], words = []
  for (const [ticker, e] of want) {
    const h = (holdings || []).find((x) => x.ticker === ticker)
    const have = usable(h)
    const enough = have >= e.atoms
    if (!enough) short.push(ticker)
    const list = e.lines.map((n) => `${n.id} ${n.how}`).concat(e.unknown.map((n) => `${n.id} ${n.how}`)).join('; ')
    words.push(`${ticker}: the lines need ${units(e.atoms, 8)}${e.unknown.length ? ' and more' : ''} (${list}); the trader can count on ${units(have, h ? h.precision : 8)}${h ? ` (${whereWords(h)})` : ''}${enough ? '' : `, short by ${units(e.atoms - have, 8)}`}`)
  }
  const t = topups.length ? '. Top-up: ' + topups.map((x) => x.words).join('; ') : ''
  return { ok: !short.length, short, detail: words.join('. ') + t }
}

// ---- the faucet top-up ----
// What the faucet's message says it sent: { amount (text), ticker } or null.
export function faucetSent (text) {
  const m = /Sent ([\d.,\u00a0\u202f ]+?) ([A-Za-z][A-Za-z0-9.]*)\./.exec(String(text || ''))
  return m ? { amount: m[1].replace(/[,\u00a0\u202f ]/g, ''), ticker: m[2] } : null
}
// The faucet page's button for a ticker: tSEQ is its request with no asset.
export const faucetButton = (ticker) => `#assets button[data-asset=${JSON.stringify(/^t?SEQ$/.test(ticker) ? '' : ticker)}]`

// ---- a trade that leaves no row (sequentia-web-wallet #770) ----
// A trade accepted with a ticket that, `afterMs` later, has no row in the Trade tab: what it was
// accepted with and when, how long there has been no row, and what the site showed.
// `tab`, when read: what the Trade tab lists then ({ rows, newest }).
export function noRowWords ({ head, ticket, approvedAt, afterMs, site = null, tab = null }) {
  const when = approvedAt ? new Date(approvedAt).toISOString().replace(/\.\d+Z$/, 'Z') : 'an unknown time'
  const listed = tab ? `; the Trade tab lists ${tab.rows} trade(s)${tab.rows ? `, the newest "${squeeze(tab.newest, 100)}"` : ''}` : ''
  return `${head}: accepted at ${when} and no row for it in the Trade tab ${(afterMs / 1000).toFixed(1)} s later; the ticket: "${squeeze(ticket, 160) || 'not read'}"${site != null ? `; the site showed "${squeeze(site, 160) || 'nothing'}"` : ''}${listed}`
}
// What the Trade tab lists: { rows, newest } (the newest row's words).
export const TAB_LISTED = "(()=>{ const r=[...document.querySelectorAll('#userComposerRoot #ucTrades .uc-trade')]; return { rows: r.length, newest: r.length ? r[0].innerText : '' } })()"
export const squeeze = (t, n = 220) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s }

// ---- the Trade tab lists what the wallet holds (WW-RESTORE-TRADABLE) ----
// Whether the chooser lists each asset the library says can be spent now (or, before it places its
// coins, holds). -> { ok, missing: [ticker], expected: [ticker] }
export function chooserListsHeld (snap, chooser) {
  const s = snap || {}
  if (!s.lib || !chooser) return { ok: false, missing: [], expected: [], unread: true }
  const can = s.places ? Object.entries(s.places.spendable || {}) : Object.entries(s.lib.held || {})
  const want = can.filter(([, v]) => big(v) > 0n).map(([h]) => h)
  const prec = (h) => (Number.isInteger(((s.names || {})[h] || {}).precision) ? s.names[h].precision : 8)
  const listed = new Set(chooser.filter((r) => r && r.bal && atomsOf(r.bal, prec(r.hex), s.marks) !== 0n).map((r) => r.hex))
  const name = (h) => ((s.names || {})[h] || {}).ticker || h.slice(0, 8) + '…'
  const missing = want.filter((h) => !listed.has(h)).map(name)
  return { ok: !missing.length, missing, expected: want.map(name) }
}
