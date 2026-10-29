// The web wallet (sequentiatestnet.com/wallet/), in its default mode and in developer mode, at
// desktop and phone widths. Two wallets: a fresh one made here, and the funded test wallet when
// its phrase is given (--funded), restored into a fresh browser profile. Nothing is sent, traded
// or signed: the checks open pickers, type amounts and ask for a review, and stop there.
import { join } from 'node:path'
import { sleep, helpers, setWidth, forbiddenWords, forbiddenIn } from '../lib/suite.mjs'

const BASE = 'https://sequentiatestnet.com/wallet/'

// What a picker shows after one click on the control named `sel`: the rows a person can choose
// from (a searchable list, or a plain <select>'s options), and the search box if there is one.
const PICKER = (sel) => `(async()=>{
  const c=document.querySelector(${JSON.stringify(sel)}); if(!c) throw new Error('no ${sel}');
  const vis=(e)=>e && e.getClientRects().length>0 && getComputedStyle(e).visibility!=='hidden';
  if(c.tagName==='SELECT') return { kind:'select', search:false, rows:[...c.options].map(o=>o.text.trim()) };
  c.click(); await new Promise(r=>setTimeout(r,700));
  const search=[...document.querySelectorAll('input')].find(i=>vis(i) && /search/i.test((i.placeholder||'')+' '+(i.getAttribute('aria-label')||'')));
  const rows=[...document.querySelectorAll('[role=option]')].filter(o=>vis(o) && !o.classList.contains('swopt-other')).map(o=>{const t=o.querySelector('.swopt-tk,[data-ticker]'); return (t?t.innerText:o.innerText).trim().split(/\\s+/)[0].replace(/[^A-Za-z0-9.\\-…]/g,'')});
  const groups=[...document.querySelectorAll('.swopt-grp')].filter(vis).map(g=>g.innerText.trim());
  return { kind:'list', search:!!search, rows, groups };
})()`
// Types into the open picker's search box; -> the rows shown.
const SEARCH = (q) => `(async()=>{
  const vis=(e)=>e && e.getClientRects().length>0;
  const i=[...document.querySelectorAll('input')].find(x=>vis(x) && /search/i.test((x.placeholder||'')+' '+(x.getAttribute('aria-label')||'')));
  if(!i) return null;
  i.value=${JSON.stringify(q)}; i.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,500));
  return [...document.querySelectorAll('[role=option]')].filter(o=>vis(o) && !o.classList.contains('swopt-other')).map(o=>{const t=o.querySelector('.swopt-tk,[data-ticker]'); return (t?t.innerText:o.innerText).trim().split(/\\s+/)[0].replace(/[^A-Za-z0-9.\\-…]/g,'')});
})()`
const CLOSE = `(()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); const i=[...document.querySelectorAll('input')].find(x=>x.getClientRects().length && /search/i.test(x.placeholder||'')); if(i) i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); document.body.click(); return true})()`

async function openWallet (b, h, { phrase } = {}) {
  await b.send('Page.navigate', { url: BASE }, h.page.sessionId)
  await h.waitFor("(()=>{const v=(id)=>{const e=document.getElementById(id); return e && getComputedStyle(e).display!=='none'}; return v('app')||v('welcome')})()", 240000)
  if (phrase) {
    await h.eval(`localStorage.setItem('swk.sequentia.mnemonic', ${JSON.stringify(phrase)}), true`)
    await b.send('Page.navigate', { url: 'about:blank' }, h.page.sessionId); await sleep(1500)
    await b.send('Page.navigate', { url: BASE }, h.page.sessionId)
  } else {
    await h.waitFor("document.querySelector('#btnCreate') && document.querySelector('#btnCreate').offsetParent !== null", 120000)
    await h.click('#btnCreate')
    await h.waitFor("document.querySelector('#btnConfirm') && document.querySelector('#btnConfirm').offsetParent !== null")
    await h.click('#btnConfirm')
  }
  await h.waitFor("document.querySelector('#app') && getComputedStyle(document.querySelector('#app')).display !== 'none'", 240000)
}
const tab = async (h, name) => { await h.click(`[data-tab=${name}]`); await sleep(1500) }
async function mode (h, m) {
  await tab(h, 'settings')
  await h.eval(`(()=>{const c=document.querySelector('#mode${m === 'user' ? 'User' : 'Developer'}'); c.checked=true; c.dispatchEvent(new Event('change')); return true})()`)
  await sleep(3000)
}
// The default mode's receive code, once the wallet has joined (about 30 s after it opens).
const waitCode = (h) => h.waitFor("/^bitcoin:/.test((document.querySelector('#addr')||{}).textContent||'')", 180000).then(() => true, () => false)
const balanceTickers = (h) => h.eval("[...document.querySelectorAll('section[data-panel=balance] .bt-tk .tk')].filter(e=>e.getClientRects().length).map(e=>e.innerText.trim())")
const totalText = (h) => h.text('#balTotal')

