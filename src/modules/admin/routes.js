export default async function routes(app) {
  const auth = { preHandler: [app.verifyJwt] };
  const schema = {
    tags: ["admin"]
  };
  app.post("/run-notifications", { ...auth, schema: { ...schema } }, async () => {
    const { runDueInstallmentsScan, runLowStockScan } = await import("../../jobs/notifications.js");
    const results = {};
    results.due = await runDueInstallmentsScan(app);
    results.stock = await runLowStockScan(app);
    return { ok: true, results };
  });
}
