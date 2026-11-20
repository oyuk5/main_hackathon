# What Watchtower saves at 300 portals

**Short answer:** about **€48,000 a year** in the middle case, roughly **80% of the cost** of keeping 300 portal scrapers working by hand. Depending on how often portals change, the range is **€28,000 to €110,000 a year**. Adding a new portal goes from **€400–800 of engineering time to about $0.03**.

All numbers below are estimates. The assumptions are listed so anyone can change them.

## The inputs

| Input | Value | Where it comes from |
|---|---|---|
| Portals | 300 | given by the team (Patterno's website mentions 4,500+, see the scale note at the end) |
| How often a portal changes enough to break its scraper | 0.5 / 1 / 2.6 times a year (low / mid / high) | 1–2% of scrapers break per week ([ProWebScraper](https://prowebscraper.com/articles/scraper-breakage)); about 2.6 breaks per source per year ([Phyllo](https://www.getphyllo.com/post/why-scrapers-break)). Both are vendor numbers. |
| Engineer time per break | 3 hours | to notice, find the cause, patch, test and deploy (our assumption) |
| Daily monitoring by hand | 1 hour a day, 250 days | someone checks that portals still deliver (our assumption) |
| Engineer cost | **€51 an hour** | €70,000 gross a year for a software engineer in Hamburg ([Jobvector 2026](https://www.jobvector.de/gehalt/software-ingenieurin/hamburg/), [StepStone](https://www.stepstone.de/gehalt/SW-Entwickler-in/city/Hamburg.html)), plus about 21% employer social contributions, over 1,650 working hours |
| Watchtower repairs by itself | **85%** of breaks | our eval: 11 of 13 breaking changes repaired automatically, median 16 seconds (`npm run eval`) |
| Model cost per repair | **$0.021** | our eval, `/internal/ledger` |
| Model cost to add a portal | **$0.033** | lab average, see README |
| Watching Watchtower | 15 minutes a day | someone looks at the dashboard |
| Server | €100 a month | one container with headless Chromium |

## Cost per year, 300 portals

| | Low (0.5 breaks / portal / year) | **Mid (1 break)** | High (2.6 breaks) |
|---|---|---|---|
| Breaks per year | 150 | **300** | 780 |
| **By hand:** hours (fixes + monitoring) | 700 h | **1,150 h** | 2,590 h |
| **By hand:** cost | €35,700 | **€58,700** | €132,100 |
| **Watchtower:** breaks left for a person (15%) | 23 | **45** | 117 |
| **Watchtower:** hours (those fixes + dashboard) | 130 h | **197 h** | 413 h |
| **Watchtower:** people + server + model | €7,800 | **€11,200** | €22,300 |
| **Saved per year** | **€27,900** (78%) | **€47,500 (81%)** | **€109,800** (83%) |

The model cost hardly counts: 300 repairs a year at $0.021 is about **$6**. Almost all of the remaining cost is the person who handles the 15% that Watchtower cannot repair, and the server.

## What the table leaves out

- **Adding portals.** By hand, a new scraper takes 1–2 engineer days (€400–800). With Watchtower you paste the address; it costs about $0.03 in model usage and is serving within minutes. Growing from 300 to 600 portals costs about $10, not €120,000–240,000.
- **Missing tenders while a scraper is broken.** By hand, a broken portal stays dark until someone notices, often days. Watchtower notices on its next read (every 30 minutes) and usually repairs it within seconds. The team can't put a euro value on this, but for a tender-search product, missed tenders are what customers notice.
- **A wrong value is worse than a missing one.** When Watchtower is unsure, it marks the portal `failed` and says why, instead of quietly serving wrong data.

## Scale note: 4,500 portals

Patterno's website mentions 4,500+ portals. In the mid case, keeping that many scrapers by hand would take about **13,750 hours a year (around 8 full-time engineers, €700,000)**. With Watchtower it would take about 2,100 hours and €110,000, so it would save about **€590,000 a year**. Adding all of them once would cost about **$150** in model usage.

## How to read this honestly

- The break rates come from scraping vendors, who have a reason to make maintenance look expensive. That is why the low case uses half their lower number.
- The 85% repair rate was measured on our 3 demo portals with 13 kinds of change, not on 300 real portals. If real portals heal only 60% of the time, the mid case still saves **about €36,000 a year** (61%).
- If one fix takes 1.5 hours instead of 3, the savings in every column roughly halve, but they stay positive.
