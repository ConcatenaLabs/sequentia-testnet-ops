// Live trades: small market buys and sells on the testnet that move real (test) coins, from the
// web wallet's Trade tab and from SeqDEX through the web wallet, each bounded in time. A screen can
// look right while trading is broken; these lines fail when a trade does not happen, with the
// reason the wallet or the site gives.
//
// The trader is one web wallet, restored from its phrase (--trader, default
// ~/.local/share/sequentia-regression/wallets/rgtrader.phrase) into a fresh profile; without it
// every line is SKIP. It holds USDX: each pair is bought first and the bought amount sold back,
// so the wallet ends about where it started, less the fees.
//
// What the trader holds is printed at the start and the end of the surface, per asset, as its page
// computes it (lib/holdings.mjs), and WW-TRADER-FUNDED says whether it holds what the lines need,
// naming each line's amount. Short of an asset the public faucet gives, the run asks the faucet
// page for it, to the trader's own receive code, as a person would, and waits until the wallet
// shows it; the faucet is its only source. BTC is never topped up: the BTC lines sell what the BTC
// purchase before them bought. A line whose asset the trader lacks is SKIP with where that asset
// is (none held, or held where it cannot be spent yet), so one cause fails one line.
//
// A line passes when, within BOUND_MS of the person's confirmation (BTC_PAID_BOUND_MS for a
// purchase paid with BTC), the Trade tab says what was bought is received ("Received, settling"
// or "Settled"), or SeqDEX says "Traded with … order". A trade of two assets in the tree is done
// for its person once what it brought can be spent: "Settled". The wallet says "Received,
// settling" only while the next spend needs the operator's round (a coin one payment short of
// the operator's limit), so such a line must also read "Settled" within SETTLE_ROUND_MS of
// reading "Received" (settledInTime). Otherwise it fails with what the page says at that moment.
//
// A trade whose coins first wait for the wallet's own round gets an indicative ticket: a price
// "about", the least it goes for, and the wait in words ("Goes through within about 6 minutes").
// The person confirms it and the trade goes by itself once the round is through. Such a line is
// bounded by the wait its ticket states rather than BOUND_MS: it passes when the ticket shows within
// TICKET_MS (as a firm one must) and the trade reads Settled (Received for a trade with BTC) within
// the stated wait. The line keeps watching past that, up to OVERRUN times the stated wait, so it
// prints when the trade really ended against what was stated. Each line says which kind its ticket
// was, with both times, and the run's summary counts the trades that waited for a round, so a run
// cannot pass by waiting everywhere unseen.
import { sleep, helpers, faucetPass } from '../lib/suite.mjs'
import { HOLDINGS_READ, CHOOSER_READ, holdingsOf, holdingsLines, usable, whereWords, lineNeed, fundedVerdict, faucetSent, faucetButton,
  noRowWords, squeeze, chooserListsHeld, atomsOf, units, TAB_LISTED } from '../lib/holdings.mjs'

const ORIGIN = 'https://sequentiatestnet.com'
const WALLET = ORIGIN + '/wallet/'
const DEX = ORIGIN + '/dex/'
const FAUCET = ORIGIN + '/faucet/'
export const BOUND_MS = 60000
// A purchase paid with BTC is bounded by BTC_PAID_BOUND_MS instead: the wallet pays its BTC only
// once the asset held for it is final, its leaf made in the operator's next round (every 60 s on
// the testnet) and that round's block certified (a 60 s block), so it reads "Received" one to two
// and a half minutes after the confirmation, never within BOUND_MS (92 s measured, 31 October).
export const BTC_PAID_BOUND_MS = 180000
const boundOf = (pay) => (pay === 'BTC' ? BTC_PAID_BOUND_MS : BOUND_MS)
// A round takes about 64 s from built to credited on the testnet (a 60 s round and a 60 s block):
// a trade that says it is settling reads "Settled" within two of them.
export const SETTLE_ROUND_MS = 150000
// Whether a Trade tab line must read "Settled" too, not only "Received": a trade of two assets in
// the tree. A trade with BTC settles on the Bitcoin side's own terms (the BTC ark's line below).
export const inTree = (pay, get) => pay !== 'BTC' && get !== 'BTC'
// What a Trade tab line reads in the end: what it read within its bound (`done`), and, for a trade
// in the tree that read "Received", what it read within SETTLE_ROUND_MS after (`later`, null when
// nothing changed). -> { ok, word }
export function settledInTime (pay, get, done, later) {
  if (!done || /^Returned/.test(done)) return { ok: false, word: done || null }
  if (!inTree(pay, get) || /^Settled/.test(done)) return { ok: true, word: done }
  if (later && /^Settled/.test(later)) return { ok: true, word: later }
  return { ok: false, word: later || done }
}
const REVIEW_MS = 60000
// How far past its stated wait an indicative trade is still watched, so the line says when it ended.
export const OVERRUN = 3
// The wait an indicative ticket states, from the wallet's words (`goesThrough` and `settling` in
// the web wallet's user-trade.js USER_WORDS), in ms; null for a firm ticket, which names no wait.
// A ticket that waits without a time ("Goes through by itself once what you pay is ready", when
// the wallet gave none) is judged against UNSTATED_WAIT_MS, the longest wait this suite takes, and
// its line says so (waitStated).
export const UNSTATED_WAIT_MS = 12 * 60_000
const NO_TIME = /Goes through by itself once what you pay is ready/
export const WAIT_WORDS = /Goes through (in about a minute|within about \d+ minutes|by itself once what you pay is ready)/
export function statedWaitMs (text) {
  const t = String(text || '')
  if (/Goes through in about a minute/.test(t)) return 60_000
  const m = t.match(/Goes through within about (\d+) minutes/)
  if (m) return Number(m[1]) * 60_000
  return NO_TIME.test(t) ? UNSTATED_WAIT_MS : null
}
export const waitStated = (text) => !NO_TIME.test(String(text || ''))
// Whether a trade's words say it is done: Settled for a trade of two assets in the tree, Received
// or Settled for a trade with BTC; Returned is an end too, never done.
export function endWord (pay, get, word) {
  const w = String(word || '')
  if (/^Returned/.test(w)) return 'returned'
  if (/^Settled/.test(w) || (!inTree(pay, get) && /^Received/.test(w))) return 'done'
  return null
}
// The verdict on an indicative trade: it showed its ticket within TICKET_MS and ended done within
// the wait the ticket stated. `endedMs` is null when it had not ended when the watch stopped.
export function waitedInTime ({ ticketMs, statedMs, endedMs, end }) {
  return ticketMs <= TICKET_MS && end === 'done' && endedMs != null && endedMs <= statedMs
}
const secs = (ms) => (ms / 1000).toFixed(1)
// One line's words for a trade that waited for a round.
export function waitedDetail (head, { ticketMs, statedMs, endedMs, end, word, stated }) {
  // A ticket that named no time is held to the suite's longest wait, and says so.
  const bound = waitStated(stated) ? `the ${secs(statedMs)} s stated` : `the suite's longest wait, ${secs(statedMs)} s (the ticket named no time)`
  const tail = endedMs == null
    ? `still reads "${word}" ${secs(OVERRUN * statedMs)} s after confirming, ${OVERRUN} times ${bound}`
    : end === 'returned' ? `${word} after ${secs(endedMs)} s (${bound})`
      : `${word} after ${secs(endedMs)} s, ${endedMs <= statedMs ? 'within' : 'past'} ${bound}`
  return `${head}: waited for a round, ticket "${stated}" in ${secs(ticketMs)} s${ticketMs > TICKET_MS ? `, over the ${TICKET_MS / 1000} s a person waits at most` : ''}; ${tail}`
}
// A firm trade followed in the Trade tab after the site said it is under way: done within `boundMs`.
export function followedInTime (r, boundMs) { return !!r && r.end === 'done' && r.endedMs != null && r.endedMs <= boundMs }
export function followedWords (r, boundMs) {
  if (r.endedMs == null) return `in the wallet's Trade tab it still reads "${r.word}" ${secs(OVERRUN * boundMs)} s after approval, past the ${secs(boundMs)} s`
  if (r.end === 'returned') return `in the wallet's Trade tab it reads "${r.word}" after ${secs(r.endedMs)} s: nothing traded`
  return `in the wallet's Trade tab it reads "${r.word}" after ${secs(r.endedMs)} s, ${r.endedMs <= boundMs ? 'within' : 'past'} the ${secs(boundMs)} s`
}
// A person waits this long at most for a price: from Review to the ticket in the Trade tab, from
// the button to the wallet's dialog on SeqDEX (#363: about 3 s is typical, 10 s the most). A trade
// that takes longer is still made, so the lines after it run, and its line fails with the time.
export const TICKET_MS = 10000
// A purchase paid with BTC from the Bitcoin ark reads "Received" once the BTC is paid over
// Lightning, and "Settled" once the coin it received is settled in the operator's next round and
// that round's block is certified: minutes, with no Bitcoin block to wait for. SETTLE_MS is a wide
// margin over that, so a purchase that never settles fails and one merely slow does not.
export const SETTLE_MS = 60 * 60000
// When the lines end, the trader's page stays open until none of its refreshes waits for a round
// and every purchase paid with BTC is paid and collected (only an open page pays the BTC), for
// LEAVE_MS at most. The operator broadcasts a round only once every refresh in it has handed
// over its forfeits, which only an open page can do: a page closed earlier voids its refreshes ten
// minutes later, holds back everyone else's in those rounds, and leaves the trader's coins
// unusable at the next run (sequentia-testnet-ops #191).
export const LEAVE_MS = 15 * 60000
// Whether the leaf wallet `state` (the page's `__leavesApi.state`) has a refresh or a coin still
// moving: the web wallet's own test (leaves.js `inFlight`).
const DONE_PARTICIPATION = ['released', 'void', 'expired', 'refused']
const MOVING_COIN = ['pending', 'sending', 'offered', 'given', 'forfeited', 'exiting']
export function stillMoving (state) {
  if (!state) return null
  const parts = (Array.isArray(state.participations) ? state.participations : []).filter((p) => p && !DONE_PARTICIPATION.includes(p.state) && !p.released)
  const coins = (Array.isArray(state.coins) ? state.coins : []).filter((c) => c && MOVING_COIN.includes(c.state))
  return { participations: parts.map((p) => `${String(p.participation || '').slice(0, 12)} ${p.state}`), coins: coins.length }
}

