# Demo portal lists

Real European public-tender portals (32 in 24 countries plus TED) and the 8 lab portals (Obec Lipnice should end `failed`: its documents need a login), for the dashboard's "Import list" button. Same data in `portals.xlsx`, `portals.csv` and `portals.json`; `portals-small.txt` is 9 addresses for a quick paste demo.
Addresses were checked with one plain request each on 21 Nov 2026; Notes say when a site needs a login for documents, is a JavaScript app, or redirects.

Use: start `npm run lab` (for the localhost portals) and the server, open the dashboard, click "Import list", drop a file (or paste text), review the found addresses, then click "Watch N portals".
Cost: about $0.03–0.04 in model calls per new portal; portals on software Watchtower already knows cost $0.
Real portals are read politely at 1 request per second, so big ones take minutes to fill. The lab portals fill in seconds.
Not included: the hidden test portals (NRW, e-Vergabe Bund, eTenders IE) and the EPPS portals that share their software (Cyprus, Malta), and PLACSP (robots.txt).
