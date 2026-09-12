import { and, eq, inArray, sql } from "drizzle-orm";
import {
  assetsTable,
  db,
  eventAssetsTable,
  eventsTable,
  tagTemplateAssetsTable,
  tagTemplatesTable,
} from "@usestormline/db-internal";
import { GetEconomicCalendarResponse } from "@usestormline/api-zod-internal";
import { logger } from "./logger";
import { ROBINHOOD_CHAIN_ID } from "./stock-token-config";
export {
  assessGeopoliticalCorroboration,
  geopoliticalSimilarity,
  matchConflictRecord,
  type ConflictRecord,
  type GeopoliticalCandidate,
} from "./geopolitical-matching";

type CalendarEvent = ReturnType<typeof GetEconomicCalendarResponse.parse>["events"][number];

type TemplateDefinition = {
  id: string;
  name: string;
  category: string;
  region: string;
  keywords: string[];
  symbols: string[];
  rationales: Record<string, string>;
  sensitivities: Record<string, 1 | 2 | 3>;
};

/*
 * These are symbol baskets, not asset identities. Every symbol is resolved
 * against the persisted official registry below; an absent symbol is ignored.
 * No address, feed, ticker metadata, or logo is inferred here.
 */
const TEMPLATE_DEFINITIONS: TemplateDefinition[] = [
  {
    id: "us-rate-decision",
    name: "US rate decision",
    category: "monetary_policy",
    region: "US",
    keywords: ["FOMC", "rate decision", "federal funds"],
    symbols: ["SPY", "QQQ", "SCHD", "VTI"],
    rationales: {
      SPY: "Policy-rate repricing changes the discount rate applied across US equities.",
      QQQ: "Growth-stock valuations are especially sensitive to changes in the policy path.",
      SCHD: "Policy-rate repricing changes the discount rate applied to dividend-paying equities.",
      VTI: "Policy decisions affect the broad US equity risk premium and financing conditions.",
    },
    sensitivities: { SPY: 2, QQQ: 2, SCHD: 2, VTI: 2 },
  },
  {
    id: "us-inflation-print",
    name: "US inflation print",
    category: "macro_data",
    region: "US",
    keywords: ["CPI", "PCE", "inflation"],
    symbols: ["SPY", "QQQ", "VTI"],
    rationales: {
      SPY: "Inflation surprises can move real yields and broad US equity multiples.",
      QQQ: "Long-duration technology valuations are particularly sensitive to real yields.",
      VTI: "Inflation changes real purchasing power and the expected policy path for broad equities.",
    },
    sensitivities: { SPY: 2, QQQ: 2, VTI: 2 },
  },
  {
    id: "us-labour-report",
    name: "US labour report",
    category: "macro_data",
    region: "US",
    keywords: ["nonfarm", "employment situation", "unemployment rate"],
    symbols: ["SPY", "QQQ", "AMZN"],
    rationales: {
      SPY: "Employment and wage data change the outlook for aggregate demand and policy.",
      QQQ: "A labour-market surprise can materially alter the expected rate path for growth assets.",
      AMZN: "Household employment and income trends transmit directly to consumer spending and retail demand.",
    },
    sensitivities: { SPY: 2, QQQ: 2, AMZN: 2 },
  },
  {
    id: "crypto-market-structure-bill",
    name: "Crypto market structure bill",
    category: "legislation",
    region: "US",
    keywords: ["CLARITY", "market structure", "digital asset"],
    symbols: ["COIN", "SOFI", "MSTR"],
    rationales: {
      COIN: "Market-structure rules directly affect exchange registration and token-market access.",
      SOFI: "Digital-asset legislation can change the regulated brokerage distribution model.",
      MSTR: "Digital-asset market rules affect the liquidity and financing environment for bitcoin exposure.",
    },
    sensitivities: { COIN: 3, SOFI: 2, MSTR: 2 },
  },
  {
    id: "tariff-action",
    name: "Tariff action",
    category: "trade_policy",
    region: "US",
    keywords: ["tariff", "Section 301", "trade deal"],
    symbols: ["AAPL", "TSLA", "NVDA", "AMZN"],
    rationales: {
      AAPL: "Tariffs can change the landed cost and sourcing economics of global hardware supply chains.",
      TSLA: "Trade measures affect imported components, vehicles, and cross-border pricing.",
      NVDA: "Export controls and tariffs can change semiconductor supply and overseas demand.",
      AMZN: "Import costs and cross-border commerce rules can affect retail margins and selection.",
    },
    sensitivities: { AAPL: 3, TSLA: 2, NVDA: 2, AMZN: 2 },
  },
  {
    id: "national-election",
    name: "National election",
    category: "election",
    region: "US",
    keywords: ["election", "midterm", "general election"],
    symbols: ["SPY", "QQQ", "GLD"],
    rationales: {
      SPY: "Election outcomes can change the expected path of fiscal policy and market regulation.",
      QQQ: "Changes in the policy outlook can affect regulated technology and growth-sector multiples.",
      GLD: "Election uncertainty can change demand for defensive stores of value and hedges.",
    },
    sensitivities: { SPY: 1, QQQ: 1, GLD: 2 },
  },
];