// The wallet's BTC purchases not yet done, from its trade records (the page's `swk.usertrade.*`):
// `unpaid`, whose BTC only an open page pays (closed, nothing is traded), and `unclaimed`, whose BTC
// is paid and whose asset is not yet collected. The page stays open while either is left.
export function btcPurchasesOpen (records) {
  const open = (records || []).filter((r) => r && r.source === 'btc-gateway' && r.dir === 'buy' && ['confirming', 'waiting', 'sent'].includes(r.state))
  return { unpaid: open.filter((r) => !r.preimage).length, unclaimed: open.filter((r) => r.preimage && r.receiveState !== 'received').length }
}
// The trade records the page keeps, read from its storage.
const TRADE_RECORDS = `(()=>{ const out=[]; for(let i=0;i<localStorage.length;i++){ const k=localStorage.key(i);
  if(!/^swk\.usertrade\.[^.]+$/.test(k)) continue; try{ const v=JSON.parse(localStorage.getItem(k)); if(Array.isArray(v)) out.push(...v.map(r=>({ source:r.source, dir:r.dir, state:r.state, preimage:!!r.preimage, receiveState:r.receiveState||null }))) }catch{} }
  return out })()`

// The Trade tab: what is paid, what is received, the amount paid.
const TAB_TRADES = [
  ['USDX-GOLD-BUY', 'USDX', 'GOLD', '5'],
  ['USDX-GOLD-SELL', 'GOLD', 'USDX', '0.001'],
  ['TSEQ-USDX-BUY', 'USDX', 'tSEQ', '5'],
  ['TSEQ-USDX-SELL', 'tSEQ', 'USDX', '20'],
  // The BTC desk sells no less than 10,000 sats (about 8 USDX).
  ['BTC-USDX-BUY', 'USDX', 'BTC', '10'],
  ['BTC-USDX-SELL', 'BTC', 'USDX', '0.00004'],
]
// SeqDEX's market page: the pair as shown, the side, the amount of its base (You receive for a
// purchase, You pay for a sale).
const DEX_TRADES = [
  ['USDX-GOLD-BUY', 'GOLD-USDX', 'buy', '0.001'],
  ['USDX-GOLD-SELL', 'GOLD-USDX', 'sell', '0.001'],
  ['TSEQ-USDX-BUY', 'tSEQ-USDX', 'buy', '20'],
  ['TSEQ-USDX-SELL', 'tSEQ-USDX', 'sell', '20'],
  ['BTC-USDX-BUY', 'USDX-BTC', 'sell', '10'],
  ['BTC-USDX-SELL', 'USDX-BTC', 'buy', '10'],
]

// Waits for `expression` to be true on the page and answers its value. The page helpers' waitFor
// answers nothing, only that it came; these lines need what the page said.
async function waitValue (p, expression, ms) {
  const t0 = Date.now()
  for (;;) {
    try { const v = await p.eval(expression); if (v) return v } catch {}
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + expression)
    await sleep(250)
  }
}

