/**
 * English and German for everything the dashboard itself writes. Texts that come from the API
 * (portal reasons, run summaries, log messages, tender titles) are shown as the server wrote them.
 * The choice is remembered in this browser; with none stored, a German browser starts in German.
 */
import { createContext, Fragment, useCallback, useContext, useState, type ReactNode } from "react";

export type Lang = "en" | "de";

type Vars = Record<string, string | number>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Msg = string | ((v: any) => string);

const KEY = "wt.lang";

function initial(): Lang {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "en" || stored === "de") return stored;
  } catch {
    /* private window */
  }
  try {
    return navigator.language?.toLowerCase().startsWith("de") ? "de" : "en";
  } catch {
    return "en";
  }
}

/** The language formatters read outside React (times, numbers). Kept in step with the provider. */
let current: Lang = initial();
try {
  document.documentElement.lang = current;
} catch {
  /* no document */
}

export const getLang = () => current;
export const locale = () => (current === "de" ? "de-DE" : undefined);
export const fmtInt = (n: number) => n.toLocaleString(current === "de" ? "de-DE" : "en-US");

const N = (n: number) => fmtInt(n);
const pe = (n: number, one: string, many = `${one}s`) => `${N(n)} ${n === 1 ? one : many}`;
const pd = (n: number, one: string, many: string) => `${N(n)} ${n === 1 ? one : many}`;

// ------------------------------------------------------------ English

