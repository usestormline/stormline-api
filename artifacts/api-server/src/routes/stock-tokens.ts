import { Router, type IRouter } from "express";
import {
  GetStockTokenPortfolioQueryParams,
  GetStockTokenPortfolioResponse,
  GetStockTokenAssetsResponse,
  GetStockTokenRegistryResponse,
  SyncStockTokenRegistryResponse,
} from "@usestormline/api-zod-internal";
import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import {
  getCanonicalAssets,
  getRegistryStatus,
  RegistrySyncThrottledError,
  syncStockTokenRegistry,
} from "../lib/stock-token-registry";
import { timingSafeEqual } from "node:crypto";
import {
  ROBINHOOD_CHAIN_ID as CHAIN_ID,
  ROBINHOOD_CHAIN_NAME,
  ROBINHOOD_EXPLORER_URL as EXPLORER_URL,
  ROBINHOOD_RPC_URL as RPC_URL,
} from "../lib/stock-token-config";

const router: IRouter = Router();
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
const PORTFOLIO_TTL_MS = 2 * 60 * 1000;
const MULTICALL3_ABI = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

type PortfolioPayload = ReturnType<typeof GetStockTokenPortfolioResponse.parse>;

const portfolioCache = new Map<
  string,
  { expiresAt: number; payload: PortfolioPayload }
>();
const portfolioRequests = new Map<string, Promise<PortfolioPayload>>();