// Chooses `ticker` in the asset chooser that the button `#id` opens.
const pick = (id, ticker) => `(async()=>{
  const b=document.getElementById(${JSON.stringify(id)}); if(!b) throw new Error('no #${id}');
  b.click(); await new Promise(r=>setTimeout(r,400));
  const i=document.querySelector('.swpop-search input'); if(!i) throw new Error('#${id} opens no chooser');
  i.value=${JSON.stringify(ticker)}; i.dispatchEvent(new Event('input')); await new Promise(r=>setTimeout(r,300));
  const o=[...document.querySelectorAll('.swpop .swopt')].find(x=>{const t=x.querySelector('.swopt-tk'); return t && t.firstChild && t.firstChild.textContent.trim()===${JSON.stringify(ticker)}});
  if(!o){ i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); throw new Error('no ${ticker} in the chooser'); }
  o.click(); return true })()`

async function openTrader (b, h, phrase) {
  // The page's test hooks: the leaf wallet's state, read when the lines end (LEAVE_MS).
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.SEQ_TEST_HOOKS = true' }, h.page.sessionId)
  await b.send('Page.navigate', { url: WALLET }, h.page.sessionId)
  await h.waitFor("(()=>{const v=(id)=>{const e=document.getElementById(id); return e && getComputedStyle(e).display!=='none'}; return v('app')||v('welcome')})()", 240000)
  // The trader's profile is kept between runs: a page that opens its wallet already is the
  // trader's, restored by an earlier run; a fresh profile is given the phrase.
  const fresh = !(await h.eval("localStorage.getItem('swk.sequentia.mnemonic') ? true : false"))
  if (fresh) {
    await h.eval(`localStorage.setItem('swk.sequentia.mnemonic', ${JSON.stringify(phrase)}), true`)
    await b.send('Page.navigate', { url: 'about:blank' }, h.page.sessionId); await sleep(1500)
    await b.send('Page.navigate', { url: WALLET }, h.page.sessionId)
  }
  await h.waitFor("document.querySelector('#app') && getComputedStyle(document.querySelector('#app')).display !== 'none'", 240000)
  // Open only once the leaf wallet is: joined, and its restore run to its end. A wallet still
  // restoring shows part of what it holds, and a trade from it tests a half-restored wallet. Up to
  // RESTORE_MS, its time printed. -> { s, fresh }
  const t0 = Date.now()
  await h.waitFor("!!(window.__leavesApi && window.__leavesApi.isOpen() && !window.__leavesApi.restoring())", RESTORE_MS)
  const s = Math.round((Date.now() - t0) / 1000)
  console.log(`trader: the leaf wallet open after ${s} s (${fresh ? 'restored from the phrase in a fresh profile' : 'reopened from the kept profile'})`)
  return { s, fresh }
}
// How long the trader's wallet may take to open before the trades are SKIP: a restore of weeks of
// trades in a fresh profile has taken 20 minutes (sequentia-web-wallet #767). A restore past
// RESTORE_BOUND_MS fails its own line (WW-RESTORE-LONG) and the trades still run.
const RESTORE_MS = 40 * 60_000
export const RESTORE_BOUND_MS = 5 * 60_000

// One trade in the Trade tab. -> { ok, detail }
async function tabTrade (h, pay, get, amount) {
  await h.click('[data-tab=swap]'); await sleep(1000)
  // A ticket left open by the line before (one that came after its bound) is cancelled, as a
  // person would, so each line starts from the composer and fails only for its own trade.
  await h.eval("(()=>{ const c=document.querySelector('#userComposerRoot #ucCancel'); if(c) c.click(); return true })()"); await sleep(500)
  await h.waitFor("!!document.querySelector('#userComposerRoot #ucPay') && !!document.querySelector('#userComposerRoot #ucReview')", 120000)
  await h.eval(pick('ucPay', pay)); await sleep(400)
  await h.eval(pick('ucGet', get)); await sleep(400)
  await h.type('#userComposerRoot #ucAmount', amount); await sleep(1500)
  const t0 = Date.now()
  await h.click('#userComposerRoot #ucReview')
  const tk = await waitValue(h, "(()=>{ const r=document.getElementById('userComposerRoot'); if(r.querySelector('#ucConfirm')) return 'OK '+r.querySelector('#ucTicket').innerText; const n=r.querySelector('#ucNote'); return n && n.classList.contains('err') && n.textContent && !r.querySelector('#ucReview').disabled ? 'ERR '+n.textContent : false })()", REVIEW_MS).catch(() => null)
  if (!tk) return { ok: false, detail: `no ticket ${REVIEW_MS / 1000} s after Review; the button reads "${await h.text('#userComposerRoot #ucReview')}", the page says "${await h.text('#userComposerRoot #ucNote')}"`, at: '#userComposerRoot #ucNote' }
  if (tk.startsWith('ERR ')) return { ok: false, detail: `${amount} ${pay} → ${get}: ${tk.slice(4)}`, at: '#userComposerRoot #ucNote' }
  const rows0 = await h.eval("document.querySelectorAll('#userComposerRoot #ucTrades .uc-trade').length")
  // An indicative ticket names its wait (#ucWait): the trade waits for a round, then goes by itself.
  const stated = await h.eval("((document.querySelector('#userComposerRoot #ucWait')||{}).textContent||'').trim()")
  const statedMs = statedWaitMs(stated)
  const ids0 = statedMs != null ? (await h.eval(TRADE_IDS).catch(() => [])) || [] : []
  const tC = Date.now()
  await h.click('#userComposerRoot #ucConfirm')
  if (statedMs != null) {
    const r = await followWaited(h, pay, get, statedMs, tC, ids0)
    const v = { ticketMs: tC - t0, statedMs, stated, ...r }
    // Accepted and never listed (sequentia-web-wallet #770): said as such, with the ticket.
    if (!r.trade) {
      const note = await h.text('#userComposerRoot #ucNote').catch(() => '')
      return { ok: false, waited: true, detail: noRowWords({ head: `${amount} ${pay} → ${get}: waited for a round`, ticket: tk.slice(3), approvedAt: tC, afterMs: Date.now() - tC, site: null, tab: await h.eval(TAB_LISTED).catch(() => null) }) + (note ? `; the Trade tab says "${squeeze(note)}"` : ''), at: '#userComposerRoot #ucTrades' }
    }
    return { ok: waitedInTime(v), waited: true, trade: r.trade, detail: waitedDetail(`${amount} ${pay} → ${get}`, v), at: '#userComposerRoot #ucTrades' }
  }
  const done = await waitValue(h, `(()=>{ const r=document.querySelectorAll('#userComposerRoot #ucTrades .uc-trade'); if(r.length<=${rows0}) return false; const s=(r[0].querySelector('.uc-state')||{}).textContent||''; return /^(Received|Settled|Returned)/.test(s) ? s : false })()`, boundOf(pay)).catch(() => null)
  const row = await h.eval("((document.querySelector('#userComposerRoot #ucTrades .uc-trade')||{}).innerText||'').replace(/\\s+/g,' ')")
  const note = await h.text('#userComposerRoot #ucNote')
  const secs = ((Date.now() - tC) / 1000).toFixed(1)
  const trade = await h.eval("((document.querySelector('#userComposerRoot #ucTrades .uc-trade')||{}).dataset||{}).trade||null")
  const ticketS = ((tC - t0) / 1000).toFixed(1)
  if (done && !/^Returned/.test(done)) {
    const slow = tC - t0 > TICKET_MS
    // In the tree, "Received" means a round is still needed before its coins can be spent: the
    // line waits for "Settled", SETTLE_ROUND_MS at most.
    let later = null, laterS = null
    if (inTree(pay, get) && !/^Settled/.test(done)) {
      const tR = Date.now()
      later = await waitValue(h, `(()=>{ const r=document.querySelector('#userComposerRoot #ucTrades .uc-trade'); const s=((r||{}).querySelector ? (r.querySelector('.uc-state')||{}).textContent : '')||''; return /^(Settled|Returned)/.test(s) ? s : false })()`, SETTLE_ROUND_MS).catch(() => null)
      if (!later) later = await h.eval("(document.querySelector('#userComposerRoot #ucTrades .uc-trade .uc-state')||{}).textContent||null")
      laterS = ((Date.now() - tR) / 1000).toFixed(1)
    }
    const v = settledInTime(pay, get, done, later)
    const tail = laterS == null ? '' : v.ok ? `, then ${v.word} ${laterS} s later` : `; ${SETTLE_ROUND_MS / 1000} s later it still reads "${v.word}", so what it brought cannot be spent yet`
    return { ok: !slow && v.ok, trade, detail: `${amount} ${pay} → ${get}: firm ticket in ${ticketS} s${slow ? `, over the ${TICKET_MS / 1000} s a person waits at most` : ''}; ${done} after ${secs} s${tail}` }
  }
  // No row of its own yet: the top row is an earlier trade's, and is not reported as this one's.
  const rows1 = await h.eval("document.querySelectorAll('#userComposerRoot #ucTrades .uc-trade').length")
  if (!(rows1 > rows0)) {
    return { ok: false, detail: noRowWords({ head: `${amount} ${pay} → ${get}: firm ticket`, ticket: tk.slice(3), approvedAt: tC, afterMs: Date.now() - tC, site: null, tab: await h.eval(TAB_LISTED).catch(() => null) }) + (note ? `; the Trade tab says "${squeeze(note)}"` : ''), at: '#userComposerRoot #ucTrades' }
  }
  return { ok: false, detail: `${amount} ${pay} → ${get}: after ${secs} s the trade reads "${row || 'no row'}"${note ? '; ' + note : ''}`, at: '#userComposerRoot #ucTrades' }
}

