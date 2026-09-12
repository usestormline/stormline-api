import {
  db,
  assetsTable,
  assetRegistrySyncTable,
  type InsertAsset,
} from "@usestormline/db-internal";
import { and, eq, notInArray, sql } from "drizzle-orm";
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  parseAbi,
  type Address,
} from "viem";
import { logger } from "./logger";
import {
  CHAINLINK_FEEDS,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_RPC_URL,
} from "./stock-token-config";

const REGISTRY_URL = "https://api.robinhood.com/rhj/assets";
const PROVIDER_MIN_INTERVAL_MS = 1_000 / 60;
const SHARED_SYNC_COOLDOWN_MS = 60_000;
const SCHEDULE_INTERVAL_MS = 60 * 60 * 1_000;
const FEED_ABI = parseAbi(["function decimals() view returns (uint8)"]);

type RegistryAsset = Omit<
  InsertAsset,
  "chainlinkFeed" | "feedDecimals" | "shieldEnabled"
>;

let lastProviderRequestAt = 0;
let syncRequest: Promise<RegistrySyncResult> | undefined;
let schedule: NodeJS.Timeout | undefined;

export type RegistrySyncResult = {
  canonicalAssetCount: number;
  usableAssetCount: number;
  syncedAt: Date;
};

export class RegistrySyncThrottledError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super("Stock Token registry sync is throttled");
  }
}