const en = {
  // states
  "state.serving": "Serving",
  "state.healing": "Being repaired",
  "state.integrating": "Being attached",
  "state.failed": "Needs a person",
  "stateLower.serving": "serving",
  "stateLower.healing": "being repaired",
  "stateLower.integrating": "being attached",
  "stateLower.failed": "need a person",

  // times
  "ago.now": "just now",
  "ago.min": "{n} min ago",
  "ago.h": "{n} h ago",
  "ago.yesterday": "yesterday",
  "ago.days": "{n} days ago",
  "dur.s": "{n} s",
  "dur.min": "{n} min",

  // header
  "header.tagline": "keeps tender portals delivering",
  "header.address": "Portal address",
  "header.adding": "Adding…",
  "header.watch": "Watch portal",
  "header.importTitle": "Add many portals from an Excel, CSV, JSON or text file",
  "header.import": "Import list",
  "header.notUrl": "That is not a web address. Start with https://.",
  "header.added": "{host} is now watched. Attaching starts now.",
  "header.notAdded": "The portal was not added: the API did not answer.",
  "lang.group": "Language",
  "theme.group": "Theme",
  "theme.auto": "Follow the computer's setting",
  "theme.light": "Light",
  "theme.dark": "Dark",

  // app
  "api.down": "The Watchtower API is not answering.",
  "api.downStale": "Showing the last successful update; retrying every 3 seconds.",
  "api.downRetry": "Retrying every 3 seconds.",
  "app.tryAgain": "Try again",
  "app.loading": "Loading dashboard",
  "app.noneSelected": "No portal is selected.",
  "app.showAll": "Show all portals",
  "app.where": "Where they are",
  "app.countries": (v: { n: number }) => pe(v.n, "country", "countries"),
  "tabs.views": "Views",
  "tabs.portals": "Portals",
  "tabs.issues": "Issues",
  "tabs.log": "Log",

  // summary
  "sum.label": "Summary",
  "sum.empty": "No portals yet",
  "sum.emptyBody": "Add a portal address above. Watchtower learns how to read it, delivers its open tenders and documents, and repairs itself when a portal changes.",
  "sum.ok": "Nothing needs a person",
  "sum.bad": (v: { n: number }) => `${pe(v.n, "portal")} ${v.n === 1 ? "needs" : "need"} a person`,
  "sum.delivered": (v: { o: number; t: number }) => `{open} open ${v.o === 1 ? "tender" : "tenders"} delivered from {serving} of ${pe(v.t, "portal")}.`,
  "sum.checked": "Checked {time}",
  "sum.checkAgain": "Check again now",
  "sum.day": (v: { r: number; p: number; h: number }) =>
    `Last 24 hours: {reads} ${v.r === 1 ? "read" : "reads"}, {problems} ${v.p === 1 ? "problem" : "problems"} found, {repaired} repaired by itself${v.h > 0 ? ", {handed} handed to a person" : ""}.`,
  "sum.needsYou": "Needs you:",
  "sum.more": " and {n} more.",
  "sum.filterGroup": "Show only portals that are",
  "sum.showOnly": "Show only: {w}",

  // portal table
  "sort.label": "Sort",
  "sort.urgent.0": "Most urgent first",
  "sort.urgent.1": "Least urgent first",
  "sort.stale.0": "Longest without delivery",
  "sort.stale.1": "Most recently delivered",
  "sort.tenders.0": "Most open tenders",
  "sort.tenders.1": "Fewest open tenders",
  "sort.name.0": "Name A–Z",
  "sort.name.1": "Name Z–A",
  "table.label": "Portals",
  "table.search": "Search portals",
  "table.searchPlaceholder": "Search portals and reasons",
  "table.filter": "Filter by state",
  "table.hideSide": "Hide map and cost panel",
  "table.showSide": "Show map and cost panel",
  "table.reverseTitle": "Reverse: {w}",
  "table.reverseAria": "Reverse the order. Now: {w}",
  "table.chipGroup": "Show portals that are",
  "table.all": "All",
  "table.noMatch": "No portal matches.",
  "table.clear": "Clear the filters",
  "table.clickReverse": "{w}. Click to reverse.",
  "table.byUrgency": "Sort by urgency",
  "table.portal": "Portal",
  "table.says": "What Watchtower says",
  "table.tenders": "Tenders",
  "table.deliveredOpen": (v: { delivered: number; open: number }) => `${N(v.delivered)} delivered, ${N(v.open)} open`,
  "table.lastDelivered": "Last delivered",
  "table.actions": "Actions",
  "table.repairingNow": "repairing now",
  "table.readingNow": "reading now",
  "table.noneYet": "none yet",
  "table.stale": "No delivery for over 2 hours, while reads run every 30 minutes",
  "table.notYet": "Not yet",
  "table.strip": "Every read and repair in the last 24 hours. Tall marks are repairs; red marks are problems.",
  "table.readAria": "Read {host} now",
  "table.running": "Running",
  "table.readNow": "Read now",
  "table.pages": "Portal table pages",
  "table.range": "{a}–{b} of {n} portals",
  "table.prev": "Previous page",
  "table.next": "Next page",

  // cost
  "cost.title": "Model usage so far",
  "cost.note": "Regular reads call no model and cost $0.",
  "cost.attach": "Attaching",
  "cost.repair": "Repairs",

  // strip
  "strip.repairRunning": "Repair running",
  "strip.repaired": "Repaired",
  "strip.repairFailed": "Repair failed",
  "strip.readFailed": "Read failed",
  "strip.reading": "Reading",
  "strip.readPassed": "Read passed",
  "strip.label": (v: { r: number; p: number; f: number }) => `Last 24 hours: ${pe(v.r, "read")}, ${pe(v.p, "repair")}, ${N(v.f)} failed.`,
  "strip.none": "No activity in the last 24 hours.",
  "strip.at": "{label} at {time}",

  // board
  "board.label": "Issues",
  "lane.person.title": "Needs a person",
  "lane.person.note": "Watchtower could not fix these on its own.",
  "lane.person.empty": "Nothing needs a person.",
  "lane.fixing.title": "Fixing itself",
  "lane.fixing.note": "Repairs and first attaches running now. The last correct tenders stay served.",
  "lane.fixing.empty": "No repair running.",
  "lane.fixing.attachEmpty": "No first attach is running.",
  "lane.fixed.title": "Fixed by itself",
  "lane.fixed.note": "Portals that changed in the last 24 hours and were repaired without help.",
  "lane.fixed.empty": "No repairs in the last 24 hours.",
  "lane.clear.title": "Serving",
  "lane.clear.note": "Portals currently delivering tenders.",
  "lane.clear.empty": "No portals are serving.",
  "next.robots": "Ask the portal for permission or an open data feed; Watchtower will not read paths robots.txt forbids.",
  "next.login": "Ask the portal to publish documents without a login; Watchtower never logs in. The last correct tenders stay served.",
  "next.captcha": "Ask the portal for an API or a feed; Watchtower does not solve captchas.",
  "next.forbidden": "Ask the portal to allow automated reads from Watchtower's address.",
  "next.session": "Ask the portal for an API or a feed that works without a browser session.",
  "next.javascript": "Find the portal's data address by hand and add it as the portal's address.",
  "board.served": (v: { n: number }) => `${pe(v.n, "tender")} still served`,
  "board.nothingYet": "Nothing delivered yet",
  "board.broke": "Broke {when}",
  "board.never": "Never delivered",
  "board.repairStarted": "Repair started {when}",
  "board.queued": "Repair queued",
  "board.learning": "Learning a new portal",
  "board.firstTenders": "First tenders arrive once the recipe passes every check",
  "board.changed": "The portal changed",
  "board.repairedDot": "Repaired.",
  "board.brokeRepaired": "Broke {a}, repaired {b}",
  "board.took": "took {d}",
  "board.working": "working",
  "board.todo": "To do: ",
  "board.tried": "Tried: ",
  "board.lastRead": "Last read {when}",
  "board.open": "open",

  // detail
  "detail.portal": "Portal",
  "detail.stale": "Not updating: the API is not answering",
  "detail.live": "Updates every 3 seconds",
  "detail.close": "Close",
  "detail.gone": "This portal no longer exists, or the API is not answering.",
  "detail.loading": "Loading…",
  "detail.busyRepair": "and repairing now",
  "detail.busyRead": "and reading now",
  "detail.openTenders": "Open tenders",
  "detail.lastDelivered": "Last delivered",
  "detail.howRead": "How it is read",
  "detail.recipe": "{tier}, recipe v{v}",
  "detail.notLearned": "Not learned yet",
  "detail.modelCost": "Model cost",
  "detail.activity": "Activity in the last 24 hours",
  "detail.24h": "24 h ago",
  "detail.12h": "12 h ago",
  "detail.now": "Now",
  "detail.marks": "Short marks are reads; tall marks are repairs. Red marks failed.",
  "tier.feed": "Feed",
  "tier.jsonApi": "JSON API",
  "tier.html": "Web pages",
  "tier.browser": "Browser",
  "tier.unknown": "Unknown",
  "detail.alreadyRunning": "Already running; following that run.",
  "detail.readingNow": "Reading now.",
  "detail.readNotStarted": "The read did not start: the API did not answer.",
  "detail.notRemoved": "The portal was not removed: the API did not answer.",
  "detail.readNow": "Read now",
  "detail.confirmStop": "Click again to stop watching",
  "detail.stop": "Stop watching",
  "detail.history": "Run history",
  "detail.historyNote": "Newest first. Consecutive successful reads are grouped.",
  "detail.historyEmpty": "Nothing yet. The first read starts as soon as the portal is added.",
  "detail.showLess": "Show less",
  "detail.showAll": (v: { n: number }) => `Show all ${pe(v.n, "run")}`,
  "detail.quietOne": "Read at {t} passed every check",
  "detail.quietMany": "{n} reads passed every check, {a} to {b}",
  "run.repairing": "Repairing",
  "run.repaired": "Repaired",
  "run.repairFailed": "Repair failed",
  "run.reading": "Reading",
  "run.readPassed": "Read passed",
  "run.readFailed": "Read failed",
  "run.took": " in {d}",
  "run.cost": ", model cost {c}",
  "detail.changes": "What the repair changed, recipe v{a} to v{b}",
  "detail.removed": "removed",
  "detail.addedAria": "added",
  "detail.runLog": "Run log",
  "detail.entries": (v: { n: number; w: number }) => `${pe(v.n, "entry", "entries")}${v.w ? `, ${pe(v.w, "warning")}` : ""}.`,
  "detail.hide": "Hide",
  "detail.show": "Show",
  "usage.title": "Model usage",
  "usage.attach": "Learning the portal",
  "usage.repair": "Repairs",
  "usage.check": "Checks",
  "usage.triage": "Triage",
  "usage.for": "For",
  "usage.calls": "Calls",
  "usage.tokens": "Tokens in, out",
  "usage.cost": "Cost",
  "usage.regular": "Regular reads",
  "detail.recipeTitle": "Recipe v{v}",

  // log
  "log.problem": "Problem found",
  "log.unrepaired": "Could not repair",
  "log.running": "Running",
  "log.repaired": "Repaired",
  "log.passed": "Passed",
  "log.f.all": "Everything",
  "log.f.problems": "Problems",
  "log.f.repairs": "Repairs",
  "log.e.all": "No log entries for the selected portals.",
  "log.e.problems": "No failed reads or repairs for the selected portals.",
  "log.e.repairs": "No repairs have started for the selected portals.",
  "log.nm.all": "No log entries match your search.",
  "log.nm.problems": "No problems match your search.",
  "log.nm.repairs": "No repairs match your search.",
  "log.hint": " Turn on ‘Include reads that passed’ to see routine reads.",
  "log.today": "Today",
  "log.yesterday": "Yesterday",
  "log.todayAt": "Today {t}",
  "log.yestAt": "Yest {t}",
  "log.sinceToday": "today at {t}",
  "log.sinceYest": "yesterday at {t}",
  "log.times": "{n} times since",
  "log.entries": (v: { n: number }) => pe(v.n, "entry", "entries"),
  "log.title": "Log",
  "log.find": "Filter by portal or text",
  "log.findPlaceholder": "Filter portal or text",
  "log.show": "Show",
  "log.s.timeDesc": "Newest first",
  "log.s.timeAsc": "Oldest first",
  "log.s.portalAsc": "Portal, A to Z",
  "log.s.portalDesc": "Portal, Z to A",
  "log.s.outcomeAsc": "Problems first",
  "log.s.outcomeDesc": "Passed first",
  "log.s.tookDesc": "Took longest",
  "log.s.tookAsc": "Quickest",
  "log.s.costDesc": "Highest model cost",
  "log.s.costAsc": "Lowest model cost",
  "log.passing": "Include reads that passed",
  "log.failed": "The log could not be loaded. Retrying every 5 seconds.",
  "log.c.time": "Time",
  "log.c.portal": "Portal",
  "log.c.what": "What happened",
  "log.c.outcome": "Outcome",
  "log.c.took": "Took",
  "log.c.cost": "Model cost",
  "log.repair": "Repair",
  "log.read": "Read",
  "log.inProgress": "{step} in progress.",
  "log.hideSteps": "Hide steps",
  "log.steps": (v: { n: number }) => pe(v.n, "step"),

  // picker
  "picker.all": "All portals",
  "picker.some": "{c} of {n} portals",
  "picker.find": "Find a portal",
  "picker.shown": "{c} of {n} shown",
  "picker.allBtn": "All",
  "picker.none": "None",
  "picker.noMatch": "No portals match your search.",
  "picker.onlyAria": "Show only {name}",
  "picker.only": "Only",

  // import
  "imp.title": "Add portals from a list",
  "imp.close": "Close",
  "imp.intro": "Excel (.xlsx, .xls), OpenDocument (.ods), CSV, JSON, XML, HTML, Word or plain text. Every web address in the file is found; you choose which to watch before anything is added.",
  "imp.reading": "Reading…",
  "imp.drop": "Drop files here",
  "imp.choose": "Choose files",
  "imp.paste": "Or paste addresses",
  "imp.find": "Find addresses",
  "imp.noUrls": "No web addresses found. The file needs addresses starting with https://, http:// or www.",
  "imp.unreadable": "The file could not be read.",
  "imp.badSheet": "This file looks like a spreadsheet but could not be opened.",
  "imp.found": (v: { n: number; s: number; w: number }) =>
    `Found ${pe(v.n, "address", "addresses")} on ${pe(v.s, "site")}${v.w ? `, ${N(v.w)} already watched` : ""}.`,
  "imp.onePerSite": "Keep one address per site.",
  "imp.onePerSiteNote": "If the list holds single tender pages, Watchtower only needs each portal once.",
  "imp.selectAll": "Select all",
  "imp.selectNone": "Select none",
  "imp.already": "already watched",
  "imp.added": "added",
  "imp.invalid": "not a web address",
  "imp.notAdded": "not added",
  "imp.another": "← Another file",
  "imp.cost": "Attaching costs up to {usd} in model calls; portals on known software cost $0.",
  "imp.watch": (v: { n: number }) => `Watch ${pe(v.n, "portal")}`,
  "imp.progress": "Adding {d} of {t}…",
  "imp.result": (v: { a: number; i: number; f: number }) =>
    `${N(v.a)} added${v.i ? `, ${N(v.i)} not web addresses` : ""}${v.f ? `, ${N(v.f)} not added (the API did not answer)` : ""}. Attaching runs on its own; watch it in the table.`,
  "imp.done": "Done",

  // chart
  "chart.aria": (v: { n: number }) => `Chart of ${pe(v.n, "portal")}: {summary}`,
  "chart.cluster": (v: { n: number }) => `{country}: ${pe(v.n, "portal")}`,
  "chart.showList": "{text}. Show the list.",
  "chart.clickList": "{text}. Click for the list.",
  "chart.closeList": "Close the list",
  "chart.learning": "Learning how to read it",
  "chart.openTenders": (v: { n: number }) => `, ${N(v.n)} open ${v.n === 1 ? "tender" : "tenders"}`,
  "chart.unknown": "Not on the map: country unknown",
  "chart.more": "and {n} more, listed in the table",
  "chart.north": "N",
  "chart.east": "E",
  "chart.west": "W",
  "sea.north": "North Sea",
  "sea.atlantic": "Atlantic Ocean",
  "sea.baltic": "Baltic Sea",
  "sea.med": "Mediterranean Sea",
  "sea.norwegian": "Norwegian Sea",

  // sign-in
} satisfies Record<string, Msg>;