// The ids of the trades the Trade tab lists now.
const TRADE_IDS = "[...document.querySelectorAll('#userComposerRoot #ucTrades .uc-trade')].map((d)=>d.dataset.trade)"
// Follows the Trade tab's row of a trade that waits for a round, from the confirmation at `tC`,
// until it ends or OVERRUN times its stated wait has passed: the trade listed now that was not
// among `ids0` before the confirmation. -> { trade, end, endedMs, word }
async function followWaited (h, pay, get, statedMs, tC, ids0, trade = null) {
  const sel = (t) => `#userComposerRoot #ucTrades .uc-trade[data-trade=${JSON.stringify(String(t))}]`
  let word = ''
  for (;;) {
    if (!trade) trade = ((await h.eval(TRADE_IDS).catch(() => [])) || []).find((t) => t && !ids0.includes(t)) || null
    if (trade) {
      word = await h.eval(`((document.querySelector(${JSON.stringify(sel(trade))})||{}).querySelector?.('.uc-state')||{}).textContent||''`).catch(() => word)
      const end = endWord(pay, get, word)
      if (end) return { trade, end, endedMs: Date.now() - tC, word }
    }
    if (Date.now() - tC > OVERRUN * statedMs) return { trade, end: null, endedMs: null, word: word || 'no row' }
    await sleep(2000)
  }
}

