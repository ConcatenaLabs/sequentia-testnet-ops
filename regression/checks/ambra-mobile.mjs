// Ambra mobile, read from its source (a fresh clone of its default branch): no phone or emulator
// runs here. Each line names the file and what in it carries the capability. A source line says
// the capability is built, not that it works on a phone: those are run on a device, by hand.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { clone } from '../lib/suite.mjs'

export async function run ({ report, cache }) {
  const { dir, rev } = clone(cache, 'ambra')
  report.note(`Ambra mobile ${rev} (source)`)
  const src = (p) => { const f = join(dir, 'app/lib/src', p); return existsSync(f) ? readFileSync(f, 'utf8') : '' }
  const R = (id, line, fn) => report.line('AM-' + id, 'source', line, null, async () => fn())
  const composer = src('screens/user_composer.dart'), send = src('screens/send_screen.dart'), shell = src('screens/shell.dart')
  const picker = src('data/asset_picker.dart'), words = src('data/default_words.dart'), history = src('screens/history_screen.dart')
  const engine = src('data/user_trade.dart'), market = src('data/market_view.dart') + src('widgets/market_view.dart')

  await R('TRD-SEARCH', 'Trade (default mode): the pickers are the searchable chooser, your assets first, hidden ones left out until searched for (showAssetSheet)', () => {
    const plain = /DropdownButton<String>\(/.test(composer); const sheet = /showAssetSheet\(/.test(composer)
    return { ok: sheet && !plain, detail: plain ? 'user_composer.dart: _picker is a plain DropdownButton (ucPay, ucGet)' : { sheet } }
  })
  await R('TRD-AMOUNTS', 'Trade (default mode): an amount in You pay shows what You receive, and the other way', () => {
    // Two amount fields, the receive one included, and the engine's two-way estimate behind them.
    const fields = /ValueKey\('ucAmount'\)|'ucAmount'/.test(composer) && /'ucReceive'/.test(composer)
    const est = /engine\.estimate\(/.test(composer) && /receiveAtoms/.test(composer) && /Future<Estimate> estimate\(/.test(engine)
    return { ok: fields && est, detail: fields && est ? '' : `fields ${fields}, two-way estimate ${est} (user_composer.dart, user_trade.dart)` }
  })
  await R('TRD-MARKET', 'Trade (default mode): the pair\'s market (last price, 1D 1W 1M chart, best bid and ask, recent trades)', () => {
    const ok = /MarketView\(/.test(composer) && /'1D'/.test(market) && /Best bid/.test(market) && /Recent trades/.test(market) && /CustomPainter/.test(market)
    return { ok, detail: ok ? '' : 'no market view in user_composer.dart (data/market_view.dart, widgets/market_view.dart)' }
  })
  await R('SND-PICKER', 'Send: a searchable asset sheet, BTC first, held first, hidden left out, every asset found by searching', () => {
    const ok = /showAssetSheet\(/.test(send) && /registrySearch:\s*true/.test(send) && /isHidden\(/.test(send) && /BTC/.test(picker) && /hidden/.test(picker)
    return { ok }
  })
  await R('BAL-HIDE', 'Balance: an asset can be hidden and comes back from "Hidden assets (N)"; BTC cannot be hidden', () => {
    const ok = /_HiddenAssetsSection/.test(shell) && /Hidden assets/.test(shell) && /setHidden/.test(src('data/hidden_assets.dart'))
    return { ok }
  })
  await R('RCV-CODE', 'Receive (default mode): "Receive code", "Copy receive code", "New code", one bitcoin: pay code', () => {
    const ok = /Receive code/.test(words) && /Copy receive code/.test(words) && /New code/.test(words) && /PayCode\(/.test(shell)
    return { ok }
  })
  const code = src('data/pay_code.dart'), scan = src('screens/scan_screen.dart'), wcache = src('data/wallet_cache.dart')
  await R('RCV-SHORT', 'Receive: the code scans at a glance: upper case, the request short (SQR1…), a QR code in alphanumeric segments at level M; old codes still read', () => {
    const ok = /String\? compactRequest\(/.test(code) && /requestHrp = 'sqr'/.test(code) && /QrCode payCodeQr\(/.test(code) && /addAlphaNumeric/.test(code) &&
      /QrImageView\.withQr\(/.test(shell) && /payCodeQr\(_code!\)/.test(shell) && /libraryRequest\(s\)/.test(code)
    return { ok, detail: ok ? 'pay_code.dart, shell.dart' : 'no short code or segmented QR (pay_code.dart payCodeQr, shell.dart QrImageView.withQr)' }
  })
  await R('SCN-CODE', 'Scan: a scanned receive code is kept whole (its instant ways to pay), 720p, tap to focus, decoded off the UI thread', () => {
    const keep = /PayCode\.read\(raw\)/.test(send) && /_addr\.text = raw\.trim\(\)/.test(send)
    const cam = /ResolutionPreset\.high/.test(scan) && /setFocusPoint/.test(scan) && /Isolate\.run/.test(scan)
    return { ok: keep && cam, detail: keep && cam ? '' : `keeps the code ${keep}, camera ${cam} (send_screen.dart _scan, scan_screen.dart)` }
  })
  await R('SND-INSTANT', 'Send: a receive code is paid instant first (request, ark, invoice) and at its address only when none fits, saying so', () => {
    const ok = /LeafService\.instance\.payable\(seq\)/.test(send) && /code\.lightning/.test(send) && /DefaultWords\.byAddress\(/.test(send) && /static String byAddress\(/.test(words)
    return { ok }
  })
  await R('RCV-KEPT', 'Receive: the last code shows at once, syncing or not, until paid or lapsing; a new one replaces it only when ready', () => {
    const ok = /WalletCache\.loadReceiveCode\(\)/.test(shell) && /saveReceiveCode\(/.test(shell) && /saveReceiveCode\(/.test(wcache)
    return { ok }
  })
  await R('HIS-PENDING', 'History: a payment shows the moment it leaves, pending until its block; BTC arriving shows as soon as the network has it', () => {
    const ok = /WalletCache\.addPayment\(/.test(send) && /List<Map<String, dynamic>> incomingBtc\(/.test(history) && /settlePayment\(/.test(history)
    return { ok }
  })
  await R('ARK-MIGRATE', 'A wallet from before: its Lightning BTC moves to the ark by itself, and a board that never reached the network holds nothing back', () => {
    const ok = /class LightningToArk/.test(src('data/lightning_to_ark.dart')) && /boardsLost\(/.test(src('data/ark_btc_service.dart')) && /static String moving\(/.test(words)
    return { ok }
  })
  await R('WORDS-TEST', 'Default mode\'s sentences are tested against the words default mode never says', () => {
    const t = join(dir, 'app/test/default_words_test.dart'); const ok = existsSync(t) && /forbidden/.test(readFileSync(t, 'utf8'))
    return { ok, detail: ok ? 'app/test/default_words_test.dart' : 'no test' }
  })
  // Ambra #162 to #169 (package AM5).
  const ark = src('data/ark_btc_service.dart'), stake = src('screens/stake_screen.dart'), swords = src('data/stake_words.dart'), main = readFileSync(join(dir, 'app/lib/main.dart'), 'utf8')
  await R('TRD-BTC-ADDRESS', 'Trade: BTC at the address with too little on the ark is moved for the trade and said so, never "You have no BTC"; a board stops at the server\'s largest coin (#162)', () => {
    const ok = /'btc-moving'/.test(engine) && /btcMove/.test(composer) && /boardFor\(BigInt sats\)/.test(ark) && /if \(amount > maxBoard\) amount = maxBoard/.test(ark)
    return { ok, detail: ok ? '' : 'user_trade.dart btc-moving, ark_btc_service.dart boardFor / maxBoard' }
  })
  await R('TRD-DEADLINE', 'Trade: every source asked at once, the quote takes what answered within 8 s (20 s for the BTC desk alone), a late answer let go of (#163, #165)', () => {
    const ok = /kQuoteFirmMs = 8000/.test(engine) && /kBtcOnlyFirmMs = 20000/.test(engine) && /_inTime\(/.test(engine) && /Future\.wait\(\s*worth\.map/.test(engine)
    return { ok }
  })
  await R('TRD-KEPT', 'Trade: what was entered and a price being asked survive the background, the app lock and a restart; the lock covers the open wallet (#164)', () => {
    const ok = /draftKey/.test(composer) && /_restoreDraft\(/.test(composer) && /Offstage\(offstage: !repo\.unlocked/.test(main)
    return { ok }
  })
  await R('TRD-SENDING', 'Trade: the screen is free after 1.5 s and the trade goes on under Open as "Sending…" (#165)', () => {
    const ok = /kConfirmShownFor = Duration\(milliseconds: 1500\)/.test(composer) && /static const sending = 'Sending…'/.test(engine)
    return { ok }
  })
  await R('TRD-ABOUT', 'Trade: the amount that follows the price reads "about", Review reads "Getting the exact price…" (#166)', () => {
    const ok = /static const about = 'about'/.test(engine) && /Getting the exact price…/.test(engine) && /UserWords\.about/.test(composer)
    return { ok }
  })
  await R('TRD-WORDS', 'Trade: one word per state in Open and History, no promised time ("Received, settling") (#167)', () => {
    const ok = /'Received, settling'/.test(engine) && !/Settled in a minute or two|Settled after the next Bitcoin blocks/.test(engine) && /tradeStateWord\(rec,/.test(history)
    return { ok }
  })
  await R('TRD-FLIP', 'Trade: ⇅ between You pay and You receive, each amount with its asset (#168)', () => {
    const ok = /ValueKey\('ucFlip'\)/.test(composer) && /void _flip\(\)/.test(composer)
    return { ok }
  })
  await R('STK-PLAIN', 'Stake (default mode): what it is for, how much, where (pools by whether producing, none picked), cost, getting it back (#169)', () => {
    const ok = /whatTitle/.test(swords) && /poolVerdict\(/.test(swords) && /_plainBody\(/.test(stake) && /StakeWords\.step2/.test(stake)
    return { ok }
  })
  await R('HIS-TRADES', 'History: a default-mode trade is one row ("Swapped <pay> for <get>")', () => {
    const ok = /UserTrade|userTrade|Swapped/.test(history); return { ok, detail: ok ? '' : 'history_screen.dart lists chain transactions only; default-mode trades show only under Swap › Your trades' }
  })
}
