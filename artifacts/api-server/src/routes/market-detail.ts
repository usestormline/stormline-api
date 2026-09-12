import { Router, type IRouter } from "express";
import {
  GetStockTokenMarketDetailParams,
  GetStockTokenMarketDetailResponse,
} from "@usestormline/api-zod-internal";
import { getAddress, isAddress } from "viem";
import { getCanonicalAssets } from "../lib/stock-token-registry";
import {
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_EXPLORER_URL,
} from "../lib/stock-token-config";

const router: IRouter = Router();
const QUOTE_URL = "https://financialmodelingprep.com/stable/quote";
const PROFILE_URL = "https://financialmodelingprep.com/stable/profile";
const CACHE_TTL_MS = 30_000;

type ProviderRecord = Record<string, unknown>;
type MarketDetail = ReturnType<typeof GetStockTokenMarketDetailResponse.parse>;

const cache = new Map<string, { expiresAt: number; payload: MarketDetail }>();
const inFlight = new Map<string, Promise<MarketDetail>>();

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

async function fetchProviderRecord(baseUrl: string, symbol: string) {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) throw new Error("FMP_API_KEY is not configured");
  const url = new URL(baseUrl);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("apikey", apiKey);
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`FMP returned ${response.status}`);
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) throw new Error("FMP returned an invalid response");
  const record = body[0];
  return record && typeof record === "object"
    ? (record as ProviderRecord)
    : null;
}

async function loadMarketDetail(address: string) {
  const assets = await getCanonicalAssets();
  const asset = assets.find(
    (candidate) => candidate.address.toLowerCase() === address.toLowerCase(),
  );
  if (!asset) {
    const error = new Error("Canonical Stock Token not found");
    error.name = "NotFoundError";
    throw error;
  }

  const [quote, profileResult] = await Promise.all([
    fetchProviderRecord(QUOTE_URL, asset.symbol),
    fetchProviderRecord(PROFILE_URL, asset.symbol).catch(() => null),
  ]);
  if (!quote || number(quote.price) === null) {
    const error = new Error("Market quote not found");
    error.name = "NotFoundError";
    throw error;
  }

  const profile = profileResult;
  const timestamp = number(quote.timestamp);
  const quoteUpdatedAt = timestamp ? new Date(timestamp * 1_000) : new Date();

  return GetStockTokenMarketDetailResponse.parse({
    provider: "Financial Modeling Prep",
    asOf: new Date(),
    quoteUpdatedAt,
    symbol: asset.symbol,
    name: text(profile?.companyName) ?? text(quote.name) ?? asset.name,
    contractAddress: asset.address,
    chainId: 4663,
    explorerUrl: `${ROBINHOOD_EXPLORER_URL}/token/${asset.address}`,
    logoUrl:
      safeUrl(profile?.image) ??
      `https://images.financialmodelingprep.com/symbol/${encodeURIComponent(asset.symbol)}.png`,
    currency: text(profile?.currency),
    exchange:
      text(profile?.exchangeFullName) ??
      text(profile?.exchange) ??
      text(quote.exchange),
    price: number(quote.price),
    change: number(quote.change),
    changePercent: number(quote.changePercentage),
    open: number(quote.open),
    previousClose: number(quote.previousClose),
    dayLow: number(quote.dayLow),
    dayHigh: number(quote.dayHigh),
    yearLow: number(quote.yearLow),
    yearHigh: number(quote.yearHigh),
    volume: number(quote.volume),
    averageVolume: number(profile?.averageVolume),
    marketCap: number(quote.marketCap) ?? number(profile?.marketCap),
    sector: text(profile?.sector),
    industry: text(profile?.industry),
    country: text(profile?.country),
    website: safeUrl(profile?.website),
    description: text(profile?.description),
    isEtf: profile?.isEtf === true,
  });
}

router.get(
  "/stock-tokens/:address/market-detail",
  async (req, res): Promise<void> => {
    const parsed = GetStockTokenMarketDetailParams.safeParse({
      address: req.params.address,
    });
    if (
      !parsed.success ||
      !isAddress(parsed.data.address)
    ) {
      res.status(400).json({ error: "Use a valid canonical contract address" });
      return;
    }

    const address = getAddress(parsed.data.address);
    const cacheKey = address.toLowerCase();
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.json(cached.payload);
      return;
    }

    let request = inFlight.get(cacheKey);
    if (!request) {
      request = loadMarketDetail(address);
      inFlight.set(cacheKey, request);
    }

    try {
      const payload = await request;
      cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, payload });
      req.log.info(
        {
          operation: "stock-token-market-detail-read",
          symbol: payload.symbol,
          contractAddress: payload.contractAddress,
          quoteUpdatedAt: payload.quoteUpdatedAt,
        },
        "Stock Token market detail read",
      );
      res.json(payload);
    } catch (error) {
      const notFound =
        error instanceof Error && error.name === "NotFoundError";
      req.log[notFound ? "warn" : "error"](
        {
          operation: "stock-token-market-detail-read",
          contractAddress: address,
          err: error,
        },
        "Stock Token market detail failed",
      );
      res.status(notFound ? 404 : 502).json({
        error: notFound
          ? "Market detail is unavailable for this canonical asset"
          : "Market data provider is unavailable",
      });
    } finally {
      inFlight.delete(cacheKey);
    }
  },
);

export default router;