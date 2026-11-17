// The web wallet (sequentiatestnet.com/wallet/), in its default mode and in developer mode, at
// desktop and phone widths. Two wallets: a fresh one made here, and the funded test wallet when
// its phrase is given (--funded), restored into a fresh browser profile. Nothing is sent, traded
// or signed: the checks open pickers, type amounts and ask for a review, and stop there.
import { join } from 'node:path'
import { sleep, helpers, setWidth, forbiddenWords, forbiddenIn, faucetPass, PICKER, SEARCH, CLOSE } from '../lib/suite.mjs'

// WW_BASE checks another copy of the page: a branch served in front of the testnet by the web
// wallet's tooling/live-proxy.mjs, before it is deployed.
const BASE = process.env.WW_BASE || 'https://sequentiatestnet.com/wallet/'
const ORIGIN = new URL(BASE).origin

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
const waitCode = (h) => h.waitFor("/^bitcoin:/i.test((document.querySelector('#addr')||{}).textContent||'')", 180000).then(() => true, () => false)
const balanceTickers = (h) => h.eval("[...document.querySelectorAll('section[data-panel=balance] .bt-tk .tk')].filter(e=>e.getClientRects().length).map(e=>e.innerText.trim())")
const totalText = (h) => h.text('#balTotal')
// A number of four or more digits not grouped (thousands separators), in what a person reads.
const ungrouped = (t) => (String(t).match(/(^|[^\d.,])\d{4,}(?=[.\s]|$)/g) || []).map((x) => x.trim())
// A dash in a sentence (a word on each side), which default mode's copy never uses.
const dashes = (t) => String(t).split('\n').filter((l) => /\S\s[—–]\s\S/.test(l)).map((l) => l.trim().slice(0, 100))
const pickAsset = (sel, tk) => `(async()=>{const b=document.querySelector(${JSON.stringify(sel)}); if(!b) return false; b.click(); await new Promise(r=>setTimeout(r,500)); const i=document.querySelector('.swpop-search input'); if(!i) return false; i.value=${JSON.stringify(tk)}; i.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,400)); const o=[...document.querySelectorAll('.swpop [role=option]')].find(o=>((o.querySelector('.swopt-tk')||{}).firstChild||{}).textContent===${JSON.stringify(tk)}); if(!o){ i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); return false } o.click(); await new Promise(r=>setTimeout(r,800)); return true})()`