// One trade on SeqDEX's market page through the web wallet open in another tab. -> { ok, detail }
async function dexTrade (b, site, wallet, pair, side, amount) {
  // What the wallet pays and gets: the pair is shown base-quote; a purchase pays the quote.
  const [base, quote] = pair.split('-')
  const pay = side === 'buy' ? quote : base, get = side === 'buy' ? base : quote
  await b.send('Page.navigate', { url: DEX + 'market.html?pair=' + pair }, site.page.sessionId)
  await site.waitFor("!!document.querySelector('#fGo')", 90000)
  await site.waitFor("document.querySelector('#btnConnect').classList.contains('ok') && /\\d/.test(document.querySelector('#fBal').innerText)", 60000).catch(() => null)
  await site.click('#side-' + side); await sleep(300)
  await site.click('#type-market'); await sleep(1500)
  // The ticket is drawn again as the page's data arrives: the amount is typed until it stays.
  const field = side === 'buy' ? '#fReceive' : '#fPay'
  for (let i = 0; i < 5; i++) {
    await site.type(field, amount); await sleep(1500)
    if ((await site.eval(`(document.querySelector('${field}')||{}).value`)) === amount) break
  }
  await site.eval("(document.querySelector('#fStatus').className='status', document.querySelector('#fStatus').textContent='', true)")
  const tGo = Date.now()
  await site.click('#fGo')
  // The wallet's dialog, or the site's word that the wallet refused before showing one.
  const first = await Promise.race([
    wallet.waitFor("(()=>{const m=document.querySelector('#pageApiApproval'); return m && m.innerText ? true : false})()", REVIEW_MS).then(() => 'dialog', () => null),
    site.waitFor("(()=>{const s=document.querySelector('#fStatus'); return !!s && s.classList.contains('err')})()", REVIEW_MS).then(() => 'refused', () => null),
  ])
  if (first !== 'dialog') return { ok: false, detail: `${side} ${amount} of ${pair}: ${first === 'refused' ? await site.text('#fStatus') : `no dialog in the wallet ${REVIEW_MS / 1000} s after the button`}`, at: '#fStatus' }
  const tC = Date.now()
  const dialogS = ((tC - tGo) / 1000).toFixed(1)
  const slowDialog = tC - tGo > TICKET_MS
  // An indicative ticket in the dialog names its wait: the trade waits for a round and goes by
  // itself, which the site says is under way; it is followed in the wallet's Trade tab.
  // The dialog's words are the ticket the trade is accepted with, reported when it leaves no row.
  const dialog = await wallet.eval("((document.querySelector('#pageApiApproval')||{}).innerText||'')").catch(() => '')
  const stated = (String(dialog).match(WAIT_WORDS) || [''])[0]
  const statedMs = statedWaitMs(stated)
  // The trades the wallet lists before approval: the one it lists after is this trade's.
  const ids0 = (await wallet.eval(TRADE_IDS).catch(() => [])) || []
  await wallet.click('#pageApiApprove')
  if (statedMs != null) {
    const st = await waitValue(site, "(()=>{const s=document.querySelector('#fStatus'); return s && (s.classList.contains('ok')||s.classList.contains('err')) ? (s.classList.contains('ok')?'ok ':'err ')+s.textContent : false})()", BOUND_MS).catch(() => null)
    if (!st || !st.startsWith('ok ')) return { ok: false, waited: true, detail: `${side} ${amount} of ${pair}: waited for a round, ticket "${stated}" in ${dialogS} s; after approval the site says "${st ? st.slice(st.indexOf(' ') + 1) : 'nothing'}"`, at: '#fStatus' }
    const r = await followWaited(wallet, pay, get, statedMs, tC, ids0)
    const v = { ticketMs: tC - tGo, statedMs, stated, ...r }
    // Accepted and never listed (sequentia-web-wallet #770): said as such, with the ticket.
    if (!r.trade) return { ok: false, waited: true, detail: noRowWords({ head: `${side} ${amount} of ${pair}: waited for a round, dialog in ${dialogS} s`, ticket: dialog, approvedAt: tC, afterMs: Date.now() - tC, site: await site.text('#fStatus').catch(() => ''), tab: await wallet.eval(TAB_LISTED).catch(() => null) }), at: '#fStatus' }
    return { ok: waitedInTime(v), waited: true, detail: waitedDetail(`${side} ${amount} of ${pair} (the site: "${st.slice(3)}")`, v), at: '#fStatus' }
  }
  // The site draws its form again after a trade, so #fStatus can be missing for a moment.
  const st = await waitValue(site, "(()=>{const s=document.querySelector('#fStatus'); return s && (s.classList.contains('ok')||s.classList.contains('err')) ? (s.classList.contains('ok')?'ok ':'err ')+s.textContent : false})()", BOUND_MS).catch(() => null)
  const secs = ((Date.now() - tC) / 1000).toFixed(1)
  // Paid with BTC: done only once the BTC is paid and what it bought is collected, which the
  // wallet's Trade tab row says ("Received" or "Settled"), within BTC_PAID_BOUND_MS. The site's own
  // word (it said "Traded" before the BTC was paid) is reported, never taken for it.
  if (pay === 'BTC' && st && st.startsWith('ok ')) {
    const r = await followWaited(wallet, pay, get, BTC_PAID_BOUND_MS / OVERRUN, tC, ids0)
    const done = r.end === 'done'
    const took = ((r.endedMs ?? (Date.now() - tC)) / 1000).toFixed(1)
    return { ok: done && !slowDialog, trade: r.trade, detail: `${side} ${amount} of ${pair}: dialog in ${dialogS} s; the site said "${st.slice(3)}"; the wallet's row ${done ? `reads "${r.word}" after ${took} s` : `reads "${r.word}" after ${took} s, not Received`}`, at: '#fStatus' }
  }
  if (st && st.startsWith('ok ') && /Traded with/.test(st)) return { ok: !slowDialog, detail: `${side} ${amount} of ${pair}: firm ticket, dialog in ${dialogS} s${slowDialog ? `, over the ${TICKET_MS / 1000} s a person waits at most` : ''}; ${st.slice(3)} after ${secs} s` }
  // A firm trade the site says is under way: followed in the wallet's Trade tab to its end, and
  // judged on the time, BOUND_MS as for any firm trade (ops #239).
  if (st && st.startsWith('ok ') && /under way/i.test(st)) {
    const head = `${side} ${amount} of ${pair}: firm ticket, dialog in ${dialogS} s${slowDialog ? `, over the ${TICKET_MS / 1000} s a person waits at most` : ''}; the site said "${st.slice(3)}"`
    const r = await followWaited(wallet, pay, get, BOUND_MS, tC, ids0)
    if (!r.trade) return { ok: false, detail: noRowWords({ head, ticket: dialog, approvedAt: tC, afterMs: Date.now() - tC, site: await site.text('#fStatus').catch(() => ''), tab: await wallet.eval(TAB_LISTED).catch(() => null) }), at: '#fStatus' }
    return { ok: followedInTime(r, BOUND_MS) && !slowDialog, trade: r.trade, detail: `${head}; ${followedWords(r, BOUND_MS)}`, at: '#fStatus' }
  }
  return { ok: false, detail: `${side} ${amount} of ${pair}: after ${secs} s the site says "${st ? st.slice(st.indexOf(' ') + 1) : await site.text('#fStatus') || 'nothing'}"`, at: '#fStatus' }
}

// The parts of the page's leaf wallet state that stillMoving reads, as plain data.
const LEAF_STATE = `(()=>{ const s=window.__leavesApi && window.__leavesApi.state; if(!s) return null;
  return { participations:(s.participations||[]).map(p=>({ participation:p.participation, state:p.state, released:!!p.released })),
    coins:(s.coins||[]).map(c=>({ state:c.state })) } })()`
// Keeps the trader's page open until nothing of it is moving, LEAVE_MS at most, and says how it left.
async function leaveSettled (w, report) {
  const t0 = Date.now()
  let left = null, btc = { unpaid: 0, unclaimed: 0 }
  for (;;) {
    left = stillMoving(await w.eval(LEAF_STATE).catch(() => null))
    btc = btcPurchasesOpen(await w.eval(TRADE_RECORDS).catch(() => []))
    const quiet = (!left || (!left.participations.length && !left.coins)) && !btc.unpaid && !btc.unclaimed
    if (quiet || Date.now() - t0 > LEAVE_MS) break
    await sleep(15000)
  }
  const mins = ((Date.now() - t0) / 60000).toFixed(1)
  if (btc.unpaid || btc.unclaimed) report.note(`trader: after ${mins} min, BTC purchases not done: ${btc.unpaid} not yet paid (nothing traded if the page closes), ${btc.unclaimed} paid and not yet collected`)
  else report.note('trader: every BTC purchase is paid and collected')
  if (!left) report.note(`trader: its leaf wallet could not be read; the page closes after ${mins} min`)
  else if (!left.participations.length && !left.coins) report.note(`trader: nothing waits for a round; the page closes after ${mins} min`)
  else report.note(`trader: after ${mins} min still waiting: ${left.participations.join(', ') || 'no refresh'}; ${left.coins} coin(s) moving. The page closes now`)
}

