# Perps Tracker

A local dashboard for your perp trading on [Bulk](https://app.bulk.trade), [Arcus](https://app.arcus.xyz)
and [Entropy](https://entropy.io), styled after Entropy's trading terminal. Light and dark mode (sun/moon
button, top right).

Made by **[@Korgonxx](https://x.com/Korgonxx)**: follow on X for updates and new features.

This is the open-source version you run on your own computer. Don't want to run anything? There's also a
hosted version at [perps-tracker-delta.vercel.app](https://perps-tracker-delta.vercel.app) (invite only:
codes are posted on [X](https://x.com/Korgonxx)).

| Page | What's on it |
|---|---|
| **Overview** | Volume, open interest (OI) and average hold time per exchange and combined, daily volume, hold-time spread, hedges, open and closed positions. |
| **Live** | Your open trades ticking every second, hedges grouped as one, with hold time and PnL. |
| **Strategy** | An Arcus points routine measured on *your* trading, on any one, two or all three exchanges (tick the ones you want), and a checklist that turns green as you match it. |
| **Fees** | Fees and funding per exchange, fee tiers, maker/taker split, and fees per day. |
| **Points** | Bulk AURA and Arcus points loaded automatically, pre-deposit AURA, leagues and tiers, countdowns to the next drops, and what each point costs you in fees. Entropy is ready for when its points launch. |
| **Referrals** | The developer's sign-up codes for each exchange, and your own referral codes to copy and share. |
| **Leagues** | Bulk's Challenger Series: this week's fee pool, what each league's wallets get, your share, and what reaching the next league would pay. |

Switch pages you don't use off in **Settings → Display → Pages**.

It only reads public data from each exchange's API using your wallet address. There are no API keys
and no signing, and nothing leaves your computer except those read-only requests.

## Get it and start it

1. Install [Node.js](https://nodejs.org) (LTS) if you don't have it.
2. Download it from the [official repository](https://github.com/0xkorgon/perps-tracker): the green
   **Code** button → **Download ZIP** (or a zip on the [Releases](https://github.com/0xkorgon/perps-tracker/releases)
   page, when there is one). Both are the same signed files. Then **extract it** (right-click the zip →
   Extract All). Running it from inside the zip doesn't work.
3. Double-click **`start.bat`** in the extracted folder. The dashboard opens at <http://localhost:8787>.
4. A short setup asks what to call you, which exchanges you use and what you want from the tracker,
   takes your public wallet addresses, and offers a 1-minute tour. Run it again any time from
   **Settings → System**, or take the tour from the book button at the top.

No account on an exchange yet? The setup and the **Referrals** page have sign-up links.

## FAQ

**Is it safe to download and run?**
Here's what it is and isn't, so you can judge for yourself:

- It's a small program (Node.js) plus a web page, and both run only on your computer. Its page only
  answers your own PC (127.0.0.1); nobody else on your network or the internet can open it.
- It never asks for a private key or seed phrase, never connects a wallet and never signs anything,
  so it can't move funds. It only needs your **public** wallet addresses, the same ones anyone can see
  on-chain. If anything ever asks you for a key, it isn't this tracker.
- It installs nothing else: no packages are downloaded (`package.json` lists none), no installer, no
  admin rights.
- It's open source: every line is in this repository for you (or someone you trust) to read.
- Every time it starts it runs a security check: every file matches the signed list of official
  files, there are no extra programs in its folder, no keys saved in its settings, and the code only
  talks to Bulk, Arcus and Hyperliquid. Settings → System shows the result and can run a Windows
  Defender scan of the folder.
- Download it only from this repository (github.com/0xkorgon/perps-tracker), not from a copy someone
  re-uploaded, and check **Settings → System → Official build** says *Verified*.

**What does it send over the internet?**
Only read-only requests for your public data: Bulk's exchange API (`mainnet-api1.bulk.trade`) and AURA
page (`app.bulk.trade`), Arcus (`api.arcus.xyz`, `points-api.arcus.xyz`) and Hyperliquid
(`api.hyperliquid.xyz`, for Entropy). Your public address is in those requests, as it is when you use
the exchanges' own sites. No analytics, no tracking, nothing is sent to the developer.

**How do I know my copy is the official one?**
Settings → System → Official build: *Verified* means every file matches the release the developer
signed. A copy with any file changed (its referral links, say) shows a red "Modified, unofficial
build" bar on every page. Don't trust a copy that shows it; download the official one here.

**Windows says "Windows protected your PC" when I open start.bat.**
That's SmartScreen being careful with a script downloaded from the internet that isn't signed with a
paid Windows certificate. Click **More info → Run anyway**, or before extracting, right-click the zip →
Properties → tick **Unblock** → OK. If you'd rather check first, read `start.bat`: it's a few lines
that check Node.js is installed and run `node server.js`.

**It closes straight away / says the files aren't next to start.bat.**
Extract the zip first (right-click → Extract All) and run `start.bat` from the extracted folder.
Opening it from inside the zip doesn't work. Install [Node.js](https://nodejs.org) (LTS) if it asks.

**What does it keep on my computer?**
`config.json` (your addresses, settings and your own referral codes) and the `data` folder (cached
trade history, points, balances, alerts). Nothing else, nowhere else (apart from a small file
remembering the version you trust, in `%LOCALAPPDATA%\PerpsTracker`). Delete the folder to remove it all.

**Can I use it on a Mac or Linux?**
Yes, with Node.js 18 or newer: open a terminal in the folder and run `node server.js`. Pop-up alerts
work there too (on Linux if `notify-send` is installed); *start with Windows* is Windows only.

**Why does Bulk AURA say "update needed"?**
Bulk's website only answers web browsers. Use the one-click **Send AURA to tracker** bookmark from the
Points page after each Saturday reveal (see Points).

**How accurate are the points estimates?**
They're estimates: neither exchange publishes its formula. Each is calibrated on your own paid weeks
and checked against them (Pulse → Points → *How it's worked out* shows how far off it was on each
week), and shows a likely range.

**How do I update?**
Download the new release, extract it, and copy your `config.json` and `data` folder from the old
folder into the new one. Then run `start.bat` from the new folder.

**How do I uninstall?**
If you turned on *Start when I log in*, turn it off in Settings → System. Close the tracker's window
and delete its folder.

**Do I have to use the referral codes?**
No. They're how you can support the developer if you sign up on an exchange; everything works the
same either way.

**Who made it?**
[@Korgonxx](https://x.com/Korgonxx) on X. Follow for updates, and send feedback or ideas there.

Keep the black window open while you use the dashboard; it refreshes every minute. Close it to stop.

After an update is copied into the folder, a bar at the top of the page asks you to restart the tracker
(close the black window, double-click `start.bat`), because the running copy still has the old code.

Only one copy runs at a time. If you double-click `start.bat` while the tracker is already open, the new
copy asks the old one to close and takes over. (Copies from before this version can't be asked, so the
new one tells you to close the old black window first.)

## Which address goes where

| Exchange | Address | Notes |
|---|---|---|
| Bulk | Solana address | The wallet you connected at app.bulk.trade. Sub-accounts are found automatically. |
| Arcus | 0x… address | Arcus signs you in with an embedded wallet. Copy the address shown **inside the Arcus app**, not your MetaMask/Rabby one. |
| Entropy | 0x… address | The wallet you log in to entropy.io with. Entropy trades on Hyperliquid, so this is your Hyperliquid account. |

### How Entropy trades are counted

Entropy is a front end for Hyperliquid: it has its own markets (OpenAI, Anthropic, SanDisk…) and also
lets you trade BTC, HYPE, trade.xyz stocks and the rest from the same account. Entropy tags every order
it sends, so the tracker counts:

- every trade on Entropy's own markets, and
- every trade you placed through entropy.io on any other Hyperliquid market.

Trades from other apps on the same Hyperliquid account are left out. If a position you opened on Entropy
is closed or liquidated somewhere else, that close still ends the position (so hold time and OI stay
right), but it doesn't count as Entropy volume. Account value is your whole Hyperliquid account.

## Hedges

The Overview groups your open positions by asset across exchanges (NVDA-USD on Arcus and xyz:NVDA on
Entropy both count as NVDA, and Bulk's SPACEX-USD pairs with Arcus's SPCX-USD; an index perp priced like its ETF, such as mkts:US500 at SPY's price, is
grouped with SPY as long as the two prices agree within 3%) and shows whether each pair is **hedged** (long and short sizes cancel
within 5%), **uneven**, or **one-sided**. For every leg it shows the liquidation price and how far the
price has to move against it, plus uPnL and the funding paid or received since it opened. Distances
under 15% turn gold and under 5% red, and the closest one also appears in the bottom bar on every page.

Bulk and Hyperliquid (Entropy) report liquidation prices. Arcus doesn't, so its price is estimated
from the market's maintenance margin and your margin (shown with ≈). Bulk's take-profit / stop-loss
orders are shown too: if one fills, that pair stops being hedged.

Between full syncs the tracker re-reads the mark price and funding rate of every market you hold
(every 30 seconds while any leg is within 15% of liquidation, otherwise every 2 minutes), so
distances stay current. Each pair also shows **funding now**: what it earns or pays per day at the
current hourly rates (all three exchanges pay funding hourly), and each leg's own share. When a pair
is paying, a gold note says what swapping sides would earn instead (long where the short is and short
where the long is), what closing and reopening would cost in taker fees, and how long that takes to
pay back. Rates change every hour, so treat it as a prompt to look, not a sure thing.

## Alerts

The tracker watches your positions while it runs, even with the browser closed:

| Alert | When |
|---|---|
| **Near liquidation** | A leg comes within 10% (warning) or 5% (danger) of its liquidation price, with how much margin to add to get it back to 10% (and 15%) away. Once per level; it re-arms after the leg moves a point clear of the line, so it doesn't repeat while price wobbles. |
| **Hedge broken** | A hedged pair loses a leg (closed, liquidated, a TP/SL filled) or goes uneven, and is still that way a minute later. Closing both sides yourself, one after the other, doesn't alert. |
| **Liquidated** | A liquidation fill shows up on any exchange. |
| **AURA week about to end** | An hour before Saturday's cutoff (12:30 UTC): trades before it count this week. |

Each alert arrives as a Windows pop-up from the tracker itself (danger pop-ups stay on screen until
you dismiss them, and **Open dashboard** takes you to your hedges), as a card in the top-right corner
of the dashboard, and as a line in the tracker's window. Sounds: an alarm for danger and a chime for
warnings. While the dashboard is open, visible and has been clicked once (browsers only allow sound
after that), the page plays the sound and the pop-up stays quiet, so you hear it once. Otherwise the
pop-up plays Windows' own alarm.

**Settings → Alerts** turns each alert, the pop-ups and the sounds on or off, sets the two distances,
plays both sounds, and has **Test pop-up** to check pop-ups work on your PC. Alerts are kept in
`data/alerts.json` (last 100). If Windows' Focus assist / Do not disturb is on, pop-ups wait in the
notification centre.

If trades keep landing on your Entropy wallet without Entropy's order tag (for example if Entropy
changes how it tags orders), the Entropy card shows a warning instead of quietly missing them.

## Live

Your open trades right now, ticking every second, in one table grouped by asset: a Bulk BTC-USD long and its Entropy BTC short sit together as one hedge.

- **Hedge header** (when an asset is open on more than one exchange): Hedged, Uneven or One-sided, each leg's side and size, the net left over, combined PnL, funding per day right now, and a warning when a leg is within 15% of liquidation (gold, red under 5%) with how much margin to add to get it to 10% away (hover for 15%).
- **Legs**: hold time, PnL and distance to liquidation for every leg; each leg has its exchange's colour
  on its left edge (Bulk blue, Entropy orange, Arcus pink).

Prices refresh with each sync and the risk watch (every 30 seconds to 2 minutes); hold times tick in the page.

## Strategy

Built from another Arcus trader's points dashboard plus his own words (translated from Turkish):

- *"Min 7k 8k oi 24 saat tutuyorum"*: "I keep at least $7–8K of OI open, 24 hours a day."
- *"Günde 2 3 kere aç kapa yapıyorum"*: "I open and close 2–3 times a day."

The checklist (targets default to his numbers, shown as the benchmark; click **Edit targets** to change
them or switch items off):

| Habit | Benchmark | Measured as |
|---|---|---|
| Keep $7–8K of OI open | ~$7.6K (SPY short) | OI right now |
| Hold that OI 24 hours a day | 24 h | share of the time your OI was at or above that target |
| Open & close 2–3 times a day | 2–3 | closed positions per day |
| Trade stocks & ETFs, not crypto | 92.4% | stock/ETF/RWA share of volume (Arcus boosts these) |
| Trade outside US market hours | 39.5% | off-hours share of stock volume (Arcus boosts this too) |
| Hold positions 1–24 hours | 134 of 140 | share of closed positions held 1 h – 1 day; open positions on every exchange show a live "5h 12m / 24h" timer |
| No quick flips under 10 min | ~1% | share of closed positions held under 10 min |
| Trade every day | 7 of 7 | days with a fill |
| ~$250K volume per points week | $251K | scaled to the window you pick |
| Maker orders 35%+ of volume | 37.2% | maker share of volume |
| Fees under 1.5 bps | 1.34 bps | fees ÷ volume |
| Break even or better | +$7 | realised PnL + funding − fees |

Notes:

- **Exchanges**: tick one, two or all three (Arcus, Bulk, Entropy). Everything on the page, checklist
  included, adds up the ones you pick. At least one stays ticked; **All** ticks all three.
- **The checklist column scrolls on its own** on wide screens, with the score pinned at its top, so the
  rest of the page stays where it is. On narrower screens the habit list scrolls inside its own box.
- **Points weeks** run Wednesday 3 PM to Wednesday 3 PM New York time (Arcus's schedule).
- The score, the tick marks and the checklist bars animate when you open the page, and a habit that
  changes state after a sync flashes green or red. With "reduce motion" turned on in your system
  settings, nothing animates.
- **US hours** means 4am–8pm New York time on NYSE trading days (Arcus's own session for stock
  perps). Nights, weekends and NYSE holidays are off-hours. Bulk only lists crypto. On Entropy, its own
  markets and the stock, index and commodity markets count as stocks; BTC, HYPE and other coins count
  as crypto.
- **PnL** is before fees. Bulk reports it when a position fully closes. Funding is positive when you
  received it. Deposits are tracked for Arcus and Bulk.

### Bulk alone: trading AURA habits

Tick only **Bulk** and Strategy switches to Bulk's own habits (Bulk has no stocks, so the Arcus stock
and off-hours habits don't apply): taker volume per AURA week, fees per 1,000 AURA at your own rate,
the league threshold and breaking even. Windows follow Bulk's AURA weeks (Saturday 12:30 to Saturday
12:30 UTC). Your AURA per dollar is measured from your own revealed weeks. Bulk targets are saved
separately from the Arcus routine.

## Fees

Fees, fee tiers and maker/taker splits come from your trades automatically, for the window you pick,
with a chart of fees per day (per week for windows longer than about three months).

## Points

| Program | Where it comes from | What you see |
|---|---|---|
| **Bulk AURA** | Bulk's public AURA data for your Bulk wallet, nothing to set up | Total and rank, pre-deposit AURA per week and your deposit, trading, Gauntlet (Challenger Series) and referral AURA per mainnet week, your previous weeks side by side, your trading league and how much more AURA the next league needs, your referral code. |
| **Arcus points** | Arcus's public points leaderboard, found by your **points name** | Points, rank and tier this season, your earlier season's rank, one reading per weekly drop, and points per $10K of volume. |
| **Entropy points** | Not launched yet | What your account has done on Entropy so far, and a box to log a total by hand once Entropy shows one. |

- **Your Arcus points name**: Arcus only shows your own points when you're logged in, but its public
  leaderboard lists every account under a points name (usually an adjective and an animal, like
  "Rustic Owl"; capitals and extra spaces don't matter). Copy yours from
  Arcus's points page into **Settings → Points**, or into the box on the Points page.
- **Updating Bulk AURA in one click**: Bulk's website only answers web browsers, so the tracker
  can't always read your AURA itself (it keeps trying every so often). Instead, drag the **Send AURA to
  tracker** button on the Points page to your bookmarks bar once. After each Saturday reveal, open
  app.bulk.trade and click it: your browser reads your AURA and the last eight weeks' results for your
  Bulk wallets, opens the tracker and asks before importing. Nothing else is read or sent. Pasting by
  hand still works too.
- **Up to date or not**: your AURA is complete until the next reveal, so the page says *up to date*
  (through which week, and when the next reveal is). A week revealed after your last update shows as
  estimated (≈) from your trading until you update.
- **Drops**: Bulk settles each week on Saturday at 12:30 UTC and reveals it at 13:00 UTC. Arcus hands
  out 250,000 points every Wednesday at 3 PM New York time. The Points page counts down to both and shows
  how much you've traded so far this week; the bottom bar shows the next two on every page.
- **Cost per 1,000 points** is the trading fees you paid divided by the points earned for trading, so
  you can compare exchanges.
- **Gauntlet AURA** is what Bulk pays in its Challenger Series (`challenger_week_N_gauntlet` in your
  AURA). Season 1 started with the AURA week from Saturday 17 October, so challenger week N is mainnet
  week N + 6, and it shows in that week: in the AURA split, the chart, the week-by-week table and the
  Pulse estimate (as an extra, since Bulk hasn't published how it's worked out).
- **Previous weeks**: every revealed week shows, even when you never pasted that week's results: what
  Bulk paid (from your AURA total), your taker volume, open position-days and fees, and what the
  estimate gives for that week from the weeks before it only. A week revealed after your AURA was last
  read shows as *not loaded yet* until you paste your AURA page again. The paste box also links the
  results of earlier weeks that aren't saved.

## Leagues

From Saturday 17 October 2026, every AURA Saturday (13:00 UTC), Bulk shares 12.5% of its net fees
with the top trading leagues: **Challenger** (top 25) 45%, **Diamond** (top 100) 25%, and
**Platinum** and **Gold** 30% between them, each Platinum wallet getting two shares to a Gold wallet's
one. Silver and below get nothing. The Leagues page shows:

- **Pool this week**: 12.5% of Bulk's fees, from Bulk's public volume this AURA week, projected to the
  cutoff, at 3.5 bps (Bulk's taker fee; makers pay nothing).
- **Who gets what**: each league's ranks, wallets, share and the trading AURA its last wallet had.
- **Your share**, and **Next**: what the next league up needs, what your pace adds by Saturday, and how
  much more it would pay each week.
- **Payouts** (from 17 October): type in what each payout paid you. The fee rate then corrects itself
  from how far off the estimate was.

Bulk hasn't published its net fees or how it splits a league's share between wallets, so the page
assumes an even split. League sizes and cutoffs come from Bulk's leaderboard on 12 October until your
first AURA import after a reveal (Points page), which replaces them.

## Pulse (the round button, bottom right)

A quick view you can open on any page. The badge on the button shows this week's habit score, or a
**!** when a position is getting close to liquidation (gold under 15%, red under 5%, and the button
pulses).

| Tab | What's in it |
|---|---|
| **Portfolio** | Your total balance across Bulk, Arcus and Hyperliquid (Entropy), live while the tab is open (re-read about every 10 seconds), each exchange's balance and free margin, what's changed since you deposited, where the change came from (fees, funding, price moves), and the total over the last 7 days. |
| **Live** | Open interest, unrealised PnL, the nearest liquidation, every hedge with its legs (side, size, leverage, when it opened, how long it's been held (to the minute) with a bar: the 1–24 h zone on Arcus legs, distance to liquidation, uPnL), its funding now per day (with a swap hint when it's paying) and your last few closed positions. |
| **Habits** | This points week's score as a ring, each habit with your number against the target, and which habit is closest to turning green. It uses the exchanges you ticked on Strategy. |
| **Points** | What the next Bulk and Arcus drops should pay you, with a likely range, what you've earned so far, gauntlet AURA on its own line, last week's estimate next to what Bulk paid, and a slider to try "what if I trade $X more before the cutoff". **How it's worked out** shows every number used. |

How the portfolio is worked out:

- **Balance** is each exchange's own account value: Bulk counts every lane, including isolated
  positions; Arcus is the equity of each sub-account; Hyperliquid is the whole account Entropy trades
  from (spot and perps).
- **Since you deposited** is balance minus net deposits: Bulk's deposits and withdrawals from its
  account history, Arcus's own net-deposits figure, and Hyperliquid's own all-time PnL for the account.
- **Where the change came from** adds up fees, funding and price moves from your trades. "Other" is
  what those don't explain, such as trades from other apps on the same Hyperliquid account or history
  older than the exchanges serve.
- **The 7-day line** comes from readings the tracker takes every 5 minutes while it runs (kept 30 days
  in `data/balances.json`), so it starts from the day you install this version.

How the estimates work (neither exchange publishes its formula):

- **Bulk AURA**: from your own revealed weeks: what Bulk paid you per dollar you took, the latest
  weeks weighing most, times your taker volume by the cutoff. Each past week is also predicted from
  the weeks before it only; how far those predictions missed is shown ("Checked on your weeks") and
  sets the likely range. Gauntlet AURA (Challenger Series) is shown on its own line, as in your last
  week with it. After each reveal, Pulse shows the estimate next to what Bulk paid. It works even
  while Bulk is turning the tracker away, because your trades come from Bulk's exchange API; your
  revealed weeks come in when you paste them on the Points page.
- **Arcus points**: Arcus splits a fixed 250,000 points a week by a score it doesn't publish, and says
  trading stocks and other real-world assets, and trading off-hours, earn more. The tracker reads all
  trading on Arcus from Arcus's public hourly candles (back to the season start) and, from your paid
  weeks, measures what a dollar of stocks and a dollar of crypto earned you against the market's
  average dollar. Estimate = 250,000 × that × your volume ÷ all Arcus volume, so a busier week on
  Arcus means fewer points for the same trading, and this week's stock/crypto mix counts. Each paid
  week is also predicted from the weeks before it only ("Checked on your weeks", and the Model column
  on the Points page); those misses set the likely range. Whether the hours your positions stay open
  add points is tested the same way, and used once it predicts your weeks better.
- **Your volume by the cutoff** is projected from this week's pace, blended with your recent daily
  average while the week is young (Bulk's week ends Saturday 12:30 UTC, Arcus's at the Wednesday drop).

## Referrals & codes

The **Referrals** page (it works before you add any wallet) has:

- **Support the tracker**: the developer's referral codes, access codes and sign-up links for each
  exchange. Signing up with them supports the tracker and keeps it free. They're part of the signed
  release, and the page says whether this copy is the verified official one.
- **Your codes**: your own referral codes and links for any exchange, kept on this computer, each
  with a button that copies a ready-to-send message. Your Bulk code is picked up from your AURA data.

## Official builds

Every official release is signed by the developer. On start, the tracker checks the signature and
every file against the signed list (**Settings → System → Official build**):

- **Verified**: an untouched official release.
- **Modified, unofficial build**: any file differs from the signed release (or the copy isn't signed).
  It still runs, but a red bar on every page says so, so nobody mistakes an edited copy (with other
  referral links, say) for the official one. Get the official version from the repository.

The tracker is open source: read, run and change it as you like. Changed copies simply aren't the
official build.

## Settings

**Settings** (top right) has five tabs: **Wallets** (addresses and how often to sync), **Points** (your
Arcus points name), **Alerts** (see above), **Display** and **System** (both below). System also
exports a copy of everything:

| Export | What's in it |
|---|---|
| Everything (JSON) | Settings, wallets, each exchange's cached history, points data and logs, and the computed stats. |
| Trades (CSV) | Every fill on every exchange: time, market, side, size, price, notional, fee, maker/taker, PnL. |
| Closed positions (CSV) | Every position from open to close, with hold time and volume. |
| Points (CSV) | Bulk AURA per week, Arcus points per drop, and any totals you logged, with the fees behind them. |

### System: start with Windows and the security check

- **Start when I log in** puts a small file in your Windows Startup folder (`Perps Tracker.cmd`) that
  starts the tracker minimised when you log in, without opening the browser. It only starts if the full
  security check passes; if anything fails, the tracker stays closed and a Windows pop-up says why.
  Turning it off deletes the file.
- **The security check** runs every time the tracker starts (and in full, with an antivirus scan, before
  it starts with Windows, or when you press **Run check now**):

| Check | What it makes sure of |
|---|---|
| Tracker files | Every code file matches the official list for this version (`security/manifest.json`, a SHA-256 fingerprint of each file). |
| Same as last time | Before starting with Windows: the files are the ones you last opened yourself. A copy of the list is kept outside the folder (in `%LOCALAPPDATA%\PerpsTracker`), so changing the code and the list together is still caught. After an update, opening the tracker yourself makes the new version the trusted one. |
| No unexpected programs | No programs or scripts (.exe, .vbs, .ps1, extra .js …) anywhere in the folder, including `data`, and no downloaded packages (`node_modules`). Your own notes and spreadsheets are ignored. |
| No keys saved | `config.json` holds nothing that looks like a private key, key file or seed phrase. The tracker only needs your public addresses and never signs anything. |
| Network | The code only points at Bulk, Arcus and Hyperliquid, and the dashboard only answers this computer (127.0.0.1). |
| No packages | `package.json` lists no third-party packages or install scripts. |
| Antivirus | Windows Defender scans the tracker folder (with the full check). If Defender is off because another antivirus is in charge, it's noted and the other checks decide. |

  When you open the tracker yourself and a check fails, its window lists what failed and asks whether
  to start anyway. The last result is shown in **Settings → System** and kept in `data/security.json`.

### Display

Saved on this browser and applied right away.

- **Live tab title**: the browser tab's title starts with your numbers, updated every second, so you
  can watch your trades from another tab or window. Pick any of: liquidation warning (only shown
  within 15%), open PnL, hold time (your biggest Bulk position, or your biggest position if none is
  on Bulk), time to the AURA cutoff. For example:
  `⚠ Bulk BTC-USD 2.4% from liquidation · +$5.70 · BTC 2d 02:12:15 · AURA 6d 4h · Live`.
- **Live tab icon**: the tab's icon turns gold within 15% of liquidation and flashes red within 5%.
  Otherwise its tallest bar is green or red with your open PnL. Settings shows your tab as it is right now.
- **Pulse: move and resize**: drag Pulse by its header to anywhere on the page and resize it from its
  bottom-right corner (at least 340 × 300). The round button can be dragged too; a short press still
  opens and closes Pulse. Where you put them is kept. Double-click the header to put the panel back
  next to the button, or use **Put Pulse back in the corner**. Turned off, Pulse sits in the
  bottom-right corner at its usual size; where you put it is remembered, so turning it on again puts
  it back there. Narrow windows always use the corner.
- **Pulse: pop-out window** (Chrome and Edge): adds a button to Pulse's header that floats Pulse, tabs
  and all, in its own small window on top of other tabs and apps, so you can keep an eye on it while
  watching YouTube. It opens with a click (a browser rule) and keeps ticking while the dashboard's tab
  is in the background. Close that window, or click the round button, to bring Pulse back.
- **Pulse: stay open**: Pulse stays open while you click around and switch pages, and opens again
  next time if you left it open. The pin in Pulse's header does the same. Turned off, Pulse closes
  when you click elsewhere.
- **Pages**: switch any page off to take it out of the menu (at least one stays on). Turn it back on
  here whenever you like; nothing it tracks is lost.

## Good to know

- On Bulk, the two stock items don't apply (Bulk only lists crypto), so they're greyed out and left
  out of the score.
- **When an exchange's API has trouble** (Bulk's Cloudflare gateway answers 504 at times), the window
  prints one readable line, keeps your last synced data on the page and tries again at the next sync;
  history pages are asked for in smaller pieces after a time-out. The same problem again within 30
  minutes stays quiet, and a line says when it syncs again.
- Fonts (Host Grotesk, Geist Mono, Big Shoulders Display) and icons are bundled, so the dashboard
  works offline. Fonts are under the SIL Open Font License (`public/fonts/LICENSE.txt`); icons are from
  Lucide (ISC licence).
- History is cached in the `data` folder, so refreshes are fast and history survives restarts. The
  exchanges only serve part of your history (Hyperliquid keeps your latest 10,000 fills), so each
  card shows "history from …".
- The first sync of a busy account can take a minute or two (Arcus rate-limits history paging).
- Delete the `data` folder to rebuild the cache from scratch.

## Command line

```
node server.js            start the dashboard (what start.bat does)
node server.js --once     sync once, print a summary table, exit
node server.js --no-open  don't open the browser automatically
node server.js --port 9000

node tools/release.js build   maintainers: sign and build a release (needs the signing key)
```

## Files

```
start.bat            double-click to run (Windows)
server.js            local web server + sync loop
src/exchanges/       one adapter per exchange (bulk.js, arcus.js, entropy.js)
src/metrics.js       volume / OI / hold-time maths
src/analytics.js     strategy checklist and fees
src/points.js        Bulk AURA, Arcus points, drop times, points maths
src/leagues.js       Bulk's league fee pool: sizes, shares, payouts
src/estimate.js      next-drop estimates; estimate-core.js shared maths
src/model.js         the AURA model (model-public.js; official builds can add their own)
src/referrals.js     the developer's sign-up codes (signed) and your own codes
src/official.js      the developer's public key and the signature checks
src/portfolio.js     balances across exchanges and their history
src/watch.js         live marks and funding rates for the markets you hold
src/alerts.js        near-liquidation, hedge-broken, liquidation and cutoff alerts
src/notify.js        Windows / macOS / Linux pop-ups
src/security.js      the security check, official-build check and start with Windows
security/            manifest.json (fingerprints of the official files) and manifest.sig (its signature)
tools/release.js     sign and build a release (maintainers)
src/markettime.js    US session, NYSE holidays, points weeks
public/              the dashboard (index.html, style.css, js/, fonts/, img/ exchange logos)
data/                cached history, points, balances, alerts and the last security check (created on first run)
config.json          your wallets, setup answers, your codes, targets and points logs (created when you save)
```