function titleMatches(title: string, keyword: string) {
  return title.toLocaleLowerCase().includes(keyword.toLocaleLowerCase());
}

function eventTemplateCategory(event: CalendarEvent) {
  const title = event.title.toLocaleLowerCase();
  if (/\bfomc\b|rate decision|federal funds|interest rate/.test(title)) {
    return "monetary_policy";
  }
  if (/cpi|pce|inflation/.test(title)) return "macro_data";
  if (/nonfarm|employment situation|unemployment rate|jobs report/.test(title)) {
    return "macro_data";
  }
  if (/clarity|market structure|digital asset|cryptocurrency|stablecoin/.test(title)) {
    return "legislation";
  }
  if (/tariff|section 301|trade deal/.test(title)) return "trade_policy";
  if (/election|midterm|general election/.test(title)) return "election";
  if (event.category === "Macro") return "macro_data";
  return event.category === "Policy & Regulation" || event.category === "Sanctions"
    ? "legislation"
    : null;
}

function pickTemplate(event: CalendarEvent, templates: typeof TEMPLATE_DEFINITIONS) {
  const category = eventTemplateCategory(event);
  const region = event.countryCode.toUpperCase();
  let winner: { template: TemplateDefinition; score: number } | null = null;

  for (const template of templates) {
    const keywordScore = template.keywords.reduce(
      (score, keyword) => score + (titleMatches(event.title, keyword) ? 10 : 0),
      0,
    );
    const score =
      keywordScore +
      (category === template.category ? 3 : 0) +
      (region === template.region ? 1 : 0);
    // Category/region narrow a keyword match; they must not turn an
    // unrelated macro release into an inflation or labour tag.
    if (
      keywordScore > 0 &&
      category === template.category &&
      region === template.region &&
      (!winner || score > winner.score)
    ) {
      winner = { template, score };
    }
  }
  return winner?.template ?? null;
}

function asSafeLogoUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function stormRatingForImportance(importance: number) {
  return Math.max(1, Math.min(3, importance));
}

export function normalizeStormRating(value: unknown, importance: number) {
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized === "low") return 1;
    if (normalized === "medium") return 2;
    if (normalized === "high") return 3;
  }
  return stormRatingForImportance(importance);
}

