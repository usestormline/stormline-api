export type VerifiedLocation = {
  country: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  source: string;
};

type UsgsFeature = {
  id?: unknown;
  properties?: unknown;
  geometry?: unknown;
};

export type UsgsIncident = {
  providerId: string;
  title: string;
  summary: string | null;
  publishedAt: Date;
  sourceUrl: string;
  location: VerifiedLocation;
};

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeUrl(value: unknown) {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function coordinate(value: unknown, min: number, max: number) {
  const parsed = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

export function verifiedLocationsFromProvider(
  record: Record<string, unknown>,
  provider: string,
): VerifiedLocation[] {
  // FMP press releases and Finnhub news do not define incident geography.
  // Only this explicitly mapped ACLED record shape is authoritative here.
  if (provider !== "ACLED structured conflict metadata") return [];

  const latitude = coordinate(record.latitude, -90, 90);
  const longitude = coordinate(record.longitude, -180, 180);
  if (latitude === null || longitude === null) return [];

  return [{
    country: text(record.country),
    countryCode: null,
    region: null,
    city: text(record.city),
    latitude,
    longitude,
    source: provider,
  }];
}

export function fmpCalendarCountryLocation(countryCode: string): VerifiedLocation {
  const code = countryCode.trim().toUpperCase().slice(0, 3);
  return {
    country: null,
    countryCode: code,
    region: null,
    city: null,
    latitude: null,
    longitude: null,
    source: "Financial Modeling Prep economic calendar country field",
  };
}

export function parseUsgsIncident(feature: UsgsFeature): UsgsIncident | null {
  if (
    !feature.properties ||
    typeof feature.properties !== "object" ||
    Array.isArray(feature.properties) ||
    !feature.geometry ||
    typeof feature.geometry !== "object" ||
    Array.isArray(feature.geometry)
  ) {
    return null;
  }

  const properties = feature.properties as Record<string, unknown>;
  const geometry = feature.geometry as Record<string, unknown>;
  const coordinates = Array.isArray(geometry.coordinates)
    ? geometry.coordinates
    : [];
  const longitude = coordinate(coordinates[0], -180, 180);
  const latitude = coordinate(coordinates[1], -90, 90);
  const providerId = text(feature.id);
  const title = text(properties.title);
  const sourceUrl = safeUrl(properties.url);
  const time = typeof properties.time === "number" ? new Date(properties.time) : null;

  if (
    geometry.type !== "Point" ||
    longitude === null ||
    latitude === null ||
    !providerId ||
    !title ||
    !sourceUrl ||
    !time ||
    Number.isNaN(time.getTime())
  ) {
    return null;
  }

  return {
    providerId,
    title,
    summary: text(properties.place),
    publishedAt: time,
    sourceUrl,
    location: {
      country: null,
      countryCode: null,
      region: text(properties.place),
      city: null,
      latitude,
      longitude,
      source: "USGS Earthquake Hazards Program GeoJSON geometry",
    },
  };
}