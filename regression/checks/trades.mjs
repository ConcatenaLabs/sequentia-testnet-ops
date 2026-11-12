// Live trades: small market buys and sells on the testnet that move real (test) coins, from the
// web wallet's Trade tab and from SeqDEX through the web wallet, each bounded in time. A screen can
// look right while trading is broken; these lines fail when a trade does not happen, with the
// reason the wallet or the site gives.
//
// The trader is one web wallet, restored from its phrase (--trader, default
// ~/.local/share/sequentia-regression/wallets/rgtrader.phrase) into a fresh profile; without it
// every line is SKIP. It holds USDX: each pair is bought first and the bought amount sold back,
// so the wallet ends about where it started, less the fees. Refill it with USDX from the faucet
// (its Receive tab) or from treasury2026.
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
import { sleep, helpers } from '../lib/suite.mjs'

const WALLET = 'https://sequentiatestnet.com/wallet/'
const DEX = 'https://sequentiatestnet.com/dex/'
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
// The wait an indicative ticket states, from the wallet's words (`goesThrough` in the web wallet's
// default-arca.js and user-trade.js), in ms; null for a firm ticket, which names no wait.
export function statedWaitMs (text) {
  const t = String(text || '')
  if (/Goes through in about a minute/.test(t)) return 60_000
  const m = t.match(/Goes through within about (\d+) minutes/)
  return m ? Number(m[1]) * 60_000 : null
}
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
function waitedDetail (head, { ticketMs, statedMs, endedMs, end, word, stated }) {
  const tail = endedMs == null
    ? `still reads "${word}" ${secs(OVERRUN * statedMs)} s after confirming, ${OVERRUN} times the ${secs(statedMs)} s stated`
    : end === 'returned' ? `${word} after ${secs(endedMs)} s (stated ${secs(statedMs)} s)`
      : `${word} after ${secs(endedMs)} s, ${endedMs <= statedMs ? 'within' : 'past'} the ${secs(statedMs)} s stated`
  return `${head}: waited for a round, ticket "${stated}" in ${secs(ticketMs)} s${ticketMs > TICKET_MS ? `, over the ${TICKET_MS / 1000} s a person waits at most` : ''}; ${tail}`
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
    return { ok: false, detail: `${amount} ${pay} → ${get}: confirmed, and after ${secs} s the trade is not in the list yet${note ? ': ' + note : ''}`, at: '#userComposerRoot #ucTrades' }
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
  const stated = ((await wallet.eval("((document.querySelector('#pageApiApproval')||{}).innerText||'')").catch(() => '')).match(/Goes through (in about a minute|within about \d+ minutes)/) || [''])[0]
  const statedMs = statedWaitMs(stated)
  const ids0 = statedMs != null ? (await wallet.eval(TRADE_IDS).catch(() => [])) || [] : []
  const ids0Btc = pay === 'BTC' && statedMs == null ? (await wallet.eval(TRADE_IDS).catch(() => [])) || [] : []
  await wallet.click('#pageApiApprove')
  if (statedMs != null) {
    const st = await waitValue(site, "(()=>{const s=document.querySelector('#fStatus'); return s && (s.classList.contains('ok')||s.classList.contains('err')) ? (s.classList.contains('ok')?'ok ':'err ')+s.textContent : false})()", BOUND_MS).catch(() => null)
    if (!st || !st.startsWith('ok ')) return { ok: false, waited: true, detail: `${side} ${amount} of ${pair}: waited for a round, ticket "${stated}" in ${dialogS} s; after approval the site says "${st ? st.slice(st.indexOf(' ') + 1) : 'nothing'}"`, at: '#fStatus' }
    const r = await followWaited(wallet, pay, get, statedMs, tC, ids0)
    const v = { ticketMs: tC - tGo, statedMs, stated, ...r }
    return { ok: waitedInTime(v), waited: true, detail: waitedDetail(`${side} ${amount} of ${pair} (the site: "${st.slice(3)}")`, v), at: '#fStatus' }
  }
  // The site draws its form again after a trade, so #fStatus can be missing for a moment.
  const st = await waitValue(site, "(()=>{const s=document.querySelector('#fStatus'); return s && (s.classList.contains('ok')||s.classList.contains('err')) ? (s.classList.contains('ok')?'ok ':'err ')+s.textContent : false})()", BOUND_MS).catch(() => null)
  const secs = ((Date.now() - tC) / 1000).toFixed(1)
  // Paid with BTC: done only once the BTC is paid and what it bought is collected, which the
  // wallet's Trade tab row says ("Received" or "Settled"), within BTC_PAID_BOUND_MS. The site's own
  // word (it said "Traded" before the BTC was paid) is reported, never taken for it.
  if (pay === 'BTC' && st && st.startsWith('ok ')) {
    const r = await followWaited(wallet, pay, get, BTC_PAID_BOUND_MS / OVERRUN, tC, ids0Btc)
    const done = r.end === 'done'
    const took = ((r.endedMs ?? (Date.now() - tC)) / 1000).toFixed(1)
    return { ok: done && !slowDialog, trade: r.trade, detail: `${side} ${amount} of ${pair}: dialog in ${dialogS} s; the site said "${st.slice(3)}"; the wallet's row ${done ? `reads "${r.word}" after ${took} s` : `reads "${r.word}" after ${took} s, not Received`}`, at: '#fStatus' }
  }
  if (st && st.startsWith('ok ') && /Traded with/.test(st)) return { ok: !slowDialog, detail: `${side} ${amount} of ${pair}: firm ticket, dialog in ${dialogS} s${slowDialog ? `, over the ${TICKET_MS / 1000} s a person waits at most` : ''}; ${st.slice(3)} after ${secs} s` }
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

export async function run ({ b, report, trader }) {
  const lines = [...TAB_TRADES.map((t) => ['WW-TRADE-' + t[0], tabLine(t[1], t[2], t[3])]),
    ...DEX_TRADES.map((t) => ['DX-TRADE-' + t[0], dexLine(t[1], t[2], t[3])])]
  if (!trader) { for (const [id, line] of lines) report.skip(id, 'desktop', line, 'no trader wallet (--trader)'); return }
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
  if (o.error || o.fresh) {
    await report.line('WW-RESTORE-LONG', 'desktop', restoreLine, wp, async () => (o.error
      ? { ok: false, detail: `not open after ${RESTORE_MS / 60000} min: ${o.error}`, at: '#app' }
      : { ok: o.s * 1000 <= RESTORE_BOUND_MS, detail: `the restore ended after ${o.s} s`, at: '#app' }))
  } else report.skip('WW-RESTORE-LONG', 'desktop', restoreLine, `the trader's profile is kept between runs: no restore this run (the wallet opened again in ${o.s} s); --fresh-trader restores afresh`)
  if (!opened) { for (const [id, line] of lines) report.skip(id, 'desktop', line, `the trader wallet did not open within ${RESTORE_MS / 60000} min (WW-RESTORE-LONG)`); return }
  try { await tradeLines(b, report, w, wp) } finally { await leaveSettled(w, report) }
}

async function tradeLines (b, report, w, wp) {
  // A sale sells what the purchase before it bought: when that purchase did not trade and the
  // wallet holds none of it, the sale is SKIP with that reason rather than a second failure.
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
  const unlessUnbought = (key, fn) => async () => {
    const r = await fn()
    if (!r.ok && bought.get(key) === false && /You have no \S+ to trade|in the chooser/.test(String(r.detail))) return { skip: 'the purchase before it did not trade, and the wallet holds none: ' + r.detail }
    return r
  }
  let arkPurchase = null   // the purchase paid with BTC from the Bitcoin ark: { trade, t }
  for (const [id, pay, get, amount] of TAB_TRADES) {
    const line = tabLine(pay, get, amount)
    const ok = await report.line('WW-TRADE-' + id, 'desktop', line, wp, counted('WW-TRADE-' + id, unlessUnbought('WW-' + pairOf(id), () => tabTrade(w, pay, get, amount)
      .then((r) => { if (r.ok && pay === 'BTC' && r.trade) arkPurchase = { trade: r.trade, t: Date.now() }; return r })
      .catch((e) => ({ ok: false, detail: String(e && e.message || e) })))))
    if (id.endsWith('-BUY')) bought.set('WW-' + pairOf(id), !!ok)
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
    if (connected !== true) { await report.line('DX-TRADE-' + id, 'desktop', line, sp, async () => ({ ok: false, detail: 'SeqDEX did not connect to the web wallet: ' + connected })); continue }
    const ok = await report.line('DX-TRADE-' + id, 'desktop', line, sp, counted('DX-TRADE-' + id, unlessUnbought('DX-' + pairOf(id), () => dexTrade(b, s, w, pair, side, amount).catch((e) => ({ ok: false, detail: String(e && e.message || e) })))))
    if (id.endsWith('-BUY')) bought.set('DX-' + pairOf(id), !!ok)
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