export type Key = keyof typeof en;

// ------------------------------------------------------------ German

const de: Record<Key, Msg> = {
  "state.serving": "Liefert",
  "state.healing": "Wird repariert",
  "state.integrating": "Wird angebunden",
  "state.failed": "Eingriff nötig",
  "stateLower.serving": "liefern",
  "stateLower.healing": "werden repariert",
  "stateLower.integrating": "werden angebunden",
  "stateLower.failed": "brauchen einen Eingriff",

  "ago.now": "gerade eben",
  "ago.min": "vor {n} Min.",
  "ago.h": "vor {n} Std.",
  "ago.yesterday": "gestern",
  "ago.days": "vor {n} Tagen",
  "dur.s": "{n} s",
  "dur.min": "{n} Min.",

  "header.tagline": "hält Vergabeportale am Liefern",
  "header.address": "Portaladresse",
  "header.adding": "Hinzufügen…",
  "header.watch": "Portal überwachen",
  "header.importTitle": "Viele Portale aus einer Excel-, CSV-, JSON- oder Textdatei hinzufügen",
  "header.import": "Liste importieren",
  "header.notUrl": "Das ist keine Webadresse. Beginnen Sie mit https://.",
  "header.added": "{host} wird jetzt überwacht. Die Anbindung beginnt sofort.",
  "header.notAdded": "Das Portal wurde nicht hinzugefügt: Die API hat nicht geantwortet.",
  "lang.group": "Sprache",
  "theme.group": "Darstellung",
  "theme.auto": "Systemeinstellung verwenden",
  "theme.light": "Hell",
  "theme.dark": "Dunkel",

  "api.down": "Die Watchtower-API antwortet nicht.",
  "api.downStale": "Angezeigt wird der letzte erfolgreiche Stand; neuer Versuch alle 3 Sekunden.",
  "api.downRetry": "Neuer Versuch alle 3 Sekunden.",
  "app.tryAgain": "Erneut versuchen",
  "app.loading": "Dashboard wird geladen",
  "app.noneSelected": "Kein Portal ausgewählt.",
  "app.showAll": "Alle Portale anzeigen",
  "app.where": "Standorte",
  "app.countries": (v: { n: number }) => pd(v.n, "Land", "Länder"),
  "tabs.views": "Ansichten",
  "tabs.portals": "Portale",
  "tabs.issues": "Probleme",
  "tabs.log": "Protokoll",

  "sum.label": "Übersicht",
  "sum.empty": "Noch keine Portale",
  "sum.emptyBody": "Geben Sie oben eine Portaladresse ein. Watchtower lernt, das Portal zu lesen, liefert dessen offene Ausschreibungen und Unterlagen und repariert sich selbst, wenn sich ein Portal ändert.",
  "sum.ok": "Kein Eingriff nötig",
  "sum.bad": (v: { n: number }) => (v.n === 1 ? "1 Portal braucht einen Eingriff" : `${N(v.n)} Portale brauchen einen Eingriff`),
  "sum.delivered": (v: { o: number; t: number }) =>
    `{open} offene ${v.o === 1 ? "Ausschreibung" : "Ausschreibungen"} aus {serving} von ${pd(v.t, "Portal", "Portalen")} geliefert.`,
  "sum.checked": "Stand {time}",
  "sum.checkAgain": "Jetzt erneut prüfen",
  "sum.day": (v: { r: number; p: number; h: number }) =>
    `Letzte 24 Stunden: {reads} ${v.r === 1 ? "Abruf" : "Abrufe"}, {problems} ${v.p === 1 ? "Problem" : "Probleme"} gefunden, {repaired} selbst repariert${v.h > 0 ? ", {handed} an einen Menschen übergeben" : ""}.`,
  "sum.needsYou": "Bitte prüfen:",
  "sum.more": " und {n} weitere.",
  "sum.filterGroup": "Nur Portale mit diesem Status anzeigen",
  "sum.showOnly": "Nur anzeigen: {w}",

  "sort.label": "Sortierung",
  "sort.urgent.0": "Dringendste zuerst",
  "sort.urgent.1": "Am wenigsten dringend zuerst",
  "sort.stale.0": "Am längsten ohne Lieferung",
  "sort.stale.1": "Zuletzt geliefert zuerst",
  "sort.tenders.0": "Meiste offene Ausschreibungen",
  "sort.tenders.1": "Wenigste offene Ausschreibungen",
  "sort.name.0": "Name A–Z",
  "sort.name.1": "Name Z–A",
  "table.label": "Portale",
  "table.search": "Portale durchsuchen",
  "table.searchPlaceholder": "Portale und Gründe durchsuchen",
  "table.filter": "Nach Status filtern",
  "table.hideSide": "Karte und Kosten ausblenden",
  "table.showSide": "Karte und Kosten einblenden",
  "table.reverseTitle": "Umkehren: {w}",
  "table.reverseAria": "Reihenfolge umkehren. Aktuell: {w}",
  "table.chipGroup": "Portale mit diesem Status anzeigen",
  "table.all": "Alle",
  "table.noMatch": "Kein Portal passt.",
  "table.clear": "Filter zurücksetzen",
  "table.clickReverse": "{w}. Zum Umkehren klicken.",
  "table.byUrgency": "Nach Dringlichkeit sortieren",
  "table.portal": "Portal",
  "table.says": "Was Watchtower meldet",
  "table.tenders": "Ausschreibungen",
  "table.deliveredOpen": (v: { delivered: number; open: number }) => `${N(v.delivered)} geliefert, ${N(v.open)} offen`,
  "table.lastDelivered": "Zuletzt geliefert",
  "table.actions": "Aktionen",
  "table.repairingNow": "wird gerade repariert",
  "table.readingNow": "wird gerade abgerufen",
  "table.noneYet": "noch keine",
  "table.stale": "Seit über 2 Stunden keine Lieferung, obwohl alle 30 Minuten abgerufen wird",
  "table.notYet": "Noch nicht",
  "table.strip": "Jeder Abruf und jede Reparatur der letzten 24 Stunden. Hohe Striche sind Reparaturen, rote Striche Probleme.",
  "table.readAria": "{host} jetzt abrufen",
  "table.running": "Läuft",
  "table.readNow": "Jetzt abrufen",
  "table.pages": "Seiten der Portaltabelle",
  "table.range": "{a}–{b} von {n} Portalen",
  "table.prev": "Vorherige Seite",
  "table.next": "Nächste Seite",

  "cost.title": "Modellnutzung bisher",
  "cost.note": "Reguläre Abrufe nutzen kein Modell und kosten 0\u00a0$.",
  "cost.attach": "Anbindung",
  "cost.repair": "Reparaturen",

  "strip.repairRunning": "Reparatur läuft",
  "strip.repaired": "Repariert",
  "strip.repairFailed": "Reparatur fehlgeschlagen",
  "strip.readFailed": "Abruf fehlgeschlagen",
  "strip.reading": "Wird abgerufen",
  "strip.readPassed": "Abruf erfolgreich",
  "strip.label": (v: { r: number; p: number; f: number }) =>
    `Letzte 24 Stunden: ${pd(v.r, "Abruf", "Abrufe")}, ${pd(v.p, "Reparatur", "Reparaturen")}, ${N(v.f)} fehlgeschlagen.`,
  "strip.none": "Keine Aktivität in den letzten 24 Stunden.",
  "strip.at": "{label} um {time}",

  "board.label": "Probleme",
  "lane.person.title": "Eingriff nötig",
  "lane.person.note": "Diese Portale konnte Watchtower nicht selbst reparieren.",
  "lane.person.empty": "Kein Eingriff nötig.",
  "lane.fixing.title": "Repariert sich selbst",
  "lane.fixing.note": "Reparaturen und erste Anbindungen laufen gerade. Die zuletzt korrekten Ausschreibungen werden weiter geliefert.",
  "lane.fixing.empty": "Keine Reparatur aktiv.",
  "lane.fixing.attachEmpty": "Keine Erstanbindung läuft.",
  "lane.fixed.title": "Selbst repariert",
  "lane.fixed.note": "Portale, die sich in den letzten 24 Stunden geändert haben und ohne Hilfe repariert wurden.",
  "lane.fixed.empty": "Keine Reparaturen in den letzten 24 Stunden.",
  "lane.clear.title": "Liefert",
  "lane.clear.note": "Diese Portale liefern derzeit Ausschreibungen.",
  "lane.clear.empty": "Derzeit liefert kein Portal.",
  "next.robots": "Bitten Sie das Portal um Erlaubnis oder einen offenen Datenfeed; Watchtower liest keine Pfade, die robots.txt verbietet.",
  "next.login": "Bitten Sie das Portal, Unterlagen ohne Anmeldung zu veröffentlichen; Watchtower meldet sich nie an. Die zuletzt korrekten Ausschreibungen werden weiter geliefert.",
  "next.captcha": "Bitten Sie das Portal um eine API oder einen Feed; Watchtower löst keine Captchas.",
  "next.forbidden": "Bitten Sie das Portal, automatisierte Abrufe von der Adresse von Watchtower zuzulassen.",
  "next.session": "Bitten Sie das Portal um eine API oder einen Feed, der ohne Browsersitzung funktioniert.",
  "next.javascript": "Ermitteln Sie die Datenadresse des Portals von Hand und tragen Sie sie als Portaladresse ein.",
  "board.served": (v: { n: number }) => `${pd(v.n, "Ausschreibung", "Ausschreibungen")} weiterhin geliefert`,
  "board.nothingYet": "Noch nichts geliefert",
  "board.broke": "Ausgefallen {when}",
  "board.never": "Nie geliefert",
  "board.repairStarted": "Reparatur gestartet {when}",
  "board.queued": "Reparatur eingeplant",
  "board.learning": "Neues Portal wird angelernt",
  "board.firstTenders": "Die ersten Ausschreibungen kommen, sobald das Rezept alle Prüfungen besteht",
  "board.changed": "Das Portal hat sich geändert",
  "board.repairedDot": "Repariert.",
  "board.brokeRepaired": "Ausgefallen {a}, repariert {b}",
  "board.took": "Dauer {d}",
  "board.working": "in Arbeit",
  "board.todo": "Zu tun: ",
  "board.tried": "Versucht: ",
  "board.lastRead": "Zuletzt abgerufen {when}",
  "board.open": "offen",

  "detail.portal": "Portal",
  "detail.stale": "Keine Aktualisierung: Die API antwortet nicht",
  "detail.live": "Aktualisiert alle 3 Sekunden",
  "detail.close": "Schließen",
  "detail.gone": "Dieses Portal existiert nicht mehr, oder die API antwortet nicht.",
  "detail.loading": "Wird geladen…",
  "detail.busyRepair": "und wird gerade repariert",
  "detail.busyRead": "und wird gerade abgerufen",
  "detail.openTenders": "Offene Ausschreibungen",
  "detail.lastDelivered": "Zuletzt geliefert",
  "detail.howRead": "Abrufart",
  "detail.recipe": "{tier}, Rezept v{v}",
  "detail.notLearned": "Noch nicht gelernt",
  "detail.modelCost": "Modellkosten",
  "detail.activity": "Aktivität der letzten 24 Stunden",
  "detail.24h": "vor 24 Std.",
  "detail.12h": "vor 12 Std.",
  "detail.now": "Jetzt",
  "detail.marks": "Kurze Striche sind Abrufe, hohe Striche Reparaturen. Rote Striche sind fehlgeschlagen.",
  "tier.feed": "Feed",
  "tier.jsonApi": "JSON-API",
  "tier.html": "Webseiten",
  "tier.browser": "Browser",
  "tier.unknown": "Unbekannt",
  "detail.alreadyRunning": "Läuft bereits; dieser Lauf wird verfolgt.",
  "detail.readingNow": "Wird jetzt abgerufen.",
  "detail.readNotStarted": "Der Abruf wurde nicht gestartet: Die API hat nicht geantwortet.",
  "detail.notRemoved": "Das Portal wurde nicht entfernt: Die API hat nicht geantwortet.",
  "detail.readNow": "Jetzt abrufen",
  "detail.confirmStop": "Zum Beenden erneut klicken",
  "detail.stop": "Nicht mehr überwachen",
  "detail.history": "Laufverlauf",
  "detail.historyNote": "Neueste zuerst. Aufeinanderfolgende erfolgreiche Abrufe sind zusammengefasst.",
  "detail.historyEmpty": "Noch nichts. Der erste Abruf startet, sobald das Portal hinzugefügt ist.",
  "detail.showLess": "Weniger anzeigen",
  "detail.showAll": (v: { n: number }) => (v.n === 1 ? "1 Lauf anzeigen" : `Alle ${N(v.n)} Läufe anzeigen`),
  "detail.quietOne": "Abruf um {t} hat alle Prüfungen bestanden",
  "detail.quietMany": "{n} Abrufe haben alle Prüfungen bestanden, {a} bis {b}",
  "run.repairing": "Wird repariert",
  "run.repaired": "Repariert",
  "run.repairFailed": "Reparatur fehlgeschlagen",
  "run.reading": "Wird abgerufen",
  "run.readPassed": "Abruf erfolgreich",
  "run.readFailed": "Abruf fehlgeschlagen",
  "run.took": ", Dauer {d}",
  "run.cost": ", Modellkosten {c}",
  "detail.changes": "Was die Reparatur geändert hat, Rezept v{a} zu v{b}",
  "detail.removed": "entfernt",
  "detail.addedAria": "hinzugefügt",
  "detail.runLog": "Laufprotokoll",
  "detail.entries": (v: { n: number; w: number }) =>
    `${pd(v.n, "Eintrag", "Einträge")}${v.w ? `, ${pd(v.w, "Warnung", "Warnungen")}` : ""}.`,
  "detail.hide": "Ausblenden",
  "detail.show": "Anzeigen",
  "usage.title": "Modellnutzung",
  "usage.attach": "Anlernen des Portals",
  "usage.repair": "Reparaturen",
  "usage.check": "Prüfungen",
  "usage.triage": "Triage",
  "usage.for": "Zweck",
  "usage.calls": "Aufrufe",
  "usage.tokens": "Tokens ein, aus",
  "usage.cost": "Kosten",
  "usage.regular": "Reguläre Abrufe",
  "detail.recipeTitle": "Rezept v{v}",

  "log.problem": "Problem gefunden",
  "log.unrepaired": "Nicht reparierbar",
  "log.running": "Läuft",
  "log.repaired": "Repariert",
  "log.passed": "Bestanden",
  "log.f.all": "Alles",
  "log.f.problems": "Probleme",
  "log.f.repairs": "Reparaturen",
  "log.e.all": "Keine Protokolleinträge für die ausgewählten Portale.",
  "log.e.problems": "Keine fehlgeschlagenen Abrufe oder Reparaturen für die ausgewählten Portale.",
  "log.e.repairs": "Für die ausgewählten Portale wurde keine Reparatur gestartet.",
  "log.nm.all": "Keine Protokolleinträge passen zu Ihrer Suche.",
  "log.nm.problems": "Keine Probleme passen zu Ihrer Suche.",
  "log.nm.repairs": "Keine Reparaturen passen zu Ihrer Suche.",
  "log.hint": " Schalten Sie „Erfolgreiche Abrufe einbeziehen“ ein, um Routineabrufe zu sehen.",
  "log.today": "Heute",
  "log.yesterday": "Gestern",
  "log.todayAt": "Heute {t}",
  "log.yestAt": "Gestern {t}",
  "log.sinceToday": "heute um {t}",
  "log.sinceYest": "gestern um {t}",
  "log.times": "{n}-mal seit",
  "log.entries": (v: { n: number }) => pd(v.n, "Eintrag", "Einträge"),
  "log.title": "Protokoll",
  "log.find": "Nach Portal oder Text filtern",
  "log.findPlaceholder": "Portal oder Text filtern",
  "log.show": "Anzeigen",
  "log.s.timeDesc": "Neueste zuerst",
  "log.s.timeAsc": "Älteste zuerst",
  "log.s.portalAsc": "Portal, A bis Z",
  "log.s.portalDesc": "Portal, Z bis A",
  "log.s.outcomeAsc": "Probleme zuerst",
  "log.s.outcomeDesc": "Bestandene zuerst",
  "log.s.tookDesc": "Längste Dauer",
  "log.s.tookAsc": "Kürzeste Dauer",
  "log.s.costDesc": "Höchste Modellkosten",
  "log.s.costAsc": "Niedrigste Modellkosten",
  "log.passing": "Erfolgreiche Abrufe einbeziehen",
  "log.failed": "Das Protokoll konnte nicht geladen werden. Neuer Versuch alle 5 Sekunden.",
  "log.c.time": "Zeit",
  "log.c.portal": "Portal",
  "log.c.what": "Was geschah",
  "log.c.outcome": "Ergebnis",
  "log.c.took": "Dauer",
  "log.c.cost": "Kosten",
  "log.repair": "Reparatur",
  "log.read": "Abruf",
  "log.inProgress": "{step} läuft.",
  "log.hideSteps": "Schritte ausblenden",
  "log.steps": (v: { n: number }) => pd(v.n, "Schritt", "Schritte"),

  "picker.all": "Alle Portale",
  "picker.some": "{c} von {n} Portalen",
  "picker.find": "Portal suchen",
  "picker.shown": "{c} von {n} angezeigt",
  "picker.allBtn": "Alle",
  "picker.none": "Keine",
  "picker.noMatch": "Keine Portale passen zu Ihrer Suche.",
  "picker.onlyAria": "Nur {name} anzeigen",
  "picker.only": "Nur",

  "imp.title": "Portale aus einer Liste hinzufügen",
  "imp.close": "Schließen",
  "imp.intro": "Excel (.xlsx, .xls), OpenDocument (.ods), CSV, JSON, XML, HTML, Word oder reiner Text. Jede Webadresse in der Datei wird gefunden; Sie wählen aus, welche überwacht werden, bevor etwas hinzugefügt wird.",
  "imp.reading": "Wird gelesen…",
  "imp.drop": "Dateien hier ablegen",
  "imp.choose": "Dateien auswählen",
  "imp.paste": "Oder Adressen einfügen",
  "imp.find": "Adressen finden",
  "imp.noUrls": "Keine Webadressen gefunden. Die Datei muss Adressen enthalten, die mit https://, http:// oder www. beginnen.",
  "imp.unreadable": "Die Datei konnte nicht gelesen werden.",
  "imp.badSheet": "Diese Datei sieht wie eine Tabelle aus, konnte aber nicht geöffnet werden.",
  "imp.found": (v: { n: number; s: number; w: number }) =>
    `${pd(v.n, "Adresse", "Adressen")} auf ${pd(v.s, "Website", "Websites")} gefunden${v.w ? `, davon ${N(v.w)} bereits überwacht` : ""}.`,
  "imp.onePerSite": "Nur eine Adresse pro Website behalten.",
  "imp.onePerSiteNote": "Enthält die Liste einzelne Ausschreibungsseiten, braucht Watchtower jedes Portal nur einmal.",
  "imp.selectAll": "Alle auswählen",
  "imp.selectNone": "Keine auswählen",
  "imp.already": "bereits überwacht",
  "imp.added": "hinzugefügt",
  "imp.invalid": "keine Webadresse",
  "imp.notAdded": "nicht hinzugefügt",
  "imp.another": "← Andere Datei",
  "imp.cost": "Die Anbindung kostet bis zu {usd} an Modellaufrufen; Portale mit bekannter Software kosten 0\u00a0$.",
  "imp.watch": (v: { n: number }) => `${pd(v.n, "Portal", "Portale")} überwachen`,
  "imp.progress": "{d} von {t} werden hinzugefügt…",
  "imp.result": (v: { a: number; i: number; f: number }) =>
    `${N(v.a)} hinzugefügt${v.i ? `, ${N(v.i)} keine Webadressen` : ""}${v.f ? `, ${N(v.f)} nicht hinzugefügt (die API hat nicht geantwortet)` : ""}. Die Anbindung läuft von selbst; verfolgen Sie sie in der Tabelle.`,
  "imp.done": "Fertig",

  "chart.aria": (v: { n: number }) => `Karte mit ${pd(v.n, "Portal", "Portalen")}: {summary}`,
  "chart.cluster": (v: { n: number }) => `{country}: ${pd(v.n, "Portal", "Portale")}`,
  "chart.showList": "{text}. Liste anzeigen.",
  "chart.clickList": "{text}. Für die Liste klicken.",
  "chart.closeList": "Liste schließen",
  "chart.learning": "Wird angelernt",
  "chart.openTenders": (v: { n: number }) => `, ${N(v.n)} offene ${v.n === 1 ? "Ausschreibung" : "Ausschreibungen"}`,
  "chart.unknown": "Nicht auf der Karte: Land unbekannt",
  "chart.more": "und {n} weitere, in der Tabelle aufgeführt",
  "chart.north": "N",
  "chart.east": "O",
  "chart.west": "W",
  "sea.north": "Nordsee",
  "sea.atlantic": "Atlantischer Ozean",
  "sea.baltic": "Ostsee",
  "sea.med": "Mittelmeer",
  "sea.norwegian": "Europäisches Nordmeer",

};

