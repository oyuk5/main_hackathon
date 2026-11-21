import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasCancelledTitlePrefix,
  isCancellationLabel,
  isStatusLabel,
  absoluteUrl,
  cleanText,
  mapContractNature,
  mapProcedureType,
  normalizeCpv,
  normalizeCpvList,
  normalizePostalCode,
  parseDate,
  parseDateTime,
} from "./normalize.js";

test("cleanText collapses whitespace and nbsp", () => {
  assert.equal(cleanText("  a  b\n\tc  "), "a b c");
  assert.equal(cleanText("x&nbsp;y"), "x y");
  assert.equal(cleanText(42), "42");
  assert.equal(cleanText("   "), null);
  assert.equal(cleanText(null), null);
  assert.equal(cleanText({}), null);
  assert.equal(cleanText(NaN), null);
});

test("parseDate numeric formats, day first", () => {
  const cases: [string, string][] = [
    ["2026-12-09", "2026-12-09"],
    ["2026-12-09T23:30:00Z", "2026-12-09"],
    ["2026-12-09T00:30:00+01:00", "2026-12-09"],
    ["09.12.2026", "2026-12-09"],
    ["9.12.2026", "2026-12-09"],
    ["09/12/2026", "2026-12-09"],
    ["09-12-2026", "2026-12-09"],
    ["03/04/2026", "2026-04-03"],
    ["09.12.26", "2026-12-09"],
    ["Publiziert am 09.12.2026 um 10:00", "2026-12-09"],
  ];
  for (const [input, want] of cases) assert.equal(parseDate(input), want, input);
});

test("parseDate month names in many languages", () => {
  const cases: [string, string][] = [
    ["9 déc. 2026", "2026-12-09"],
    ["9 dec 2026", "2026-12-09"],
    ["9 décembre 2026", "2026-12-09"],
    ["9 decembre 2026", "2026-12-09"],
    ["9 december 2026", "2026-12-09"],
    ["9. Dezember 2026", "2026-12-09"],
    ["3. März 2026", "2026-03-03"],
    ["9 dic 2026", "2026-12-09"],
    ["9 de diciembre de 2026", "2026-12-09"],
    ["9 grudnia 2026", "2026-12-09"],
    ["15 października 2026", "2026-10-15"],
    ["December 9, 2026", "2026-12-09"],
    ["Dec. 9th, 2026", "2026-12-09"],
    ["9 Dec 2026", "2026-12-09"],
    ["9 dezembro 2026", "2026-12-09"],
    ["1 maart 2026", "2026-03-01"],
    ["1 mrt. 2026", "2026-03-01"],
    ["12 settembre 2026", "2026-09-12"],
    ["Date limite : 9 janv. 2027", "2027-01-09"],
  ];
  for (const [input, want] of cases) assert.equal(parseDate(input), want, input);
});

test("parseDate rejects impossible or absent dates", () => {
  assert.equal(parseDate("31.02.2026"), null);
  assert.equal(parseDate("2026-13-01"), null);
  assert.equal(parseDate("29.02.2027"), null);
  assert.equal(parseDate("29.02.2028"), "2028-02-29");
  assert.equal(parseDate("9 foo 2026"), null);
  assert.equal(parseDate("soon"), null);
  assert.equal(parseDate(""), null);
  assert.equal(parseDate(null), null);
  assert.equal(parseDate(12345), null);
});

test("parseDate with explicit format", () => {
  assert.equal(parseDate("12/09/2026", "MM/dd/yyyy"), "2026-12-09");
  assert.equal(parseDate("2026|09|12", "yyyy|dd|MM"), "2026-12-09");
  assert.equal(parseDate("9-Dec-26", "d-MMM-yy"), "2026-12-09");
  // format does not match: falls back to built-in (day first)
  assert.equal(parseDate("09.12.2026", "MM/dd/yyyy"), "2026-12-09");
});

