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
// A line passes when, within BOUND_MS of the person's confirmation, the Trade tab says what was
// bought is received ("Received. Settled after the next Bitcoin blocks." or "Settled"), or SeqDEX
// says "Traded with … order". Otherwise it fails with what the page says at that moment.
import { sleep, helpers } from '../lib/suite.mjs'

const WALLET = 'https://sequentiatestnet.com/wallet/'
const DEX = 'https://sequentiatestnet.com/dex/'
export const BOUND_MS = 60000
const REVIEW_MS = 60000
// A purchase paid with BTC from the Bitcoin ark reads "Received" within BOUND_MS and "Settled" once
// the trade's Bitcoin side is final: the next Bitcoin blocks (about 10 minutes each on testnet4).
export const SETTLE_MS = 60 * 60000

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
  await b.send('Page.navigate', { url: WALLET }, h.page.sessionId)
  await h.waitFor("(()=>{const v=(id)=>{const e=document.getElementById(id); return e && getComputedStyle(e).display!=='none'}; return v('app')||v('welcome')})()", 240000)
  await h.eval(`localStorage.setItem('swk.sequentia.mnemonic', ${JSON.stringify(phrase)}), true`)
  await b.send('Page.navigate', { url: 'about:blank' }, h.page.sessionId); await sleep(1500)
  await b.send('Page.navigate', { url: WALLET }, h.page.sessionId)
  await h.waitFor("document.querySelector('#app') && getComputedStyle(document.querySelector('#app')).display !== 'none'", 240000)
  // Joined: Receive gives a receive code.
  await h.click('[data-tab=receive]')
  await h.waitFor("/^bitcoin:/.test((document.querySelector('#addr')||{}).textContent||'')", 240000)
}

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
  if (!tk) return { ok: false, detail: `no ticket ${REVIEW_MS / 1000} s after Review; the page says "${await h.text('#userComposerRoot #ucNote')}"`, at: '#userComposerRoot #ucNote' }
  if (tk.startsWith('ERR ')) return { ok: false, detail: `${amount} ${pay} → ${get}: ${tk.slice(4)}`, at: '#userComposerRoot #ucNote' }
  const rows0 = await h.eval("document.querySelectorAll('#userComposerRoot #ucTrades .uc-trade').length")
  const tC = Date.now()
  await h.click('#userComposerRoot #ucConfirm')
  const done = await waitValue(h, `(()=>{ const r=document.querySelectorAll('#userComposerRoot #ucTrades .uc-trade'); if(r.length<=${rows0}) return false; const s=(r[0].querySelector('.uc-state')||{}).textContent||''; return /^(Received|Settled|Returned)/.test(s) ? s : false })()`, BOUND_MS).catch(() => null)
  const row = await h.eval("((document.querySelector('#userComposerRoot #ucTrades .uc-trade')||{}).innerText||'').replace(/\\s+/g,' ')")
  const note = await h.text('#userComposerRoot #ucNote')
  const secs = ((Date.now() - tC) / 1000).toFixed(1)
  const trade = await h.eval("((document.querySelector('#userComposerRoot #ucTrades .uc-trade')||{}).dataset||{}).trade||null")
  if (done && !/^Returned/.test(done)) return { ok: true, trade, detail: `${amount} ${pay} → ${get}: ${done} after ${secs} s (ticket in ${((tC - t0) / 1000).toFixed(1)} s)` }
  return { ok: false, detail: `${amount} ${pay} → ${get}: after ${secs} s the trade reads "${row || 'no row'}"${note ? '; ' + note : ''}`, at: '#userComposerRoot #ucTrades' }
}