const DICT: Record<Lang, Record<Key, Msg>> = { en, de };

function fill(s: string, vars?: Vars) {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (all, k: string) => {
    const v = vars[k];
    return v === undefined ? all : typeof v === "number" ? N(v) : v;
  });
}

/** A text in the current language. Numbers in `vars` are formatted for that language. */
export function t(key: Key, vars?: Vars): string {
  const m = DICT[current][key];
  return fill(typeof m === "function" ? m(vars ?? {}) : m, vars);
}

/** Like `t`, but `{name}` slots can hold elements (a bold number, a link). */
export function tx(key: Key, vars: Vars, nodes: Record<string, ReactNode>): ReactNode {
  const m = DICT[current][key];
  const text = typeof m === "function" ? m(vars) : m;
  const parts = text.split(/\{(\w+)\}/g);
  return parts.map((p, i) => (i % 2 === 1 ? <Fragment key={i}>{p in nodes ? nodes[p] : fill(`{${p}}`, vars)}</Fragment> : p));
}

// ------------------------------------------------------------ React

const LangContext = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: current, setLang: () => {} });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setState] = useState<Lang>(current);
  const setLang = useCallback((l: Lang) => {
    current = l;
    document.documentElement.lang = l;
    try {
      localStorage.setItem(KEY, l);
    } catch {
      /* private window: the choice lasts until reload */
    }
    setState(l);
  }, []);
  current = lang;
  return <LangContext.Provider value={{ lang, setLang }}>{children}</LangContext.Provider>;
}