async function seedTemplatesAndAssets() {
  await db
    .insert(tagTemplatesTable)
    .values(
      TEMPLATE_DEFINITIONS.map(({ id, name, category, region, keywords }) => ({
        id,
        name,
        category,
        region,
        keywords,
        active: true,
      })),
    )
    .onConflictDoUpdate({
      target: tagTemplatesTable.id,
      set: {
        name: sql`excluded.name`,
        category: sql`excluded.category`,
        region: sql`excluded.region`,
        keywords: sql`excluded.keywords`,
        active: sql`excluded.active`,
      },
    });

  const symbols = [...new Set(TEMPLATE_DEFINITIONS.flatMap((template) => template.symbols))];
  const assets = symbols.length
    ? await db
        .select()
        .from(assetsTable)
        .where(
          and(
            eq(assetsTable.chainId, ROBINHOOD_CHAIN_ID),
            inArray(assetsTable.symbol, symbols),
          ),
        )
    : [];
  const bySymbol = new Map<string, (typeof assets)[number]>();
  for (const asset of assets) {
    if (!bySymbol.has(asset.symbol)) bySymbol.set(asset.symbol, asset);
  }

  for (const template of TEMPLATE_DEFINITIONS) {
    await db
      .delete(tagTemplateAssetsTable)
      .where(eq(tagTemplateAssetsTable.templateId, template.id));
    const rows = template.symbols.flatMap((symbol) => {
      const asset = bySymbol.get(symbol);
      if (!asset) return [];
      return [
        {
          templateId: template.id,
          asset: asset.address,
          rationale: template.rationales[symbol],
          sensitivity: template.sensitivities[symbol],
        },
      ];
    });
    if (rows.length) await db.insert(tagTemplateAssetsTable).values(rows);
  }
}

async function tagEvent(event: CalendarEvent) {
  const templates = await db
    .select()
    .from(tagTemplatesTable)
    .where(eq(tagTemplatesTable.active, true));
  const definitions = templates.flatMap((template) => {
    const definition = TEMPLATE_DEFINITIONS.find(
      (candidate) => candidate.id === template.id,
    );
    return definition
      ? [
          {
            ...definition,
            category: template.category,
            region: template.region,
            keywords: template.keywords,
          },
        ]
      : [];
  });
  const template = pickTemplate(event, definitions);

  await db
    .delete(eventAssetsTable)
    .where(
      and(
        eq(eventAssetsTable.eventId, event.id),
        eq(eventAssetsTable.source, "template"),
      ),
    );
  if (!template) return;

  const assets = await db
    .select({
      asset: tagTemplateAssetsTable.asset,
      rationale: tagTemplateAssetsTable.rationale,
      sensitivity: tagTemplateAssetsTable.sensitivity,
    })
    .from(tagTemplateAssetsTable)
    .where(eq(tagTemplateAssetsTable.templateId, template.id));
  if (assets.length) {
    await db
      .insert(eventAssetsTable)
      .values(
        assets.map((asset) => ({
          eventId: event.id,
          asset: asset.asset,
          rationale: asset.rationale,
          sensitivity: asset.sensitivity,
          source: "template" as const,
        })),
      )
      .onConflictDoUpdate({
        target: [eventAssetsTable.eventId, eventAssetsTable.asset],
        set: {
          rationale: sql`excluded.rationale`,
          sensitivity: sql`excluded.sensitivity`,
          source: sql`excluded.source`,
        },
      });
  }
}

