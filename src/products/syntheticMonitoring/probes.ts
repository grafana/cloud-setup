import type { Probe } from "./api.js";

type Location = readonly [latitude: number, longitude: number];

// These region names come from the stack's Synthetic Monitoring API URL.
// For example, eu-west-2 means Frankfurt here. The coordinates only need to
// be close enough to choose nearby probes.
// https://grafana.com/docs/grafana-cloud/observe-and-act/testing/synthetic-monitoring/set-up/set-up-private-probes/#probe-api-server-url
const BACKEND_LOCATIONS: Record<string, Location> = {
  "": [41.26, -95.86], // GCP US Central uses synthetic-monitoring-api.grafana.net, with no region in the name
  "us-central2": [41.26, -93.62], // Older Azure URL, still in use
  "us-central-7": [41.26, -93.62],
  "us-east-0": [40.42, -82.91],
  "us-east-1": [33.2, -80.01],
  "us-east-3": [38.13, -78.45],
  "us-west-0": [43.8, -120.55],
  "ca-east-0": [45.5, -73.57],
  "sa-east-0": [-23.53, -46.79],
  "sa-east-1": [-23.56, -46.64],
  "eu-west": [50.47, 3.82],
  "eu-west-2": [50.11, 8.68],
  "eu-west-3": [52.37, 4.9],
  "eu-west-6": [53.35, -6.26],
  "eu-north-0": [59.33, 18.07],
  "eu-central-0": [47.36, 8.54],
  "gb-south": [51.51, -0.13],
  "gb-south-1": [51.51, -0.13],
  "me-central-0": [26.43, 50.09],
  "me-central-1": [25.11, 55.17],
  "ap-south-0": [19.08, 72.88],
  "ap-south-1": [19.08, 72.88],
  "ap-northeast-0": [35.68, 139.65],
  "ap-southeast-0": [1.34, 103.71],
  "ap-southeast-1": [1.35, 103.82],
  "ap-southeast-2": [-6.21, 106.85],
  "au-southeast": [-33.87, 151.21],
  "au-southeast-1": [-33.87, 151.21],
};

function stackLocation(apiUrl?: string): Location | undefined {
  if (!apiUrl) return undefined;
  try {
    const match = /^synthetic-monitoring-api(?:-([a-z0-9-]+))?\.grafana\.net$/.exec(new URL(apiUrl).hostname);
    return match ? BACKEND_LOCATIONS[match[1] ?? ""] : undefined;
  } catch {
    return undefined;
  }
}

// Smaller values mean closer probes. We only compare distances, so there
// is no need to convert the result to kilometres.
function distance(probe: Probe, origin: Location): number {
  const { latitude, longitude } = probe;
  if (
    latitude === undefined ||
    longitude === undefined ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    (latitude === 0 && longitude === 0)
  )
    return Infinity;
  const radians = Math.PI / 180;
  return (
    Math.sin(((latitude - origin[0]) * radians) / 2) ** 2 +
    Math.cos(origin[0] * radians) *
      Math.cos(latitude * radians) *
      Math.sin(((longitude - origin[1]) * radians) / 2) ** 2
  );
}

// Pick the nearest probe from each region before picking a second from any region.
// A one-probe check uses the first probe, and a three-probe check uses the first three.
// Use probe IDs to break ties or when locations are missing, so the result
// doesn't depend on the order the API returns.
export function orderProbes(probes: Probe[], apiUrl?: string): Probe[] {
  const origin = stackLocation(apiUrl);
  const ranked = [...probes].sort((a, b) => {
    const delta = origin ? distance(a, origin) - distance(b, origin) : 0;
    return delta || a.id - b.id;
  });
  const regions = new Map<string, Probe[]>();
  for (const probe of ranked) {
    const region = probe.region?.trim().toUpperCase() || "";
    const group = regions.get(region) ?? [];
    group.push(probe);
    regions.set(region, group);
  }
  const ordered: Probe[] = [];
  // Put probes without a region last. We can still use them if there aren't
  // enough probes with known regions.
  const unknown = regions.get("") ?? [];
  regions.delete("");
  for (let round = 0; ordered.length < ranked.length - unknown.length; round++) {
    for (const group of regions.values()) {
      const probe = group[round];
      if (probe) ordered.push(probe);
    }
  }
  return [...ordered, ...unknown];
}
