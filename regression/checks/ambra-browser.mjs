// Ambra browser (the extension, from a fresh clone of its default branch), on the live testnet:
// its popup opened as a page, in default mode. A fresh wallet, then the funded test wallet
// imported from its phrase. Nothing is sent or traded; Review is asked for and not confirmed.
import { sleep, helpers, forbiddenWords, forbiddenIn } from '../lib/suite.mjs'
import { newExtensionWallet } from './seqdex.mjs'

const W = 'popup'
const tab = async (h, t) => { await h.click(`.tabs [data-tab=${t}]`); await sleep(1500) }
const rows = (h) => h.eval("[...document.querySelectorAll('#assetList .asset-row')].map(r=>({k:r.dataset.key, tk:(r.querySelector('.tk')||{}).innerText, fig:(r.querySelector('.fig')||{}).innerText}))")
const options = (h, sel) => h.eval(`(()=>{const s=document.querySelector(${JSON.stringify(sel)}); if(!s) return null; return {tag:s.tagName, rows: s.tagName==='SELECT' ? [...s.options].map(o=>o.text.trim()) : []}})()`)

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
  await R('BAL-HIDE', 'An asset can be hidden from the list and the default pickers', h, async () => {
    const any = await h.eval("[...document.querySelectorAll('#tBalance button, #tBalance [title]')].some(x=>/hide/i.test(x.innerText+' '+(x.title||'')))")
    return { ok: any, detail: any ? '' : 'no hide control anywhere on Balance (the web wallet and Ambra mobile have one)' }
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
  await R('SND-PICKER', 'Send: the asset picker lists BTC first', h, async () => {
    const o = await options(h, '#sendDAsset'); return { ok: !!o && o.rows[0] === 'BTC', detail: o }
  })

  await tab(h, 'trade'); await sleep(4000)
  await R('TRD-FORM', 'Trade: You pay, You get, an amount, Review', h, async () => {
    const t = await h.text('#userComposerRoot'); return { ok: /You pay/i.test(t) && /You get/i.test(t) && await h.visible('#ucReview') }
  })
  for (const [id, sel, what] of [['TRD-PAY-SEARCH', '#ucPay', 'You pay'], ['TRD-GET-SEARCH', '#ucGet', 'You get']]) {
    await R(id, `Trade: the ${what} picker is searchable`, h, async () => {
      const o = await options(h, sel); return { at: sel, ok: !!o && o.tag !== 'SELECT', detail: o && o.tag === 'SELECT' ? `a plain <select> (${o.rows.length} options), no search` : o }
    })
  }
  await R('TRD-AMOUNTS', 'Trade: an amount in You pay shows what You get, and the other way', h, async () => {
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
  await R('NO-ERRORS', 'No uncaught error in the popup', null, async () => ({ ok: problems(pop).length === 0, detail: problems(pop).slice(0, 4) }))

  // ---------- the funded test wallet, imported ----------
  if (!funded) { for (const id of ['BAL-BTC-FIRST', 'TRD-HELD-FIRST', 'TRD-HELD-TRADABLE']) report.skip('AB-' + id, W, 'needs the funded test wallet', 'no --funded phrase file'); return }
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
  await tab(h, 'trade'); await sleep(4000)
  await R('TRD-HELD-FIRST', 'Trade: the You get picker lists BTC, then your assets, before the rest', h, async () => {
    const o = await options(h, '#ucGet'); const mine = ['BTC', 'USDX', 'GOLD']
    const i = o.rows.findIndex((x) => !mine.includes(x)); const late = o.rows.slice(i < 0 ? o.rows.length : i).filter((x) => mine.includes(x))
    return { at: '#ucGet', ok: o.tag !== 'SELECT' && o.rows[0] === 'BTC' && !late.length, detail: { kind: o.tag, first: o.rows.slice(0, 6), heldAfterOthers: late } }
  })
  await R('TRD-HELD-TRADABLE', 'Trade: every asset the balance shows can be paid from (never "You have no <T> to trade.")', h, async () => {
    const bad = {}
    for (const tk of ['USDX', 'GOLD']) {
      const set = await h.eval(`(()=>{const s=document.querySelector('#ucPay'); const o=s&&[...s.options].find(o=>o.text.trim()==='${tk}'); if(!o) return false; s.value=o.value; s.dispatchEvent(new Event('change',{bubbles:true})); return true})()`)
      if (!set) { bad[tk] = 'not offered in You pay'; continue }
      await sleep(800); await h.type('#ucAmount', tk === 'GOLD' ? '0.01' : '1'); await h.click('#ucReview')
      await h.waitFor("/[A-Za-z]/.test((document.querySelector('#ucNote')||{}).innerText||'') && !/Finding/.test(document.querySelector('#ucNote').innerText) || !!document.querySelector('#ucConfirm:not(.hide)')", 60000).catch(() => {})
      const note = await h.text('#ucNote'); if (/^You have no /.test(note)) bad[tk] = note
      await h.eval("(document.querySelector('#ucCancel')||{click(){}}).click(),1"); await h.type('#ucAmount', '')
    }
    return { ok: !Object.keys(bad).length, detail: bad }
  })
}
