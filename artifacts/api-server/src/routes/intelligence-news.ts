import { createHash } from "node:crypto";
import { Router, type IRouter } from "express";
import {
  GetIntelligenceNewsQueryParams,
  GetIntelligenceNewsResponse,
} from "@usestormline/api-zod-internal";
import { getCanonicalAssets } from "../lib/stock-token-registry";
import {
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_EXPLORER_URL,
} from "../lib/stock-token-config";
import {
  assessGeopoliticalCorroboration,
  type ConflictRecord,
} from "../lib/geopolitical-matching";
import {
  parseUsgsIncident,
  verifiedLocationsFromProvider,
} from "../lib/verified-geography";
const router: IRouter = Router();
const FMP_URL =
  "https://financialmodelingprep.com/stable/news/press-releases-latest";
const FMP_SYMBOL_URL =
  "https://financialmodelingprep.com/stable/news/press-releases";
const FINNHUB_MARKET_URL = "https://finnhub.io/api/v1/news";
const FINNHUB_COMPANY_URL = "https://finnhub.io/api/v1/company-news";
const USGS_URL = "https://earthquake.usgs.gov/fdsnws/event/1/query";
const GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc";
const ACLED_URL = "https://api.acleddata.com/acled/read";
const CACHE_TTL_MS = 5 * 60 * 1000;

type ProviderRecord = Record<string, unknown>;
type FeedItem = ReturnType<
  typeof GetIntelligenceNewsResponse.parse
>["items"][number];
type FeedResponse = ReturnType<typeof GetIntelligenceNewsResponse.parse>;
type CanonicalAsset = Awaited<ReturnType<typeof getCanonicalAssets>>[number];

const cache = new Map<string, { expiresAt: number; payload: FeedResponse }>();
const inFlight = new Map<string, Promise<FeedResponse>>();

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeUrl(value: unknown) {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function parseDate(value: unknown) {
  const date =
    typeof value === "number"
      ? new Date(value * 1_000)
      : typeof value === "string"
        ? new Date(value.includes("T") ? value : value.replace(" ", "T"))
        : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function normalizedSymbol(value: unknown) {
  return text(value)?.toUpperCase().replace(/[^A-Z0-9.-]/g, "") || null;
}

function canonicalAssetFor(
  symbol: string | null,
  assetsBySymbol: Map<string, CanonicalAsset>,
) {
  if (!symbol) return null;
  const asset = assetsBySymbol.get(symbol);
  if (!asset) return null;
  return {
    symbol: asset.symbol,
    name: asset.name,
    contractAddress: asset.address,
    chainId: 4663 as const,
    explorerUrl: `${ROBINHOOD_EXPLORER_URL}/token/${asset.address}`,
  };
}

function stableId(provider: string, sourceUrl: string, title: string) {
  return createHash("sha256")
    .update(`${provider}:${sourceUrl}:${title}`)
    .digest("hex")
    .slice(0, 20);
}

async function fetchJsonArray(url: URL) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`Provider returned ${response.status}`);
  }
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) {
    throw new Error("Provider returned an invalid response");
  }
  return body.filter(
    (item): item is ProviderRecord =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}

