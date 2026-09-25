import assert from "node:assert/strict";
import { test } from "node:test";
import { orderProbes } from "../dist/products/syntheticMonitoring/probes.js";

const probes = [
  { id: 1, name: "London", region: "EMEA", latitude: 51.51, longitude: -0.13 },
  { id: 2, name: "Paris", region: "EMEA", latitude: 48.86, longitude: 2.35 },
  { id: 3, name: "Frankfurt", region: "EMEA", latitude: 50.11, longitude: 8.68 },
  { id: 4, name: "NewYork", region: "AMER", latitude: 40.71, longitude: -74.01 },
  { id: 5, name: "Tokyo", region: "APAC", latitude: 35.68, longitude: 139.65 },
  { id: 6, name: "Sydney", region: "APAC", latitude: -33.87, longitude: 151.21 },
  { id: 7, name: "Dallas", region: "AMER", latitude: 32.78, longitude: -96.8 },
];
const names = (ordered) => ordered.map((probe) => probe.name);

test("a German stack starts in Frankfurt, then covers the other regions before repeating", () => {
  const ordered = orderProbes(probes, "https://synthetic-monitoring-api-eu-west-2.grafana.net");
  assert.deepEqual(names(ordered.slice(0, 3)), ["Frankfurt", "NewYork", "Tokyo"]);
  assert.deepEqual(
    ordered.slice(3, 6).map((probe) => probe.region),
    ["EMEA", "AMER", "APAC"],
  );
  assert.equal(new Set(ordered.map((probe) => probe.id)).size, probes.length);
  assert.equal(ordered.length, probes.length);
});

test("Australian and legacy US backends choose their nearby probe first", () => {
  assert.equal(orderProbes(probes, "https://synthetic-monitoring-api-au-southeast.grafana.net")[0].name, "Sydney");
  assert.equal(orderProbes(probes, "https://synthetic-monitoring-api-au-southeast-1.grafana.net/")[0].name, "Sydney");
  assert.equal(orderProbes(probes, "https://synthetic-monitoring-api.grafana.net")[0].name, "Dallas");
  assert.equal(orderProbes(probes, "https://synthetic-monitoring-api-us-central2.grafana.net")[0].name, "Dallas");
});

test("ordering does not depend on the API's list order and does not mutate it", () => {
  const reversed = [...probes].reverse();
  const before = structuredClone(reversed);
  const apiUrl = "https://synthetic-monitoring-api-eu-west-2.grafana.net";
  assert.deepEqual(orderProbes(reversed, apiUrl), orderProbes(probes, apiUrl));
  assert.deepEqual(reversed, before);
});

test("missing, unknown, custom, and malformed backend URLs retain deterministic region diversity", () => {
  for (const apiUrl of [
    undefined,
    "",
    "not a URL",
    "https://synthetic-monitoring-api-future-region.grafana.net",
    "https://synthetic-monitoring-api-au-southeast.grafana.net.example.com",
    "https://sm.example.com",
  ]) {
    const ordered = orderProbes([...probes].reverse(), apiUrl);
    assert.deepEqual(names(ordered.slice(0, 3)), ["London", "NewYork", "Tokyo"], apiUrl);
    assert.equal(ordered.length, probes.length);
  }
});

test("equal distances, missing coordinates, and invalid coordinates have stable fallbacks", () => {
  const ordered = orderProbes(
    [
      { id: 9, name: "Missing", region: "EMEA" },
      { id: 8, name: "Invalid", region: "EMEA", latitude: 100, longitude: 200 },
      { id: 7, name: "NaN", region: "EMEA", latitude: NaN, longitude: 0 },
      { id: 6, name: "Infinity", region: "EMEA", latitude: 50, longitude: Infinity },
      { id: 5, name: "Unset", region: "EMEA", latitude: 0, longitude: 0 },
      { ...probes[0], id: 4, name: "London 2", region: " emea " },
      probes[0],
    ],
    "https://synthetic-monitoring-api-gb-south-1.grafana.net",
  );
  assert.deepEqual(names(ordered), ["London", "London 2", "Unset", "Infinity", "NaN", "Invalid", "Missing"]);
});

test("unknown regions cannot displace known regional coverage, but remain available", () => {
  const unknown = { id: 0, name: "Unknown", latitude: 50.11, longitude: 8.68 };
  const ordered = orderProbes([unknown, ...probes], "https://synthetic-monitoring-api-eu-west-2.grafana.net");
  assert.deepEqual(names(ordered.slice(0, 3)), ["Frankfurt", "NewYork", "Tokyo"]);
  assert.equal(ordered.at(-1), unknown);
  assert.deepEqual(
    orderProbes([
      { id: 2, name: "B" },
      { id: 1, name: "A" },
    ]).map((probe) => probe.id),
    [1, 2],
  );
  assert.deepEqual(orderProbes([]), []);
});
