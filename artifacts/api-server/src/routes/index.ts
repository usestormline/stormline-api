import { Router, type IRouter } from "express";
import economicCalendarRouter from "./economic-calendar";
import healthRouter from "./health";
import intelligenceNewsRouter from "./intelligence-news";
import marketDetailRouter from "./market-detail";
import networkActivityRouter from "./network-activity";
import stockTokensRouter from "./stock-tokens";

const router: IRouter = Router();

router.use(economicCalendarRouter);
router.use(healthRouter);
router.use(intelligenceNewsRouter);
router.use(marketDetailRouter);
router.use(networkActivityRouter);
router.use(stockTokensRouter);

export default router;
