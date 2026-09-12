import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const eventStatusEnum = pgEnum("event_status", [
  "draft",
  "published",
  "merged",
]);

export const eventAssetSourceEnum = pgEnum("event_asset_source", [
  "template",
  "curator",
  "suggested",
]);

/**
 * The persisted, provider-independent representation of a calendar event.
 * Keep the provider fields here in lockstep with EconomicCalendarEvent: the
 * API can therefore continue serving a cached/provider result if persistence
 * is temporarily unavailable.
 */
export const eventsTable = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    countryCode: text("country_code").notNull(),
    date: timestamp("date", { withTimezone: true }).notNull(),
    importance: integer("importance").notNull().default(0),
    actual: text("actual"),
    previous: text("previous"),
    forecast: text("forecast"),
    period: text("period"),
    source: text("source"),
    sourceUrl: text("source_url"),
    unit: text("unit"),
    currency: text("currency"),
    category: text("category").notNull(),
    agency: text("agency"),
    publicationDate: timestamp("publication_date", { withTimezone: true }),
    effectiveDate: timestamp("effective_date", { withTimezone: true }),
    verificationType: text("verification_type").notNull(),
    lastUpdated: timestamp("last_updated", { withTimezone: true })
      .notNull()
      .defaultNow(),
    stormRating: smallint("storm_rating").notNull().default(1),
    ratingConfirmed: boolean("rating_confirmed").notNull().default(false),
    status: eventStatusEnum("status").notNull().default("draft"),
    mergedIntoId: text("merged_into_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("events_date_idx").on(table.date),
    index("events_category_idx").on(table.category),
    check(
      "events_storm_rating_check",
      sql`${table.stormRating} >= 1 AND ${table.stormRating} <= 4`,
    ),
  ],
);

/**
 * `asset` is the canonical contract address from the assets registry. It is
 * deliberately not a free-form ticker or name, and is resolved only from
 * assetsTable during ingestion.
 */
export const eventAssetsTable = pgTable(
  "event_assets",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => eventsTable.id, { onDelete: "cascade" }),
    asset: text("asset").notNull(),
    rationale: text("rationale").notNull(),
    sensitivity: smallint("sensitivity").notNull(),
    source: eventAssetSourceEnum("source").notNull().default("template"),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.asset] }),
    index("event_assets_asset_idx").on(table.asset),
    check(
      "event_assets_sensitivity_check",
      sql`${table.sensitivity} >= 1 AND ${table.sensitivity} <= 3`,
    ),
    check(
      "event_assets_rationale_nonempty_check",
      sql`length(btrim(${table.rationale})) > 0`,
    ),
  ],
);

export const tagTemplatesTable = pgTable(
  "tag_templates",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    category: text("category").notNull(),
    region: text("region").notNull(),
    keywords: text("keywords").array().notNull().default([]),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("tag_templates_name_idx").on(table.name)],
);

export const tagTemplateAssetsTable = pgTable(
  "tag_template_assets",
  {
    templateId: text("template_id")
      .notNull()
      .references(() => tagTemplatesTable.id, { onDelete: "cascade" }),
    asset: text("asset").notNull(),
    rationale: text("rationale").notNull(),
    sensitivity: smallint("sensitivity").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.templateId, table.asset] }),
    index("tag_template_assets_asset_idx").on(table.asset),
    check(
      "tag_template_assets_sensitivity_check",
      sql`${table.sensitivity} >= 1 AND ${table.sensitivity} <= 3`,
    ),
    check(
      "tag_template_assets_rationale_nonempty_check",
      sql`length(btrim(${table.rationale})) > 0`,
    ),
  ],
);

export const insertEventSchema = createInsertSchema(eventsTable).omit({
  createdAt: true,
  updatedAt: true,
});
export const insertEventAssetSchema = createInsertSchema(eventAssetsTable);
export const insertTagTemplateSchema = createInsertSchema(tagTemplatesTable).omit(
  { createdAt: true, updatedAt: true },
);
export const insertTagTemplateAssetSchema =
  createInsertSchema(tagTemplateAssetsTable);

export type InsertEvent = z.infer<typeof insertEventSchema>;
export type Event = typeof eventsTable.$inferSelect;
export type InsertEventAsset = z.infer<typeof insertEventAssetSchema>;
export type EventAsset = typeof eventAssetsTable.$inferSelect;
export type InsertTagTemplate = z.infer<typeof insertTagTemplateSchema>;
export type TagTemplate = typeof tagTemplatesTable.$inferSelect;
export type InsertTagTemplateAsset = z.infer<
  typeof insertTagTemplateAssetSchema
>;
export type TagTemplateAsset = typeof tagTemplateAssetsTable.$inferSelect;

export type ApprovalAsset = Pick<EventAsset, "sensitivity" | "rationale">;

export type EventApprovalValidation = {
  valid: boolean;
  errors: string[];
};

/**
 * Shared approval guard for future curator endpoints and publishing jobs.
 * It intentionally accepts plain data so it can be used before or after a
 * database read.
 */
export function validateEventApproval(input: {
  ratingConfirmed: boolean;
  assets: readonly ApprovalAsset[];
}): EventApprovalValidation {
  const errors: string[] = [];
  if (!input.assets.some((asset) => asset.sensitivity >= 2)) {
    errors.push("At least one asset must have sensitivity 2 or 3");
  }
  if (
    input.assets.some(
      (asset) =>
        typeof asset.rationale !== "string" || asset.rationale.trim().length === 0,
    )
  ) {
    errors.push("Every tagged asset must have a non-empty rationale");
  }
  if (!input.ratingConfirmed) {
    errors.push("Storm rating must be confirmed");
  }
  return { valid: errors.length === 0, errors };
}