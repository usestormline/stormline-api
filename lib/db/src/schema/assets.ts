import {
  boolean,
  integer,
  primaryKey,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const assetsTable = pgTable(
  "assets",
  {
    chainId: integer("chain_id").notNull(),
    address: text("address").notNull(),
    symbol: text("symbol").notNull(),
    name: text("name").notNull(),
    rhjUid: text("rhj_uid").notNull(),
    tokenDecimals: integer("token_decimals").notNull(),
    currentMultiplier: text("current_multiplier").notNull().default("1"),
    isin: text("isin"),
    status: text("status").notNull(),
    chainlinkFeed: text("chainlink_feed"),
    feedDecimals: integer("feed_decimals"),
    logoUrl: text("logo_url"),
    shieldEnabled: boolean("shield_enabled").notNull().default(false),
    allDayTradability: boolean("all_day_tradability").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.chainId, table.address] }),
  ],
);

export const assetRegistrySyncTable = pgTable("asset_registry_sync", {
  chainId: integer("chain_id").primaryKey(),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  nextAllowedAt: timestamp("next_allowed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertAssetSchema = createInsertSchema(assetsTable).omit({
  updatedAt: true,
});
export type InsertAsset = z.infer<typeof insertAssetSchema>;
export type Asset = typeof assetsTable.$inferSelect;
export type AssetRegistrySync =
  typeof assetRegistrySyncTable.$inferSelect;