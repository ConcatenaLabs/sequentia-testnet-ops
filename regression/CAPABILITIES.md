# What each surface lets a person do

Every capability a person relies on, one line each, with the check that proves it on the live
testnet. The id is the line's id in the suite's output (`run.mjs`); a capability whose check is
not written yet says so, and why. "Contract" is the section of the default-mode contract,
[`sequentia-web-wallet/docs/DEFAULT_MODE.md`](https://github.com/ConcatenaLabs/sequentia-web-wallet/blob/main/docs/DEFAULT_MODE.md),
that the line holds a wallet to. A capability that a change removes on purpose leaves this page
in the same pull request as the change; one that disappears without that is a regression, and
the suite fails it.

How each surface is read:

- **Web wallet**: `sequentiatestnet.com/wallet/` in headless Chromium, desktop (1440 px) and
  phone (390 px), with a fresh wallet and with the funded test wallet.
- **SeqDEX**: `sequentiatestnet.com/dex/`, desktop and phone, with Ambra browser installed, first
  not connected, then connected.
- **Ambra browser**: the extension from a fresh clone of its default branch, its popup opened as
  a page, a fresh wallet and the funded test wallet imported.
- **Ambra mobile**: its source, from a fresh clone (no phone or emulator here). A source line says
  the capability is built, not that it runs; running it is a device check, by hand.

## Web wallet, default mode

| Id | A person can | Contract |
|---|---|---|
| WW-NODE-READS | pay an address from leaves, offboard or claim to it, and hold a supervised asset as one: the page's node route answers `validateaddress`, `getsupervisedassets` and `isassetfrozen` | Send |
| WW-BAL-FRESH | see a fresh wallet as one row, BTC at 0 | Names |
| WW-BAL-TOTAL | read one total in the reference currency | Balance |
| WW-BAL-REF | change the reference currency (Show values in) | Balance |
| WW-BAL-BTC-FIRST | see BTC first and every other asset as one row among equals, no "native" label | Names |
| WW-BAL-HIDE | hide an asset: it moves to "Hidden assets (n)", the total is unchanged | Balance |
| WW-BAL-FAUCET | ask the testnet faucet for an asset | Receive |
| WW-RCV-CODE | get one receive code, `bitcoin:<address>?ark=…&sequentia=…` | Receive |
| WW-RCV-TIP | read what the code takes ("Any asset, any amount. …") | Receive |
| WW-RCV-BUTTONS | copy the code, make a new one; no address-only controls | Receive |
| WW-RCV-AMOUNT | ask for an amount of BTC: the code names it and carries an invoice | Receive |
| WW-RCV-WORDS | read Receive without a word default mode never says | Never in default mode |
| WW-SND-RECIPIENT | paste a receive code, an address or an invoice into "Recipient" | Send |
| WW-SND-BALANCE | see the asset's one figure, "balance <amount>", beside it | Send |
| WW-SND-INVOICE | pay a BTC invoice ("Paste an invoice to pay it with your BTC.") | BTC |
| WW-SND-WORDS | read Send without a forbidden word or a fee-rate field | Never in default mode |
| WW-TRD-FORM | trade with You pay and You receive, their amounts, and Review | Trade |
| WW-TRD-PAY-SEARCH | search the You pay picker | Asset pickers |
| WW-TRD-GET-SEARCH | search the You receive picker and find an asset by ticker | Asset pickers |
| WW-TRD-PASTE-ID | paste an asset id into a picker and find it | Asset pickers |
| WW-TRD-HELD-FIRST | see BTC, then what the wallet holds, before the rest | Asset pickers |
| WW-TRD-HIDDEN | not see a hidden asset in a picker's first rows, and find it by search | Asset pickers |
| WW-TRD-AMOUNTS | type what they pay or what they get, and see the other | Trade |
| WW-TRD-HELD-TRADABLE | pay from every asset the balance shows (never "You have no <T> to trade.") | Trade |
| WW-TRD-REFUSE | read a refusal in plain words | Trade |
| WW-TRD-WORDS | read Trade without a forbidden word | Never in default mode |
| WW-MKT-HEAD | read the pair, its last price and 24h change | Market |
| WW-MKT-CHART | read a chart with 1D, 1W, 1M and the chart library's notice | Market |
| WW-MKT-BOOK | read the best bid and ask and the depth bar, or that nobody trades | Market |
| WW-MKT-TRADES | read recent trades, or "No trades yet" | Market |
| WW-HIS-OPEN | open History | History |
| WW-APP-WORDS | use every tab without meeting a forbidden word | Never in default mode |
| WW-PHONE-FIT | use every tab on a phone without sideways scrolling | (layout) |
| WW-NO-ERRORS, WW-NO-ERRORS-FUNDED | use the page without an uncaught error | (all) |

Not checked yet: History's one row per trade ("Swapped … for …") and a payment's row (needs a
trade or payment made by the run, which the suite does not make); "Your trades" Open and Past
(same); the Send review and its refusals after Review (they need a recipient that would be paid);
Stake, Issuance, Mix and Sign (developer tools reached from More; their own drives are in the web
wallet's `tooling/`). A coin paid on the chain to the shown address ending as part of what a
trade can pay from within minutes (it moves coins; the web wallet's leaves tests and SX2's drive
prove it).

## Web wallet, developer mode

| Id | A person can | Contract |
|---|---|---|
| WW-DEV-PICKER | search the Swap picker: "Your assets" first, hidden left out, search finds them | Asset pickers |
| WW-DEV-TETHER | type an amount in You pay and see You receive filled | Trade |
| WW-DEV-MARKETS | browse every market from Swap | Market |

## SeqDEX

| Id | A person can | Contract |
|---|---|---|
| DX-NO-WALLET-NOTE | see Connect wallet, or Get a wallet with no wallet at all | Connect |
| DX-CHOOSER | choose among the Sequentia web wallet, Ambra mobile, Ambra browser and Sequentia Core on this computer, each with its state | Connect |
| DX-MKT-LIST | read every pair with last price, 24h change, high / low, volume and 7 days | SeqDEX |
| DX-MKT-SEARCH | search the markets | SeqDEX |
| DX-MKT-FILTERS | filter by quote (All, BTC, the fiat stablecoins), Favourites, You hold | SeqDEX |
| DX-MKT-FAV | star a pair and find it under Favourites | SeqDEX |
| DX-MKT-WORDS, DX-PAIR-WORDS | read Markets and a pair without a forbidden word | Never in default mode |
| DX-PAIR-HEAD | read a pair's name, last price, 24h change, high, low and volume | SeqDEX |
| DX-PAIR-FLIP | see the price the other way round | SeqDEX |
| DX-PAIR-CHART | switch Price and Depth, six ranges, Candles and Line | SeqDEX |
| DX-PAIR-DEPTH | read the depth chart | SeqDEX |
| DX-PAIR-INDICATORS | add the seven indicators | SeqDEX |
| DX-PAIR-BOOK | read both sides of the book and "Spread <amount> · <percent> · Mid <price>" | SeqDEX |
| DX-PAIR-TRADES | read recent trades | SeqDEX |
| DX-TICKET | choose Buy or Sell, Market or Limit, Price, Amount, 25% to Max | SeqDEX |
| DX-TICKET-TOTAL | read the Total beside Price and Amount | SeqDEX |
| DX-TICKET-ESTIMATE | read what fills now and what rests, and "Buy <amount> <TICKER>" | SeqDEX |
| DX-TICKET-OPTIONS, DX-TICKET-OPTIONS-WALLET | use the options the connected wallet offers | SeqDEX |
| DX-ORDERS | read Open orders, Trades, Order history, "This market only" | SeqDEX |
| DX-PORTFOLIO, DX-PORTFOLIO-WALLET | read the total, the assets and export a CSV | SeqDEX |
| DX-PHONE-BAR | Buy and Sell from the foot of a pair on a phone | SeqDEX |
| DX-FIT | use a pair on a phone without sideways scrolling | (layout) |
| DX-CONNECT | connect Ambra browser once ("Connect to this site?"), then see "Connected" and the address | Connect |
| DX-IN-PLACE | move to a pair and to Portfolio and stay connected | Connect |
| DX-RELOAD | reload and stay connected without being asked again | Connect |
| DX-DISCONNECT | disconnect, and stay disconnected after a reload | Connect |
| DX-NO-ERRORS | use the site without an uncaught error | (all) |

Not checked yet: placing, taking and taking back an order (they move coins; the extension's
`test/market/drive.mjs` proves them on a private chain); Auction (no wallet offers it); pairing
Ambra mobile and connecting the web wallet (each needs the other surface open beside the site). The ticket's Max staying within what the connected wallet can spend now (needs the funded
wallet connected).

## Ambra browser, default mode

| Id | A person can | Contract |
|---|---|---|
| AB-MODE-DEFAULT | start a new wallet in default mode | The principle |
| AB-BAL-FRESH | see a fresh wallet as one row, BTC at 0 | Names |
| AB-BAL-TOTAL | read one total ("Portfolio total") | Balance |
| AB-BAL-BTC-FIRST | see BTC first, then the assets held, no "native" label | Names |
| AB-BAL-HIDE | hide an asset from the list and the pickers | Balance |
| AB-RCV-CODE | get the receive code (re-opening the tab once the wallet has joined) | Receive |
| AB-RCV-IN-PLACE | see the code replace the address on the open screen once the wallet has joined | Receive |
| AB-RCV-WORDS | read the tip, Copy receive code, New code, Amount in BTC (optional) | Receive |
| AB-FAUCET | ask the testnet faucet | Receive |
| AB-SND-RECIPIENT | use "Recipient" with its hint and "balance <amount>" | Send |
| AB-SND-PICKER | choose the asset to send with the shared chooser, searchable, BTC first | Asset pickers |
| AB-ASSET-MENUS | meet the shared chooser in every asset menu, in both modes (no plain asset menu on any tab) | Asset pickers |
| AB-TRD-FORM | trade with You pay, You receive, their amounts and Review | Trade |
| AB-TRD-PAY-SEARCH, AB-TRD-GET-SEARCH | search the Trade pickers | Asset pickers |
| AB-TRD-HELD-FIRST | see BTC, then what the wallet holds, before the rest | Asset pickers |
| AB-TRD-AMOUNTS | type what they pay or what they get, and see the other | Trade |
| AB-TRD-HELD-TRADABLE | pay from every asset the balance shows | Trade |
| AB-TRD-REFUSE | read a refusal in plain words | Trade |
| AB-TRD-MARKET | read the pair's market above You pay | Market |
| AB-HISTORY | open History ("No transactions yet.") | History |
| AB-WORDS | use every tab without a forbidden word | Never in default mode |
| AB-DEV-MODE | switch to developer mode (the address and every rail) and back | The principle |
| AB-NO-ERRORS | use the popup without an uncaught error | (all) |

Not checked yet: Ambra browser's approval window's Trade? and Place an order? (the trades
surface trades through the web wallet); Stake; reveal and remove the phrase (the suite removes a wallet only to import the
funded one).

## Ambra mobile (source)

| Id | Built | Contract |
|---|---|---|
| AM-TRD-SEARCH | the Trade pickers are the searchable asset sheet | Asset pickers |
| AM-TRD-AMOUNTS | You pay and You receive are tethered: either amount typed, the other follows | Trade |
| AM-TRD-MARKET | Trade shows the pair's market | Market |
| AM-SND-PICKER | Send's picker is the searchable sheet: BTC and held first, hidden out, every asset found by searching | Asset pickers |
| AM-BAL-HIDE | Balance hides an asset into "Hidden assets (n)"; BTC cannot be hidden | Balance |
| AM-RCV-CODE | Receive shows one receive code with Copy receive code and New code | Receive |
| AM-WORDS-TEST | default mode's sentences are tested against the forbidden words | Never in default mode |
| AM-HIS-TRADES | History lists a default-mode trade as one row | History |

Not checked here: everything at run time (pairing with SeqDEX, Send and Receive on a device, Stake,
the site approvals). They need a phone or an emulator.

## Trading, live

From the trader wallet (`checks/trades.mjs`): a small market purchase, then the sale of what it
bought, each priced within 10 seconds (Review to the ticket; on SeqDEX, the button to the wallet's
dialog) and done within 60 seconds of the confirmation, or failed with the time or what the page
says.

| Id | Can | Contract |
|---|---|---|
| WW-TRADE-USDX-GOLD-BUY, WW-TRADE-USDX-GOLD-SELL | buy GOLD with USDX and sell it back in the Trade tab | Trade |
| WW-TRADE-TSEQ-USDX-BUY, WW-TRADE-TSEQ-USDX-SELL | buy tSEQ with USDX and sell it back in the Trade tab | Trade |
| WW-TRADE-BTC-USDX-BUY, WW-TRADE-BTC-USDX-SELL | buy BTC with USDX and sell it back in the Trade tab | Trade |
| WW-TRADE-BTC-ARK-SETTLED | see the sale of BTC above, paid from the Bitcoin ark, reach Settled within an hour with the wallet open | Trade |
| DX-TRADE-USDX-GOLD-BUY, DX-TRADE-USDX-GOLD-SELL | buy and sell GOLD on SeqDEX's market page through the web wallet | SeqDEX |
| DX-TRADE-TSEQ-USDX-BUY, DX-TRADE-TSEQ-USDX-SELL | buy and sell tSEQ on SeqDEX through the web wallet | SeqDEX |
| DX-TRADE-BTC-USDX-BUY, DX-TRADE-BTC-USDX-SELL | buy and sell BTC against USDX on SeqDEX through the web wallet | SeqDEX |

## Capabilities lost, and where

Found by reading each repository's history for what a screen used to do:

- **The searchable asset picker in default mode's Trade.** The web wallet's `7fc56668` ("swap: the
  Trade tab in user mode, three inputs and one button") replaced the composer, whose picker
  searched, listed held assets first, left hidden ones out and took a pasted id (`1ad005b4`), with
  two plain `<select>`s. Ambra browser copied that composer in `bcbf967`; Ambra mobile made the
  same change in `707b0d6` (a `DropdownButton` in place of `showAssetSheet`). Developer mode and
  Send kept the searchable picker in all three.
- **The receive amount in default mode's Trade.** The same three commits kept one amount, on the
  pay side, where the composer had You pay and You receive tethered both ways.
- **Ambra mobile's user-mode Receive address.** `0291b64` removed "Show address" from default mode
  on purpose (the code carries the address), as the contract says.