export async function run ({ b, report, widths, funded, problems }) {
  const R = (id, w, line, h, fn) => report.line('WW-' + id, w, line, h && h.page, fn)
  const page = await b.page('about:blank')
  const h = helpers(page)
  await page.b.send('Network.enable', {}, page.sessionId).catch(() => {})
  // Our own tooling: the faucet neither refuses nor records this page's requests (README).
  const faucetExempt = await faucetPass(b, page, ORIGIN).catch(() => false)
  const words = await forbiddenWords(h).catch(() => null)

  // ---------- a fresh wallet, default mode ----------
  await setWidth(b, page, widths[0])
  await openWallet(b, h)
  await R('PHRASE-GONE', null, 'Once the backup is confirmed, the recovery phrase is no longer in the page', h, async () => {
    const r = await h.eval("(()=>{const m=(localStorage.getItem('swk.sequentia.mnemonic')||'').split(' '); const w=document.getElementById('words'); return {wordNodes:w?w.children.length:null, pending:typeof window._pending, inPage:m.length>=3 && document.documentElement.outerHTML.includes(m.slice(0,3).join(' '))}})()")
    return { ok: r.wordNodes === 0 && r.pending !== 'string' && !r.inPage, detail: r }
  })
  const joined = await waitCode(h)
  for (const w of widths) {
    await setWidth(b, page, w); await sleep(800)
    await tab(h, 'balance')
    await R('BAL-FRESH', w, 'A fresh wallet shows exactly one row: BTC at 0', h, async () => {
      await h.waitFor("document.querySelectorAll('section[data-panel=balance] .bt-tk .tk').length", 60000)
      const t = await balanceTickers(h); return { ok: t.length === 1 && t[0] === 'BTC', detail: t }
    })
    await R('BTC-EXIT-QUIET', w, 'While the ark answers, BTC says nothing of leaving it, and the page carries the rule that would', h, async () => {
      const r = await h.eval("(async()=>{const lines=document.querySelectorAll('section[data-panel=balance] .bt-exit').length; const src=await fetch('btc-ark.js').then(r=>r.text()).catch(()=>''); return {lines, rule:/exit_auto/.test(src)}})()")
      return { ok: r.lines === 0 && r.rule, detail: r }
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
    // Receive in default mode is one card: the QR code, one line and Copy; everything else behind
    // More options (the web wallet's docs/DEFAULT_MODE.md, "Receive"). The QR code's text is the
    // image's data-text.
    const qrText = () => h.eval("(document.querySelector('#qr')||{dataset:{}}).dataset.text||''")
    await R('RCV-SIMPLE', w, 'Receive is one card: the QR code, "Scan or share to get paid in BTC or any asset." and Copy; no code text, label, New code or switch in view', h, async () => {
      const r = { qr: await h.visible('#qr'), line: await h.text('#recvLine'), copy: await h.text('#btnCopy'), copyShown: await h.visible('#btnCopy'),
        more: await h.text('#btnRecvMore'), codeText: await h.visible('#addr'), label: await h.visible('#recvLbl'), newCode: await h.visible('#btnRecvNew'),
        newAddr: await h.visible('#btnNewAddr'), conf: await h.visible('#recvConfRow'), amount: await h.visible('#recvAmt'), name: await h.visible('#nameBox'),
        blinded: await h.visible('#btnConf'), xpub: await h.visible('#btnXpub') }
      const ok = r.qr && r.line === 'Scan or share to get paid in BTC or any asset.' && r.copy === 'Copy' && r.copyShown && r.more === 'More options' &&
        !r.codeText && !r.label && !r.newCode && !r.newAddr && !r.conf && !r.amount && !r.name && !r.blinded && !r.xpub
      return { ok, detail: r }
    })
    await R('RCV-NAME', w, 'A fresh wallet gets a payment name with nothing asked: the QR code holds name@sequentiatestnet.com alone, under 100 characters', h, async () => {
      const got = await h.waitFor("/^[a-z0-9_-]{3,32}@sequentiatestnet\\.com$/.test((document.querySelector('#qr')||{dataset:{}}).dataset.text||'')", 90000).then(() => true, () => false)
      const t = await qrText()
      // The service makes ten names at once per network, then one every ten minutes: a runner
      // whose network made its ten just now is told so by the page (#nameBox data-refused), which
      // is the limit at work and not a failure of the line.
      if (!got) {
        const refused = await h.eval("(document.querySelector('#nameBox')||{dataset:{}}).dataset.refused||''")
        if (refused === 'busy') return { skip: 'the name service is limiting new names from this network: ' + await h.text('#nameTip') }
      }
      return { ok: got && t.length < 100, detail: { qr: t, chars: t.length } }
    })
    await R('RCV-ARRIVE-QUIET', w, 'Nothing is said about a payment before one comes in', h, async () => {
      const v = await h.visible('#recvArrive'); return { ok: !v, detail: { arrivalLine: v } }
    })
    await h.click('#btnRecvMore'); await sleep(800)
    await R('RCV-MORE', w, 'More options: the payment name and where to change it, "Request a specific amount", New code, Show full code, Confidential', h, async () => {
      const r = { name: await h.text('#recvMoreName'), amountLabel: await h.text('#recvAmtLbl'), amountHint: await h.eval("(document.querySelector('#recvAmt')||{}).placeholder||''"),
        amount: await h.visible('#recvAmt'), newCode: await h.text('#btnRecvNew'), full: await h.text('#btnRecvFull'), conf: await h.visible('#recvConfChk') || await h.visible('#recvConfRow'),
        confLabel: await h.text('#recvConfLbl'), less: await h.text('#btnRecvMore') }
      const ok = /^Your payment name is \w+@sequentiatestnet\.com\. You can change or remove it in Settings\.$/.test(r.name) && /^request a specific amount$/i.test(r.amountLabel) &&
        /Amount in BTC/i.test(r.amountHint) && r.amount && r.newCode === 'New code' && r.full === 'Show full code' && r.conf && r.confLabel === 'Confidential' && r.less === 'Fewer options'
      return { ok, detail: r }
    })
    await h.click('#btnRecvFull'); await sleep(1000)
    await R('RCV-CODE', w, 'Show full code: one receive code, bitcoin:<address>?ark=…&sequentia=…, shown and in the QR code; Show name goes back', h, async () => {
      const code = await h.text('#addr'), shown = await h.visible('#addr'), qr = await qrText(), back = await h.text('#btnRecvFull')
      return { ok: joined && shown && /^bitcoin:tb1[a-z0-9]+\?.*ark=.*sequentia=/i.test(code) && qr === code && back === 'Show name', detail: { shown, code: code.slice(0, 60) + '…', back } }
    })
    await R('RCV-SHORT', w, 'The full code scans: upper case, the request short (SQR1…) and under 300 characters, the whole code under 600', h, async () => {
      const code = (await h.text('#addr')).trim()
      const req = (/&sequentia=(SQR1[0-9A-Z]+)(&|$)/.exec(code) || [])[1] || ''
      const ok = /^BITCOIN:TB1[0-9A-Z]+\?/.test(code) && !!req && req.length < 300 && code.length < 600
      return { ok, detail: { chars: code.length, request: req.length, code: code.slice(0, 60) + '…' } }
    })
    await h.click('#btnRecvFull'); await sleep(800)
    await R('RCV-AMOUNT', w, 'An amount requested: the QR code is the code naming it and carrying an invoice', h, async () => {
      await h.type('#recvAmt', '0.0001')
      const ok = await h.waitFor("/amount=0\\.0001/.test((document.querySelector('#qr')||{dataset:{}}).dataset.text||'') && /lightning=/.test(document.querySelector('#qr').dataset.text)", 60000).then(() => true, () => false)
      const code = await qrText(); await h.type('#recvAmt', '')
      // The QR code is drawn again without the amount a moment after the field empties: the next
      // line reads Receive as a person leaves it, not mid-redraw.
      await h.waitFor("/@/.test((document.querySelector('#qr')||{dataset:{}}).dataset.text||'')", 15000).catch(() => {})
      return { ok, detail: code.replace(/(lightning=)\w{12}\w*/i, '$1…').slice(0, 140) }
    })
    await R('RCV-CONF', w, 'Confidential on: the QR code is the confidential address (tsqb1…) and the line says so; off again, the name', h, async () => {
      await h.click('#recvConfChk'); await sleep(1000)
      const qr = await qrText(), line = await h.text('#recvLine')
      await h.click('#recvConfChk'); await sleep(1000)
      const after = await qrText()
      return { ok: /^tsqb1/.test(qr) && line === 'Any Sequentia asset, any amount, paid to your confidential address.' && /@/.test(after), detail: { qr: qr.slice(0, 16) + '…', line, after } }
    })
    await R('RCV-NO-HEX', w, 'No restricted-asset card, account id or other hex identifier on Receive unless asked for', h, async () => {
      const card = await h.visible('#recvOampCard'), hex = (await h.text('section[data-panel=receive]')).match(/\b[0-9a-f]{40,}\b/g) || []
      return { ok: !card && !hex.length, detail: { card, hex: hex.map((x) => x.slice(0, 12) + '…') } }
    })
    await R('RCV-NO-INVOICE', w, 'Receive: a wallet holding no BTC shows no invoice card and no empty framed box', h, async () => {
      const c = await h.visible('#lnRecvCard'), box = await h.visible('#lnRecvBolt11')
      return { ok: !c && !box, detail: { card: c, emptyBox: box } }
    })
    if (words) await R('RCV-WORDS', w, 'Receive says none of the words default mode never says', h, async () => {
      const f = forbiddenIn(await h.text('section[data-panel=receive]'), words); return { ok: !f.length, detail: f }
    })
    await h.click('#btnRecvMore'); await sleep(500)
    await tab(h, 'settings')
    await R('SET-NAME', w, 'Settings holds the payment name, with Copy, Change name and Remove name', h, async () => {
      const r = { shown: await h.visible('#setNameCard #nameBox'), name: await h.text('#nameAddr'), copy: await h.visible('#btnNameCopy'),
        change: await h.text('#btnNameChoose'), remove: await h.text('#btnNameRemove') }
      return { ok: r.shown && /@sequentiatestnet\.com$/.test(r.name) && r.copy && r.change === 'Change name' && r.remove === 'Remove name', detail: r, at: '#setNameCard' }
    })

    await tab(h, 'send')
    await R('SND-RECIPIENT', w, 'Send: the field is "Recipient", hint "a receive code, a payment name, an address or an invoice"', h, async () => {
      const r = await h.eval("(()=>{const i=document.querySelector('section[data-panel=send] .raddr'); const l=i&&i.closest('.rec').querySelector('label'); return {label:l&&l.innerText.trim(), hint:i&&i.placeholder}})()")
      return { at: 'section[data-panel=send] .raddr', ok: /^recipient$/i.test(r.label || '') && r.hint === 'a receive code, a payment name, an address or an invoice', detail: r }
    })
    await R('SND-BALANCE', w, 'Send: next to the asset its one figure, "balance <amount>"', h, async () => {
      const t = await h.text('section[data-panel=send] .ravail'); return { at: 'section[data-panel=send] .ravail',  ok: /^balance /.test(t), detail: t }
    })
    await R('SND-NO-INVOICE', w, 'Send: a wallet holding no BTC shows no "Pay an invoice" card', h, async () => {
      const c = await h.visible('#lnSendCard'); return { ok: !c, detail: { card: c } }
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
    await R('TRD-FLIP', w, 'Trade: ⇅ exchanges You pay and You receive, the amount typed going with its asset', h, async () => {
      if (!(await h.visible('#ucFlip'))) return { ok: false, detail: 'no ⇅ control' }
      await h.type('#ucAmount', '0.001'); await sleep(600)
      const before = await h.eval("[document.querySelector('#ucPay').innerText.trim(), document.querySelector('#ucGet').innerText.trim()]")
      await h.click('#ucFlip'); await sleep(1500)
      const after = await h.eval("[document.querySelector('#ucPay').innerText.trim(), document.querySelector('#ucGet').innerText.trim(), document.querySelector('#ucReceive').value]")
      await h.click('#ucFlip'); await sleep(1000); await h.type('#ucAmount', '')
      return { ok: after[0] === before[1] && after[1] === before[0] && after[2] === '0.001', detail: { before, after } }
    })
    await R('MKT-BTC-QUOTE', w, 'Market: BTC against a fiat stablecoin is priced in the stablecoin ("BTC / USDX")', h, async () => {
      const p1 = await h.eval(pickAsset('#ucPay', 'BTC')), p2 = await h.eval(pickAsset('#ucGet', 'USDX'))
      await h.waitFor("/\\//.test((document.querySelector('#ucMarket')||{}).innerText||'')", 20000).catch(() => {})
      const head = (await h.text('#ucMarket')).split('\n')[0]
      return { ok: p1 && p2 && /^BTC \/ USDX/.test(head), detail: { picked: [p1, p2], head } }
    })
    if (w === widths[0]) await R('TRD-KEEP-RELOAD', w, 'A reload keeps the open tab and the Trade pair and amount', h, async () => {
      await h.type('#ucAmount', '0.002'); await sleep(800)
      const pair = await h.eval("[document.querySelector('#ucPay').innerText.trim(), document.querySelector('#ucGet').innerText.trim()]")
      await b.send('Page.reload', {}, h.page.sessionId)
      await h.waitFor("document.querySelector('#app') && getComputedStyle(document.querySelector('#app')).display !== 'none' && !!document.querySelector('#ucAmount')", 240000).catch(() => {})
      await sleep(3000)
      const r = await h.eval("({tab:(document.querySelector('#tabs button.active')||{dataset:{}}).dataset.tab, pay:(document.querySelector('#ucPay')||{innerText:''}).innerText.trim(), get:(document.querySelector('#ucGet')||{innerText:''}).innerText.trim(), amount:(document.querySelector('#ucAmount')||{}).value})")
      await h.type('#ucAmount', '').catch(() => {})
      return { ok: r.tab === 'swap' && r.pay === pair[0] && r.get === pair[1] && r.amount === '0.002', detail: { before: pair, after: r } }
    })
    if (words) await R('TRD-WORDS', w, 'Trade says none of the words default mode never says', h, async () => {
      const f = forbiddenIn(await h.text('section[data-panel=swap]'), words); return { ok: !f.length, detail: f }
    })
    await tab(h, 'history')
    await R('HIS-OPEN', w, 'History opens', h, async () => ({ ok: await h.visible('#historyPanel') }))
    await R('HIS-NO-RESCUE', w, 'History in default mode offers no Bump fee, Replace or Speed up: a payment that waits is sped up by itself', h, async () => {
      await tab(h, 'history')
      const found = await h.eval("[...document.querySelectorAll('#historyPanel button')].map(b=>b.textContent.trim()).filter(t=>/^(Bump fee|Replace…|Speed up)$/.test(t))")
      await tab(h, 'balance')
      return { ok: !found.length, detail: found }
    })
    // A payment to an address that was never made (its page closed before the operator's
    // settlement) is said once on Balance and as "Not sent" in History. Nothing is sent here: the
    // wallet's own record of such a payment is written into the page, as the page writes it when
    // the leaf library lists the payment `not_made`, and the page is read and its OK pressed.
    await R('SEND-NOT-MADE-SAID', w, 'A payment to an address that was never made is said once on Balance, with OK, and reads "Not sent" in History', h, async () => {
      const seeded = await h.eval(`(()=>{ const k=Object.keys(localStorage).find(k=>k.startsWith('swk.leaves.code.')); if(!k) return null; const tag=k.slice('swk.leaves.code.'.length);
        const key='swk.instantHist.'+tag; const l=JSON.parse(localStorage.getItem(key)||'[]'); const id='${'0'.repeat(56)}'+String(Date.now()).slice(-8);
        l.push({ kind:'out', at:Date.now()-60000, later:true, legs:[{ asset:'4dfe69c334a9cdf4005ddf3889bba1bc397703fa8da669254877f3209caf7c8f', atoms:'100000000' }], offboard:id, stage:'not_made', address:'tb1q68apqvgwpsnewuwvtjy2xra4g3phq23quqzedu' });
        localStorage.setItem(key, JSON.stringify(l)); return id })()`)
      if (!seeded) return { ok: false, detail: 'no receive code kept for this wallet: the record could not be placed' }
      await tab(h, 'history'); await tab(h, 'balance')
      const CARD = "(()=>{ const c=document.getElementById('newsCard'); return c && !c.classList.contains('hide') ? c.innerText.replace(/\\s+/g,' ').trim() : '' })()"
      await h.waitFor(CARD, 20000).catch(() => {})
      const card = await h.eval(CARD)
      await tab(h, 'history')
      const row = await h.eval("(()=>{ const r=[...document.querySelectorAll('.item.instant')].find(i=>/Not sent/.test(i.innerText)); return r ? r.innerText.replace(/\\s+/g,' ').trim() : '' })()")
      await tab(h, 'balance')
      await h.eval(`(()=>{ const l=document.querySelector('#newsCard [data-offboard="${seeded}"] button'); if(l) l.click(); return !!l })()`)
      await sleep(800)
      const gone = await h.eval(`!document.querySelector('#newsCard [data-offboard="${seeded}"]')`)
      const ok = /Your payment of 1 OILX to tb1q68apqvgwps…zedu was not made: nothing left your wallet\. Send it again\./.test(card) && /Nothing left your wallet/.test(row) && gone
      return { ok, detail: { card, row, gone } }
    })
    if (words) await R('APP-WORDS', w, 'No tab in default mode says a word default mode never says', h, async () => {
      const found = {}
      for (const t of ['balance', 'send', 'receive', 'swap', 'history']) { await tab(h, t); const f = forbiddenIn(await h.text('#app'), words); if (f.length) found[t] = f }
      return { ok: !Object.keys(found).length, detail: found }
    })
    if (words) await R('MORE-WORDS', w, 'Mix, Issuance, Stake, Sign, Help and Settings say no word default mode never says, and no dash in a sentence', h, async () => {
      const found = {}
      for (const t of ['mix', 'assets', 'stake', 'sign', 'help', 'settings']) {
        await h.eval(`(document.querySelector('#tabs button[data-tab=${t}]')||{click(){}}).click(),1`); await sleep(1500)
        const txt = await h.text(`section[data-panel=${t}]`); const f = [...forbiddenIn(txt, words), ...['SeqDEX', 'OpenAMP'].filter((x) => txt.includes(x)), ...dashes(txt)]
        if (f.length) found[t] = f
      }
      await tab(h, 'balance')
      return { ok: !Object.keys(found).length, detail: found }
    })
    if (w === 'phone') await R('PHONE-FIT', w, 'Phone: no tab scrolls sideways', h, async () => {
      const over = {}
      for (const t of ['balance', 'send', 'receive', 'swap', 'history']) { await tab(h, t); const o = await h.overflow(); if (o > 1) over[t] = o + 'px' }
      return { ok: !Object.keys(over).length, detail: over }
    })
  }
  // A faucet payment is in the balance the moment the faucet says it was sent, and in History.
  await R('FAUCET-AT-ONCE', null, 'A faucet payment shows under its asset as arriving the moment the faucet says it was sent, and History lists it as Received', h, async () => {
    await setWidth(b, page, widths[0]); await tab(h, 'balance')
    // An asset button still on: the faucet pays each asset once per wallet.
    const asset = await h.eval("(()=>{const on=[...document.querySelectorAll('#faucetBtns button')].filter(x=>!x.disabled); const b=on.find(x=>x.dataset.faucet==='EURX')||on.find(x=>x.dataset.faucet && x.dataset.faucet!=='BTC'); if(!b) return null; b.click(); return b.dataset.faucet})()")
    if (!asset) return { skip: 'no faucet button for an asset this wallet has not received' }
    const said = await h.waitFor("/arriving|Received|already|error/i.test((document.querySelector('#faucetStatus')||{}).innerText||'')", 120000).then(() => true, () => false)
    const st = await h.text('#faucetStatus')
    // Without the token, a network the faucet has paid for ten wallets today is held back.
    if (/already paid .* on your network/i.test(st)) return { skip: (faucetExempt ? 'the faucet refused the suite\'s token: ' : 'no faucet token (README), and the faucet paid this network today: ') + st }
    if (!said || !/arriving|Received/.test(st)) return { ok: false, detail: 'faucet: ' + st }
    const shown = await h.waitFor(`[...document.querySelectorAll('section[data-panel=balance] .bt-tk .tk')].some(e=>e.innerText.trim()===${JSON.stringify(asset)})`, 2500).then(() => true, () => false)
    await h.waitFor("/Received/.test((document.querySelector('#faucetStatus')||{}).innerText||'')", 120000).catch(() => {})
    await tab(h, 'history')
    const row = await h.waitFor(`[...document.querySelectorAll('#histList .item')].some(i=>/Received/.test(i.innerText) && i.innerText.includes(${JSON.stringify(asset)}))`, 30000).then(() => true, () => false)
    return { ok: shown && row, detail: { faucet: st, inBalanceWithin2_5s: shown, historyRow: row } }
  })
  // A payment lands on Receive itself, so whoever holds up the QR code sees it arrive without
  // leaving the screen: the faucet is asked from the page while Receive is open.
  await R('RCV-ARRIVE', null, 'With Receive open, a payment coming in reads "Payment arriving…", then "Received <amount> <TICKER>." on the same screen', h, async () => {
    await setWidth(b, page, widths[0]); await tab(h, 'balance')
    const asset = await h.eval("(()=>{const on=[...document.querySelectorAll('#faucetBtns button')].filter(x=>!x.disabled && x.dataset.faucet && x.dataset.faucet!=='BTC' && x.dataset.faucet!=='EURX'); return on.length ? on[0].dataset.faucet : null})()")
    if (!asset) return { skip: 'no faucet button for an asset this wallet has not received' }
    await tab(h, 'receive')
    await h.eval(`(()=>{const x=[...document.querySelectorAll('#faucetBtns button')].find(x=>x.dataset.faucet===${JSON.stringify(asset)}); x.click(); return true})()`)
    const arriving = await h.waitFor("/Payment arriving/.test((document.querySelector('#recvArrive')||{}).innerText||'')", 60000).then(() => true, () => false)
    const got = await h.waitFor(`/^Received [0-9.,]+ ${asset}\\.$/.test((document.querySelector('#recvArrive')||{}).innerText||'')`, 180000).then(() => true, () => false)
    const line = await h.text('#recvArrive'), faucet = await h.text('#faucetStatus')
    if (/already paid .* on your network/i.test(faucet)) return { skip: 'the faucet held this network back: ' + faucet }
    return { ok: arriving && got, detail: { asset, arrivingSeen: arriving, line, faucet } }
  })
  // The node calls the leaf wallet makes to read an address a person gives it (a payment from
  // leaves, an offboard, a claim) and to tell a supervised asset from a plain one, asked of the
  // page's own node route as the wallet asks them.
  // What waits on the chain is sped up by itself, in words default mode may say; and a coin
  // received out of round is refreshed by itself unless the page turns it off, with a library that
  // takes a waiting refresh back, so a refresh never holds a coin the wallet needs (arca#492).
  await R('SPEED-REFRESH-BUILT', null, 'The page speeds up what waits by itself, in words default mode may say, and refreshes received coins with a library that takes a waiting refresh back', h, async () => {
    const r = await h.eval(`(async()=>{const t=(p)=>fetch(new URL(p,location.href)).then(r=>r.ok?r.text():'');
      const sp=await t('speed-up.js'), lv=await t('leaves.js'), wasm=await t('leaves/pkg/leaf_wallet_bg.wasm');
      const m=sp.match(/spedUp: '([^']+)'/);
      return {words:m?m[1]:null, refreshByDefault:lv.includes('window.SEQ_REFRESH_RECEIVED === false'), refreshOff:window.SEQ_REFRESH_RECEIVED===false, library:wasm.includes('speed_up'), withdraws:wasm.includes('Arca/participation-withdraw')}})()`)
    const said = r.words ? forbiddenIn(r.words, words || []) : ['no words']
    return { ok: !!r.words && !said.length && r.refreshByDefault && !r.refreshOff && r.library && r.withdraws, detail: r }
  })
  await R('NODE-READS', null, 'The node route answers the wallet\'s address and supervised-asset reads', h, async () => {
    const r = await h.eval(`(async()=>{const call=(method,params)=>fetch('/node-rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,params,id:1})}).then(r=>r.json());
      const v=await call('validateaddress',['tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx']);
      const s=await call('getsupervisedassets',[]);
      const a=(Array.isArray(s.result)&&s.result[0]&&s.result[0].asset)||'0'.repeat(64);
      const f=await call('isassetfrozen',[a,'0014'+'11'.repeat(20)]);
      return {validateaddress:v.error?v.error.message:(v.result&&v.result.isvalid),getsupervisedassets:s.error?s.error.message:s.result.length+' assets',isassetfrozen:f.error?f.error.message:f.result}})()`)
    const refused = (x) => typeof x === 'string' && /not allowed here/.test(x)
    return { ok: r.validateaddress === true && !refused(r.getsupervisedassets) && !refused(r.isassetfrozen), detail: r }
  })
  // A name released on another device while this one shows it (web #809): Receive stops showing
  // it within seconds, no other wallet can take it, a payer looking it up is told nobody goes by
  // it, and after a reload the page never shows it. The wallet then takes a name again in Settings.
  await R('NAME-ELSEWHERE', null, 'A name released on another device while Receive shows it: gone from Receive within seconds, never another wallet\'s, unknown to payers, not shown after a reload; Get a name brings one back', h, async () => {
    await setWidth(b, page, widths[0]); await tab(h, 'receive')
    const QR = "(document.querySelector('#qr')||{dataset:{}}).dataset.text||''"
    const named = await h.waitFor(`/^[a-z0-9_-]{3,32}@sequentiatestnet\\.com$/.test(${QR}) ? ${QR} : false`, 90000).catch(() => null)
    if (!named) return { skip: 'the fresh wallet shows no name on Receive' }
    const name = named.split('@')[0]
    const svc = (body) => `(async()=>{const L=await import(new URL('lnaddr.js', location.href).href);
      const lsp=(window.SEQ_LSP_URL||new URL('/lsp', location.href).href).replace(/\\/$/,''); const ts=Math.floor(Date.now()/1000);
      const k=L.nameKey(localStorage.getItem('swk.sequentia.mnemonic')); const other=L.nameKey('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong');
      const post=(p,b)=>fetch(lsp+'/lnaddr/-/'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(r=>r.status);
      ${body}})()`
    // Another device of the same wallet releases it.
    const t0 = Date.now()
    const released = await h.eval(svc(`return post('release',{name:${JSON.stringify(name)},ts,sig:L.signWith(k.priv,L.signedDigest('release','sequentiatestnet.com',${JSON.stringify(name)},ts))})`))
    const gone = await h.waitFor(`!(${QR}).startsWith(${JSON.stringify(name + '@')})`, 15000).then(() => true, () => false)
    const goneMs = Date.now() - t0
    // Another wallet tries to take it; a payer looks it up.
    const taken = await h.eval(svc(`return post('register',{name:${JSON.stringify(name)},pubkey:other.pub,ts,sig:L.signWith(other.priv,L.signedDigest('register','sequentiatestnet.com',${JSON.stringify(name)},other.pub,ts))})`))
    const lookup = await h.eval(svc(`return fetch(lsp+'/lnaddr/'+${JSON.stringify(name)}).then(r=>r.status)`))
    // Reloaded: the page never shows it, sampled for 20 s once the wallet is open.
    await b.send('Page.navigate', { url: BASE }, page.sessionId)
    await h.waitFor("document.querySelector('#app') && getComputedStyle(document.querySelector('#app')).display !== 'none'", 240000)
    await tab(h, 'receive')
    let shownAfterReload = false
    for (let i = 0; i < 40; i++) { if ((await h.eval(QR)).startsWith(name + '@')) { shownAfterReload = true; break } await sleep(500) }
    // The person takes a name again in Settings.
    await tab(h, 'settings')
    await h.eval("(document.querySelector('#btnNameGet')||{click(){}}).click(), true")
    const back = await h.waitFor("(document.querySelector('#nameAddr')||{}).textContent || false", 60000).catch(() => '')
    await tab(h, 'receive')
    const ok = released === 200 && gone && goneMs < 15000 && taken === 409 && lookup === 404 && !shownAfterReload && !!back
    return { ok, detail: { name, released, goneMs, taken, lookup, shownAfterReload, back } }
  })
  // The fresh wallet's name is removed, so a run leaves no name behind at the service, and the
  // removal is the service's to keep: it then holds no name for the key and marks it as removed.
  await R('NAME-REMOVE', null, 'Remove name in Settings: the service holds no name for the wallet afterwards, and marks it as removed so no device makes one again by itself', h, async () => {
    const r = await h.eval(`(async()=>{
      const name=(document.querySelector('#nameAddr')||{}).textContent||'';
      const btn=document.querySelector('#btnNameRemove'); if(!name || !btn) return {name, skipped:true};
      btn.click();
      for(let i=0;i<60 && (document.querySelector('#nameAddr')||{}).textContent;i++) await new Promise(r=>setTimeout(r,500));
      const { nameKey } = await import(new URL('lnaddr.js', location.href).href);
      const pub = nameKey(localStorage.getItem('swk.sequentia.mnemonic')).pub;
      const lsp = (window.SEQ_LSP_URL || new URL('/lsp', location.href).href).replace(/\\/$/, '');
      const mine = await fetch(lsp + '/lnaddr/-/mine?pubkey=' + pub).then(r=>r.json()).catch((e)=>({error:String(e)}));
      return {name, left:(document.querySelector('#nameAddr')||{}).textContent||'', mine}})()`)
    if (r.skipped) return { skip: 'the fresh wallet holds no name to remove' }
    return { ok: !r.left && r.mine && r.mine.ok && r.mine.name === null && r.mine.declined === true, detail: r }
  })
  await R('NO-ERRORS', null, 'No uncaught error on the page (fresh wallet)', null, async () => ({ ok: problems(page).length === 0, detail: problems(page).slice(0, 4) }))

  // ---------- the funded test wallet ----------
  if (!funded) {
    for (const id of ['BAL-RELOAD', 'BAL-BTC-FIRST', 'BAL-HIDE', 'SND-PICKER-HELD', 'SND-FEE-LINE', 'AMT-GROUPED', 'TRD-NO-FALSE-UPTO', 'TRD-HELD-FIRST', 'TRD-HIDDEN', 'STK-FROM-BALANCE', 'DEV-PICKER', 'DEV-TETHER']) report.skip('WW-' + id, null, 'needs the funded test wallet', 'no --funded phrase file')
    return
  }
  // A fresh profile for it: the page holds one wallet per origin.
  await b.send('Page.navigate', { url: 'about:blank' }, page.sessionId); await sleep(1000)
  await b.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' }, page.sessionId).catch(() => {})
  await setWidth(b, page, widths[0])
  await openWallet(b, h, { phrase: funded.phrase })
  await tab(h, 'balance')
  const held = await h.waitFor("(()=>{const t=[...document.querySelectorAll('section[data-panel=balance] .bt-tk .tk')].map(e=>e.innerText.trim()); return t.length>=3 ? t : false})()", 240000).then(() => true, () => false)
  await R('BAL-RELOAD', null, 'A reload opens on the last figures: the total never reads 0, nor "Up to date." before everything is read', h, async () => {
    await h.waitFor("/Up to date/.test((document.querySelector('#syncStatus')||{}).innerText||'')", 240000).catch(() => {})
    await b.send('Page.reload', {}, h.page.sessionId)
    const seen = []; const t0 = Date.now()
    while (Date.now() - t0 < 15000) {
      await sleep(250)
      const r = await h.eval("({t:((document.querySelector('#balTotal')||{}).innerText||'').replace(/\\s+/g,' '), s:((document.querySelector('#syncStatus')||{}).innerText||'')})").catch(() => null)
      if (r && r.t && (!seen.length || seen[seen.length - 1].t !== r.t || seen[seen.length - 1].s !== r.s)) seen.push({ ms: Date.now() - t0, ...r })
    }
    const zero = seen.filter((x) => /total balance 0 /i.test(x.t))
    return { ok: held && !zero.length, detail: zero.length ? { zero: zero.slice(0, 3) } : seen.slice(0, 4) }
  })
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
    await tab(h, 'send')
    await R('SND-PICKER-HELD', w, 'Send: the asset picker lists BTC, then every asset the wallet holds, with its balance', h, async () => {
      await tab(h, 'balance'); const bal = (await balanceTickers(h).catch(() => [])) || []; await tab(h, 'send')
      const p = await h.eval(PICKER('#recipients .rec .asset-chooser')); await h.eval(CLOSE)
      // Every row Balance lists (a hidden asset is not one of them) is under Your assets.
      return { ok: p.rows[0] === 'BTC' && bal.length > 1 && bal.every((t) => p.rows.includes(t)), detail: { rows: p.rows.slice(0, 8), groups: p.groups, balance: bal } }
    })
    await R('SND-FEE-LINE', w, 'Send: paying a receive code shows no network fee line waiting for the amount', h, async () => {
      await tab(h, 'receive'); const code = (await h.text('#addr')).trim(); await tab(h, 'send')
      await h.eval("(()=>{const s=document.querySelector('#recipients .rec .rasset'); const o=[...s.options].find(x=>x.textContent.trim()==='USDX'); if(o){ s.value=o.value; s.dispatchEvent(new Event('change',{bubbles:true})) } return !!o})()")
      await h.type('#recipients .rec .raddr', code); await h.type('#recipients .rec .ramt', '0.01'); await sleep(2500)
      const shown = await h.visible('#sendFeeBox'), t = shown ? await h.text('#sendFeeBox') : ''
      const avail = await h.text('#recipients .rec .ravail')
      await h.type('#recipients .rec .raddr', ''); await h.type('#recipients .rec .ramt', '')
      // A code paid at its address (before the wallet's instant side has opened) has a fee line, which
      // must say the fee: never one waiting for the amount already typed.
      return { ok: /^bitcoin:/i.test(code) && !/set once the amount is entered/.test(t), detail: { feeLine: shown ? t.slice(0, 80) : '(none)', balanceLine: avail } }
    })
    await R('AMT-GROUPED', w, 'Amounts outside Balance are grouped as Balance groups them (Send, the pickers, Trade)', h, async () => {
      const send = await h.text('#recipients .rec .ravail')
      const p = await h.eval(PICKER('#recipients .rec .asset-chooser')); const rows = await h.eval("[...document.querySelectorAll('.swpop .swopt-bal')].map(x=>x.innerText).join(' | ')"); await h.eval(CLOSE)
      await tab(h, 'swap'); await sleep(2500)
      const have = await h.text('#ucHave')
      const found = [...ungrouped(send), ...ungrouped(rows), ...ungrouped(have)]
      return { ok: !found.length, detail: { send, have, ungrouped: found, picker: p.kind } }
    })
    await tab(h, 'swap'); await sleep(4000)
    await R('TRD-NO-FALSE-UPTO', w, 'Trade: no "The book can fill up to …" for an amount the book can fill', h, async () => {
      const ok1 = await h.eval(pickAsset('#ucPay', 'USDX')), ok2 = await h.eval(pickAsset('#ucGet', 'GOLD'))
      await h.type('#ucAmount', '1'); await h.waitFor("Number((document.querySelector('#ucReceive')||{}).value)>0", 30000).catch(() => {})
      await sleep(1500); const note = await h.text('#ucNote'); const got = await h.eval("document.querySelector('#ucReceive').value"); await h.type('#ucAmount', '')
      if (!(Number(got) > 0)) return { skip: 'the book priced nothing for 1 USDX → GOLD: ' + (note || 'no answer') }
      return { ok: ok1 && ok2 && !/can fill up to/i.test(note), detail: { receive: got, note } }
    })
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
    await R('STK-FROM-BALANCE', w, 'Stake and Mix count what the balance shows: Stake offers its fee in a held asset, Mix says what is held', h, async () => {
      await h.eval("(document.querySelector('#tabs button[data-tab=stake]')||{click(){}}).click(),1"); await sleep(1500)
      const fee = await h.eval("[...document.querySelectorAll('#stFeeAsset option')].map(o=>o.textContent)")
      await h.eval("(document.querySelector('#tabs button[data-tab=mix]')||{click(){}}).click(),1"); await sleep(3000)
      const plan = await h.text('#cjPlan')
      await tab(h, 'swap'); await sleep(1500)
      return { ok: Array.isArray(fee) && fee.length >= 1 && !/transparent coins/.test(plan) && !/you hold 0 /.test(plan), detail: { feeChoices: fee, mixPlan: plan.slice(0, 120) } }
    })
    await R('TRD-HELD-TRADABLE', w, 'Trade: every asset the balance shows can be paid from (never "You have no <T> to trade.")', h, async () => {
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
