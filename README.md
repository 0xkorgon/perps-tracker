# Perps Tracker

Your perps dashboard for [Bulk](https://app.bulk.trade), [Arcus](https://app.arcus.xyz) and
[Entropy](https://entropy.io): volume, open interest, hedges, fees, liquidation alerts, and what your next
Bulk AURA and Arcus points drops should pay. Light and dark mode.

Made by **[@Korgonxx](https://x.com/Korgonxx)**: follow on X for updates and new features.

This is the full tracker, the same code as the hosted version, AURA model included. Run it on your own
computer: no invite, no account, nothing to install but Node.js. Don't want to run anything? The hosted
version is at [perps-tracker-delta.vercel.app](https://perps-tracker-delta.vercel.app) (invite only: codes
are posted on [X](https://x.com/Korgonxx)).

| Page | What's on it |
|---|---|
| **Overview** | Volume, open interest and average hold time per exchange and combined, daily volume, hedges, open and closed positions. |
| **Live** | Your open trades ticking every second, hedges grouped as one, hold time, PnL and Bulk's hold multiplier. |
| **Strategy** | An Arcus points routine and Bulk's AURA habits, measured on your own trading, with a checklist that turns green as you match it. |
| **Planner** | Price a Bulk trade before you open it: the AURA it should earn, its fees, its gauntlet bonus and what it does to your league. |
| **Fees** | Fees and funding per exchange, fee tiers (from Bulk's live fee schedule), maker/taker split, fees per day. |
| **Points** | Bulk AURA and Arcus points, the estimate for the next drop with its workings, how close past estimates were, this week's gauntlet and referral AURA. |
| **Leagues** | Bulk's Challenger Series: this week's prize pool, what each league gets, your share, and what the next league would pay. |
| **Referrals** | Sign-up codes for each exchange, your own codes, and your referrals' live volume and the referral AURA it earns you. |

Switch off the pages you don't use in **Settings → Display → Pages**.

## Get it and start it

1. Install [Node.js](https://nodejs.org) 20 or newer (the LTS version).
2. Download this repository: the green **Code** button → **Download ZIP**, then **extract it**
   (right-click the zip → Extract All). Running it from inside the zip doesn't work.
3. Windows: double-click **`start.bat`**. Mac or Linux: open a terminal in the folder and run
   `npm start`.
4. Open <http://localhost:8787> (start.bat opens it for you) and click **Open my dashboard**. A short
   setup takes your public wallet addresses and offers a 1-minute tour.

Your data stays in the `data` folder next to the code. Keep it when you update: download the new
version, copy your `data` folder into it, and start it again.

**Coming from 2.x?** Copy your old `config.json` and `data` folder into the new folder before you
start it. The first dashboard you open carries over your wallets, settings, AURA and trade history
(the old files stay as they were).

### Bulk AURA and referrals

Bulk's AURA pages only answer real browsers, so the tracker can't read your AURA by itself. On the
**Points** page, drag the **Send AURA to tracker** button to your bookmarks bar once. After each Saturday
reveal, open app.bulk.trade and click it: a tab opens on the tracker and imports your AURA.

Click the same bookmark on Bulk's **Referrals** page while you're logged in and it also brings the
wallets you referred. The tracker then reads their public trades for your live referral volume, and
estimates the referral AURA it earns you (Bulk pays 1 AURA for every 4 Trading AURA your referrals earn).
Turn **In your estimates** on (Referrals page) to add it to your Bulk estimate.

## How the estimates work

- **Bulk AURA** (`private/aura-model.js`): measured on 873 wallets in Bulk's week 4 and 883 in week 5,
  AURA = A × taker volume + B × open positions' dollar-hours + L × volume liquidated, with A moving with
  Bulk's total volume (its public hourly candles). Your own revealed weeks set your factor (Bulk's credit
  on top, and how its rates moved since), and every past week is predicted from the weeks before it
  only, so the Points page shows how far off the estimate has been for you. Without that file the
  tracker uses `src/model-public.js`, which works from your own revealed weeks alone.
- **Leagues** (`src/leagues.js`): the pool is 12.5% of Bulk's net fees, estimated from Bulk's volume this
  week and its fee per dollar, corrected from the payouts you log. Cutoffs come from your AURA import.
- **Gauntlet** (`src/gauntlet.js`): your taker volume on the week's goal against everyone's, from Bulk's
  candles. After each reveal, dashboards compare the estimate with what Bulk paid and scale later ones.
- **Arcus points**: your share of all Arcus volume times how your points compared with that share in
  weeks already paid.

Estimates, not promises: neither exchange publishes its formula.

## Is it safe?

- It only reads public data from each exchange's API, using your **public** wallet addresses. It never
  asks for a private key or seed phrase, never connects a wallet and never signs anything, so it can't
  move funds. If anything ever asks you for a key, it isn't this tracker.
- Run with `npm start` or start.bat, it only answers your own computer (127.0.0.1).
- It installs nothing: no packages (`package.json` lists none), no installer, no admin rights.
- Every line is in this repository for you, or someone you trust, to read. Download it only from
  github.com/0xkorgon/perps-tracker.

## Host it for others (optional)

`npm run serve` (or `node server.js`) runs it as a hosted server: new dashboards then need an invite
code. Open `http://localhost:8787/#admin` with the admin key printed at the first start (also in
`data/admin.key`) to make codes. Put it behind HTTPS (Caddy, nginx) to share it. Settings:

| Variable | What it does |
|---|---|
| `PERPS_PORT` | Port to listen on (default 8787) |
| `PERPS_HOST` | Address to listen on (default 127.0.0.1) |
| `PERPS_DATA` | Data folder (default `./data`) |
| `PERPS_ORIGINS` | Other websites allowed to call the API, comma-separated (if the page is hosted elsewhere; set its address in `public/config.js`) |
| `PERPS_ADMIN_KEY` | The admin key (default: made on first start) |
| `PERPS_OPEN=1` | Same as `--local`: no invite needed |

## Support the tracker

The **Referrals** page and `src/referrals.js` carry the developer's sign-up codes (KORGONXX on Bulk and
Arcus, korgonxx on Entropy). Signing up with them supports the tracker and keeps it free. And follow
[@Korgonxx](https://x.com/Korgonxx) on X.

## License

MIT. See [LICENSE](LICENSE).
