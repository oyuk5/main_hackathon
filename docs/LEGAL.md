# Legal notes on reading public tender data

**Not legal advice.** These are engineering notes from the hackathon team, written 2026-11-21 from the sources linked below. Patterno should have a lawyer check them before relying on them. Where a source could not be verified, the note says so.

## 1. Re-use of public sector information: Open Data Directive (EU) 2019/1024
Source: https://eur-lex.europa.eu/eli/dir/2019/1024/oj/eng
- The Directive covers "existing documents held by public sector bodies" (Art 1(1)(a)). Member states must make them "re-usable for commercial or non-commercial purposes" (Art 3(1)).
- Excluded:
  - documents for which third parties hold intellectual property rights (Art 1(2)(c))
  - documents outside the body's public task (Art 1(2)(a))
- It is without prejudice to the GDPR (Art 1(4)).
- Public bodies may not use the database right to block re-use (Art 1(6)).
- The Directive binds member states, not re-users. A re-user relies on the national law that transposes it (in Germany the DNG; not checked here).
- No clause names tender notices or tender documents explicitly. Whether tender documents are covered is **not verified**.

## 2. TED reuse terms
Source: https://ted.europa.eu/en/legal-notice
- "Unless otherwise noted, the procurement notices published in the Supplement to the Official Journal of the European Union can be freely reused, for commercial or non-commercial purposes."
- The reuse policy follows Commission Decision 2011/833/EU (https://eur-lex.europa.eu/eli/dec/2011/833/oj/eng): reuse is free of charge and needs no individual application (Art 4). Documents with third-party IP are excluded (Art 2(2)(b)).
- TED's editorial content is CC BY 4.0: give credit and say what was changed.
- TED's terms cover TED itself, **not** the documents that national and local portals host. Our coverage sample (`docs/COVERAGE.md`) uses only the TED API.

## 3. robots.txt and website terms of use
- **Terms of use.** Ryanair v PR Aviation, C-30/14 (https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:62014CJ0030): for a database protected by neither copyright nor the sui generis right, the owner may set contractual limits on use. Whether a site's terms bind a crawler is a question of national contract law.
- **Text and data mining.** Directive (EU) 2019/790 Art 4(3) (https://eur-lex.europa.eu/eli/dir/2019/790/oj/eng): the commercial exception applies unless the rightholder has expressly reserved use, "such as machine-readable means" for content online. Recital 18 mentions metadata and website terms.
- **robots.txt.** We found no EU statute or CJEU ruling that gives robots.txt binding force. Whether it counts as a machine-readable reservation under Art 4(3) is **not verified**.

## 4. EU database right: Directive 96/9/EC
Source: https://eur-lex.europa.eu/eli/dir/1996/9/oj/eng
- A maker who made a substantial investment can prevent extraction or re-utilisation of a substantial part (Art 7(1)), and also repeated, systematic extraction of insubstantial parts (Art 7(5)).
- A lawful user may take insubstantial parts for any purpose (Art 8(1)).
- CV-Online Latvia, C-762/19 (https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:62019CJ0762): a specialised search engine that copies and indexes a freely accessible database does extract and re-utilise it. The maker can stop it only where this puts the maker's investment at risk; para 41 calls for "a fair balance".
- Freistaat Bayern v Esterbauer, C-490/14 (https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:62014CJ0490): a public body (Bavaria) held a database right. Open Data Directive Art 1(6) now limits how public bodies may use it against re-use.
- Watchtower copies whole tender lists from each portal. That is likely a "substantial part" of the portal's database, so CV-Online is the relevant test.

## 5. GDPR: contact persons in tender documents
Source: https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng
- TED's own privacy notice lists the personal data in notices: the contact person's job title or name, and a professional e-mail and phone (https://ted.europa.eu/en/legal-notice). Tender documents can contain the same.
- Possible legal basis: legitimate interest, Art 6(1)(f). It needs a documented balancing test.
- Data obtained from someone other than the person: Art 14 applies. Art 14(5)(b) exempts cases where informing everyone "would involve a disproportionate effort". The controller must then take appropriate measures, including making the information public.
- Data minimisation, Art 5(1)(c), and storage limitation, Art 5(1)(e): keep only what serving the tender needs, and only for as long as needed.

## 6. Copyright on tender documents: Germany, § 5 UrhG
Source: https://www.gesetze-im-internet.de/urhg/__5.html
- § 5(1): laws, ordinances, official decrees and announcements (Bekanntmachungen), and decisions, have no copyright protection.
- § 5(2): the same applies to other official works published in the official interest for general information. The bans on changes and the source-citation duty (§§ 62, 63) still apply.
- We found **no court decision** that applies § 5 to Vergabeunterlagen.
- LG Köln, 18.12.2014, 14 O 193/14, as reported at https://vergabeblog.de/2015-03-05/kein-urheberrechtlicher-schutz-fuer-leistungsbeschreibungen-oder-doch-lg-koeln-urt-v-18-12-2014-14-o-19314/: the court denied protection to a Leistungsbeschreibung for lack of originality under § 2 UrhG, not § 5. The blog calls the case specific. The judgment itself was not read.
- Tender documents can contain third-party works, for example architects' plans or studies. § 5 does not cover them, and the Open Data Directive excludes them (Art 1(2)(c)).

## What Watchtower already does right
Each point was checked in code; see README "Compliance and trust".
- Reads only pages published without login. Holds no credentials and solves no captchas. A login, captcha, 401/403 or robots.txt refusal makes the portal `failed`, with a reason that names the block.
- Honours robots.txt for every page, document and browser request. Uses an honest User-Agent and keeps at least 1.1 s between requests to a host.
- Tonight's gauntlet showed it: two portals were left alone because of robots.txt, and one answered 403 to our User-Agent and was not worked around (`docs/GAUNTLET.md`).
- Stores documents only to serve them with their tender.
- Model cost is capped per portal and per day.

## What Patterno should check with a lawyer
1. Whether national portal terms of use, or robots.txt as a TDM reservation, bind a crawler like this one. Also whether a portal operator's investment qualifies for the database right under CV-Online.
2. Whether tender **documents**, as opposed to notices, are covered by national open-data law (for example the DNG) or by § 5(2) UrhG. How to handle third-party works inside them.
3. The legitimate-interest assessment and the Art 14(5)(b) reliance for passing contact names to commercial customers. A retention period, for example purging documents some time after the deadline.

On point 3, one engineering gap is already known: `DELETE /portals/{id}` leaves document files on disk, still served by hash (MORNING.md, 5a).