async function fetchJsonObject(url: URL, headers?: Record<string, string>) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Provider returned ${response.status}`);
  const body = (await response.json()) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Provider returned an invalid response");
  }
  return body as ProviderRecord;
}

async function fetchPressReleases(
  limit: number,
  symbol: string | undefined,
  assetsBySymbol: Map<string, CanonicalAsset>,
) {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) throw new Error("FMP_API_KEY is not configured");

  const url = new URL(symbol ? FMP_SYMBOL_URL : FMP_URL);
  url.searchParams.set("page", "0");
  url.searchParams.set("limit", String(Math.max(limit, 50)));
  if (symbol) url.searchParams.set("symbols", symbol);
  url.searchParams.set("apikey", apiKey);
  const records = await fetchJsonArray(url);

  return records.flatMap((record): FeedItem[] => {
    const title = text(record.title);
    const sourceUrl = safeUrl(record.url);
    const publishedAt = parseDate(record.publishedDate);
    const itemSymbol = normalizedSymbol(record.symbol);
    if (
      !title ||
      !sourceUrl ||
      !publishedAt ||
      (symbol && itemSymbol !== symbol)
    ) {
      return [];
    }
    return [
      {
        id: stableId("fmp", sourceUrl, title),
        kind: "press_release",
        title,
        summary: text(record.text)?.slice(0, 2_000) ?? null,
        publishedAt,
        source: text(record.publisher) ?? text(record.site) ?? "Company release",
        sourceUrl,
        imageUrl: safeUrl(record.image),
        provider: "Financial Modeling Prep",
        symbol: itemSymbol,
        category: "Company press release",
        verification: "official_company_release",
        independentSourceCount: 1,
        corroboratingSources: [text(record.publisher) ?? text(record.site) ?? "Company release"],
        conflictDetails: null,
        canonicalAsset: canonicalAssetFor(itemSymbol, assetsBySymbol),
        locations: verifiedLocationsFromProvider(
          record,
          "Financial Modeling Prep press release",
        ),
      },
    ];
  });
}

async function fetchFinnhubNews(
  symbol: string | undefined,
  assetsBySymbol: Map<string, CanonicalAsset>,
) {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) throw new Error("FINNHUB_API_KEY is not configured");

  const url = new URL(symbol ? FINNHUB_COMPANY_URL : FINNHUB_MARKET_URL);
  if (symbol) {
    const to = new Date();
    const from = new Date(to);
    from.setUTCDate(from.getUTCDate() - 14);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("from", from.toISOString().slice(0, 10));
    url.searchParams.set("to", to.toISOString().slice(0, 10));
  } else {
    url.searchParams.set("category", "general");
  }
  url.searchParams.set("token", apiKey);
  const records = await fetchJsonArray(url);

  return records.flatMap((record): FeedItem[] => {
    const title = text(record.headline);
    const sourceUrl = safeUrl(record.url);
    const publishedAt = parseDate(record.datetime);
    const related = normalizedSymbol(record.related);
    const itemSymbol = symbol ?? related;
    if (!title || !sourceUrl || !publishedAt) return [];
    return [
      {
        id: stableId("finnhub", sourceUrl, title),
        kind: "news",
        title,
        summary: text(record.summary)?.slice(0, 1_200) ?? null,
        publishedAt,
        source: text(record.source) ?? "News source",
        sourceUrl,
        imageUrl: safeUrl(record.image),
        provider: "Finnhub",
        symbol: itemSymbol ?? null,
        category: text(record.category),
        verification: "reported",
        independentSourceCount: 1,
        corroboratingSources: [text(record.source) ?? "News source"],
        conflictDetails: null,
        canonicalAsset: canonicalAssetFor(itemSymbol ?? null, assetsBySymbol),
        locations: verifiedLocationsFromProvider(record, "Finnhub news"),
      },
    ];
  });
}

async function fetchUsgsIncidents(limit: number) {
  const url = new URL(USGS_URL);
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 7);
  url.searchParams.set("format", "geojson");
  url.searchParams.set("starttime", start.toISOString());
  url.searchParams.set("minmagnitude", "4.5");
  url.searchParams.set("orderby", "time");
  url.searchParams.set("limit", String(Math.min(limit, 100)));

  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`USGS returned ${response.status}`);
  const body = (await response.json()) as Record<string, unknown>;
  if (!Array.isArray(body.features)) {
    throw new Error("USGS returned an invalid response");
  }

  return body.features.flatMap((value): FeedItem[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const incident = parseUsgsIncident(value);
    if (!incident) return [];
    return [{
      id: stableId("usgs", incident.sourceUrl, incident.providerId),
      kind: "news",
      title: incident.title,
      summary: incident.summary,
      publishedAt: incident.publishedAt,
      source: "U.S. Geological Survey",
      sourceUrl: incident.sourceUrl,
      imageUrl: null,
      provider: "USGS",
      symbol: null,
      category: "Earthquake",
      verification: "official_incident_report",
      independentSourceCount: 1,
      corroboratingSources: ["U.S. Geological Survey"],
      conflictDetails: null,
      canonicalAsset: null,
      locations: [incident.location],
    }];
  });
}

type GeopoliticalStory = {
  title: string;
  sourceUrl: string;
  publishedAt: Date;
  source: string;
  imageUrl: string | null;
};

function parseGdeltDate(value: unknown) {
  const candidate = text(value);
  if (!candidate) return null;
  const compact = candidate.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return compact
    ? parseDate(`${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z`)
    : parseDate(candidate);
}

async function fetchGdeltStories(limit: number) {
  const url = new URL(GDELT_DOC_URL);
  url.searchParams.set(
    "query",
    '(conflict OR attack OR missile OR airstrike OR invasion OR protest OR coup OR sanctions) sourcelang:english',
  );
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("format", "json");
  url.searchParams.set("sort", "datedesc");
  url.searchParams.set("maxrecords", String(Math.min(250, Math.max(limit * 3, 75))));
  url.searchParams.set("timespan", "48h");
  const body = await fetchJsonObject(url);
  const articles = Array.isArray(body.articles) ? body.articles : [];
  return articles.flatMap((raw): GeopoliticalStory[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const record = raw as ProviderRecord;
    const title = text(record.title);
    const sourceUrl = safeUrl(record.url);
    const publishedAt = parseGdeltDate(record.seendate);
    if (!title || !sourceUrl || !publishedAt) return [];
    let hostname: string;
    try {
      hostname = new URL(sourceUrl).hostname.replace(/^www\./, "");
    } catch {
      return [];
    }
    return [{
      title,
      sourceUrl,
      publishedAt,
      source: text(record.domain) ?? hostname,
      imageUrl: safeUrl(record.socialimage),
    }];
  });
}

function numeric(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(text(value));
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchAcledRecords(): Promise<ConflictRecord[]> {
  const accessToken = process.env.ACLED_ACCESS_TOKEN;
  if (!accessToken) throw new Error("ACLED_ACCESS_TOKEN is not configured");
  const url = new URL(process.env.ACLED_API_URL ?? ACLED_URL);
  const today = new Date();
  const from = new Date(today);
  from.setUTCDate(from.getUTCDate() - 4);
  url.searchParams.set("event_date", `${from.toISOString().slice(0, 10)}|${today.toISOString().slice(0, 10)}`);
  url.searchParams.set("event_date_where", "BETWEEN");
  url.searchParams.set("limit", "500");
  const body = await fetchJsonObject(url, {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  });
  const records = Array.isArray(body.data) ? body.data : [];
  return records.flatMap((raw): ConflictRecord[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const record = raw as ProviderRecord;
    const eventId = text(record.event_id_cnty) ?? text(record.event_id_no_cnty);
    const eventDate = text(record.event_date);
    const eventType = text(record.event_type);
    const location = text(record.location);
    const country = text(record.country);
    if (!eventId || !eventDate || !eventType || !location || !country) return [];
    const fatalities = numeric(record.fatalities);
    return [{
      eventId,
      eventDate,
      eventType,
      subEventType: text(record.sub_event_type),
      actors: [text(record.actor1), text(record.actor2), text(record.assoc_actor_1), text(record.assoc_actor_2)]
        .filter((value): value is string => Boolean(value)),
      location,
      country,
      latitude: numeric(record.latitude),
      longitude: numeric(record.longitude),
      fatalities: fatalities === null ? 0 : Math.max(0, Math.trunc(fatalities)),
      notes: text(record.notes),
    }];
  });
}

function normalizeGeopoliticalFeed(
  stories: GeopoliticalStory[],
  acledRecords: readonly ConflictRecord[],
  limit: number,
): FeedItem[] {
  return stories
    .map((representative): FeedItem => {
      const assessment = assessGeopoliticalCorroboration(representative, acledRecords);
      const conflict = assessment.conflict;
      return {
        id: stableId("gdelt", representative.sourceUrl, representative.title),
        kind: "geopolitical",
        title: representative.title,
        summary: conflict?.notes?.slice(0, 1_200) ?? null,
        publishedAt: representative.publishedAt,
        source: representative.source,
        sourceUrl: representative.sourceUrl,
        imageUrl: representative.imageUrl,
        provider: "GDELT",
        symbol: null,
        category: conflict?.eventType ?? "Geopolitical",
        verification: assessment.verification,
        independentSourceCount: assessment.independentSourceCount,
        corroboratingSources: assessment.corroboratingSources,
        conflictDetails: conflict
          ? {
              eventId: conflict.eventId,
              eventType: conflict.eventType,
              subEventType: conflict.subEventType,
              actors: conflict.actors,
              location: conflict.location,
              country: conflict.country,
              latitude: conflict.latitude,
              longitude: conflict.longitude,
              fatalities: conflict.fatalities,
              eventDate: new Date(`${conflict.eventDate}T00:00:00Z`),
            }
          : null,
        canonicalAsset: null,
        locations: conflict
          ? verifiedLocationsFromProvider(
              {
                country: conflict.country,
                city: conflict.location,
                latitude: conflict.latitude,
                longitude: conflict.longitude,
              },
              "ACLED structured conflict metadata",
            )
          : [],
      };
    })
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
    .slice(0, limit);
}

async function loadFeed(
  kind: "all" | "press_release" | "news" | "geopolitical",
  symbol: string | undefined,
  limit: number,
) {
  const assets = await getCanonicalAssets();
  const uniqueSymbols = new Map<string, CanonicalAsset | null>();
  for (const asset of assets) {
    const key = asset.symbol.toUpperCase();
    uniqueSymbols.set(key, uniqueSymbols.has(key) ? null : asset);
  }
  const assetsBySymbol = new Map(
    [...uniqueSymbols.entries()].flatMap(([key, asset]) =>
      asset ? [[key, asset] as const] : [],
    ),
  );

  const shouldFetchFmp = kind === "all" || kind === "press_release";
  const shouldFetchFinnhub = kind === "all" || kind === "news";
  const shouldFetchGeopolitical =
    !symbol && (kind === "all" || kind === "geopolitical");
  const acledConfigured =
    Boolean(process.env.ACLED_ACCESS_TOKEN) &&
    process.env.ACLED_CONFIRMATION_ENABLED === "true";
  const usgsRequested = shouldFetchFinnhub && !symbol;
  const [fmp, finnhub, usgs, gdelt, acled] = await Promise.allSettled([
    shouldFetchFmp
      ? fetchPressReleases(limit, symbol, assetsBySymbol)
      : Promise.resolve([]),
    shouldFetchFinnhub
      ? fetchFinnhubNews(symbol, assetsBySymbol)
      : Promise.resolve([]),
    usgsRequested
      ? fetchUsgsIncidents(limit)
      : Promise.resolve([]),
    shouldFetchGeopolitical
      ? fetchGdeltStories(limit)
      : Promise.resolve([]),
    shouldFetchGeopolitical && acledConfigured
      ? fetchAcledRecords()
      : Promise.resolve([]),
  ]);

  const fmpFailed = shouldFetchFmp && fmp.status === "rejected";
  const finnhubFailed = shouldFetchFinnhub && finnhub.status === "rejected";
  const usgsFailed = usgsRequested && usgs.status === "rejected";
  const gdeltFailed = shouldFetchGeopolitical && gdelt.status === "rejected";
  const acledFailed =
    shouldFetchGeopolitical && acledConfigured && acled.status === "rejected";
  const geopoliticalItems =
    gdelt.status === "fulfilled"
      ? normalizeGeopoliticalFeed(
          gdelt.value,
          acled.status === "fulfilled" ? acled.value : [],
          limit,
        )
      : [];
  if (
    (kind === "press_release" && fmpFailed) ||
    (kind === "news" && finnhubFailed && (!usgsRequested || usgsFailed)) ||
    (kind === "all" && fmpFailed && finnhubFailed && usgsFailed && gdeltFailed)
  ) {
    throw new Error("All requested intelligence news providers failed");
  }

  const items = [
    ...(fmp.status === "fulfilled" ? fmp.value : []),
    ...(finnhub.status === "fulfilled" ? finnhub.value : []),
    ...(usgs.status === "fulfilled" ? usgs.value : []),
    ...geopoliticalItems,
  ]
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
    .slice(0, limit);

  return GetIntelligenceNewsResponse.parse({
    status:
      fmpFailed || finnhubFailed || usgsFailed || gdeltFailed || acledFailed || (shouldFetchGeopolitical && !acledConfigured)
        ? "degraded"
        : "live",
    asOf: new Date(),
    timezone: "UTC",
    providerStatuses: [
      ...(shouldFetchFmp
        ? [
            {
              provider: "Financial Modeling Prep" as const,
              status: fmpFailed ? ("unavailable" as const) : ("live" as const),
              itemCount: fmp.status === "fulfilled" ? fmp.value.length : 0,
              access: "configured" as const,
              commercialUse: "provider_terms_apply" as const,
              termsUrl: "https://site.financialmodelingprep.com/terms-of-service",
            },
          ]
        : []),
      ...(shouldFetchFinnhub
        ? [
            {
              provider: "Finnhub" as const,
              status: finnhubFailed ? ("unavailable" as const) : ("live" as const),
              itemCount: finnhub.status === "fulfilled" ? finnhub.value.length : 0,
              access: "configured" as const,
              commercialUse: "provider_terms_apply" as const,
              termsUrl: "https://finnhub.io/terms-of-service",
            },
          ]
        : []),
      ...(usgsRequested
        ? [
            {
              provider: "USGS" as const,
              status: usgsFailed ? ("unavailable" as const) : ("live" as const),
              itemCount: usgs.status === "fulfilled" ? usgs.value.length : 0,
              access: "public" as const,
              commercialUse: "permitted" as const,
              termsUrl: "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits",
            },
          ]
        : []),
      ...(shouldFetchGeopolitical
        ? [
            {
              provider: "GDELT" as const,
              status: gdeltFailed ? ("unavailable" as const) : ("live" as const),
              itemCount: geopoliticalItems.length,
              access: "public" as const,
              commercialUse: "permitted" as const,
              termsUrl: "https://www.gdeltproject.org/about.html",
            },
            {
              provider: "ACLED" as const,
              status: !acledConfigured
                ? ("access_required" as const)
                : acledFailed
                  ? ("unavailable" as const)
                  : ("live" as const),
              itemCount: acled.status === "fulfilled" ? acled.value.length : 0,
              access: acledConfigured ? ("configured" as const) : ("license_required" as const),
              commercialUse: "contract_required" as const,
              termsUrl: "https://acleddata.com/eula",
            },
          ]
        : []),
    ],
    items,
  });
}

router.get("/intelligence/news", async (req, res): Promise<void> => {
  const parsed = GetIntelligenceNewsQueryParams.safeParse({
    kind: req.query.kind,
    symbol: req.query.symbol,
    limit: req.query.limit,
  });
  if (!parsed.success) {
    res.status(400).json({ error: "Use a valid feed filter, symbol, and limit" });
    return;
  }

  const kind = parsed.data.kind ?? "all";
  const symbol = parsed.data.symbol?.toUpperCase();
  const limit = parsed.data.limit ?? 50;
  const cacheKey = `${kind}:${symbol ?? "*"}:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    res.json(cached.payload);
    return;
  }

  let request = inFlight.get(cacheKey);
  if (!request) {
    request = loadFeed(kind, symbol, limit);
    inFlight.set(cacheKey, request);
  }

  try {
    const payload = await request;
    cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, payload });
    req.log.info(
      {
        operation: "intelligence-news-read",
        kind,
        symbol: symbol ?? null,
        status: payload.status,
        itemCount: payload.items.length,
        providers: payload.providerStatuses,
      },
      "Intelligence news feed read",
    );
    res.json(payload);
  } catch (error) {
    req.log.error(
      {
        operation: "intelligence-news-read",
        kind,
        symbol: symbol ?? null,
        err: error,
      },
      "Intelligence news feed failed",
    );
    res.status(502).json({ error: "Intelligence news providers are unavailable" });
  } finally {
    inFlight.delete(cacheKey);
  }
});

export default router;
