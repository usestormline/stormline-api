import { createHash } from "node:crypto";
import { Router, type IRouter } from "express";
import {
  GetEconomicCalendarQueryParams,
  GetEconomicCalendarResponse,
} from "@usestormline/api-zod-internal";
import {
  enrichCalendarEvents,
  normalizeStormRating,
  persistAndTagCalendarEvents,
} from "../lib/event-tagging";
import { logger } from "../lib/logger";
import { fmpCalendarCountryLocation } from "../lib/verified-geography";

const router: IRouter = Router();
const PROVIDER_URL = "https://financialmodelingprep.com/stable/economic-calendar";
const FEDERAL_REGISTER_URL = "https://www.federalregister.gov/api/v1/documents.json";
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_RANGE_MS = 14 * 24 * 60 * 60 * 1000;
const POLICY_LOOKBACK_DAYS = 180;
const CORE_MARKETS = new Set(["US", "CN", "EU", "DE", "JP", "UK"]);
const SECTOR_MARKETS = new Set(["CA", "AU", "CH", "TW", "KR", "IN", "SA"]);
const AGENCIES = [
  "securities-and-exchange-commission",
  "commodity-futures-trading-commission",
  "federal-reserve-system",
  "foreign-assets-control-office",
] as const;
const FEDERAL_REGISTER_FIELDS = [
  "document_number",
  "title",
  "abstract",
  "html_url",
  "publication_date",
  "effective_on",
  "type",
  "agencies",
] as const;
const RELEVANCE =
  /\b(crypto(?:currency|asset)?s?|digital assets?|virtual currenc(?:y|ies)|stablecoins?|blockchain|distributed ledger|securities?|broker(?:-dealer)?s?|exchanges?|bank(?:ing|s)?|financial institutions?|capital markets?|derivatives?|commodit(?:y|ies)|sanctions?|special(?:ly)? designated|blocked persons?|money laundering|terroris[mt] financing|payment systems?|custod(?:y|ial)|tokeni[sz](?:e|ed|ation))\b/i;
const SANCTIONS = /\b(sanctions?|blocked persons?|special(?:ly)? designated|OFAC)\b/i;

type ProviderEvent = Record<string, unknown>;
type FederalRegisterDocument = Record<string, unknown>;
type CachedResponse = {
  expiresAt: number;
  payload: ReturnType<typeof GetEconomicCalendarResponse.parse>;
};

const cache = new Map<string, CachedResponse>();
const inFlight = new Map<
  string,
  Promise<ReturnType<typeof GetEconomicCalendarResponse.parse>>
>();