export async function run ({ b, report, widths, funded, problems }) {
  const R = (id, w, line, h, fn) => report.line('WW-' + id, w, line, h && h.page, fn)
  const page = await b.page('about:blank')
  const h = helpers(page)
  await page.b.send('Network.enable', {}, page.sessionId).catch(() => {})
  const words = await forbiddenWords(h).catch(() => null)

  // ---------- a fresh wallet, default mode ----------
  await setWidth(b, page, widths[0])
  await openWallet(b, h)
  const joined = await waitCode(h)
  for (const w of widths) {
    await setWidth(b, page, w); await sleep(800)
    await tab(h, 'balance')
    await R('BAL-FRESH', w, 'A fresh wallet shows exactly one row: BTC at 0', h, async () => {
      await h.waitFor("document.querySelectorAll('section[data-panel=balance] .bt-tk .tk').length", 60000)
      const t = await balanceTickers(h); return { ok: t.length === 1 && t[0] === 'BTC', detail: t }
    })
    await R('BAL-TOTAL', w, 'One total in the reference currency at the top', h, async () => {
      const t = await totalText(h); return { ok: /total balance/i.test(t) && /\d/.test(t), detail: t.replace(/\s+/g, ' ') }
    })
    await R('BAL-REF', w, 'The reference currency can be changed (Show values in)', h, async () => {
      const r = await h.eval("(async()=>{const s=document.querySelector('#refCcySel'); if(!s) return null; const was=s.value; const to=[...s.options].map(o=>o.value).find(v=>v!==was&&v==='BTC')||[...s.options].map(o=>o.value).find(v=>v!==was); s.value=to; s.dispatchEvent(new Event('change')); await new Promise(r=>setTimeout(r,1500)); const t=document.querySelector('#balTotal').innerText; s.value=was; s.dispatchEvent(new Event('change')); return {to, t}})()")
      return { ok: !!r && r.t.includes(r.to), detail: r }
    })
    await R('BAL-FAUCET', w, 'The testnet faucet card offers its assets', h, async () => {
      const n = await h.eval("document.querySelectorAll('#faucetBtns button').length"); return { ok: n >= 2, detail: `${n} buttons` }
    })

    await tab(h, 'receive')
    await R('RCV-CODE', w, 'Receive shows a "Receive code": bitcoin:<address>?ark=…&sequentia=…', h, async () => {
      const lbl = await h.text('#recvLbl'), code = await h.text('#addr')
      return { ok: joined && /receive code/i.test(lbl) && /^bitcoin:tb1[a-z0-9]+\?.*ark=.*sequentia=/.test(code), detail: { label: lbl, code: code.slice(0, 60) + '…' } }
    })
    await R('RCV-TIP', w, 'Under it: "Any asset, any amount. …"', h, async () => {
      const t = await h.text('#recvTip'); return { ok: /^Any asset, any amount\./.test(t), detail: t }
    })
    await R('RCV-BUTTONS', w, 'Buttons "Copy receive code" and "New code"; no address-only controls', h, async () => {
      const c = await h.text('#btnCopy'), n = await h.text('#btnNewAddr'), conf = await h.visible('#btnConf'), xpub = await h.visible('#btnXpub')
      return { ok: c === 'Copy receive code' && n === 'New code' && !conf && !xpub, detail: { copy: c, new: n, blindedButton: conf, xpub } }
    })
    await R('RCV-AMOUNT', w, '"Amount in BTC (optional)": with an amount the code names it and carries an invoice', h, async () => {
      const ph = await h.eval("(document.querySelector('#recvAmt')||{}).placeholder||''")
      if (!/Amount in BTC/i.test(ph)) return { ok: false, detail: 'field: ' + JSON.stringify(ph) }
      await h.type('#recvAmt', '0.0001')
      const ok = await h.waitFor("/amount=0\\.0001/.test(document.querySelector('#addr').textContent) && /lightning=/.test(document.querySelector('#addr').textContent)", 60000).then(() => true, () => false)
      const code = await h.text('#addr'); await h.type('#recvAmt', '')
      return { ok, detail: code.replace(/(lightning=)\w{12}\w*/, '$1…').slice(0, 140) }
    })
    if (words) await R('RCV-WORDS', w, 'Receive says none of the words default mode never says', h, async () => {
      const f = forbiddenIn(await h.text('section[data-panel=receive]'), words); return { ok: !f.length, detail: f }
    })

    await tab(h, 'send')
    await R('SND-RECIPIENT', w, 'Send: the field is "Recipient", hint "a receive code, an address or an invoice"', h, async () => {
      const r = await h.eval("(()=>{const i=document.querySelector('section[data-panel=send] .raddr'); const l=i&&i.closest('.rec').querySelector('label'); return {label:l&&l.innerText.trim(), hint:i&&i.placeholder}})()")
      return { at: 'section[data-panel=send] .raddr', ok: /^recipient$/i.test(r.label || '') && r.hint === 'a receive code, an address or an invoice', detail: r }
    })
    await R('SND-BALANCE', w, 'Send: next to the asset its one figure, "balance <amount>"', h, async () => {
      const t = await h.text('section[data-panel=send] .ravail'); return { at: 'section[data-panel=send] .ravail',  ok: /^balance /.test(t), detail: t }
    })
    await R('SND-INVOICE', w, 'Send: "Pay an invoice" with "Paste an invoice to pay it with your BTC."', h, async () => {
      const t = await h.text('section[data-panel=send]'); return { ok: /Paste an invoice to pay it with your BTC\./.test(t), detail: (t.match(/pay an invoice[^\n]*\n[^\n]*/i) || [''])[0] }
    })
    if (words) await R('SND-WORDS', w, 'Send says none of the words default mode never says, and has no fee-rate field', h, async () => {
      const t = await h.text('section[data-panel=send]'); const f = forbiddenIn(t, words)
      const rate = await h.eval("[...document.querySelectorAll('section[data-panel=send] input')].some(i=>i.getClientRects().length && /fee ?rate|\\/vB/i.test((i.placeholder||'')+(i.previousElementSibling?.innerText||'')))")
      return { ok: !f.length && !rate, detail: { words: f, feeRateField: rate } }
    })

    await tab(h, 'swap'); await sleep(4000)
    await R('TRD-FORM', w, 'Trade: You pay, You receive, their amounts, and Review', h, async () => {
      const t = await h.text('#userComposerRoot'); const r = await h.visible('#ucReview')
      return { ok: /you pay/i.test(t) && /you receive/i.test(t) && r, detail: { review: r } }
    })
    await R('TRD-PAY-SEARCH', w, 'Trade: the You pay picker is searchable', h, async () => {
      const p = await h.eval(PICKER('#ucPay')); await h.eval(CLOSE)
      return { at: '#ucPay',  ok: p.search, detail: p.kind === 'select' ? `a plain <select> (${p.rows.length} options), no search` : p }
    })
    await R('TRD-GET-SEARCH', w, 'Trade: the You receive picker is searchable, and finds an asset by ticker', h, async () => {
      const p = await h.eval(PICKER('#ucGet'))
      if (!p.search) { await h.eval(CLOSE); return { at: '#ucGet',  ok: false, detail: p.kind === 'select' ? `a plain <select> (${p.rows.length} options), no search` : p } }
      const rows = await h.eval(SEARCH('GOLD')); await h.eval(CLOSE)
      return { ok: rows && rows.includes('GOLD'), detail: rows }
    })
    await R('TRD-PASTE-ID', w, 'Trade: pasting an asset id in the picker finds that asset', h, async () => {
      const gold = await h.eval("fetch('/registry/index.minimal.json').then(r=>r.json()).then(j=>Object.keys(j).find(k=>Array.isArray(j[k])&&j[k][1]==='GOLD'))")
      const p = await h.eval(PICKER('#ucGet'))
      if (!p.search) { await h.eval(CLOSE); return { at: '#ucGet',  ok: false, detail: 'no search box to paste into' } }
      const rows = await h.eval(SEARCH(gold)); await h.eval(CLOSE)
      return { ok: !!rows && rows.length >= 1, detail: rows }
    })
    await R('TRD-AMOUNTS', w, 'Trade: an amount in You pay shows what You receive, and an amount in You receive shows what You pay', h, async () => {
      const f = await h.eval("[...document.querySelectorAll('#userComposerRoot input')].filter(i=>i.getClientRects().length).map(i=>i.id||i.placeholder)")
      return { at: '#ucAmount',  ok: f.length >= 2, detail: f.length < 2 ? `one amount field (${f.join(', ')}); no You receive amount` : f }
    })
    await R('TRD-REFUSE', w, 'Trade: a refusal in plain words ("You have no BTC to trade." / "Enter how much you pay.")', h, async () => {
      await h.type('#ucAmount', ''); await h.click('#ucReview'); await sleep(1500)
      const a = await h.text('#ucNote')
      await h.type('#ucAmount', '0.001'); await h.click('#ucReview')
      await h.waitFor("/[A-Za-z]/.test((document.querySelector('#ucNote')||{}).innerText||'') && !/Finding/.test(document.querySelector('#ucNote').innerText)", 60000).catch(() => {})
      const b2 = await h.text('#ucNote'); await h.type('#ucAmount', '')
      return { ok: a === 'Enter how much you pay.' && /^You have no BTC to trade\.$|^Up to .* can be traded now\.$/.test(b2), detail: { empty: a, fresh: b2 } }
    })
    await R('MKT-HEAD', w, 'Market: the pair "<base> / <quote>", the last price and its 24h change', h, async () => {
      const t = await h.text('#ucMarket'); return { ok: /^\S+ \/ \S+/.test(t) && /24h|No trades/.test(t), detail: t.split('\n').slice(0, 2).join(' | ') }
    })
    await R('MKT-CHART', w, 'Market: a chart with 1D, 1W, 1M and the TradingView notice', h, async () => {
      const t = await h.text('#ucMarket'); const c = await h.eval("!!document.querySelector('#ucMarket canvas')")
      return { ok: c && /1D/.test(t) && /1W/.test(t) && /1M/.test(t) && /Charts by TradingView Lightweight Charts/.test(t), detail: { canvas: c } }
    })
    await R('MKT-BOOK', w, 'Market: Best bid and Best ask with Buyers/Sellers %, or "Nobody is buying or selling right now"', h, async () => {
      const t = await h.text('#ucMarket'); return { ok: (/Best bid/.test(t) && /Best ask/.test(t) && /Buyers \d+%/.test(t) && /Sellers \d+%/.test(t)) || /Nobody is buying or selling right now/.test(t), detail: (t.match(/Best bid.*|Nobody.*/) || [''])[0] }
    })
    await R('MKT-TRADES', w, 'Market: Recent trades with price, amount and time, or "No trades yet"', h, async () => {
      const t = await h.text('#ucMarket'); return { ok: /Recent trades/.test(t) || /No trades yet/.test(t), detail: (t.match(/Recent trades.*/) || ['none'])[0] }
    })
    if (words) await R('TRD-WORDS', w, 'Trade says none of the words default mode never says', h, async () => {
      const f = forbiddenIn(await h.text('section[data-panel=swap]'), words); return { ok: !f.length, detail: f }
    })
    await tab(h, 'history')
    await R('HIS-OPEN', w, 'History opens', h, async () => ({ ok: await h.visible('#historyPanel') }))
    if (words) await R('APP-WORDS', w, 'No tab in default mode says a word default mode never says', h, async () => {
      const found = {}
      for (const t of ['balance', 'send', 'receive', 'swap', 'history']) { await tab(h, t); const f = forbiddenIn(await h.text('#app'), words); if (f.length) found[t] = f }
      return { ok: !Object.keys(found).length, detail: found }
    })
    if (w === 'phone') await R('PHONE-FIT', w, 'Phone: no tab scrolls sideways', h, async () => {
      const over = {}
      for (const t of ['balance', 'send', 'receive', 'swap', 'history']) { await tab(h, t); const o = await h.overflow(); if (o > 1) over[t] = o + 'px' }
      return { ok: !Object.keys(over).length, detail: over }
    })
  }
  await R('NO-ERRORS', null, 'No uncaught error on the page (fresh wallet)', null, async () => ({ ok: problems(page).length === 0, detail: problems(page).slice(0, 4) }))

  // ---------- the funded test wallet ----------
  if (!funded) {
    for (const id of ['BAL-BTC-FIRST', 'BAL-HIDE', 'TRD-HELD-FIRST', 'TRD-HIDDEN', 'DEV-PICKER', 'DEV-TETHER']) report.skip('WW-' + id, null, 'needs the funded test wallet', 'no --funded phrase file')
    return
  }
  // A fresh profile for it: the page holds one wallet per origin.
  await b.send('Page.navigate', { url: 'about:blank' }, page.sessionId); await sleep(1000)
  await b.send('Storage.clearDataForOrigin', { origin: 'https://sequentiatestnet.com', storageTypes: 'all' }, page.sessionId).catch(() => {})
  await setWidth(b, page, widths[0])
  await openWallet(b, h, { phrase: funded.phrase })
  await tab(h, 'balance')
  const held = await h.waitFor("(()=>{const t=[...document.querySelectorAll('section[data-panel=balance] .bt-tk .tk')].map(e=>e.innerText.trim()); return t.length>=3 ? t : false})()", 240000).then(() => true, () => false)
  for (const w of widths) {
    await setWidth(b, page, w); await sleep(800)
    await tab(h, 'balance')
    await R('BAL-BTC-FIRST', w, 'BTC is the first row; every other asset one row among equals, with no "native" label', h, async () => {
      const t = await balanceTickers(h); const nat = /native/i.test(await h.text('section[data-panel=balance]'))
      return { ok: held && t[0] === 'BTC' && t.length >= (w === widths[0] ? 3 : 2) && !nat, detail: { rows: t, native: nat } }
    })
    await R('BAL-HIDE', w, 'An asset can be hidden: it leaves the list for "Hidden assets (N)", and the total stays the same', h, async () => {
      const before = await totalText(h)
      const r = await h.eval("(async()=>{const row=[...document.querySelectorAll('section[data-panel=balance] .bt-tk')].find(x=>x.querySelector('.tk').innerText.trim()==='GOLD'); if(!row) return 'no GOLD row'; const d=[...row.parentElement.querySelectorAll('*')].find(x=>x.children.length===0 && x.innerText && x.innerText.trim()==='details'); if(d) d.click(); await new Promise(r=>setTimeout(r,800)); const b=[...document.querySelectorAll('section[data-panel=balance] button')].find(x=>x.getClientRects().length && /Hide asset/.test(x.innerText)); if(!b) return 'no hide button'+(d?'':' (no details)'); b.click(); await new Promise(r=>setTimeout(r,1500)); return 'hidden'})()")
      const t = await balanceTickers(h), body = await h.text('section[data-panel=balance]'), after = await totalText(h)
      return { ok: (r === 'hidden' || (r === 'no GOLD row' && w !== widths[0])) && !t.includes('GOLD') && /Hidden assets \(1\)/.test(body) && before === after, detail: { r, rows: t, totalBefore: before.replace(/\s+/g, ' '), totalAfter: after.replace(/\s+/g, ' ') } }
    })
    await tab(h, 'swap'); await sleep(4000)
    await R('TRD-HELD-FIRST', w, 'Trade: the You receive picker lists BTC, then your assets, before the rest', h, async () => {
      const p = await h.eval(PICKER('#ucGet')); await h.eval(CLOSE)
      const at = '#ucGet'; const mine = ['BTC', 'USDX', 'GOLD']; const i = p.rows.findIndex((x) => !mine.includes(x))
      const late = p.rows.slice(i < 0 ? p.rows.length : i).filter((x) => mine.includes(x))
      return { at, ok: p.search && p.rows[0] === 'BTC' && !late.length, detail: { kind: p.kind, first: p.rows.slice(0, 6), heldAfterOthers: late, groups: p.groups } }
    })
    await R('TRD-HIDDEN', w, 'Trade: a hidden asset is left out of the pickers\' first list and found by search', h, async () => {
      const p = await h.eval(PICKER('#ucPay'))
      if (!p.search) { await h.eval(CLOSE); return { at: '#ucPay', ok: false, detail: `a plain <select>; hidden GOLD listed: ${p.rows.includes('GOLD')}` } }
      const s = await h.eval(SEARCH('GOLD')); await h.eval(CLOSE)
      return { ok: !p.rows.includes('GOLD') && !!s && s.includes('GOLD'), detail: { first: p.rows, search: s } }
    })
    await R('TRD-HELD-TRADABLE', w, 'Trade: every asset the balance shows can be paid from (never "You have no <T> to trade.")', h, async () => {
      const bad = {}
      for (const tk of ['USDX', 'GOLD']) {
        const set = await h.eval(`(()=>{const s=document.querySelector('#ucPay'); const o=s&&[...s.options].find(o=>o.text.trim()==='${tk}'); if(!o) return false; s.value=o.value; s.dispatchEvent(new Event('change',{bubbles:true})); return true})()`)
        if (!set) { bad[tk] = 'not offered in You pay'; continue }
        await sleep(800); await h.type('#ucAmount', tk === 'GOLD' ? '0.01' : '1'); await h.click('#ucReview')
        await h.waitFor("/[A-Za-z]/.test((document.querySelector('#ucNote')||{}).innerText||'') && !/Finding/.test(document.querySelector('#ucNote').innerText) || !!document.querySelector('#ucConfirm')", 60000).catch(() => {})
        const note = await h.text('#ucNote'); if (/^You have no /.test(note)) bad[tk] = note
        await h.eval("(document.querySelector('#ucCancel')||{click(){}}).click(),1"); await h.type('#ucAmount', '')
      }
      return { ok: !Object.keys(bad).length, detail: bad }
    })
  }
  // Developer mode: the picker the default mode should have, and tethered amounts.
  await mode(h, 'developer')
  for (const w of widths) {
    await setWidth(b, page, w); await tab(h, 'swap'); await sleep(3000)
    await R('DEV-PICKER', w, 'Developer Swap: a searchable picker, "Your assets" first, hidden left out, search finds it', h, async () => {
      const p = await h.eval(PICKER('#swPayPick'))
      const s = p.search ? await h.eval(SEARCH('GOLD')) : null; await h.eval(CLOSE)
      return { ok: p.search && p.rows[0] === 'BTC' && /^your assets$/i.test(p.groups[0] || '') && !p.rows.includes('GOLD') && s && s.includes('GOLD'), detail: { first: p.rows, groups: p.groups, search: s } }
    })
    await R('DEV-TETHER', w, 'Developer Swap: an amount in You pay fills You receive', h, async () => {
      await h.eval(PICKER('#swRecvPick')); await sleep(300)
      const picked = await h.eval("(()=>{const o=[...document.querySelectorAll('[role=option]')].find(x=>x.getClientRects().length && /^USDX/.test(x.innerText.trim())); if(!o) return false; o.click(); return true})()")
      await sleep(2000); await h.type('#swPayAmt', '0.0001')
      const ok = await h.waitFor("Number((document.querySelector('#swRecvAmt')||{}).value)>0", 45000).then(() => true, () => false)
      const v = await h.eval("document.querySelector('#swRecvAmt').value"); await h.type('#swPayAmt', '')
      return { ok: picked && ok, detail: { picked, receive: v } }
    })
  }
  await R('DEV-MARKETS', null, 'Developer Swap: Browse markets lists the markets', h, async () => {
    await h.click('#swMarketsBtn'); await sleep(3000)
    const t = await h.text('section[data-panel=swap]'); const m = t.match(/(\d+) pairs/); const rows = t.split('\n').filter(l => /^[A-Za-z0-9.]+ ?\/ ?[A-Za-z0-9.]+(\t|$)/.test(l.trim())).length
    await h.clickText('button', 'Close').catch(() => {})
    return { ok: !!m && Number(m[1]) >= 3 && rows >= 3, detail: `${m ? m[1] : 0} pairs, ${rows} rows shown` }
  })
  await mode(h, 'user')
  await R('NO-ERRORS-FUNDED', null, 'No uncaught error on the page (funded wallet)', null, async () => ({ ok: problems(page).length === 0, detail: problems(page).slice(0, 4) }))
}
