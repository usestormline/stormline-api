import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  parseAbi,
} from "viem";
import { getOraclePrice } from "./prices";
import {
  CHAINLINK_FEEDS,
  ROBINHOOD_RPC_URL,
} from "./stock-token-config";

const feedAbi = parseAbi(["function decimals() view returns (uint8)"]);
const client = createPublicClient({ transport: http(ROBINHOOD_RPC_URL) });

export function getConfiguredFeed(assetAddress: string) {
  if (!isAddress(assetAddress)) return null;
  const entry = Object.entries(CHAINLINK_FEEDS).find(
    ([address]) =>
      isAddress(address) &&
      getAddress(address) === getAddress(assetAddress),
  );
  return entry && isAddress(entry[1]) ? getAddress(entry[1]) : null;
}

export function getConfiguredFeedCount() {
  return Object.keys(CHAINLINK_FEEDS).length;
}

export async function getFeedDecimals(assetAddress: string) {
  const feedAddress = getConfiguredFeed(assetAddress);
  if (!feedAddress) return null;
  return client.readContract({
    address: feedAddress,
    abi: feedAbi,
    functionName: "decimals",
  });
}

export { getOraclePrice };
