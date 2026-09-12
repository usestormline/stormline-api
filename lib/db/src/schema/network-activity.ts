import {
  index,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const networkActivityKindEnum = pgEnum("network_activity_kind", [
  "rule_evaluation",
  "activity",
]);

export const networkActivityOutcomeEnum = pgEnum("network_activity_outcome", [
  "matched",
  "not_matched",
  "succeeded",
  "failed",
  "not_applicable",
]);

export const networkActivityTable = pgTable(
  "network_activity",
  {
    id: serial("id").primaryKey(),
    kind: networkActivityKindEnum("kind").notNull(),
    eventType: text("event_type").notNull(),
    outcome: networkActivityOutcomeEnum("outcome")
      .notNull()
      .default("not_applicable"),
    actorHash: text("actor_hash").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("network_activity_occurred_at_idx").on(table.occurredAt),
    index("network_activity_actor_hash_idx").on(table.actorHash),
  ],
);

export const insertNetworkActivitySchema = createInsertSchema(
  networkActivityTable,
).omit({ id: true, createdAt: true });
export type InsertNetworkActivity = z.infer<
  typeof insertNetworkActivitySchema
>;
export type NetworkActivity = typeof networkActivityTable.$inferSelect;