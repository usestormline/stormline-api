export type GeopoliticalCandidate = {
  title: string;
  publishedAt: Date;
  source: string;
};

export type ConflictRecord = {
  eventId: string;
  eventDate: string;
  eventType: string;
  subEventType: string | null;
  actors: string[];
  location: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
  fatalities: number;
  notes: string | null;
};

const STOP_WORDS = new Set([
  "about", "after", "against", "amid", "from", "into", "near", "over",
  "that", "their", "this", "with", "says", "report", "reports",
]);

const GENERIC_EVENT_WORDS = new Set([
  "airstrike", "attack", "attacks", "battle", "clashes", "conflict",
  "civilians", "coup", "dead", "deadly", "death", "deaths", "elsewhere",
  "forces", "government", "killed", "kills",
  "military", "missile", "police", "protest", "protests", "sanctions",
  "overnight", "people", "reported", "strike", "strikes", "troops", "violence",
]);

const GENERIC_ACTOR_WORDS = new Set([
  ...GENERIC_EVENT_WORDS,
  "armed", "civilians", "demonstrators", "militia", "protesters",
]);

const TERM_ALIASES = new Map([
  ["israeli", "israel"],
  ["lebanese", "lebanon"],
  ["palestinian", "palestine"],
  ["russian", "russia"],
  ["ukrainian", "ukraine"],
]);

function normalizedTerms(value: string) {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length >= 4 && !STOP_WORDS.has(term))
    .map((term) => TERM_ALIASES.get(term) ?? term);
}

function termSet(value: string) {
  return new Set(normalizedTerms(value));
}

function overlapCount(left: Set<string>, right: Set<string>) {
  return [...left].filter((term) => right.has(term)).length;
}

export function geopoliticalSimilarity(left: string, right: string) {
  const leftTerms = termSet(left);
  const rightTerms = termSet(right);
  if (!leftTerms.size || !rightTerms.size) return 0;
  return overlapCount(leftTerms, rightTerms) / Math.min(leftTerms.size, rightTerms.size);
}

function explicitTerms(value: string, excluded: Set<string>) {
  return new Set(normalizedTerms(value).filter((term) => !excluded.has(term)));
}

const GENERIC_GEOGRAPHY_WORDS = new Set([
  ...GENERIC_EVENT_WORDS,
  "city", "district", "province", "region", "state", "town", "village",
]);

function hasLocationEvidence(title: string, record: ConflictRecord) {
  const titleTerms = termSet(title);
  const locationTerms = explicitTerms(record.location, GENERIC_GEOGRAPHY_WORDS);
  return locationTerms.size > 0 && overlapCount(titleTerms, locationTerms) >= 1;
}

function hasActorEvidence(title: string, record: ConflictRecord) {
  const titleTerms = termSet(title);
  const actorTerms = explicitTerms(record.actors.join(" "), GENERIC_ACTOR_WORDS);
  return overlapCount(titleTerms, actorTerms) >= 1;
}

function hasDistinctiveDetailEvidence(title: string, record: ConflictRecord) {
  if (!record.notes) return false;
  const titleTerms = termSet(title);
  const identityTerms = termSet(
    `${record.location} ${record.country} ${record.actors.join(" ")}`,
  );
  const detailTerms = explicitTerms(record.notes, new Set([
    ...GENERIC_ACTOR_WORDS,
    ...GENERIC_GEOGRAPHY_WORDS,
    ...identityTerms,
  ]));
  return detailTerms.size > 0 && overlapCount(titleTerms, detailTerms) >= 1;
}

export function matchConflictRecord(
  candidate: GeopoliticalCandidate,
  records: readonly ConflictRecord[],
) {
  const candidateDay = Date.UTC(
    candidate.publishedAt.getUTCFullYear(),
    candidate.publishedAt.getUTCMonth(),
    candidate.publishedAt.getUTCDate(),
  );
  let winner: { record: ConflictRecord; score: number } | null = null;

  for (const record of records) {
    const recordDay = new Date(`${record.eventDate}T00:00:00Z`).getTime();
    if (!Number.isFinite(recordDay) || candidateDay !== recordDay) {
      continue;
    }
    const locationEvidence = hasLocationEvidence(candidate.title, record);
    const actorEvidence = hasActorEvidence(candidate.title, record);
    const detailEvidence = hasDistinctiveDetailEvidence(candidate.title, record);
    if (!locationEvidence || !actorEvidence || !detailEvidence) continue;

    const descriptiveText = [record.notes, record.location, record.country, ...record.actors]
      .filter((value): value is string => Boolean(value))
      .join(" ");
    const score = geopoliticalSimilarity(candidate.title, descriptiveText);
    if (score >= 0.5 && (!winner || score > winner.score)) {
      winner = { record, score };
    }
  }
  return winner?.record ?? null;
}

export function assessGeopoliticalCorroboration(
  story: GeopoliticalCandidate,
  records: readonly ConflictRecord[],
) {
  const conflict = matchConflictRecord(story, records);
  return {
    verification: conflict
      ? ("structured_confirmation" as const)
      : ("single_source" as const),
    independentSourceCount: 1,
    corroboratingSources: conflict ? [story.source, "ACLED"] : [story.source],
    conflict,
  };
}