import test from "node:test";
import assert from "node:assert/strict";
import {
  assessGeopoliticalCorroboration,
  matchConflictRecord,
  type ConflictRecord,
} from "./geopolitical-matching";

const publishedAt = new Date("2026-09-12T12:00:00Z");

function conflict(overrides: Partial<ConflictRecord> = {}): ConflictRecord {
  return {
    eventId: "GZA-1",
    eventDate: "2026-09-12",
    eventType: "Explosions/Remote violence",
    subEventType: "Air/drone strike",
    actors: ["Military Forces of Israel"],
    location: "Gaza City",
    country: "Palestine",
    latitude: 31.5,
    longitude: 34.47,
    fatalities: 2,
    notes: "Israeli forces carried out an airstrike in Shujaiya, Gaza City.",
    ...overrides,
  };
}

test("matches ACLED only with explicit event location evidence", () => {
  const record = conflict();
  assert.equal(
    matchConflictRecord(
      { title: "Israeli airstrike hits Shujaiya in Gaza City", publishedAt, source: "news.example" },
      [record],
    )?.eventId,
    record.eventId,
  );
  assert.equal(
    matchConflictRecord(
      { title: "Deadly airstrike reported overnight", publishedAt, source: "israeli-publisher.example" },
      [record],
    ),
    null,
  );
});

test("does not match a similar ACLED event in another country", () => {
  assert.equal(
    matchConflictRecord(
      { title: "Missile attack strikes Kyiv Ukraine", publishedAt, source: "news.example" },
      [
        conflict({
          eventId: "LBN-1",
          location: "Beirut",
          country: "Lebanon",
          actors: ["Military Forces of Israel"],
          notes: "Israeli forces launched a missile attack in Beirut.",
        }),
      ],
    ),
    null,
  );
});

test("does not match the same actor at a different explicit location", () => {
  assert.equal(
    matchConflictRecord(
      {
        title: "Israeli airstrike hits Beirut Lebanon overnight",
        publishedAt,
        source: "news.example",
      },
      [conflict()],
    ),
    null,
  );
});

test("does not match repeated same-city events without the same distinctive detail", () => {
  assert.equal(
    matchConflictRecord(
      {
        title: "Israeli airstrike hits Zeitoun in Gaza City",
        publishedAt,
        source: "news.example",
      },
      [conflict()],
    ),
    null,
  );
});

test("does not match a record from a different day", () => {
  assert.equal(
    matchConflictRecord(
      {
        title: "Israeli airstrike hits Shujaiya in Gaza City",
        publishedAt,
        source: "news.example",
      },
      [conflict({ eventDate: "2026-09-11" })],
    ),
    null,
  );
});

test("keeps independent reports separate from ACLED corroboration", () => {
  const assessment = assessGeopoliticalCorroboration(
    {
      title: "Israeli airstrike hits Shujaiya in Gaza City",
      publishedAt,
      source: "publisher-a.example",
    },
    [conflict()],
  );
  assert.equal(assessment.verification, "structured_confirmation");
  assert.equal(assessment.independentSourceCount, 1);
  assert.deepEqual(assessment.corroboratingSources, ["publisher-a.example", "ACLED"]);
  assert.equal(assessment.conflict?.eventId, "GZA-1");
});

test("never infers independent reporting from publisher domains", () => {
  const assessment = assessGeopoliticalCorroboration(
    {
      title: "Israeli airstrike hits Gaza City overnight",
      publishedAt,
      source: "publisher-a.example",
    },
    [],
  );
  assert.equal(assessment.verification, "single_source");
  assert.equal(assessment.independentSourceCount, 1);
  assert.deepEqual(assessment.corroboratingSources, ["publisher-a.example"]);
  assert.equal(assessment.conflict, null);
});