function parseDateQuery(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function asNullableText(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asSourceUrl(value: unknown) {
  const text = asNullableText(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeEvent(event: ProviderEvent) {
  const title = asNullableText(event.event);
  const countryCode = asNullableText(event.country)?.toUpperCase();
  const date = asNullableText(event.date);
  if (!title || !countryCode || !date) return null;

  const parsedDate = new Date(date.includes("T") ? date : `${date.replace(" ", "T")}Z`);
  if (Number.isNaN(parsedDate.getTime())) return null;

  const impact = asNullableText(event.impact)?.toLowerCase();
  const importance =
    impact === "high" ? 3 : impact === "medium" ? 2 : impact === "low" ? 1 : 0;
  const id = createHash("sha256")
    .update(`${countryCode}:${parsedDate.toISOString()}:${title}`)
    .digest("hex")
    .slice(0, 20);

  return {
    id,
    title,
    countryCode: countryCode.slice(0, 3),
    date: parsedDate,
    // Importance and the initial storm rating intentionally share the
    // provider's LOW/MEDIUM/HIGH mapping. Persistence clamps this to 1-3.
    importance: normalizeStormRating(impact, importance),
    actual: asNullableText(event.actual),
    previous: asNullableText(event.previous),
    forecast: asNullableText(event.estimate),
    period: null,
    source: "Financial Modeling Prep",
    sourceUrl: asSourceUrl(
      "https://site.financialmodelingprep.com/developer/docs/stable/economics-calendar",
    ),
    unit: asNullableText(event.unit),
    currency: asNullableText(event.currency),
    category: "Macro" as const,
    agency: null,
    publicationDate: null,
    effectiveDate: null,
    verificationType: "provider-calendar" as const,
    lastUpdated: new Date(),
    stormRating: normalizeStormRating(impact, importance),
    ratingConfirmed: false,
    needsTagging: true,
    affectedAssets: [],
    locations: [fmpCalendarCountryLocation(countryCode)],
  };
}

function parseDate(value: unknown) {
  const text = asNullableText(value);
  if (!text || !/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
  const date = new Date(`${text.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function fetchMarketEvents(fromText: string, toText: string) {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    throw new Error("FMP_API_KEY is not configured");
  }

  const url = new URL(PROVIDER_URL);
  url.searchParams.set("from", fromText);
  url.searchParams.set("to", toText);
  url.searchParams.set("apikey", apiKey);

  const providerResponse = await fetch(url, {
    signal: AbortSignal.timeout(8_000),
  });

  if (!providerResponse.ok) {
    throw new Error(`Provider returned ${providerResponse.status}`);
  }

  const providerBody = (await providerResponse.json()) as unknown;
  if (!Array.isArray(providerBody)) {
    throw new Error("Provider returned an invalid response");
  }

  const events = providerBody
    .map((event) =>
      event && typeof event === "object"
        ? normalizeEvent(event as ProviderEvent)
        : null,
    )
    .filter(
      (event): event is NonNullable<typeof event> =>
        event !== null &&
        ((CORE_MARKETS.has(event.countryCode) && event.importance >= 2) ||
          (SECTOR_MARKETS.has(event.countryCode) && event.importance >= 3)),
    )
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  return GetEconomicCalendarResponse.parse({
    provider: "Financial Modeling Prep",
    status: "live",
    asOf: new Date(),
    timezone: "UTC",
    events,
  });
}

function normalizePolicyEvent(
  document: FederalRegisterDocument,
  from: Date,
  to: Date,
) {
  const title = asNullableText(document.title);
  const abstract = asNullableText(document.abstract);
  const sourceUrl = asSourceUrl(document.html_url);
  const publicationDate = parseDate(document.publication_date);
  const effectiveDate = parseDate(document.effective_on);
  const agencies = Array.isArray(document.agencies) ? document.agencies : [];
  const agency =
    agencies
      .map((item) =>
        item && typeof item === "object"
          ? asNullableText((item as Record<string, unknown>).name)
          : null,
      )
      .filter((name): name is string => Boolean(name))
      .join(", ") || null;

  if (!title || !sourceUrl || !publicationDate || !agency) return null;
  if (!RELEVANCE.test(`${title} ${abstract ?? ""}`)) return null;

  const end = new Date(to);
  end.setUTCHours(23, 59, 59, 999);
  const effectiveInRange =
    effectiveDate !== null && effectiveDate >= from && effectiveDate <= end;
  const publicationInRange = publicationDate >= from && publicationDate <= end;
  if (!effectiveInRange && !publicationInRange) return null;

  const date = effectiveInRange ? effectiveDate : publicationDate;
  const category = SANCTIONS.test(`${agency} ${title} ${abstract ?? ""}`)
    ? ("Sanctions" as const)
    : ("Policy & Regulation" as const);
  const documentNumber = asNullableText(document.document_number);
  const id = createHash("sha256")
    .update(documentNumber ?? `${agency}:${title}:${publicationDate.toISOString()}`)
    .digest("hex")
    .slice(0, 20);

  return {
    id,
    title,
    countryCode: "US",
    date,
    importance: category === "Sanctions" ? 3 : 2,
    actual: null,
    previous: null,
    forecast: null,
    period: asNullableText(document.type),
    source: "Federal Register",
    sourceUrl,
    unit: null,
    currency: null,
    category,
    agency,
    publicationDate: publicationDate.toISOString().slice(0, 10),
    effectiveDate: effectiveDate?.toISOString().slice(0, 10) ?? null,
    verificationType: effectiveInRange
      ? ("official-effective-date" as const)
      : ("official-publication" as const),
    lastUpdated: new Date(),
    stormRating: category === "Sanctions" ? 3 : 2,
    ratingConfirmed: false,
    needsTagging: true,
    affectedAssets: [],
    locations: [],
  };
}

async function fetchOfficialPolicyEvents(from: Date, to: Date) {
  const earliest = new Date(from);
  earliest.setUTCDate(earliest.getUTCDate() - POLICY_LOOKBACK_DAYS);
  const url = new URL(FEDERAL_REGISTER_URL);
  url.searchParams.set("per_page", "100");
  url.searchParams.set("order", "newest");
  url.searchParams.set(
    "conditions[publication_date][gte]",
    earliest.toISOString().slice(0, 10),
  );
  url.searchParams.set(
    "conditions[publication_date][lte]",
    to.toISOString().slice(0, 10),
  );
  for (const agency of AGENCIES) {
    url.searchParams.append("conditions[agencies][]", agency);
  }
  for (const field of FEDERAL_REGISTER_FIELDS) {
    url.searchParams.append("fields[]", field);
  }

  const documents: unknown[] = [];
  let nextUrl: string | null = url.toString();
  let pageCount = 0;
  while (nextUrl && pageCount < 10) {
    const response = await fetch(nextUrl, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Federal Register returned ${response.status}`);
    }
    const body = (await response.json()) as Record<string, unknown>;
    if (!Array.isArray(body.results)) {
      throw new Error("Federal Register returned an invalid response");
    }
    documents.push(...body.results);
    nextUrl = asSourceUrl(body.next_page_url);
    pageCount += 1;
  }
  if (nextUrl) {
    logger.warn(
      {
        operation: "federal-register-ingestion",
        pageCount,
        documentCount: documents.length,
      },
      "Federal Register ingestion reached its page safety limit; using collected documents",
    );
  }

  return documents
    .map((document) =>
      document && typeof document === "object"
        ? normalizePolicyEvent(document as FederalRegisterDocument, from, to)
        : null,
    )
    .filter(
      (event): event is NonNullable<typeof event> => event !== null,
    );
}

async function fetchCombinedMarketEvents(fromText: string, toText: string) {
  const from = new Date(`${fromText}T00:00:00.000Z`);
  const to = new Date(`${toText}T00:00:00.000Z`);
  const [macroResult, policyResult] = await Promise.allSettled([
    fetchMarketEvents(fromText, toText),
    fetchOfficialPolicyEvents(from, to),
  ]);
  if (macroResult.status === "rejected") {
    logger.warn(
      {
        operation: "fmp-calendar-ingestion",
        error:
          macroResult.reason instanceof Error
            ? macroResult.reason.message
            : "Unknown provider error",
      },
      "Financial Modeling Prep calendar ingestion failed",
    );
  }
  if (policyResult.status === "rejected") {
    logger.warn(
      {
        operation: "federal-register-ingestion",
        error:
          policyResult.reason instanceof Error
            ? policyResult.reason.message
            : "Unknown provider error",
      },
      "Federal Register ingestion failed",
    );
  }
  if (macroResult.status === "rejected" && policyResult.status === "rejected") {
    throw new Error("All calendar providers are unavailable");
  }

  const macroEvents =
    macroResult.status === "fulfilled" ? macroResult.value.events : [];
  const policyEvents =
    policyResult.status === "fulfilled" ? policyResult.value : [];
  const deduplicated = new Map<
    string,
    (typeof macroEvents)[number] | (typeof policyEvents)[number]
  >();
  for (const event of [...macroEvents, ...policyEvents]) {
    const key = `${event.category}:${event.date.toISOString().slice(0, 10)}:${event.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()}`;
    if (!deduplicated.has(key)) deduplicated.set(key, event);
  }

  const response = GetEconomicCalendarResponse.parse({
    provider:
      macroResult.status === "fulfilled" && policyResult.status === "fulfilled"
        ? "Financial Modeling Prep + Federal Register"
        : macroResult.status === "fulfilled"
          ? "Financial Modeling Prep (official publications unavailable)"
          : "Federal Register (macro releases unavailable)",
    status: "live",
    asOf: new Date(),
    timezone: "UTC",
    events: [...deduplicated.values()].sort(
      (a, b) => a.date.getTime() - b.date.getTime(),
    ),
  });
  try {
    await persistAndTagCalendarEvents(response.events);
  } catch (error) {
    // Provider data remains useful when persistence is unavailable. The next
    // cache miss will retry the write and tagging operation.
    logger.warn(
      {
        operation: "economic-calendar-persistence",
        error: error instanceof Error ? error.message : "Unknown database error",
      },
      "Economic calendar persistence failed",
    );
  }

  return GetEconomicCalendarResponse.parse({
    ...response,
    events: await enrichCalendarEvents(response.events),
  });
}

router.get("/calendar/events", async (req, res): Promise<void> => {
  const from = parseDateQuery(req.query.from);
  const to = parseDateQuery(req.query.to);
  const parsed = GetEconomicCalendarQueryParams.safeParse({ from, to });

  if (
    !parsed.success ||
    parsed.data.to < parsed.data.from ||
    parsed.data.to.getTime() - parsed.data.from.getTime() > MAX_RANGE_MS
  ) {
    res.status(400).json({ error: "Use a valid date range of 14 days or less" });
    return;
  }

  const fromText = parsed.data.from.toISOString().slice(0, 10);
  const toText = parsed.data.to.toISOString().slice(0, 10);
  const cacheKey = `${fromText}:${toText}`;
  const cached = cache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    res.json(
      GetEconomicCalendarResponse.parse({
        ...cached.payload,
        status: "cached",
      }),
    );
    return;
  }

  try {
    let request = inFlight.get(cacheKey);
    const joinedExistingRequest = Boolean(request);
    if (!request) {
      request = fetchCombinedMarketEvents(fromText, toText);
      inFlight.set(cacheKey, request);
    }

    const payload = await request;

    cache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      payload,
    });
    if (!joinedExistingRequest) {
      req.log.info(
        { operation: "economic-calendar-sync", eventCount: payload.events.length },
        "Market calendar synchronized",
      );
    }
    res.json({
      ...payload,
      status: joinedExistingRequest ? "cached" : payload.status,
    });
  } catch (error) {
    req.log.error(
      {
        operation: "economic-calendar-sync",
        error: error instanceof Error ? error.message : "Unknown provider error",
      },
      "Economic calendar provider failed",
    );

    if (cached) {
      res.json(
        GetEconomicCalendarResponse.parse({
          ...cached.payload,
          status: "cached",
        }),
      );
      return;
    }

    res.status(502).json({ error: "Economic calendar is temporarily unavailable" });
  } finally {
    const pending = inFlight.get(cacheKey);
    if (pending) {
      inFlight.delete(cacheKey);
    }
  }
});

export default router;