// One trade on SeqDEX's market page through the web wallet open in another tab. -> { ok, detail }
async function dexTrade (b, site, wallet, pair, side, amount) {
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
  await site.click('#fGo')
  // The wallet's dialog, or the site's word that the wallet refused before showing one.
  const first = await Promise.race([
    wallet.waitFor("(()=>{const m=document.querySelector('#pageApiApproval'); return m && m.innerText ? true : false})()", REVIEW_MS).then(() => 'dialog', () => null),
    site.waitFor("(()=>{const s=document.querySelector('#fStatus'); return !!s && s.classList.contains('err')})()", REVIEW_MS).then(() => 'refused', () => null),
  ])
  if (first !== 'dialog') return { ok: false, detail: `${side} ${amount} of ${pair}: ${first === 'refused' ? await site.text('#fStatus') : `no dialog in the wallet ${REVIEW_MS / 1000} s after the button`}`, at: '#fStatus' }
  const tC = Date.now()
  await wallet.click('#pageApiApprove')
  // The site draws its form again after a trade, so #fStatus can be missing for a moment.
  const st = await waitValue(site, "(()=>{const s=document.querySelector('#fStatus'); return s && (s.classList.contains('ok')||s.classList.contains('err')) ? (s.classList.contains('ok')?'ok ':'err ')+s.textContent : false})()", BOUND_MS).catch(() => null)
  const secs = ((Date.now() - tC) / 1000).toFixed(1)
  if (st && st.startsWith('ok ') && /Traded with/.test(st)) return { ok: true, detail: `${side} ${amount} of ${pair}: ${st.slice(3)} after ${secs} s` }
  return { ok: false, detail: `${side} ${amount} of ${pair}: after ${secs} s the site says "${st ? st.slice(st.indexOf(' ') + 1) : await site.text('#fStatus') || 'nothing'}"`, at: '#fStatus' }
}

export async function run ({ b, report, trader }) {
  const lines = [...TAB_TRADES.map((t) => ['WW-TRADE-' + t[0], `The Trade tab trades ${t[3]} ${t[1]} for ${t[2]} within ${BOUND_MS / 1000} s`]),
    ...DEX_TRADES.map((t) => ['DX-TRADE-' + t[0], `SeqDEX through the web wallet: a market ${t[2]} of ${t[3]} on ${t[1]} within ${BOUND_MS / 1000} s`])]
  if (!trader) { for (const [id, line] of lines) report.skip(id, 'desktop', line, 'no trader wallet (--trader)'); return }
  const wp = await b.page('about:blank')
  const w = helpers(wp)
  await openTrader(b, w, trader.phrase)
  // A sale sells what the purchase before it bought: when that purchase did not trade and the
  // wallet holds none of it, the sale is SKIP with that reason rather than a second failure.
  const bought = new Map()
  const pairOf = (id) => id.replace(/-(BUY|SELL)$/, '')
  const unlessUnbought = (key, fn) => async () => {
    const r = await fn()
    if (!r.ok && bought.get(key) === false && /You have no \S+ to trade|in the chooser/.test(String(r.detail))) return { skip: 'the purchase before it did not trade, and the wallet holds none: ' + r.detail }
    return r
  }
  let arkPurchase = null   // the purchase paid with BTC from the Bitcoin ark: { trade, t }
  for (const [id, pay, get, amount] of TAB_TRADES) {
    const line = `The Trade tab trades ${amount} ${pay} for ${get} within ${BOUND_MS / 1000} s`
    const ok = await report.line('WW-TRADE-' + id, 'desktop', line, wp, unlessUnbought('WW-' + pairOf(id), () => tabTrade(w, pay, get, amount)
      .then((r) => { if (r.ok && pay === 'BTC' && r.trade) arkPurchase = { trade: r.trade, t: Date.now() }; return r })
      .catch((e) => ({ ok: false, detail: String(e && e.message || e) }))))
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
    const line = `SeqDEX through the web wallet: a market ${side} of ${amount} on ${pair} within ${BOUND_MS / 1000} s`
    if (connected !== true) { await report.line('DX-TRADE-' + id, 'desktop', line, sp, async () => ({ ok: false, detail: 'SeqDEX did not connect to the web wallet: ' + connected })); continue }
    const ok = await report.line('DX-TRADE-' + id, 'desktop', line, sp, unlessUnbought('DX-' + pairOf(id), () => dexTrade(b, s, w, pair, side, amount).catch((e) => ({ ok: false, detail: String(e && e.message || e) }))))
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
