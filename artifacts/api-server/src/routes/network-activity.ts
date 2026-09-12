import { createHmac, timingSafeEqual } from "node:crypto";
import {
  Router,
  type IRouter,
  type Request,
} from "express";
import { and, count, countDistinct, eq, gte, lt } from "drizzle-orm";
import { db, networkActivityTable } from "@usestormline/db-internal";
import {
  GetNetworkStatisticsResponse,
  RecordNetworkActivityBody,
  RecordNetworkActivityResponse,
} from "@usestormline/api-zod-internal";

const router: IRouter = Router();
const MINIMUM_COHORT_SIZE = 3;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ALLOWED_EVENT_TYPES = {
  rule_evaluation: new Set(["rule_evaluated", "rule_triggered"]),
  activity: new Set([
    "rule_configured",
    "rule_removed",
    "shield_armed",
    "shield_disarmed",
  ]),
} as const;

function getActorHash(cohortKey: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET must be set");
  }

  return createHmac("sha256", secret).update(cohortKey).digest("hex");
}

function hasTrustedIngestKey(req: Request) {
  const secret = process.env.SESSION_SECRET;
  const supplied = req.get("x-stormline-ingest-key");
  if (!secret || !supplied) return false;

  const expectedBuffer = Buffer.from(secret);
  const suppliedBuffer = Buffer.from(supplied);
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

router.post("/network/activity", async (req, res): Promise<void> => {
  if (!hasTrustedIngestKey(req)) {
    res.status(403).json({ error: "Trusted ingestion required" });
    return;
  }

  const parsed = RecordNetworkActivityBody.strict().safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid network activity");
    res.status(400).json({ error: "Invalid activity event" });
    return;
  }

  if (!ALLOWED_EVENT_TYPES[parsed.data.kind].has(parsed.data.eventType)) {
    res.status(400).json({ error: "Event type does not match event kind" });
    return;
  }

  const occurredAt = parsed.data.occurredAt
    ? new Date(parsed.data.occurredAt)
    : new Date();
  const now = Date.now();
  if (
    occurredAt.getTime() > now + FIVE_MINUTES_MS ||
    occurredAt.getTime() < now - 7 * DAY_MS
  ) {
    res.status(400).json({ error: "Event timestamp is outside the accepted window" });
    return;
  }

  await db.insert(networkActivityTable).values({
    kind: parsed.data.kind,
    eventType: parsed.data.eventType,
    outcome: parsed.data.outcome ?? "not_applicable",
    actorHash: getActorHash(parsed.data.cohortKey),
    occurredAt,
  });

  res.status(202).json(RecordNetworkActivityResponse.parse({ accepted: true }));
});

async function aggregate(
  start: Date,
  end: Date,
  filters: { kind?: "rule_evaluation" | "activity"; eventType?: string } = {},
) {
  const conditions = [
    gte(networkActivityTable.occurredAt, start),
    lt(networkActivityTable.occurredAt, end),
  ];
  if (filters.kind) conditions.push(eq(networkActivityTable.kind, filters.kind));
  if (filters.eventType)
    conditions.push(eq(networkActivityTable.eventType, filters.eventType));

  const [result] = await db
    .select({
      eventCount: count(),
      cohortCount: countDistinct(networkActivityTable.actorHash),
    })
    .from(networkActivityTable)
    .where(and(...conditions));

  return {
    count:
      Number(result?.cohortCount ?? 0) >= MINIMUM_COHORT_SIZE
        ? Number(result?.eventCount ?? 0)
        : null,
    cohortCount: Number(result?.cohortCount ?? 0),
  };
}

router.get("/network/statistics", async (_req, res): Promise<void> => {
  const now = new Date();
  const delayedCutoff = new Date(now.getTime() - FIVE_MINUTES_MS);
  const historicalEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const [totalResult, liveEvaluations, delayedTriggers, delayedActivity, historicalCohorts] =
    await Promise.all([
      db.select({ totalEvents: count() }).from(networkActivityTable),
      aggregate(new Date(now.getTime() - 60 * 60 * 1000), now, {
        kind: "rule_evaluation",
      }),
      aggregate(new Date(delayedCutoff.getTime() - DAY_MS), delayedCutoff, {
        eventType: "rule_triggered",
      }),
      aggregate(new Date(delayedCutoff.getTime() - DAY_MS), delayedCutoff, {
        kind: "activity",
      }),
      aggregate(new Date(historicalEnd.getTime() - 30 * DAY_MS), historicalEnd),
    ]);

  const totalEvents = Number(totalResult[0]?.totalEvents ?? 0);
  const status =
    totalEvents === 0
      ? "empty"
      : liveEvaluations.cohortCount >= MINIMUM_COHORT_SIZE
        ? "live"
        : delayedTriggers.cohortCount >= MINIMUM_COHORT_SIZE ||
            delayedActivity.cohortCount >= MINIMUM_COHORT_SIZE
          ? "delayed"
          : historicalCohorts.cohortCount >= MINIMUM_COHORT_SIZE
            ? "historical"
            : "private";

  const response = {
    status,
    asOf: now,
    minimumCohortSize: MINIMUM_COHORT_SIZE,
    metrics: [
      {
        key: "rule_evaluations",
        label: "Rule evaluations",
        window: "Last 60 minutes",
        dataClass: "live",
        count: liveEvaluations.count,
        suppressed: liveEvaluations.count === null,
      },
      {
        key: "rule_triggers",
        label: "Rule triggers",
        window: "Previous 24 hours, delayed 5 minutes",
        dataClass: "delayed",
        count: delayedTriggers.count,
        suppressed: delayedTriggers.count === null,
      },
      {
        key: "activity_events",
        label: "Activity events",
        window: "Previous 24 hours, delayed 5 minutes",
        dataClass: "delayed",
        count: delayedActivity.count,
        suppressed: delayedActivity.count === null,
      },
      {
        key: "active_cohorts",
        label: "Active anonymous cohorts",
        window: "Previous 30 complete UTC days",
        dataClass: "historical",
        count:
          historicalCohorts.cohortCount >= MINIMUM_COHORT_SIZE
            ? historicalCohorts.cohortCount
            : null,
        suppressed: historicalCohorts.cohortCount < MINIMUM_COHORT_SIZE,
      },
    ],
  };

  res.json(GetNetworkStatisticsResponse.parse(response));
});

export default router;