/**
 * Builds web/src/geo/europe.json: European countries from Natural Earth 1:50m (world-atlas),
 * as GeoJSON with ISO alpha-2 codes and coordinates rounded to 0.02°, for the dashboard map.
 * Run once after changing the country list: npx tsx scripts/build-europe-map.ts
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { feature } from "topojson-client";

const require = createRequire(import.meta.url);
const topo = require("world-atlas/countries-50m.json");

// ISO 3166 numeric to alpha-2, for every country drawn on the chart.
const A2: Record<string, string> = {
  "008": "AL", "020": "AD", "040": "AT", "056": "BE", "070": "BA", "100": "BG", "112": "BY", "191": "HR", "196": "CY",
  "203": "CZ", "208": "DK", "233": "EE", "246": "FI", "250": "FR", "276": "DE", "292": "GI", "300": "GR", "348": "HU",
  "352": "IS", "372": "IE", "380": "IT", "428": "LV", "438": "LI", "440": "LT", "442": "LU", "470": "MT", "492": "MC",
  "498": "MD", "499": "ME", "528": "NL", "807": "MK", "578": "NO", "616": "PL", "620": "PT", "642": "RO", "643": "RU",
  "674": "SM", "688": "RS", "703": "SK", "705": "SI", "724": "ES", "752": "SE", "756": "CH", "804": "UA", "826": "GB",
  "792": "TR", "504": "MA", "012": "DZ", "788": "TN", "434": "LY", "818": "EG", "376": "IL", "422": "LB", "760": "SY",
  "400": "JO", "368": "IQ", "364": "IR", "268": "GE", "051": "AM", "031": "AZ", "398": "KZ", "304": "GL", "-99": "XK",
};
const BOX = { w: -26, e: 46, s: 33, n: 72 };
const r = (x: number) => Math.round(x * 50) / 50;

type Ring = [number, number][];
const keepRing = (ring: Ring) => ring.some(([x, y]) => x >= BOX.w - 10 && x <= BOX.e + 10 && y >= BOX.s - 6 && y <= BOX.n + 6);
const clean = (ring: Ring) => {
  const out: Ring = [];
  for (const [x, y] of ring) {
    const p: [number, number] = [r(Math.min(Math.max(x, BOX.w - 12), BOX.e + 12)), r(Math.min(Math.max(y, BOX.s - 8), BOX.n + 8))];
    const last = out.at(-1);
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
};

const fc = feature(topo, topo.objects.countries) as unknown as { features: { id: string; geometry: { type: string; coordinates: unknown } }[] };
const features = [];
for (const f of fc.features) {
  const code = A2[f.id];
  if (!code || !f.geometry) continue;
  const polys = (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates) as Ring[][];
  const kept = polys.filter((p) => keepRing(p[0]!)).map((p) => p.map(clean).filter((ring) => ring.length >= 4));
  if (kept.length === 0) continue;
  features.push({ type: "Feature", id: code, properties: {}, geometry: { type: "MultiPolygon", coordinates: kept } });
}
fs.writeFileSync("web/src/geo/europe.json", JSON.stringify({ type: "FeatureCollection", features }));
console.log(`${features.length} countries, ${fs.statSync("web/src/geo/europe.json").size} bytes`);