// The lines' own words.
const tabLine = (pay, get, amount) => `The Trade tab prices ${amount} ${pay} for ${get} within ${TICKET_MS / 1000} s and trades it within ${boundOf(pay) / 1000} s, or within the wait its ticket states`
const dexLine = (pair, side, amount) => `SeqDEX through the web wallet: a market ${side} of ${amount} on ${pair}, priced within ${TICKET_MS / 1000} s and traded within ${BOUND_MS / 1000} s, or within the wait its ticket states`
const fundedLine = 'The trader holds what the trade lines pay from its own holdings, topped up from the public faucet when short'
const tradableLine = () => `After a restore in a fresh profile, the Trade tab lists what the wallet holds within ${TRADABLE_BOUND_MS / 1000} s of the restore ending`

// What each line pays, from the line itself: a Trade tab line states what it pays; a SeqDEX purchase
// states what it receives, a sale what it pays (lib/holdings.mjs lineNeed).
export function tabNeed ([id, pay, get, amount]) { return { id: 'WW-TRADE-' + id, pay, get, payAmount: amount } }
export function dexNeed ([id, pair, side, amount]) {
  const [base, quote] = pair.split('-')
  return side === 'buy' ? { id: 'DX-TRADE-' + id, pay: quote, get: base, getAmount: amount } : { id: 'DX-TRADE-' + id, pay: base, get: quote, payAmount: amount }
}

// After a restore ends, the Trade tab may take a while to list what the wallet holds
// (sequentia-web-wallet #767): a person reads an empty chooser meanwhile. The trade lines start
// only once it lists it, TRADABLE_WAIT_MS at most; a restore in a fresh profile has its line
// (WW-RESTORE-TRADABLE), bounded by TRADABLE_BOUND_MS.
export const TRADABLE_BOUND_MS = 15_000
const TRADABLE_WAIT_MS = 5 * 60_000
// A faucet payment is shown by the wallet, and can be traded, within TOPUP_MS at most.
const TOPUP_MS = 5 * 60_000

// The trader's holdings, read from its page: the Trade tab's chooser (a ticket left open is
// cancelled first, as a person would) and the page's own answers. -> { snap, rows, list }
async function readHoldings (w, { chooser = true } = {}) {
  let rows = null
  if (chooser) {
    await w.click('[data-tab=swap]').catch(() => {}); await sleep(600)
    await w.eval("(()=>{ const c=document.querySelector('#userComposerRoot #ucCancel'); if(c) c.click(); return true })()").catch(() => {})
    await w.waitFor("!!document.querySelector('#userComposerRoot #ucPay')", 30000).catch(() => {})
    rows = await w.eval(CHOOSER_READ).catch(() => null)
  }
  const snap = await w.eval(HOLDINGS_READ).catch(() => null)
  return { snap, rows, list: snap ? holdingsOf(snap, rows) : null }
}
function printHoldings (report, when, hold) { for (const l of holdingsLines(when, hold && hold.list)) report.note(l) }

// Waits until the Trade tab lists every asset the library says the wallet can spend now, and the
// wallet no longer steps its restored history (`stillRestoring`: until then it refuses a trade that
// would wait on money, "Your wallet is still being restored"). -> { ms, ok, missing, expected,
// restoring (still stepping when the wait ended), listedMs (when the tab first listed it all) }
async function waitTradable (w, t0) {
  let last = null, listedMs = null
  for (;;) {
    const hold = await readHoldings(w)
    last = chooserListsHeld(hold.snap, hold.rows)
    if (last.ok && listedMs == null) listedMs = Date.now() - t0
    const restoring = !!(hold.snap && hold.snap.stillRestoring)
    if ((last.ok && !restoring) || Date.now() - t0 > TRADABLE_WAIT_MS) return { ms: listedMs ?? Date.now() - t0, ...last, restoring, readyMs: Date.now() - t0 }
    await sleep(2000)
  }
}

// Whether a rise of `rose` atoms is the payment of `want` (null: not read) arriving: all of it, less
// at most 1% for the fee of moving it in.
export function arrivedWhole (rose, want) { return rose > 0n && (want == null || rose * 100n >= want * 99n) }

// Asks the public faucet page for `ticker`, to the trader's own receive code, as a person would,
// and waits until the wallet shows it and can trade it. -> { ok, words }
async function topUp (b, w, ticker, before) {
  const say = (x) => ({ ...x, words: `${ticker}: ${x.words}` })
  await w.click('[data-tab=receive]').catch(() => {})
  const code = await waitValue(w, "(()=>{ const t=((document.querySelector('#addr')||{}).textContent||'').trim(); return /^bitcoin:/i.test(t) ? t : false })()", 180000).catch(() => null)
  if (!code) return say({ ok: false, words: 'not asked: the wallet showed no receive code within 180 s' })
  const fp = await b.page('about:blank')
  const f = helpers(fp)
  try {
    // The suite's token, when it has one (README, "The faucet token"), on the faucet's own requests.
    await faucetPass(b, fp, ORIGIN).catch(() => false)
    await b.send('Page.navigate', { url: FAUCET }, fp.sessionId)
    await f.waitFor('!!document.querySelector(\'#addr\') && !!document.querySelector(\'#assets\')', 60000)
    if (!(await f.eval(`!!document.querySelector(${JSON.stringify(faucetButton(ticker))})`))) return say({ ok: false, words: 'not asked: the faucet page offers no button for it' })
    await f.type('#addr', code)
    const h0 = (before || []).find((x) => x.ticker === ticker)
    const had = usable(h0), hadNow = (h0 && h0.now) || 0n
    const tAsk = Date.now()
    await f.click(faucetButton(ticker))
    const said = await waitValue(f, "(()=>{ const m=document.querySelector('#log .msg'); return m && !m.classList.contains('busy') ? m.className+' '+m.textContent : false })()", 120000).catch(() => null)
    const text = said ? said.replace(/^msg (ok|err) /, '') : 'nothing within 120 s'
    const sent = said && /^msg ok /.test(said) ? faucetSent(text) : null
    const asked = `asked the public faucet page for it to the trader's receive code (${code.slice(0, 18)}…); it said "${squeeze(text, 160)}"`
    if (!sent) return say({ ok: false, words: asked })
    const want = atomsOf(sent.amount, 8)
    // Shown: what the wallet can count on rose by what was sent; tradable: the Trade tab's figure
    // did. A payment to the address is moved in for a fee in its own asset, so the rise may fall
    // short of what was sent by that fee (arrivedWhole).
    let shownMs = null, nowMs = null, rose = 0n
    while (Date.now() - tAsk < TOPUP_MS) {
      const hold = await readHoldings(w)
      const h = hold.list && hold.list.find((x) => x.ticker === ticker)
      if (shownMs == null && arrivedWhole(usable(h) - had, want)) shownMs = Date.now() - tAsk
      rose = ((h && h.now) || 0n) - hadNow
      if (arrivedWhole(rose, want)) { nowMs = Date.now() - tAsk; if (shownMs == null) shownMs = nowMs; break }
      await sleep(3000)
    }
    const s = (ms) => (ms / 1000).toFixed(1)
    const tail = nowMs != null ? `; the wallet showed it after ${s(shownMs)} s and could trade ${units(rose, 8)} ${ticker} more after ${s(nowMs)} s`
      : shownMs != null ? `; the wallet showed it after ${s(shownMs)} s, and could not trade it yet ${s(TOPUP_MS)} s after asking`
        : `; ${s(TOPUP_MS)} s after asking the wallet shows none of it`
    return say({ ok: shownMs != null, words: asked + tail })
  } catch (e) {
    return say({ ok: false, words: 'the faucet page could not be used: ' + String(e && e.message || e).split('\n')[0] })
  } finally { await b.send('Target.closeTarget', { targetId: fp.targetId }).catch(() => {}) }
}