function nullableText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeUrl(value: unknown) {
  const text = nullableText(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeAsset(value: unknown): RegistryAsset | null {
  if (!value || typeof value !== "object") return null;
  const asset = value as Record<string, unknown>;
  const deployments = Array.isArray(asset.deployments) ? asset.deployments : [];
  const deployment = deployments.find(
    (item) =>
      item &&
      typeof item === "object" &&
      Number((item as Record<string, unknown>).chainId) === ROBINHOOD_CHAIN_ID,
  ) as Record<string, unknown> | undefined;
  const rawAddress = nullableText(deployment?.contractAddress);
  const rhjUid = nullableText(asset.id);
  const symbol = nullableText(asset.tokenSymbol);
  const rawName = nullableText(asset.tokenName);
  const status = nullableText(asset.status);
  const tokenDecimals =
    typeof asset.tokenDecimals === "number" &&
    Number.isInteger(asset.tokenDecimals) &&
    asset.tokenDecimals >= 0 &&
    asset.tokenDecimals <= 36
      ? asset.tokenDecimals
      : null;
  if (
    !rawAddress ||
    !isAddress(rawAddress) ||
    !rhjUid ||
    !symbol ||
    !rawName ||
    !status ||
    tokenDecimals === null
  ) {
    return null;
  }

  const capabilities =
    asset.tradingCapabilities && typeof asset.tradingCapabilities === "object"
      ? (asset.tradingCapabilities as Record<string, unknown>)
      : undefined;
  const overnight =
    capabilities?.overnight && typeof capabilities.overnight === "object"
      ? (capabilities.overnight as Record<string, unknown>)
      : null;
  const allDayTradability =
    capabilities?.allDayTradability === true ||
    (overnight?.whole === "TRADING_STATUS_TRADABLE" &&
      overnight?.fractional === "TRADING_STATUS_TRADABLE");

  return {
    chainId: ROBINHOOD_CHAIN_ID,
    address: getAddress(rawAddress),
    symbol,
    name: rawName.replace(/\s*•\s*Robinhood Token$/i, ""),
    rhjUid,
    tokenDecimals,
    currentMultiplier: nullableText(asset.currentMultiplier) ?? "1",
    isin: nullableText(asset.isin),
    status,
    logoUrl: safeUrl(asset.logoUrl),
    allDayTradability,
  };
}

function hasConfiguredDeployment(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const deployments = Array.isArray(
    (value as Record<string, unknown>).deployments,
  )
    ? ((value as Record<string, unknown>).deployments as unknown[])
    : [];
  return deployments.some(
    (item) =>
      item &&
      typeof item === "object" &&
      Number((item as Record<string, unknown>).chainId) === ROBINHOOD_CHAIN_ID,
  );
}

function getConfiguredFeed(assetAddress: string) {
  const entry = Object.entries(CHAINLINK_FEEDS).find(
    ([address]) =>
      isAddress(address) &&
      getAddress(address) === getAddress(assetAddress),
  );
  if (!entry || !isAddress(entry[1])) return null;
  return getAddress(entry[1]);
}

async function readFeedDecimals(feedAddress: Address) {
  const client = createPublicClient({ transport: http(ROBINHOOD_RPC_URL) });
  return client.readContract({
    address: feedAddress,
    abi: FEED_ABI,
    functionName: "decimals",
  });
}

async function fetchRegistry() {
  const waitMs =
    PROVIDER_MIN_INTERVAL_MS - (Date.now() - lastProviderRequestAt);
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastProviderRequestAt = Date.now();
  const response = await fetch(REGISTRY_URL, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(`Robinhood registry returned ${response.status}`);
  }
  const body = (await response.json()) as unknown;
  const rows =
    body &&
    typeof body === "object" &&
    Array.isArray((body as { assets?: unknown }).assets)
      ? (body as { assets: unknown[] }).assets
      : null;
  if (!rows) {
    throw new Error("Robinhood registry returned an invalid response");
  }
  const configuredRows = rows.filter(hasConfiguredDeployment);
  const normalized = configuredRows.map(normalizeAsset);
  if (normalized.some((asset) => asset === null)) {
    throw new Error(
      "Robinhood registry contained a malformed configured-chain deployment",
    );
  }
  const assets = normalized as RegistryAsset[];
  if (assets.length === 0) {
    throw new Error("Robinhood registry contained no configured-chain deployments");
  }
  const addresses = new Set(assets.map((asset) => asset.address));
  const uids = new Set(assets.map((asset) => asset.rhjUid));
  if (addresses.size !== assets.length || uids.size !== assets.length) {
    throw new Error(
      "Robinhood registry contained duplicate configured-chain assets",
    );
  }
  return assets;
}

async function performSync(): Promise<RegistrySyncResult> {
  const syncSlot = await db.transaction(async (tx) => {
    await tx
      .insert(assetRegistrySyncTable)
      .values({ chainId: ROBINHOOD_CHAIN_ID })
      .onConflictDoNothing();
    const stateResult = await tx.execute<{
      next_allowed_at: Date;
    }>(sql`
      select next_allowed_at
      from asset_registry_sync
      where chain_id = ${ROBINHOOD_CHAIN_ID}
      for update
    `);
    const state = stateResult.rows[0];
    if (
      state?.next_allowed_at &&
      new Date(state.next_allowed_at).getTime() > Date.now()
    ) {
      return Math.max(
        1,
        Math.ceil(
          (new Date(state.next_allowed_at).getTime() - Date.now()) / 1_000,
        ),
      );
    }
    await tx
      .update(assetRegistrySyncTable)
      .set({ nextAllowedAt: new Date(Date.now() + SHARED_SYNC_COOLDOWN_MS) })
      .where(eq(assetRegistrySyncTable.chainId, ROBINHOOD_CHAIN_ID));
    return 0;
  });
  if (syncSlot > 0) {
    throw new RegistrySyncThrottledError(syncSlot);
  }

  const canonicalAssets = await fetchRegistry();
  const [existingCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(assetsTable)
    .where(eq(assetsTable.chainId, ROBINHOOD_CHAIN_ID));
  const previousCount = existingCount?.count ?? 0;
  if (
    previousCount > 0 &&
    canonicalAssets.length < Math.floor(previousCount * 0.9)
  ) {
    throw new Error(
      `Robinhood registry completeness check failed: received ${canonicalAssets.length} of ${previousCount} persisted assets`,
    );
  }
  const rows = await Promise.all(
    canonicalAssets.map(async (asset) => {
      const chainlinkFeed = getConfiguredFeed(asset.address);
      const feedDecimals =
        chainlinkFeed === null
          ? null
          : await readFeedDecimals(chainlinkFeed);
      return {
        ...asset,
        chainlinkFeed,
        feedDecimals,
        updatedAt: new Date(),
      };
    }),
  );

  await db.transaction(async (tx) => {
    for (const row of rows) {
      await tx
        .insert(assetsTable)
        .values(row)
        .onConflictDoUpdate({
          target: [assetsTable.chainId, assetsTable.address],
          set: {
            symbol: row.symbol,
            name: row.name,
            rhjUid: row.rhjUid,
            tokenDecimals: row.tokenDecimals,
            currentMultiplier: row.currentMultiplier,
            isin: row.isin,
            status: row.status,
            chainlinkFeed: row.chainlinkFeed,
            feedDecimals: row.feedDecimals,
            logoUrl: row.logoUrl,
            allDayTradability: row.allDayTradability,
            updatedAt: row.updatedAt,
          },
        });
    }
    await tx
      .delete(assetsTable)
      .where(
        and(
          eq(assetsTable.chainId, ROBINHOOD_CHAIN_ID),
          notInArray(assetsTable.address, rows.map((row) => row.address)),
        ),
      );
    await tx
      .update(assetRegistrySyncTable)
      .set({ lastSyncedAt: new Date() })
      .where(eq(assetRegistrySyncTable.chainId, ROBINHOOD_CHAIN_ID));
  });

  return {
    canonicalAssetCount: rows.length,
    usableAssetCount: rows.filter((row) => row.chainlinkFeed !== null).length,
    syncedAt: new Date(),
  };
}

export async function syncStockTokenRegistry() {
  if (!syncRequest) {
    syncRequest = performSync().finally(() => {
      syncRequest = undefined;
    });
  }
  return syncRequest;
}

export async function getRegistryStatus(): Promise<RegistrySyncResult> {
  const [[counts], [syncState]] = await Promise.all([
    db
      .select({
        canonicalAssetCount: sql<number>`count(*)::int`,
        usableAssetCount:
          sql<number>`count(*) filter (where ${assetsTable.chainlinkFeed} is not null)::int`,
      })
      .from(assetsTable)
      .where(eq(assetsTable.chainId, ROBINHOOD_CHAIN_ID)),
    db
      .select({ lastSyncedAt: assetRegistrySyncTable.lastSyncedAt })
      .from(assetRegistrySyncTable)
      .where(eq(assetRegistrySyncTable.chainId, ROBINHOOD_CHAIN_ID))
      .limit(1),
  ]);
  return {
    canonicalAssetCount: counts?.canonicalAssetCount ?? 0,
    usableAssetCount: counts?.usableAssetCount ?? 0,
    syncedAt: syncState?.lastSyncedAt ?? new Date(0),
  };
}

export async function getCanonicalAssets() {
  const rows = await db
    .select()
    .from(assetsTable)
    .where(eq(assetsTable.chainId, ROBINHOOD_CHAIN_ID));
  if (rows.length > 0) return rows;
  await syncStockTokenRegistry();
  return db
    .select()
    .from(assetsTable)
    .where(eq(assetsTable.chainId, ROBINHOOD_CHAIN_ID));
}

export function startStockTokenRegistrySchedule() {
  if (schedule) return;
  void syncStockTokenRegistry()
    .then((result) =>
      logger.info(
        { operation: "stock-token-registry-sync", ...result },
        "Stock Token registry synchronized",
      ),
    )
    .catch((error) =>
      logger.error(
        {
          operation: "stock-token-registry-sync",
          error: error instanceof Error ? error.message : "Unknown sync error",
        },
        "Stock Token registry synchronization failed",
      ),
    );
  schedule = setInterval(() => {
    void syncStockTokenRegistry().catch((error) =>
      logger.error(
        {
          operation: "stock-token-registry-sync",
          error: error instanceof Error ? error.message : "Unknown sync error",
        },
        "Scheduled Stock Token registry synchronization failed",
      ),
    );
  }, SCHEDULE_INTERVAL_MS);
  schedule.unref();
}