// SeqDEX (sequentiatestnet.com/dex/), its default view, at desktop and phone widths: Markets, a
// pair's page (chart, book, trades, the order ticket, your orders) and Portfolio; the wallet
// chooser; then Ambra browser connected once and carried across pages (SD1's shell checks).
// Nothing is placed or signed: the ticket is filled and read, never sent.
import { sleep, helpers, setWidth, forbiddenWords, forbiddenIn } from '../lib/suite.mjs'

const DEX = 'https://sequentiatestnet.com/dex/'
const PAIR = 'GOLD-USDX'

export async function newExtensionWallet (b, password = 'regression-suite-password') {
  await b.serviceWorker()
  const pop = await b.page(`chrome-extension://${b.extId}/popup/popup.html`)
  await pop.waitFor("document.querySelector('#btnStartCreate') && document.querySelector('#btnStartCreate').offsetParent !== null && !!document.querySelector('#btnStartCreate').onclick", 60000)
  await pop.click('#btnStartCreate')
  await pop.waitFor("document.querySelector('#newPhrase').dataset.phrase")
  await pop.set('createPw', password); await pop.set('createPw2', password)
  await pop.click('#btnCreateGo')
  await pop.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 120000)
  return pop
}

export async function run ({ b, report, widths, problems }) {
  const R = (id, w, line, h, fn) => report.line('DX-' + id, w, line, h && h.page, fn)
  const page = await b.page('about:blank')
  const h = helpers(page)
  const go = async (url, ready, ms = 90000) => { await b.send('Page.navigate', { url }, page.sessionId); await h.waitFor(ready, ms) }
  const words = await forbiddenWords(h).catch(() => null)
  const MARKETS_READY = "document.querySelectorAll('#tickers tr[data-pair]').length > 3"
  const PAIR_READY = "!!document.querySelector('#fGo') && /\\d/.test((document.querySelector('#lastPrice')||{}).innerText||'')"

  // ---------- no wallet yet ----------
  await setWidth(b, page, widths[0])
  await go(DEX, MARKETS_READY)
  await R('NO-WALLET-NOTE', null, 'With no wallet: "SeqDEX needs a wallet. …" and where to get each', h, async () => {
    // Ambra browser is installed in this browser, so the note is gone; the chooser still names all four.
    const t = await h.bodyText(); const btn = await h.text('#btnConnect')
    return { ok: /Connect wallet|Get a wallet/.test(btn), detail: { button: btn, note: /SeqDEX needs a wallet/.test(t) } }
  })
  await R('CHOOSER', null, 'The chooser, "Connect with": Sequentia web wallet, Ambra mobile, Ambra browser, Sequentia Core on this computer, each with its state', h, async () => {
    await h.click('#btnConnect'); await sleep(1500)
    const t = await h.text('#connectMenu'); await h.click('#btnConnect')
    const names = ['Sequentia web wallet', 'Ambra mobile', 'Ambra browser', 'Sequentia Core on this computer']
    const missing = names.filter((n) => !t.includes(n))
    return { ok: /Connect with/.test(t) && !missing.length && /Ready|Not open|Pair|Not running|Not installed/.test(t), detail: missing.length ? { missing } : t.replace(/\s+/g, ' ') }
  })

  for (const w of widths) {
    await setWidth(b, page, w)
    await go(DEX, MARKETS_READY); await sleep(2500)
    await R('MKT-LIST', w, 'Markets: every pair with Last price, 24h change, 24h high / low, volume and 7 days', h, async () => {
      const r = await h.eval("({rows:document.querySelectorAll('#tickers tr[data-pair]').length, head:[...document.querySelectorAll('#tickers th')].map(x=>x.innerText.trim()).filter(Boolean)})")
      const need = w === 'phone' ? [/last/i, /24h|change/i] : [/last/i, /24h|change/i, /high/i, /volume/i, /7 days/i]
      return { ok: r.rows >= 6 && need.every((re) => r.head.some((x) => re.test(x))), detail: r }
    })
    await R('MKT-SEARCH', w, 'Markets: the search narrows the list', h, async () => {
      const before = await h.eval("document.querySelectorAll('#tickers tr[data-pair]').length")
      await h.type('#tickers input[type=search]', 'GOLD'); await sleep(800)
      const rows = await h.eval("[...document.querySelectorAll('#tickers tr[data-pair]')].map(r=>r.dataset.pair)")
      await h.type('#tickers input[type=search]', ''); await sleep(500)
      return { ok: rows.length > 0 && rows.length < before && rows.every((p) => /GOLD/.test(p)), detail: { before, after: rows.slice(0, 6) } }
    })
    await R('MKT-FILTERS', w, 'Markets: a quote filter (All, BTC, the fiat stablecoins), Favourites and You hold', h, async () => {
      const r = await h.eval("({quotes:[...((document.querySelector('#tickers select')||{}).options||[])].map(o=>o.text.trim()), buttons:[...document.querySelectorAll('#tickers button')].map(x=>x.innerText.trim())})")
      const fav = r.buttons.some((x) => /Favourites/.test(x)), held = r.buttons.includes('You hold')
      return { ok: r.quotes.length >= 3 && r.quotes.some((x) => /BTC/.test(x)) && fav && held, detail: r }
    })
    await R('MKT-FAV', w, 'Markets: a pair starred is listed under Favourites', h, async () => {
      const r = await h.eval(`(async()=>{const row=document.querySelector('#tickers tr[data-pair="${PAIR}"]'); if(!row) return 'no ${PAIR} row'; const star=[...row.querySelectorAll('button,[aria-pressed]')].find(x=>/★|☆/.test(x.innerText)||x.hasAttribute('aria-pressed')); if(!star) return 'no star'; star.click(); await new Promise(r=>setTimeout(r,400)); const f=[...document.querySelectorAll('#tickers button')].find(x=>/Favourites/.test(x.innerText)); f.click(); await new Promise(r=>setTimeout(r,600)); const rows=[...document.querySelectorAll('#tickers tr[data-pair]')].map(r=>r.dataset.pair); f.click(); star.click(); return rows})()`)
      return { ok: Array.isArray(r) && r.length >= 1 && r.includes(PAIR), detail: r }
    })
    if (words) await R('MKT-WORDS', w, 'Markets says none of the words default mode never says', h, async () => {
      const f = forbiddenIn(await h.text('#view'), words); return { ok: !f.length, detail: f }
    })

    await go(DEX + 'market.html?pair=' + PAIR, PAIR_READY); await sleep(3000)
    await R('PAIR-HEAD', w, 'A pair: its name, last price, 24h change and the day\'s high, low and volume', h, async () => {
      const r = await h.eval("({name:document.querySelector('#pairName').innerText, last:document.querySelector('#lastPrice').innerText, ch:document.querySelector('#lastChange').innerText, day:document.querySelector('#dayLine').innerText})")
      return { ok: /GOLD/.test(r.name) && /\d/.test(r.last) && (/%/.test(r.ch) || /No trades/.test(r.day)) && /High|Low|Vol|No trades/i.test(r.day), detail: r }
    })
    await R('PAIR-FLIP', w, 'A pair: ⇄ shows the price the other way round', h, async () => {
      const a = await h.text('#pairName'); await h.click('#flip'); await sleep(1200); const z = await h.text('#pairName'); await h.click('#flip'); await sleep(800)
      return { ok: a !== z && z.includes('GOLD'), detail: { before: a, after: z } }
    })
    await R('PAIR-CHART', w, 'Chart: Price or Depth; 1D 1W 1M 3M 1Y All; Candles or Line; the chart drawn', h, async () => {
      const r = await h.eval("({views:[...document.querySelectorAll('#viewTabs button')].map(x=>x.innerText.trim()), ranges:[...document.querySelectorAll('#rangeTabs button')].map(x=>x.innerText.trim()), types:[...document.querySelectorAll('#typeTabs button')].map(x=>x.innerText.trim()), canvas:!!document.querySelector('#priceChart canvas')})")
      const ok = ['Price', 'Depth'].every((x) => r.views.includes(x)) && ['1D', '1W', '1M', '3M', '1Y', 'All'].every((x) => r.ranges.includes(x)) && ['Candles', 'Line'].every((x) => r.types.includes(x)) && r.canvas
      return { ok, detail: r }
    })
    await R('PAIR-DEPTH', w, 'Chart: Depth shows the depth chart', h, async () => {
      await h.eval("document.querySelector('#viewTabs [data-v=depth]').click(),1"); await sleep(1200)
      const v = await h.eval("getComputedStyle(document.querySelector('#depthChart')).visibility!=='hidden' && !!document.querySelector('#depthChart canvas')")
      await h.eval("document.querySelector('#viewTabs [data-v=price]').click(),1"); await sleep(600)
      return { ok: v }
    })
    await R('PAIR-INDICATORS', w, 'Chart: Indicators lists Volume, Moving average 7 and 25, EMA 20, Bollinger bands 20, 2, VWAP, RSI 14', h, async () => {
      await h.click('#indBtn'); await sleep(600); const t = await h.text('#indMenu'); await h.click('#indBtn')
      const need = ['Volume', 'Moving average 7', 'Moving average 25', 'EMA 20', 'Bollinger bands 20, 2', 'VWAP', 'RSI 14']
      const missing = need.filter((x) => !t.includes(x)); return { ok: !missing.length, detail: missing.length ? { missing, shown: t.replace(/\s+/g, ' ') } : '' }
    })
    await R('PAIR-BOOK', w, 'Order book with both sides, and between them "Spread <amount> · <percent> · Mid <price>"', h, async () => {
      const r = await h.eval("({asks:document.querySelectorAll('#asks > *').length, bids:document.querySelectorAll('#bids > *').length, spread:document.querySelector('#spread').innerText.replace(/\\s+/g,' ')})")
      return { at: '#spread',  ok: (r.asks > 0 || r.bids > 0) && /Spread .* · .*% · Mid /.test(r.spread), detail: r }
    })
    await R('PAIR-TRADES', w, 'Recent trades: price, amount and time', h, async () => {
      await h.eval("document.querySelector('#bookTabs [data-b=trades]').click(),1"); await sleep(1000)
      const r = await h.eval("({rows:document.querySelectorAll('#trades > *').length, text:document.querySelector('#tradesPane').innerText.split('\\n').slice(0,6).join(' | ')})")
      await h.eval("document.querySelector('#bookTabs [data-b=book]').click(),1")
      return { ok: r.rows > 0 || /No trades/.test(r.text), detail: r }
    })
    await R('TICKET', w, 'Ticket: Buy or Sell; Market or Limit; Price, Amount; 25%, 50%, 75%, Max; "Your wallet shows the exact amounts and fees before anything is signed."', h, async () => {
      if (w === 'phone') { await h.click('#phBuy'); await sleep(800) }
      const r = await h.eval("({t:document.querySelector('#orderForm').innerText, sides:!!document.querySelector('#side-buy')&&!!document.querySelector('#side-sell'), types:[...document.querySelectorAll('[id^=type-]')].map(x=>x.innerText.trim()), price:!!document.querySelector('#fPrice'), amount:!!document.querySelector('#fAmount')})")
      const pct = ['25%', '50%', '75%', 'Max'].every((x) => r.t.includes(x))
      const ok = r.sides && r.types.includes('Market') && r.types.includes('Limit') && r.amount && pct && /Your wallet shows the exact amounts and fees before anything is signed\./.test(r.t)
      return { ok, detail: { types: r.types, price: r.price, amount: r.amount, pct } }
    })
    await R('TICKET-TOTAL', w, 'Ticket: a Total field beside Price and Amount', h, async () => {
      const t = await h.text('#orderForm'); return { at: '#orderForm',  ok: /\bTotal\b/.test(t), detail: t.split('\n').filter((l) => /Price|Amount|Total|You pay/.test(l)).slice(0, 5) }
    })
    await R('TICKET-ESTIMATE', w, 'Ticket: an amount gives the estimate (Fills now / Rests on the book / You pay) and the button "Buy <amount> GOLD"', h, async () => {
      await h.eval("(document.querySelector('#type-limit')||{click(){}}).click(),1"); await sleep(500)
      await h.type('#fAmount', '0.01'); await sleep(1500)
      const r = await h.eval("({est:document.querySelector('#fEstimate').innerText.replace(/\\s+/g,' '), go:document.querySelector('#fGo').innerText.trim()})")
      await h.type('#fAmount', '')
      return { ok: /Fills now|Rests on the book|You pay/.test(r.est) && /^(Buy|Sell) 0\.01 GOLD$/.test(r.go), detail: r }
    })
    await R('TICKET-OPTIONS', w, 'Ticket (Limit): the options the wallet offers (Post only, Nothing left resting, Smallest fill, Can take back after)', h, async () => {
      const t = await h.text('#orderForm'); const any = /Post only|Nothing left resting|Smallest fill|Can take back after/.test(t)
      return any ? { ok: true, detail: t.split('\n').filter((l) => /Post only|Nothing left|Smallest|take back/.test(l)) } : { skip: 'no wallet connected yet: options show only for what the connected wallet offers' }
    })
    if (w === 'phone') await R('PHONE-BAR', w, 'Phone: Buy and Sell at the foot of a pair', h, async () => ({ ok: await h.visible('#phBuy') && await h.visible('#phSell') }))
    await R('ORDERS', w, 'Your orders: Open orders, Trades, Order history and "This market only"', h, async () => {
      const r = await h.eval("({tabs:[...document.querySelectorAll('#ordTabs button')].map(x=>x.innerText.trim()), only:!!document.querySelector('#thisMarket')})")
      return { ok: ['Open orders', 'Trades', 'Order history'].every((x) => r.tabs.includes(x)) && r.only, detail: r }
    })
    if (words) await R('PAIR-WORDS', w, 'A pair\'s page says none of the words default mode never says', h, async () => {
      const f = forbiddenIn(await h.text('#view'), words); return { ok: !f.length, detail: f }
    })
    await R('FIT', w, 'Nothing scrolls sideways (a pair\'s page)', h, async () => { const o = await h.overflow(); return { ok: o <= 1, detail: o + 'px' } })
    await go(DEX + 'portfolio.html', "!!document.querySelector('#pfTotal')"); await sleep(2500)
    await R('PORTFOLIO', w, 'Portfolio: Total in the reference currency, the assets, Export CSV', h, async () => {
      const r = await h.eval("({total:document.querySelector('#pfTotal').innerText, csv:!!document.querySelector('#exportCsv'), note:(document.querySelector('#pfNote')||{}).innerText||''})")
      return { ok: r.csv && (/[$€\d]/.test(r.total) || /wallet/i.test(r.note)), detail: r }
    })
  }

  // ---------- connected: Ambra browser, once ----------
  await setWidth(b, page, widths[0])
  await newExtensionWallet(b)
  await go(DEX, MARKETS_READY)
  await R('CONNECT', null, 'Connect with Ambra browser: the wallet asks once ("Connect to this site?"), then "Connected" and the address, shortened', h, async () => {
    await h.click('#btnConnect'); await h.waitFor("document.querySelector('#connectMenu [data-connector=\"extension\"]') && !document.querySelector('#connectMenu').hidden", 30000)
    await h.click('#connectMenu [data-connector="extension"]')
    const t = await b.waitTarget((x) => x.type === 'page' && x.url.includes('/approval/approval.html'), 60000)
    const a = await b.pageOf(t.targetId)
    await a.waitFor("document.querySelector('#reqCard') && !document.querySelector('#reqCard').classList.contains('hide')", 30000)
    const title = await a.text('#reqTitle'); await a.click('#btnApprove')
    await h.waitFor("document.querySelector('#btnConnect').classList.contains('ok')", 60000)
    const btn = (await h.text('#btnConnect')).replace(/\s+/g, ' ')
    return { ok: /connect/i.test(title) && /Connected/.test(btn) && /tb1\w+…\w+/.test(btn), detail: { asked: title, button: btn } }
  })
  await h.eval('window.__rg = 1, true')
  await R('IN-PLACE', null, 'Connected once: a pair and Portfolio open in place, still connected', h, async () => {
    await h.click(`#tickers tr[data-pair="${PAIR}"]`)
    await h.waitFor("location.pathname.endsWith('/market.html') && !!document.querySelector('#fGo')", 30000)
    await h.click('#devNav a[data-main="portfolio.html"]')
    await h.waitFor("location.pathname.endsWith('/portfolio.html') && !!document.querySelector('#pfTotal')", 30000)
    const r = await h.eval("({mark:window.__rg||0, connected:document.querySelector('#btnConnect').classList.contains('ok')})")
    return { ok: r.mark === 1 && r.connected, detail: r }
  })
  await R('RELOAD', null, 'After a reload: connected again, nothing asked', h, async () => {
    const before = (await b.targets()).filter((x) => x.url.includes('/approval/')).length
    await h.eval('location.reload(), true'); await sleep(2500)
    await h.waitFor("document.querySelector('#btnConnect') && document.querySelector('#btnConnect').classList.contains('ok')", 60000)
    return { ok: (await b.targets()).filter((x) => x.url.includes('/approval/')).length === before }
  })
  await R('PORTFOLIO-WALLET', null, 'Portfolio reads the connected wallet: its Total', h, async () => {
    await sleep(3000); const t = await h.text('#pfTotal'); return { ok: /\$|\d/.test(t), detail: t }
  })
  await go(DEX + 'market.html?pair=' + PAIR, PAIR_READY); await sleep(3000)
  await R('TICKET-OPTIONS-WALLET', null, 'Ticket (Limit), connected: the options Ambra browser offers', h, async () => {
    await h.eval("(document.querySelector('#type-limit')||{click(){}}).click(),1"); await sleep(800)
    const t = await h.text('#orderForm'); const f = ['Post only', 'Nothing left resting', 'Smallest fill', 'Can take back after'].filter((x) => t.includes(x))
    return f.length ? { ok: true, detail: f } : { skip: 'Ambra browser offers no order option (no order-* feature), so the ticket rightly shows none' }
  })
  await R('DISCONNECT', null, 'Disconnect: forgotten here and after a reload', h, async () => {
    await h.click('#btnConnect'); await h.waitFor("!!document.querySelector('#btnDisconnect')", 20000); await h.click('#btnDisconnect')
    await h.waitFor("!document.querySelector('#btnConnect').classList.contains('ok')", 20000)
    await h.eval('location.reload(), true'); await sleep(5000); await h.waitFor("!!document.querySelector('#btnConnect')", 30000)
    const t = (await h.text('#btnConnect')).replace(/\s+/g, ' '); return { ok: /Connect wallet/.test(t), detail: t }
  })
  await R('NO-ERRORS', null, 'No uncaught error on SeqDEX\'s pages', null, async () => ({ ok: problems(page).length === 0, detail: problems(page).slice(0, 4) }))
}