export async function run ({ b, report, trader }) {
  const lines = [...TAB_TRADES.map((t) => ['WW-TRADE-' + t[0], tabLine(t[1], t[2], t[3])]),
    ...DEX_TRADES.map((t) => ['DX-TRADE-' + t[0], dexLine(t[1], t[2], t[3])])]
  if (!trader) {
    report.skip('WW-RESTORE-TRADABLE', 'desktop', tradableLine(), 'no trader wallet (--trader)')
    report.skip('WW-TRADER-FUNDED', 'desktop', fundedLine, 'no trader wallet (--trader)')
    for (const [id, line] of lines) report.skip(id, 'desktop', line, 'no trader wallet (--trader)')
    return
  }
  const wp = await b.page('about:blank')
  const w = helpers(wp)
  // The trader holds weeks of trades: its restore in a fresh profile is the long-history restore a
  // person meets on a new device, bounded on a line of its own.
  // Its profile is kept between runs (run.mjs), so it restores once; the line is measured when the
  // restore is made afresh, and otherwise says how long the wallet took to open again.
  let opened = false
  const restoreLine = `A wallet with weeks of trades, restored from its phrase in a fresh profile, finishes its restore within ${RESTORE_BOUND_MS / 1000} s`
  let o = null
  try { o = await openTrader(b, w, trader.phrase); opened = true } catch (e) { o = { error: String(e && e.message || e) } }
  const tOpen = Date.now()
  if (o.error || o.fresh) {
    await report.line('WW-RESTORE-LONG', 'desktop', restoreLine, wp, async () => (o.error
      ? { ok: false, detail: `not open after ${RESTORE_MS / 60000} min: ${o.error}`, at: '#app' }
      : { ok: o.s * 1000 <= RESTORE_BOUND_MS, detail: `the restore ended after ${o.s} s`, at: '#app' }))
  } else report.skip('WW-RESTORE-LONG', 'desktop', restoreLine, `the trader's profile is kept between runs: no restore this run (the wallet opened again in ${o.s} s); --fresh-trader restores afresh`)
  if (!opened) {
    for (const [id, line] of [['WW-RESTORE-TRADABLE', tradableLine()], ['WW-TRADER-FUNDED', fundedLine], ...lines]) report.skip(id, 'desktop', line, `the trader wallet did not open within ${RESTORE_MS / 60000} min (WW-RESTORE-LONG)`)
    return
  }
  try {
    // The trade lines start once the Trade tab lists what the wallet holds.
    const t = await waitTradable(w, tOpen)
    const s = (t.ms / 1000).toFixed(1)
    const words = t.unread ? `the wallet's balance or its Trade tab could not be read within ${s} s`
      : !t.expected.length ? `the library says the wallet can spend nothing now; the Trade tab was read after ${s} s`
        : t.ok ? `the Trade tab lists ${t.expected.join(', ')} ${s} s after the restore ended` : `${s} s after the restore ended the Trade tab still lists no ${t.missing.join(', ')} that the library says the wallet can spend`
    report.note(`trader: ${words}`)
    report.note(t.restoring ? `trader: ${(t.readyMs / 1000).toFixed(1)} s after the restore ended the wallet still steps its restored history; the trades start anyway`
      : `trader: the trades start ${(t.readyMs / 1000).toFixed(1)} s after the restore ended, its history stepped`)
    if (o.fresh) await report.line('WW-RESTORE-TRADABLE', 'desktop', tradableLine(), wp, async () => ({ ok: t.ok && t.ms <= TRADABLE_BOUND_MS, detail: words, at: '#userComposerRoot' }))
    else report.skip('WW-RESTORE-TRADABLE', 'desktop', tradableLine(), `no restore this run (the profile is kept); ${words}`)
    await tradeLines(b, report, w, wp)
  } finally {
    await leaveSettled(w, report)
    printHoldings(report, 'at the end', await readHoldings(w).catch(() => null))
  }
}