/** The current language and its text function. Components that show text call this, so they re-render on a switch. */
export function useT() {
  const { lang, setLang } = useContext(LangContext);
  return { t, tx, lang, setLang };
}

const LANGS: { id: Lang; short: string; name: string }[] = [
  { id: "en", short: "EN", name: "English" },
  { id: "de", short: "DE", name: "Deutsch" },
];

/** EN | DE, sized and styled like the theme switch next to it. */
export function LangSwitch() {
  const { lang, setLang } = useT();
  return (
    <div role="group" aria-label={t("lang.group")} className="flex shrink-0 items-center rounded-[5px] border border-hairline bg-sea p-0.5">
      {LANGS.map((l) => {
        const on = lang === l.id;
        return (
          <button
            key={l.id}
            type="button"
            lang={l.id}
            aria-pressed={on}
            aria-label={l.name}
            title={l.name}
            onClick={() => setLang(l.id)}
            className={`grid h-7 min-w-8 place-items-center rounded-[4px] px-1.5 text-[12px] font-semibold tracking-wide transition-colors cursor-pointer ${
              on ? "bg-paper text-ink shadow-[0_0_0_1px_var(--color-hairline)]" : "text-slate hover:text-docker"
            }`}
          >
            {l.short}
          </button>
        );
      })}
    </div>
  );
}
