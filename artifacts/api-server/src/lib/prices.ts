import { db, assetsTable } from "@usestormline/db-internal";
import { and, eq } from "drizzle-orm";
import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseAbi,
} from "viem";
import {
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_RPC_URL,
} from "./stock-token-config";

const MAX_ORACLE_AGE_SECONDS = Number(
  process.env.ORACLE_MAX_AGE_SECONDS ?? 3_600,
);
const AGGREGATOR_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

export async function getOraclePrice(assetAddress: string) {
  if (!isAddress(assetAddress)) {
    throw new Error("Invalid Stock Token address");
  }
  const [asset] = await db
    .select()
    .from(assetsTable)
    .where(
      and(
        eq(assetsTable.chainId, ROBINHOOD_CHAIN_ID),
        eq(assetsTable.address, getAddress(assetAddress)),
      ),
    )
    .limit(1);
  if (!asset?.chainlinkFeed || !isAddress(asset.chainlinkFeed)) {
    throw new Error("No verified Chainlink feed is configured");
  }

  const client = createPublicClient({ transport: http(ROBINHOOD_RPC_URL) });
  const feed = getAddress(asset.chainlinkFeed);
  const [decimals, round] = await Promise.all([
    client.readContract({
      address: feed,
      abi: AGGREGATOR_ABI,
      functionName: "decimals",
    }),
    client.readContract({
      address: feed,
      abi: AGGREGATOR_ABI,
      functionName: "latestRoundData",
    }),
  ]);
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = round;
  if (
    answer <= 0n ||
    startedAt === 0n ||
    updatedAt === 0n ||
    roundId === 0n ||
    answeredInRound < roundId ||
    startedAt > updatedAt
  ) {
    throw new Error("Oracle returned missing or invalid price metadata");
  }
  const nowSeconds = BigInt(Math.floor(Date.now() / 1_000));
  if (startedAt > nowSeconds || updatedAt > nowSeconds) {
    throw new Error("Oracle timestamp is in the future");
  }
  const ageSeconds = Number(nowSeconds - updatedAt);
  if (
    !Number.isFinite(MAX_ORACLE_AGE_SECONDS) ||
    MAX_ORACLE_AGE_SECONDS <= 0 ||
    ageSeconds > MAX_ORACLE_AGE_SECONDS
  ) {
    throw new Error("Oracle price is stale");
  }

  if (asset.feedDecimals !== decimals) {
    await db
      .update(assetsTable)
      .set({ feedDecimals: decimals, updatedAt: new Date() })
      .where(
        and(
          eq(assetsTable.chainId, ROBINHOOD_CHAIN_ID),
          eq(assetsTable.address, asset.address),
        ),
      );
  }
  return {
    price: formatUnits(answer, decimals),
    decimals,
    updatedAt: new Date(Number(updatedAt) * 1_000),
    ageSeconds,
  };
}