// Ambra browser (the extension, from a fresh clone of its default branch), on the live testnet:
// its popup opened as a page, in default mode. A fresh wallet, then the funded test wallet
// imported from its phrase. Nothing is sent or traded; Review is asked for and not confirmed.
import { sleep, helpers, forbiddenWords, forbiddenIn, PICKER, SEARCH, CLOSE } from '../lib/suite.mjs'
import { newExtensionWallet } from './seqdex.mjs'

const W = 'popup'
const tab = async (h, t) => { await h.click(`.tabs [data-tab=${t}]`); await sleep(1500) }
const rows = (h) => h.eval("[...document.querySelectorAll('#assetList .asset-row')].map(r=>({k:r.dataset.key, tk:(r.querySelector('.tk')||{}).innerText, fig:(r.querySelector('.fig')||{}).innerText}))")

export async function run ({ b, report, funded, problems }) {
  const R = (id, line, h, fn) => report.line('AB-' + id, W, line, h && h.page, fn)
  const pop = await newExtensionWallet(b)
  const h = helpers(pop)
  const words = await forbiddenWords(h).catch(() => null)

  await tab(h, 'settings')
  await R('MODE-DEFAULT', 'A new wallet starts in default mode', h, async () => ({ ok: (await h.eval("document.querySelector('#setMode').value")) === 'user' }))
  await tab(h, 'balance'); await sleep(3000)
  await R('BAL-FRESH', 'A fresh wallet shows exactly one row: BTC at 0', h, async () => {
    const r = await rows(h); return { ok: r.length === 1 && r[0].tk.trim().startsWith('BTC') && /^0(\.0+)?\b/.test((r[0].fig || '').trim()), detail: r }
  })
  await R('BAL-TOTAL', 'One total in the reference currency, "Portfolio total"', h, async () => {
    await h.waitFor("/\\d/.test(document.querySelector('#headline').innerText)", 60000).catch(() => {})
    const t = await h.text('#headline'), s = await h.text('#headlineSub'); return { ok: /\d/.test(t) && /Portfolio total/.test(s), detail: { t, s } }
  })
  // The code shows once the wallet has joined (about 35 s). A person re-opens the tab; so does this.
  await tab(h, 'receive')
  const HAS_CODE = "/^bitcoin:tb1/.test((document.querySelector('#recvDCode')||{}).innerText||'')"
  const inPlace = await h.waitFor(HAS_CODE, 90000).then(() => true, () => false)
  let code = inPlace
  for (let i = 0; i < 8 && !code; i++) { await tab(h, 'balance'); await tab(h, 'receive'); code = await h.waitFor(HAS_CODE, 10000).then(() => true, () => false) }
  await R('RCV-CODE', 'Receive: "Receive code", bitcoin:<address>?ark=…&sequentia=…', h, async () => {
    const l = await h.text('#recvDLbl'), c = await h.text('#recvDCode')
    return { ok: code && /^receive code$/i.test(l) && /^bitcoin:tb1\w+\?.*ark=.*sequentia=/.test(c), detail: { label: l, code: c.slice(0, 50) + '…', shownWithoutReopening: inPlace } }
  })
  await R('RCV-IN-PLACE', 'Receive: once the wallet has joined, the code takes the address\'s place without leaving the screen', h, async () => ({ at: '#recvDCode', ok: inPlace, detail: inPlace ? '' : 'the open Receive tab kept the address; the code showed only after re-opening the tab' }))
  await R('RCV-WORDS', 'Receive: the tip, "Copy receive code", "New code", "Amount in BTC (optional)"', h, async () => {
    const r = await h.eval("({tip:document.querySelector('#recvDTip').innerText.trim(), copy:document.querySelector('#btnDCopy').innerText.trim(), nw:document.querySelector('#btnDNew').innerText.trim(), amt:(document.querySelector('#recvDAmt')||{}).placeholder||(document.querySelector('label[for=recvDAmt]')||{}).innerText||''})")
    return { ok: /^Any asset, any amount\./.test(r.tip) && r.copy === 'Copy receive code' && r.nw === 'New code' && /Amount in BTC/.test(r.amt), detail: r }
  })
  await R('FAUCET', 'The testnet faucet card offers its assets', h, async () => {
    const n = await h.eval("document.querySelectorAll('#faucetBtns button').length"); return { ok: n >= 2, detail: n + ' buttons' }
  })

  await tab(h, 'send')
  await R('SND-RECIPIENT', 'Send: "Recipient", hint "a receive code, an address or an invoice", and "balance <amount>"', h, async () => {
    const r = await h.eval("({hint:document.querySelector('#sendDTo').placeholder, label:(document.querySelector('label[for=sendDTo]')||document.querySelector('#sendDTo').previousElementSibling||{}).innerText, avail:document.querySelector('#sendDAvail').innerText.trim()})")
    return { ok: r.hint === 'a receive code, an address or an invoice' && /recipient/i.test(r.label || '') && /^balance /.test(r.avail), detail: r }
  })
  await R('SND-PICKER', 'Send: the asset is the shared chooser, searchable, BTC first', h, async () => {
    const p = await h.eval(PICKER('#sendDAssetChooser')); await h.eval(CLOSE)
    return { at: '#sendDAssetChooser', ok: p.kind === 'list' && p.search && p.rows[0] === 'BTC', detail: p }
  })

  await tab(h, 'trade'); await sleep(4000)
  await R('TRD-FORM', 'Trade: You pay, You receive, their amounts, and Review', h, async () => {
    const t = await h.text('#userComposerRoot'); const r = await h.visible('#ucReview')
    return { ok: /you pay/i.test(t) && /you receive/i.test(t) && r, detail: { review: r } }
  })
  await R('TRD-PAY-SEARCH', 'Trade: the You pay picker is searchable', h, async () => {
    const p = await h.eval(PICKER('#ucPay')); await h.eval(CLOSE)
    return { at: '#ucPay', ok: p.search, detail: p.kind === 'select' ? `a plain <select> (${p.rows.length} options), no search` : p }
  })
  await R('TRD-GET-SEARCH', 'Trade: the You receive picker is searchable, and finds an asset by ticker', h, async () => {
    const p = await h.eval(PICKER('#ucGet'))
    if (!p.search) { await h.eval(CLOSE); return { at: '#ucGet', ok: false, detail: p.kind === 'select' ? `a plain <select> (${p.rows.length} options), no search` : p } }
    const rows = await h.eval(SEARCH('GOLD')); await h.eval(CLOSE)
    return { at: '#ucGet', ok: !!rows && rows.includes('GOLD'), detail: { first: p.rows.slice(0, 6), search: rows } }
  })
  await R('TRD-AMOUNTS', 'Trade: an amount in You pay shows what You receive, and an amount in You receive shows what You pay', h, async () => {
    const f = await h.eval("[...document.querySelectorAll('#userComposerRoot input')].filter(i=>i.getClientRects().length).map(i=>i.id)")
    return { at: '#ucAmount',  ok: f.length >= 2, detail: f.length < 2 ? `one amount field (${f.join(', ')})` : f }
  })
  await R('TRD-REFUSE', 'Trade: a refusal in plain words ("Enter how much you pay.", "You have no BTC to trade.")', h, async () => {
    await h.click('#ucReview'); await sleep(1200); const a = await h.text('#ucNote')
    await h.type('#ucAmount', '0.001'); await h.click('#ucReview')
    await h.waitFor("/[A-Za-z]/.test((document.querySelector('#ucNote')||{}).innerText||'') && !/Finding/.test(document.querySelector('#ucNote').innerText)", 60000).catch(() => {})
    const z = await h.text('#ucNote'); await h.type('#ucAmount', '')
    return { ok: a === 'Enter how much you pay.' && /^You have no BTC to trade\.$|^Up to .* can be traded now\.$/.test(z), detail: { empty: a, fresh: z } }
  })
  await R('TRD-MARKET', 'Trade: the pair\'s market above You pay (last price, 1D 1W 1M chart, best bid and ask, recent trades)', h, async () => {
    const t = await h.text('#userComposerRoot'); return { at: '#userComposerRoot',  ok: /1D/.test(t) && /1W/.test(t) && /Best bid|Nobody is buying/.test(t), detail: t.split('\n').slice(0, 3).join(' | ') }
  })

  await tab(h, 'history')
  await R('HISTORY', 'History opens; a fresh wallet says "No transactions yet."', h, async () => ({ ok: /No transactions yet\./.test(await h.text('#tHistory')) }))
  if (words) await R('WORDS', 'No tab in default mode says a word default mode never says', h, async () => {
    const found = {}
    for (const t of ['balance', 'send', 'receive', 'trade', 'history']) { await tab(h, t); const f = forbiddenIn(await h.text('#vApp'), words); if (f.length) found[t] = f }
    return { ok: !Object.keys(found).length, detail: found }
  })
  await R('DEV-MODE', 'Developer mode shows the address and every rail\'s controls; default mode comes back', h, async () => {
    await tab(h, 'settings')
    await h.eval("(()=>{const s=document.querySelector('#setMode'); s.value='developer'; s.dispatchEvent(new Event('change')); return 1})()"); await sleep(3000)
    await tab(h, 'receive'); const dev = await h.waitFor("(()=>{const v=(s)=>{const e=document.querySelector(s); return !!e && e.getClientRects().length>0}; return v('#recvAddr') && !v('#recvDCode')})()", 20000).then(() => true, () => false)
    await tab(h, 'settings'); await h.eval("(()=>{const s=document.querySelector('#setMode'); s.value='user'; s.dispatchEvent(new Event('change')); return 1})()"); await sleep(3000)
    await tab(h, 'receive'); const back = await h.visible('#recvDCode')
    return { ok: dev && back, detail: { dev, back } }
  })
  await R('ASSET-MENUS', 'Every asset menu, in both modes, is the shared chooser: no plain asset <select> on any tab', h, async () => {
    // A visible <select> whose every option is an asset (BTC or an asset id; '' for a "choose…" line)
    // is a menu the chooser should front. The reference currency's menu (USD, EUR, …) is not one.
    const SCAN = "[...document.querySelectorAll('#vApp select')].filter(s=>{const v=[...s.options].map(o=>o.value).filter(x=>x!==''); return s.getClientRects().length && v.length && v.every(x=>x==='BTC'||/^(oamp:)?[0-9a-f]{64}$/.test(x))}).map(s=>s.id||'(no id)')"
    const setMode = (m) => h.eval(`(()=>{const s=document.querySelector('#setMode'); s.value='${m}'; s.dispatchEvent(new Event('change')); return 1})()`)
    const found = {}; let dev = null
    for (const m of ['user', 'developer']) {
      await tab(h, 'settings'); await setMode(m); await sleep(2500)
      for (const t of ['send', 'receive', 'stake', 'settings']) { await tab(h, t); const f = await h.eval(SCAN); if (f.length) found[m + '/' + t] = f }
      if (m === 'developer') { await tab(h, 'send'); dev = await h.eval(PICKER('#sendAssetChooser')).catch((e) => ({ error: e.message })); await h.eval(CLOSE) }
    }
    await tab(h, 'settings'); await setMode('user'); await sleep(2500)
    return { ok: !Object.keys(found).length && !!dev && dev.search, detail: { plainSelects: found, developerSend: dev } }
  })
  await R('NO-ERRORS', 'No uncaught error in the popup', null, async () => ({ ok: problems(pop).length === 0, detail: problems(pop).slice(0, 4) }))

  // ---------- the funded test wallet, imported ----------
  if (!funded) { for (const id of ['BAL-BTC-FIRST', 'BAL-HIDE', 'TRD-HELD-FIRST', 'TRD-HELD-TRADABLE']) report.skip('AB-' + id, W, 'needs the funded test wallet', 'no --funded phrase file'); return }
  await tab(h, 'settings')
  await h.eval("(()=>{document.querySelector('#removePw').value='regression-suite-password'; document.querySelector('#btnRemoveWallet').click(); return 1})()")
  await h.waitFor("!document.querySelector('#vWelcome').classList.contains('hide')", 30000)
  await h.click('#btnStartImport'); await sleep(500)
  await h.eval(`(()=>{const v=(id,x)=>{const i=document.getElementById(id); i.value=x; i.dispatchEvent(new Event('input'))}; v('importPhrase', ${JSON.stringify(funded.phrase)}); v('importPw','regression-suite-password'); v('importPw2','regression-suite-password'); document.querySelector('#btnImportGo').click(); return 1})()`)
  await h.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 120000)
  await tab(h, 'balance')
  const ok = await h.waitFor("document.querySelectorAll('#assetList .asset-row').length >= 3", 240000).then(() => true, () => false)
  await R('BAL-BTC-FIRST', 'BTC is the first row; the funded wallet\'s assets follow, with no "native" label', h, async () => {
    const r = await rows(h); return { ok: ok && (r[0].tk || '').trim().startsWith('BTC') && !/native/i.test(await h.text('#tBalance')), detail: r.map((x) => (x.tk || '').trim().split(/\s/)[0]) }
  })
  await R('BAL-HIDE', 'An asset can be hidden: it leaves the list for "Hidden assets (N)", the total stays the same, and Unhide brings it back', h, async () => {
    const before = await h.text('#headline')
    const r = await h.eval("(async()=>{const row=[...document.querySelectorAll('#assetList .asset-row')].find(x=>((x.querySelector('.tk')||{}).innerText||'').trim()==='GOLD'); if(!row) return 'no GOLD row'; row.click(); await new Promise(r=>setTimeout(r,800)); const b=[...document.querySelectorAll('#assetList button')].find(x=>x.getClientRects().length && /Hide asset/.test(x.innerText)); if(!b) return 'no hide button'; b.click(); await new Promise(r=>setTimeout(r,1500)); return 'hidden'})()")
    const list = await rows(h), body = await h.text('#tBalance'), after = await h.text('#headline')
    const gone = !list.some((x) => (x.tk || '').trim() === 'GOLD')
    // Unhide, so the rest of the run sees the wallet as it was.
    const back = await h.eval("(async()=>{const f=[...document.querySelectorAll('#assetList .hidden-fold')][0]; if(!f) return 'no fold'; f.click(); await new Promise(r=>setTimeout(r,600)); const u=[...document.querySelectorAll('#assetList button')].find(x=>x.getClientRects().length && /^Unhide$/.test(x.innerText.trim())); if(!u) return 'no Unhide'; u.click(); await new Promise(r=>setTimeout(r,1500)); return 'shown'})()")
    const again = (await rows(h)).some((x) => (x.tk || '').trim() === 'GOLD')
    return { ok: r === 'hidden' && gone && /Hidden assets \(1\)/.test(body) && before === after && back === 'shown' && again, detail: { r, gone, back, again, totalBefore: before, totalAfter: after } }
  })
  await tab(h, 'trade'); await sleep(4000)
  await R('TRD-HELD-FIRST', 'Trade: the You receive picker lists BTC, then your assets, before the rest', h, async () => {
    const p = await h.eval(PICKER('#ucGet')); await h.eval(CLOSE)
    const mine = ['BTC', 'USDX', 'GOLD']; const i = p.rows.findIndex((x) => !mine.includes(x))
    const late = p.rows.slice(i < 0 ? p.rows.length : i).filter((x) => mine.includes(x))
    return { at: '#ucGet', ok: p.search && p.rows[0] === 'BTC' && !late.length, detail: { kind: p.kind, first: p.rows.slice(0, 6), heldAfterOthers: late, groups: p.groups } }
  })
  await R('TRD-HELD-TRADABLE', 'Trade: every asset the balance shows can be paid from (never "You have no <T> to trade.")', h, async () => {
    const bad = {}
    for (const tk of ['USDX', 'GOLD']) {
      // You pay is the shared asset chooser: search the ticker, then choose its row.
      const set = await h.eval(`(async()=>{const b=document.querySelector('#ucPay'); if(!b) return false; b.click(); await new Promise(r=>setTimeout(r,500)); const i=document.querySelector('.swpop-search input'); if(!i) return false; i.value='${tk}'; i.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,400)); const o=[...document.querySelectorAll('.swpop [role=option]')].find(o=>((o.querySelector('.swopt-tk')||{}).firstChild||{}).textContent==='${tk}'); if(!o){ i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); return false } o.click(); return true})()`)
      if (!set) { bad[tk] = 'not offered in You pay'; continue }
      await sleep(800); await h.type('#ucAmount', tk === 'GOLD' ? '0.01' : '1'); await h.click('#ucReview')
      await h.waitFor("/[A-Za-z]/.test((document.querySelector('#ucNote')||{}).innerText||'') && !/Finding/.test(document.querySelector('#ucNote').innerText) || !!document.querySelector('#ucConfirm')", 60000).catch(() => {})
      const note = await h.text('#ucNote'); if (/^You have no /.test(note)) bad[tk] = note
      await h.eval("(document.querySelector('#ucCancel')||{click(){}}).click(),1"); await h.type('#ucAmount', '')
    }
    return { ok: !Object.keys(bad).length, detail: bad }
  })
}