function balanceOfData(address: string) {
  return `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
}

function formatUnits(value: bigint, decimals: number) {
  if (decimals === 0) return value.toString();
  const padded = value.toString().padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function parseDecimal(value: string, decimals = 18) {
  const [whole = "0", fraction = ""] = value.split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) return 10n ** BigInt(decimals);
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.slice(0, decimals).padEnd(decimals, "0"))
  );
}

async function loadPortfolio(address: string) {
  const assets = (await getCanonicalAssets()).filter(
    (asset) => asset.status === "ASSET_STATUS_ACTIVE",
  );
  const callData = encodeFunctionData({
    abi: MULTICALL3_ABI,
    functionName: "aggregate3",
    args: [
      assets.map((asset) => ({
        target: asset.address as Address,
        allowFailure: true,
        callData: balanceOfData(address),
      })),
    ],
  });

  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        { to: MULTICALL3_ADDRESS, data: callData },
        "latest",
      ],
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new Error(`Robinhood Chain RPC returned ${response.status}`);
  }
  const body = (await response.json()) as {
    result?: unknown;
    error?: { message?: unknown };
  };
  if (typeof body.result !== "string" || !/^0x[a-fA-F0-9]+$/.test(body.result)) {
    const message =
      typeof body.error?.message === "string"
        ? body.error.message
        : "invalid multicall response";
    throw new Error(`Robinhood Chain RPC returned ${message}`);
  }
  const results = decodeFunctionResult({
    abi: MULTICALL3_ABI,
    functionName: "aggregate3",
    data: body.result as Hex,
  });
  if (results.length !== assets.length) {
    throw new Error("Robinhood Chain RPC returned an incomplete multicall");
  }

  const holdings = assets.flatMap((asset, index) => {
    const result = results[index];
    const rawBalance =
      result?.success && /^0x[a-fA-F0-9]{64}$/.test(result.returnData)
        ? BigInt(result.returnData)
        : 0n;
    if (rawBalance === 0n) return [];
    const multiplierScale = 10n ** 18n;
    const effectiveRaw =
      (rawBalance * parseDecimal(asset.currentMultiplier)) / multiplierScale;

    return [
      {
        symbol: asset.symbol,
        name: asset.name,
        contractAddress: asset.address,
        chainId: CHAIN_ID,
        rawBalance: rawBalance.toString(),
        balance: formatUnits(rawBalance, asset.tokenDecimals),
        effectiveBalance: formatUnits(effectiveRaw, asset.tokenDecimals),
        decimals: asset.tokenDecimals,
        currentMultiplier: asset.currentMultiplier,
        logoUrl: asset.logoUrl,
        isin: asset.isin,
        status: asset.status,
        explorerUrl: `${EXPLORER_URL}/token/${asset.address}`,
      },
    ];
  });

  return GetStockTokenPortfolioResponse.parse({
    provider: "Robinhood Stock Token API",
    chainId: CHAIN_ID,
    chainName: ROBINHOOD_CHAIN_NAME,
    walletAddress: address,
    asOf: new Date(),
    status: "live",
    catalogCount: assets.filter((asset) => asset.chainlinkFeed !== null).length,
    holdings,
  });
}

router.get("/stock-tokens/portfolio", async (req, res): Promise<void> => {
  const parsed = GetStockTokenPortfolioQueryParams.safeParse({
    address: req.query.address,
  });
  if (!parsed.success) {
    res.status(400).json({ error: "Use a valid EVM wallet address" });
    return;
  }

  const address = parsed.data.address.toLowerCase();
  const cached = portfolioCache.get(address);
  if (cached && cached.expiresAt > Date.now()) {
    res.json({ ...cached.payload, status: "cached" });
    return;
  }

  try {
    let request = portfolioRequests.get(address);
    const joinedExistingRequest = Boolean(request);
    if (!request) {
      request = loadPortfolio(address);
      portfolioRequests.set(address, request);
    }
    const payload = await request;
    portfolioCache.set(address, {
      expiresAt: Date.now() + PORTFOLIO_TTL_MS,
      payload,
    });
    req.log.info(
      {
        operation: "stock-token-portfolio-read",
        catalogCount: payload.catalogCount,
        holdingCount: payload.holdings.length,
        cached: joinedExistingRequest,
      },
      "Robinhood Stock Token portfolio read",
    );
    res.json({
      ...payload,
      status: joinedExistingRequest ? "cached" : payload.status,
    });
  } catch (error) {
    req.log.error(
      {
        operation: "stock-token-portfolio-read",
        error: error instanceof Error ? error.message : "Unknown provider error",
      },
      "Robinhood Stock Token portfolio failed",
    );
    if (cached) {
      res.json({ ...cached.payload, status: "cached" });
      return;
    }
    res.status(502).json({ error: "Stock Token portfolio is temporarily unavailable" });
  } finally {
    portfolioRequests.delete(address);
  }
});

router.get("/stock-tokens/registry", async (req, res): Promise<void> => {
  try {
    const status = await getRegistryStatus();
    res.json(GetStockTokenRegistryResponse.parse({
      chainId: CHAIN_ID,
      chainName: ROBINHOOD_CHAIN_NAME,
      ...status,
    }));
  } catch (error) {
    req.log.error(
      {
        operation: "stock-token-registry-status",
        error: error instanceof Error ? error.message : "Unknown database error",
      },
      "Stock Token registry status failed",
    );
    res.status(503).json({ error: "Stock Token registry is unavailable" });
  }
});

router.get("/stock-tokens/assets", async (req, res): Promise<void> => {
  try {
    const assets = await getCanonicalAssets();
    res.json(
      GetStockTokenAssetsResponse.parse({
        chainId: CHAIN_ID,
        chainName: ROBINHOOD_CHAIN_NAME,
        asOf: new Date(),
        assets: assets.map((asset) => ({
          address: asset.address,
          symbol: asset.symbol,
          name: asset.name,
          status: asset.status,
          logoUrl: asset.logoUrl,
          isin: asset.isin,
          explorerUrl: `${EXPLORER_URL}/token/${asset.address}`,
          priceReady: asset.chainlinkFeed !== null,
          allDayTradability: asset.allDayTradability,
           currentMultiplier: asset.currentMultiplier,
        })),
      }),
    );
  } catch (error) {
    req.log.error(
      {
        operation: "stock-token-assets",
        error: error instanceof Error ? error.message : "Unknown database error",
      },
      "Canonical Stock Token catalog failed",
    );
    res.status(503).json({ error: "Canonical Stock Token catalog is unavailable" });
  }
});

router.post("/stock-tokens/registry/sync", async (req, res): Promise<void> => {
  const configuredToken =
    process.env.STOCK_TOKEN_SYNC_TOKEN ?? process.env.SESSION_SECRET;
  const authorization = req.get("authorization");
  const providedToken = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  const authorized =
    Boolean(configuredToken) &&
    Buffer.byteLength(providedToken) === Buffer.byteLength(configuredToken!) &&
    timingSafeEqual(Buffer.from(providedToken), Buffer.from(configuredToken!));
  if (!authorized) {
    res.status(401).json({ error: "Sync authorization required" });
    return;
  }

  try {
    const status = await syncStockTokenRegistry();
    portfolioCache.clear();
    res.json(SyncStockTokenRegistryResponse.parse({
      chainId: CHAIN_ID,
      chainName: ROBINHOOD_CHAIN_NAME,
      ...status,
    }));
  } catch (error) {
    if (error instanceof RegistrySyncThrottledError) {
      res.set("Retry-After", String(error.retryAfterSeconds));
      res.status(429).json({
        error: "Stock Token registry sync is throttled",
        retryAfterSeconds: error.retryAfterSeconds,
      });
      return;
    }
    req.log.error(
      {
        operation: "stock-token-registry-sync",
        error: error instanceof Error ? error.message : "Unknown sync error",
      },
      "On-demand Stock Token registry synchronization failed",
    );
    res.status(502).json({ error: "Stock Token registry sync failed" });
  }
});

export default router;