test("parseDateTime local wall time with various time styles", () => {
  const z = "Europe/Berlin";
  const want = "2026-12-09T10:00:00+01:00";
  for (const input of [
    "09.12.2026 10:00",
    "09.12.2026, 10:00 Uhr",
    "09.12.2026 10.00",
    "9 décembre 2026 à 10h00",
    "9 décembre 2026 10 h 00",
    "09.12.2026 10:00:00",
    "December 9, 2026 10:00 AM",
    "2026-12-09T10:00:00",
    "2026-12-09 10:00",
    "Frist: 09.12.2026 um 10 Uhr",
    "10:00 Uhr, 09.12.2026",
  ]) {
    assert.equal(parseDateTime(input, z), want, input);
  }
  assert.equal(parseDateTime("December 9, 2026 2:30 PM", z), "2026-12-09T14:30:00+01:00");
  assert.equal(parseDateTime("December 9, 2026 12:00 AM", z), "2026-12-09T00:00:00+01:00");
  assert.equal(parseDateTime("09.12.2026 24:00", z), "2026-12-10T00:00:00+01:00");
});

test("parseDateTime handles DST in Europe/Berlin", () => {
  const z = "Europe/Berlin";
  assert.equal(parseDateTime("27.03.2026 12:00", z), "2026-03-27T12:00:00+01:00");
  assert.equal(parseDateTime("30.03.2026 12:00", z), "2026-03-30T12:00:00+02:00");
  assert.equal(parseDateTime("23.10.2026 12:00", z), "2026-10-23T12:00:00+02:00");
  assert.equal(parseDateTime("26.10.2026 12:00", z), "2026-10-26T12:00:00+01:00");
});

test("parseDateTime converts explicit offsets and instants", () => {
  assert.equal(parseDateTime("2026-12-09T09:00:00Z", "Europe/Amsterdam"), "2026-12-09T10:00:00+01:00");
  assert.equal(parseDateTime("2026-12-09T09:00:00.000Z", "Europe/Amsterdam"), "2026-12-09T10:00:00+01:00");
  assert.equal(parseDateTime("2026-12-09T10:00:00+01:00", "Europe/Berlin"), "2026-12-09T10:00:00+01:00");
  assert.equal(parseDateTime("2026-12-09T04:00:00-05:00", "Europe/Paris"), "2026-12-09T10:00:00+01:00");
  assert.equal(parseDateTime("2026-12-09T23:30:00Z", "Europe/Berlin"), "2026-12-10T00:30:00+01:00");
  assert.equal(parseDateTime("09.12.2026 09:00 UTC", "Europe/Berlin"), "2026-12-09T10:00:00+01:00");
  const ms = Date.UTC(2026, 11, 9, 9, 0, 0);
  assert.equal(parseDateTime(ms, "Europe/Berlin"), "2026-12-09T10:00:00+01:00");
  assert.equal(parseDateTime(String(ms), "Europe/Berlin"), "2026-12-09T10:00:00+01:00");
});

test("parseDateTime with explicit format", () => {
  assert.equal(parseDateTime("12/09/2026 10:00", "Europe/Berlin", "MM/dd/yyyy HH:mm"), "2026-12-09T10:00:00+01:00");
  assert.equal(parseDateTime("12/09/2026 2:05 pm", "Europe/Berlin", "MM/dd/yyyy h:mm a"), "2026-12-09T14:05:00+01:00");
  // format with only date tokens: time is still found next to it
  assert.equal(parseDateTime("12/09/2026 um 10:00", "Europe/Berlin", "MM/dd/yyyy"), "2026-12-09T10:00:00+01:00");
});

test("parseDateTime never invents a time", () => {
  const z = "Europe/Berlin";
  assert.equal(parseDateTime("09.12.2026", z), null);
  assert.equal(parseDateTime("2026-12-09", z), null);
  assert.equal(parseDateTime("9 décembre 2026", z), null);
  assert.equal(parseDateTime("09.12.2026 25:00", z), null);
  assert.equal(parseDateTime("09.12.2026 10:75", z), null);
  assert.equal(parseDateTime("31.02.2026 10:00", z), null);
  assert.equal(parseDateTime("tomorrow", z), null);
  assert.equal(parseDateTime(2026, z), null);
  assert.equal(parseDateTime(null, z), null);
});

test("normalizeCpv strips check digit and rejects junk", () => {
  assert.equal(normalizeCpv("45000000-7"), "45000000");
  assert.equal(normalizeCpv("45000000"), "45000000");
  assert.equal(normalizeCpv(" 45000000 - 7 "), "45000000");
  assert.equal(normalizeCpv("45000000-7 Bauarbeiten"), "45000000");
  assert.equal(normalizeCpv(45000000), "45000000");
  assert.equal(normalizeCpv(3000000), "03000000");
  assert.equal(normalizeCpv("03000000-1"), "03000000");
  assert.equal(normalizeCpv("4500000"), null);
  assert.equal(normalizeCpv("450000001"), null);
  assert.equal(normalizeCpv("20261209"), null); // a date, not a CPV division
  assert.equal(normalizeCpv("12345678"), null);
  assert.equal(normalizeCpv("45000000, 45200000"), null); // two codes: not one
  assert.equal(normalizeCpv("abc"), null);
  assert.equal(normalizeCpv(null), null);
});

