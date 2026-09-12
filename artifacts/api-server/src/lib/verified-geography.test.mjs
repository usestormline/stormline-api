import assert from "node:assert/strict";
import test from "node:test";
import { GetIntelligenceNewsResponse } from "../../../../lib/api-zod/src/generated/api.ts";
import {
  fmpCalendarCountryLocation,
  parseUsgsIncident,
} from "./verified-geography.ts";

const usgsFixture = {
  id: "us7000test",
  properties: {
    title: "M 5.6 - 12 km SW of Test City",
    place: "12 km SW of Test City",
    time: 1_789_200_000_000,
    url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000test",
  },
  geometry: {
    type: "Point",
    coordinates: [142.125, 38.45, 22.4],
  },
};

test("parses an official USGS incident point with explicit provenance", () => {
  const incident = parseUsgsIncident(usgsFixture);
  assert.ok(incident);
  assert.equal(incident.location.latitude, 38.45);
  assert.equal(incident.location.longitude, 142.125);
  assert.equal(
    incident.location.source,
    "USGS Earthquake Hazards Program GeoJSON geometry",
  );
});

test("rejects partial, invalid, and non-point USGS geometry", () => {
  assert.equal(
    parseUsgsIncident({
      ...usgsFixture,
      geometry: { type: "Point", coordinates: [142.125] },
    }),
    null,
  );
  assert.equal(
    parseUsgsIncident({
      ...usgsFixture,
      geometry: { type: "Point", coordinates: [220, 38.45] },
    }),
    null,
  );
  assert.equal(
    parseUsgsIncident({
      ...usgsFixture,
      geometry: { type: "Polygon", coordinates: [142.125, 38.45] },
    }),
    null,
  );
});

test("calendar country metadata never invents coordinates", () => {
  assert.deepEqual(fmpCalendarCountryLocation("uk"), {
    country: null,
    countryCode: "UK",
    region: null,
    city: null,
    latitude: null,
    longitude: null,
    source: "Financial Modeling Prep economic calendar country field",
  });
});

test("one news item can expose multiple verified points without duplication", () => {
  const locations = [
    { ...parseUsgsIncident(usgsFixture).location },
    {
      ...parseUsgsIncident(usgsFixture).location,
      latitude: 39.1,
      longitude: 143.2,
    },
  ];
  const response = GetIntelligenceNewsResponse.parse({
    status: "live",
    asOf: new Date(),
    timezone: "UTC",
    providerStatuses: [{
      provider: "USGS",
      status: "live",
      itemCount: 1,
      access: "public",
      commercialUse: "permitted",
      termsUrl: "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits",
    }],
    items: [{
      id: "one-underlying-event",
      kind: "news",
      title: usgsFixture.properties.title,
      summary: usgsFixture.properties.place,
      publishedAt: new Date(usgsFixture.properties.time),
      source: "U.S. Geological Survey",
      sourceUrl: usgsFixture.properties.url,
      imageUrl: null,
      provider: "USGS",
      symbol: null,
      category: "Earthquake",
      verification: "official_incident_report",
      independentSourceCount: 1,
      corroboratingSources: ["U.S. Geological Survey"],
      conflictDetails: null,
      canonicalAsset: null,
      locations,
    }],
  });

  assert.equal(response.items.length, 1);
  assert.equal(response.items[0].locations.length, 2);
});