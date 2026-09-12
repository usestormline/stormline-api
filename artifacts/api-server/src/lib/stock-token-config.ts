import feeds4663 from "../../config/feeds.4663.json" with { type: "json" };

export const ROBINHOOD_CHAIN_ID = Number(process.env.RH_CHAIN_ID ?? 4663);

if (ROBINHOOD_CHAIN_ID !== 4663) {
  throw new Error("Stormline only supports Robinhood Chain mainnet (RH_CHAIN_ID=4663)");
}

export const ROBINHOOD_RPC_URL =
  process.env.RH_RPC_URL ??
  "https://rpc.mainnet.chain.robinhood.com/";

export const ROBINHOOD_CHAIN_NAME = "Robinhood Chain";

export const ROBINHOOD_EXPLORER_URL = "https://robinhoodchain.blockscout.com";

export const CHAINLINK_FEEDS: Readonly<Record<string, string>> = feeds4663;