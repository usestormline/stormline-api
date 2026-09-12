import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { HealthCheckResponse } from "@usestormline/api-zod-internal";

const router: IRouter = Router();

const respondHealthy = (_req: Request, res: Response) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
};

router.get("/", respondHealthy);
router.get("/healthz", respondHealthy);

export default router;