// Each line's need, read against the price feed for a SeqDEX purchase that names what it receives.
async function needsNow () {
  const prices = await fetch(ORIGIN + '/prices', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  return { prices, needs: [...TAB_TRADES.map(tabNeed), ...DEX_TRADES.map(dexNeed)].map((n) => lineNeed(n, prices)) }
}

// The wallet's words when it refuses a trade for want of what it pays.
const FUNDS_REFUSED = /You have no \S+ to trade|in the chooser|That is more than your|can be traded now, too little/

async function tradeLines (b, report, w, wp) {
  // What the trader holds at the start, and whether it is what the lines need; short of an asset the
  // public faucet gives, it is asked for it first.
  let hold = await readHoldings(w)
  printHoldings(report, 'at the start', hold)
  const { prices, needs } = await needsNow()
  const need = new Map(needs.map((n) => [n.id, n]))
  let verdict = fundedVerdict(needs, hold.list)
  const topups = []
  if (!verdict.ok && hold.list) {
    for (const ticker of verdict.short) {
      if (ticker === 'BTC') continue
      const r = await topUp(b, w, ticker, hold.list)
      report.note(`trader: top-up of ${r.words}`)
      topups.push(r)
    }
    if (topups.length) { hold = await readHoldings(w); verdict = fundedVerdict(needs, hold.list, topups); printHoldings(report, 'after the top-up', hold) }
  }
  await report.line('WW-TRADER-FUNDED', 'desktop', fundedLine, wp, async () => (hold.list
    ? { ok: verdict.ok, detail: verdict.detail + (prices ? '' : '. The price feed could not be read: a SeqDEX purchase\'s need is not counted') }
    : { ok: false, detail: 'what the trader holds could not be read from its page' }))

  // A sale sells what the purchase before it bought: when that purchase did not trade, or was
  // skipped, and the wallet lacks what the sale pays, the sale is SKIP saying where that asset is.
  const bought = new Map()
  const pairOf = (id) => id.replace(/-(BUY|SELL)$/, '')
  // Each trade is counted by the kind of its ticket, which the summary prints: a run that passes by
  // waiting for rounds everywhere is seen as such.
  const counted = (id, fn) => async () => {
    const r = await fn()
    if (r && !r.skip && r.waited) report.tally('Trades that waited for a round (an indicative ticket)', id)
    else if (r && !r.skip && r.ok) report.tally('Trades priced firm', id)
    return r
  }
  const before = (key) => (bought.get(key) === false ? 'did not trade' : bought.get(key) === 'skip' ? 'was skipped' : null)
  // The trader's holding of `ticker` (null when it holds none), or undefined when its page could not be read.
  const holdingOf = async (ticker) => { const hh = await readHoldings(w).catch(() => null); return hh && hh.list ? hh.list.find((x) => x.ticker === ticker) || null : undefined }
  // Before a line: does the trader have what it pays? A line paying from the trader's own holdings
  // (USDX) is SKIP when it is short, as WW-TRADER-FUNDED says; a line paying what the purchase
  // before it bought is SKIP when that purchase did not trade and the wallet lacks it.
  const gate = async (id, key) => {
    const n = need.get(id)
    if (!n || n.atoms == null) return null
    if (n.from === 'bought' && !before(key)) return null
    const h = await holdingOf(n.pay)
    if (h === undefined || usable(h) >= n.atoms) return null
    if (n.from === 'held') return { skip: `the trader is short of ${n.pay} (WW-TRADER-FUNDED): the line pays ${n.how}; ${whereWords(h, n.atoms, n.pay)}` }
    return { skip: `the ${n.pay} it pays comes from the purchase before it, which ${before(key)}; ${whereWords(h, n.atoms, n.pay)}` }
  }
  // A line that ran and was refused for want of what it pays, after a purchase that did not trade:
  // SKIP, saying where the asset is, rather than a second failure.
  const unlessUnbought = (id, key, fn) => async () => {
    const g = await gate(id, key)
    if (g) return g
    const r = await fn()
    if (!r.ok && FUNDS_REFUSED.test(String(r.detail))) {
      const n = need.get(id)
      const h = await holdingOf(n ? n.pay : '')
      const where = h === undefined ? 'what the wallet holds could not be read' : whereWords(h, n && n.atoms, n && n.pay)
      if (before(key)) return { skip: `the purchase before it ${before(key)}; ${where}: ${r.detail}` }
      // The wallet had what the line pays, or was to have it: a failure, saying where it was.
      return { ...r, detail: `${r.detail} (${where})` }
    }
    return r
  }
  const mark = (id, key, ok) => { if (id.endsWith('-BUY')) bought.set(key, ok) }
  const lastStatus = () => { const r = report.rows[report.rows.length - 1]; return r ? r.status : null }
  let arkPurchase = null   // the purchase paid with BTC from the Bitcoin ark: { trade, t }
  for (const [id, pay, get, amount] of TAB_TRADES) {
    const line = tabLine(pay, get, amount)
    const key = 'WW-' + pairOf(id)
    const ok = await report.line('WW-TRADE-' + id, 'desktop', line, wp, counted('WW-TRADE-' + id, unlessUnbought('WW-TRADE-' + id, key, () => tabTrade(w, pay, get, amount)
      .then((r) => { if (r.ok && pay === 'BTC' && r.trade) arkPurchase = { trade: r.trade, t: Date.now() }; return r })
      .catch((e) => ({ ok: false, detail: String(e && e.message || e) })))))
    mark(id, key, lastStatus() === 'SKIP' ? 'skip' : !!ok)
    await sleep(3000)
  }
  // SeqDEX in a second tab, connected through the chooser's web wallet row.
  const sp = await b.page(DEX + 'market.html?pair=GOLD-USDX')
  const s = helpers(sp)
  let connected = false
  try {
    await s.waitFor("!!document.querySelector('#btnConnect')", 90000)
    await s.click('#btnConnect')
    await s.waitFor("!!document.querySelector('#connectMenu [data-connector=\"webwallet\"]')", 30000)
    await s.click('#connectMenu [data-connector="webwallet"]')
    await w.waitFor("(()=>{const m=document.querySelector('#pageApiApproval'); return m && m.innerText ? true : false})()", 60000)
    await w.click('#pageApiApprove')
    await s.waitFor("document.querySelector('#btnConnect').classList.contains('ok')", 60000)
    connected = true
  } catch (e) { connected = String(e && e.message || e) }
  for (const [id, pair, side, amount] of DEX_TRADES) {
    const line = dexLine(pair, side, amount)
    const key = 'DX-' + pairOf(id)
    if (connected !== true) { await report.line('DX-TRADE-' + id, 'desktop', line, sp, async () => ({ ok: false, detail: 'SeqDEX did not connect to the web wallet: ' + connected })); mark(id, key, false); continue }
    const ok = await report.line('DX-TRADE-' + id, 'desktop', line, sp, counted('DX-TRADE-' + id, unlessUnbought('DX-TRADE-' + id, key, () => dexTrade(b, s, w, pair, side, amount).catch((e) => ({ ok: false, detail: String(e && e.message || e) })))))
    mark(id, key, lastStatus() === 'SKIP' ? 'skip' : !!ok)
    await sleep(3000)
  }
  // The purchase paid with BTC from the Bitcoin ark reaches Settled, not only Received (#98): the
  // wallet page stays open, as a person's would, and its row is read until it settles.
  const settleLine = `A purchase paid with BTC from the Bitcoin ark reaches Settled within ${SETTLE_MS / 60000} min`
  if (!arkPurchase) { report.skip('WW-TRADE-BTC-ARK-SETTLED', 'desktop', settleLine, 'the BTC purchase above did not trade'); return }
  await w.click('[data-tab=swap]').catch(() => {})
  await report.line('WW-TRADE-BTC-ARK-SETTLED', 'desktop', settleLine, wp, async () => {
    const q = `(()=>{ const d=document.querySelector('#userComposerRoot #ucTrades .uc-trade[data-trade=${JSON.stringify(JSON.stringify(arkPurchase.trade)).slice(1, -1)}]'); return d ? d.dataset.state+' '+((d.querySelector('.uc-state')||{}).textContent||'') : 'gone' })()`
    let st = ''
    while (Date.now() - arkPurchase.t < SETTLE_MS) {
      st = await w.eval(q).catch(() => st)
      if (/^(settled|returned|failed) /.test(st)) break
      await sleep(15000)
    }
    const mins = ((Date.now() - arkPurchase.t) / 60000).toFixed(1)
    return { ok: /^settled /.test(st), detail: `after ${mins} min the trade reads "${st.replace(/^\S+ /, '')}" (${st.split(' ')[0]})`, at: '#userComposerRoot #ucTrades' }
  })
}