test("normalizeCpvList pulls, dedupes and keeps order", () => {
  assert.deepEqual(normalizeCpvList("45000000-7, 45200000-9"), ["45000000", "45200000"]);
  assert.deepEqual(normalizeCpvList(["45200000-9", "45000000-7", "45200000"]), ["45200000", "45000000"]);
  assert.deepEqual(normalizeCpvList("72000000-5 IT-Dienste; 79000000-4 Unternehmensdienste; 20261209"), ["72000000", "79000000"]);
  assert.deepEqual(normalizeCpvList([[45000000], "x"]), ["45000000"]);
  assert.deepEqual(normalizeCpvList(null), []);
  assert.deepEqual(normalizeCpvList(""), []);
});

test("mapProcedureType", () => {
  const cases: [string, string | undefined][] = [
    ["Offenes Verfahren", "open"],
    ["Öffentliche Ausschreibung", "open"],
    ["Procédure ouverte", "open"],
    ["Appel d'offres ouvert", "open"],
    ["Openbaar", "open"],
    ["Openbare procedure", "open"],
    ["Abierto", "open"],
    ["Procedimiento abierto simplificado", "open"],
    ["Procedura aperta", "open"],
    ["Przetarg nieograniczony", "open"],
    ["open", "open"],
    ["Open procedure", "open"],
    ["Open House", "other"],
    ["Nichtoffenes Verfahren", "restricted"],
    ["Nicht offenes Verfahren mit Teilnahmewettbewerb", "restricted"],
    ["Beschränkte Ausschreibung", "restricted"],
    ["Procédure restreinte", "restricted"],
    ["Niet-openbare procedure", "restricted"],
    ["Niet-openbaar", "restricted"],
    ["Procedimiento restringido", "restricted"],
    ["Procedura ristretta", "restricted"],
    ["Przetarg ograniczony", "restricted"],
    ["restricted", "restricted"],
    ["Verhandlungsverfahren mit Teilnahmewettbewerb", "negotiated"],
    ["Verhandlungsvergabe", "negotiated"],
    ["Procédure négociée", "negotiated"],
    ["Onderhandelingsprocedure", "negotiated"],
    ["Procedimiento negociado sin publicidad", "negotiated"],
    ["Procedura negoziata", "negotiated"],
    ["Negocjacje z ogłoszeniem", "negotiated"],
    ["Negotiated procedure", "negotiated"],
    ["negotiated", "negotiated"],
    ["Wettbewerblicher Dialog", "other"],
    ["Competitive dialogue", "other"],
    ["Dialogue compétitif", "other"],
    ["Innovationspartnerschaft", "other"],
    ["Freihändige Vergabe", "other"],
    ["Direct award", "other"],
    ["Zamówienie z wolnej ręki", "other"],
    ["other", "other"],
    ["Procédure adaptée", undefined],
    ["Ausschreibung", undefined],
    ["", undefined],
  ];
  for (const [input, want] of cases) assert.equal(mapProcedureType(input), want, input);
  assert.equal(mapProcedureType(null), undefined);
});

test("mapContractNature", () => {
  const cases: [string, string | undefined][] = [
    ["Bauleistung", "works"],
    ["Bauauftrag", "works"],
    ["Travaux", "works"],
    ["Werken", "works"],
    ["Obras", "works"],
    ["Lavori", "works"],
    ["Roboty budowlane", "works"],
    ["works", "works"],
    ["Dienstleistungen", "services"],
    ["Services", "services"],
    ["Diensten", "services"],
    ["Servicios", "services"],
    ["Servizi", "services"],
    ["Usługi", "services"],
    ["Lieferleistung", "supplies"],
    ["Lieferung", "supplies"],
    ["Fournitures", "supplies"],
    ["Leveringen", "supplies"],
    ["Suministros", "supplies"],
    ["Forniture", "supplies"],
    ["Dostawy", "supplies"],
    ["supplies", "supplies"],
    ["Bau- und Dienstleistungen", undefined],
    ["Sonstiges", undefined],
    ["", undefined],
  ];
  for (const [input, want] of cases) assert.equal(mapContractNature(input), want, input);
});