export async function persistAndTagCalendarEvents(events: readonly CalendarEvent[]) {
  if (!events.length) {
    try {
      await seedTemplatesAndAssets();
    } catch (error) {
      logger.warn(
        {
          operation: "economic-calendar-template-seed",
          error: error instanceof Error ? error.message : "Unknown database error",
        },
        "Calendar tag template seed failed",
      );
    }
    return;
  }

  await db
    .insert(eventsTable)
    .values(
      events.map((event) => ({
        id: event.id,
        title: event.title,
        countryCode: event.countryCode,
        date: event.date,
        importance: event.importance,
        actual: event.actual,
        previous: event.previous,
        forecast: event.forecast,
        period: event.period,
        source: event.source,
        sourceUrl: event.sourceUrl,
        unit: event.unit,
        currency: event.currency,
        category: event.category,
        agency: event.agency,
        publicationDate: event.publicationDate,
        effectiveDate: event.effectiveDate,
        verificationType: event.verificationType,
        lastUpdated: event.lastUpdated,
        stormRating: stormRatingForImportance(event.importance),
      })),
    )
    .onConflictDoUpdate({
      target: eventsTable.id,
      set: {
        title: sql`excluded.title`,
        countryCode: sql`excluded.country_code`,
        date: sql`excluded.date`,
        importance: sql`excluded.importance`,
        actual: sql`excluded.actual`,
        previous: sql`excluded.previous`,
        forecast: sql`excluded.forecast`,
        period: sql`excluded.period`,
        source: sql`excluded.source`,
        sourceUrl: sql`excluded.source_url`,
        unit: sql`excluded.unit`,
        currency: sql`excluded.currency`,
        category: sql`excluded.category`,
        agency: sql`excluded.agency`,
        publicationDate: sql`excluded.publication_date`,
        effectiveDate: sql`excluded.effective_date`,
        verificationType: sql`excluded.verification_type`,
        lastUpdated: sql`excluded.last_updated`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    });

  try {
    await seedTemplatesAndAssets();
    for (const event of events) await tagEvent(event);
  } catch (error) {
    // Event persistence must not turn a successful provider response into a
    // provider failure. The next ingestion will retry template/tag writes.
    logger.warn(
      { operation: "economic-calendar-tagging", error: error instanceof Error ? error.message : "Unknown database error" },
      "Calendar event tagging failed after event persistence",
    );
  }
}

export async function enrichCalendarEvents(events: readonly CalendarEvent[]) {
  const fallback = events.map((event) => ({
    ...event,
    stormRating: stormRatingForImportance(event.importance),
    ratingConfirmed: false,
    needsTagging: true,
    affectedAssets: [],
  }));
  if (!events.length) return fallback;

  try {
    const rows = await db
      .select({
        eventId: eventAssetsTable.eventId,
        asset: eventAssetsTable.asset,
        rationale: eventAssetsTable.rationale,
        sensitivity: eventAssetsTable.sensitivity,
        source: eventAssetsTable.source,
        symbol: assetsTable.symbol,
        name: assetsTable.name,
        logoUrl: assetsTable.logoUrl,
      })
      .from(eventAssetsTable)
      .innerJoin(
        assetsTable,
        and(
          eq(eventAssetsTable.asset, assetsTable.address),
          eq(assetsTable.chainId, ROBINHOOD_CHAIN_ID),
        ),
      )
      .where(inArray(eventAssetsTable.eventId, events.map((event) => event.id)));

    const assetsByEvent = new Map<string, typeof rows>();
    for (const row of rows) {
      const existing = assetsByEvent.get(row.eventId) ?? [];
      existing.push(row);
      assetsByEvent.set(row.eventId, existing);
    }
    const persisted = await db
      .select({
        id: eventsTable.id,
        stormRating: eventsTable.stormRating,
        ratingConfirmed: eventsTable.ratingConfirmed,
      })
      .from(eventsTable)
      .where(inArray(eventsTable.id, events.map((event) => event.id)));
    const eventMetadata = new Map(persisted.map((event) => [event.id, event]));

    return events.map((event) => {
      const metadata = eventMetadata.get(event.id);
      const affectedAssets = (assetsByEvent.get(event.id) ?? [])
        .filter((asset) => asset.rationale.trim().length > 0)
        .map((asset) => ({
          address: asset.asset,
          symbol: asset.symbol,
          name: asset.name,
          logoUrl: asSafeLogoUrl(asset.logoUrl),
          rationale: asset.rationale,
          sensitivity: asset.sensitivity,
          source: asset.source,
        }));
      return {
        ...event,
        stormRating: metadata?.stormRating ?? stormRatingForImportance(event.importance),
        ratingConfirmed: metadata?.ratingConfirmed ?? false,
        needsTagging: !affectedAssets.some((asset) => asset.sensitivity >= 2),
        affectedAssets,
      };
    });
  } catch (error) {
    logger.warn(
      { operation: "economic-calendar-enrichment", error: error instanceof Error ? error.message : "Unknown database error" },
      "Calendar asset enrichment unavailable",
    );
    return fallback;
  }
}