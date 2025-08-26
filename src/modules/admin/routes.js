import { runDueInstallmentsScan, runLowStockScan } from "../../jobs/notifications.js";
export default async function routes(app) {
  app.post(
    "/run-notifications",
    {
      preHandler: [app.verifyJwt, app.authorize("product", "read")],
      schema: {
        tags: ["admin"]
      }
    },
    async (req, rep) => {
      try {
        console.log(req.user);
        const results = {};
        results.due = await runDueInstallmentsScan(app);
        results.stock = await runLowStockScan(app);
        return { ok: true, results };
      } catch (error) {
        console.error("Error running notification scans:", error);
        return { ok: false, error: "Failed to run notification scans" };
      }
    }
  );
}