test("normalizePostalCode", () => {
  assert.equal(normalizePostalCode(" 10115 "), "10115");
  assert.equal(normalizePostalCode("1012 AB"), "1012 AB");
  assert.equal(normalizePostalCode("75001"), "75001");
  assert.equal(normalizePostalCode("SW1A 1AA"), "SW1A 1AA");
  assert.equal(normalizePostalCode("00-950"), "00-950");
  assert.equal(normalizePostalCode("D-10115"), "10115");
  assert.equal(normalizePostalCode("Berlin"), null);
  assert.equal(normalizePostalCode("12"), null);
  assert.equal(normalizePostalCode("10115 Berlin Mitte"), null);
  assert.equal(normalizePostalCode("12345678901"), null);
  assert.equal(normalizePostalCode(null), null);
});

test("absoluteUrl", () => {
  const base = "https://portal.example/tenders/list?page=2";
  assert.equal(absoluteUrl("/notice/1", base), "https://portal.example/notice/1");
  assert.equal(absoluteUrl("detail?id=5", base), "https://portal.example/tenders/detail?id=5");
  assert.equal(absoluteUrl("../docs/a.zip", base), "https://portal.example/docs/a.zip");
  assert.equal(absoluteUrl("//cdn.example/x.pdf", base), "https://cdn.example/x.pdf");
  assert.equal(absoluteUrl("http://other.example/a", base), "http://other.example/a");
  assert.equal(absoluteUrl("  /x  ", base), "https://portal.example/x");
  assert.equal(absoluteUrl("#", base), null);
  assert.equal(absoluteUrl("#top", base), null);
  assert.equal(absoluteUrl("javascript:void(0)", base), null);
  assert.equal(absoluteUrl("JavaScript:alert(1)", base), null);
  assert.equal(absoluteUrl("mailto:a@b.example", base), null);
  assert.equal(absoluteUrl("tel:+49123", base), null);
  assert.equal(absoluteUrl("ftp://x.example/a", base), null);
  assert.equal(absoluteUrl("", base), null);
  assert.equal(absoluteUrl(null, base), null);
  assert.equal(absoluteUrl("https://ok.example/a", "not a url"), "https://ok.example/a");
  assert.equal(absoluteUrl("/rel", "not a url"), null);
});

test("cancellation labels in every lab language, never sentences or negations", () => {
  for (const label of ["Widerrufen", "Aufgehoben", "zurückgezogen", "Annulé", "annulée", "Ingetrokken", "Geannuleerd", "Annullato", "revocato", "Anulada", "anulado", "Aflyst", "Annulleret", "ZRUŠENO", "Unieważnione", "Cancelled", "WITHDRAWN", "Status: Annulleret"]) {
    assert.equal(isCancellationLabel(label), true, label);
  }
  for (const text of [
    "Laufend",
    "Aktiv",
    "Zurück zur Übersicht",
    "Ausschreibungen können jederzeit vom Auftraggeber widerrufen werden",
    "Nicht widerrufen",
    "not cancelled",
    "",
    null,
  ]) {
    assert.equal(isCancellationLabel(text), false, String(text));
  }
});

test("a cancellation marker only counts at the start of a title", () => {
  assert.equal(hasCancelledTitlePrefix("AUFGEHOBEN: Neubau Kita Nord"), true);
  assert.equal(hasCancelledTitlePrefix("[Annulé] Travaux de voirie"), true);
  assert.equal(hasCancelledTitlePrefix("(Widerrufen) Winterdienst"), true);
  assert.equal(hasCancelledTitlePrefix("Cancelled - Road works"), true);
  assert.equal(hasCancelledTitlePrefix("Reinigung nach widerrufenem Vertrag"), false);
  assert.equal(hasCancelledTitlePrefix("Aufgehobene Decken im Rathaus"), false);
  assert.equal(hasCancelledTitlePrefix("Neubau: Aufgehoben"), false);
});

test("status labels", () => {
  for (const l of ["Status", "Status:", "Stav", "Tilstand", "Statut", "Stato", "Estado", "tenderStatus", "procedure_status"]) assert.equal(isStatusLabel(l), true, l);
  for (const l of ["Titel", "Beschreibung", "Statusbericht Bauamt", null]) assert.equal(isStatusLabel(l), false, String(l));
});
