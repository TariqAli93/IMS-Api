import { runDueInstallmentsScan, runLowStockScan } from "../../jobs/notifications.js";
export default async function routes(app) {
  const adminGuard = [app.verifyJwt, app.authorize("*", "*")];
  app.post(
    "/run-notifications",
    {
      preHandler: adminGuard,
      schema: {
        tags: ["admin"]
      }
    },
    async (req, rep) => {
      try {
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
