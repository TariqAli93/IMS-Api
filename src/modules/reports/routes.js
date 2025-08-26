// src/modules/reports/routes.js
export default async function routes(app) {
  const auth = { preHandler: [app.verifyJwt] };
  const schema = {
    tags: ["reports"]
  };

  const toInt = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
  };
  const toDate = (v) => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  // ---------- GET /reports/summary ----------
  // ?from=2025-01-01&to=2025-12-31
  app.get(
    "/reports/summary",
    {
      ...auth,
      schema: {
        ...schema,
        querystring: {
          type: "object",
          properties: {
            from: { type: "string", format: "date-time", nullable: true },
            to: { type: "string", format: "date-time", nullable: true }
          }
        }
      }
    },
    async (req) => {
      const from = toDate(req.query.from);
      const to = toDate(req.query.to);
      const range = from || to ? { gte: from ?? new Date(0), lte: to ?? new Date() } : undefined;

      const [
        customersCount,
        productsCount,
        contractsCounts,
        totalInstallments, // sum amounts
        totalPaid, // sum paidCents
        overdueAgg, // overdue count + amount
        paymentsInRange // sum payments in range
      ] = await app.prisma.$transaction([
        app.prisma.customer.count(),
        app.prisma.product.count(),
        app.prisma.contract.groupBy({
          by: ["status"],
          _count: { status: true }
        }),
        app.prisma.installment.aggregate({
          _sum: range ? { amountCents: true } : { amountCents: true },
          where: range ? { dueDate: range } : undefined
        }),
        app.prisma.installment.aggregate({
          _sum: range ? { paidCents: true } : { paidCents: true },
          where: range ? { dueDate: range } : undefined
        }),
        app.prisma.installment.aggregate({
          _count: true,
          _sum: { amountCents: true, paidCents: true },
          where: {
            dueDate: { lt: new Date() },
            // غير مسدّد بالكامل
            paidCents: { lt: app.prisma.installment.fields.amountCents } // مو مدعومة كـ filter، فنعالج الفرق تحت
          }
        }),
        app.prisma.payment.aggregate({
          _sum: { amountCents: true },
          where: range ? { paidAt: range } : undefined
        })
      ]);

      // معالجة overdue لأن شرط paidCents<amountCents ما ينكتب مباشرة
      const overdueItems = await app.prisma.installment.findMany({
        where: { dueDate: { lt: new Date() } },
        select: { amountCents: true, paidCents: true },
        take: 1000 // سقف احترازي
      });
      const overdueFiltered = overdueItems.filter((i) => i.paidCents < i.amountCents);
      const overdueAmount = overdueFiltered.reduce((s, i) => s + (i.amountCents - i.paidCents), 0);

      const contractsByStatus = Object.fromEntries(contractsCounts.map((c) => [c.status, c._count.status]));

      const totalAmount = totalInstallments._sum.amountCents ?? 0;
      const totalPaidCents = totalPaid._sum.paidCents ?? 0;
      const outstanding = Math.max(totalAmount - totalPaidCents, 0);

      return {
        entities: {
          customers: customersCount,
          products: productsCount,
          contractsByStatus
        },
        receivables: {
          totalAmountCents: totalAmount,
          totalPaidCents,
          outstandingCents: outstanding,
          overdue: {
            count: overdueFiltered.length,
            amountCents: overdueAmount
          }
        },
        payments: {
          range: { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null },
          totalInRangeCents: paymentsInRange._sum.amountCents ?? 0
        }
      };
    }
  );

  // ---------- GET /reports/aging ----------
  // أعمار الذمم بناءً على فرق الأيام (اليوم - dueDate) للأقساط غير المسددة بالكامل
  app.get("/reports/aging", { ...auth, schema: { tags: ["reports"] } }, async () => {
    const items = await app.prisma.installment.findMany({
      where: {},
      select: { dueDate: true, amountCents: true, paidCents: true },
      take: 1000 // سقف احترازي
    });
    const now = new Date();
    const bucket = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
    const count = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };

    for (const i of items) {
      const rem = i.amountCents - i.paidCents;
      if (rem <= 0) continue;
      const days = Math.floor((now - i.dueDate) / 86400000);
      if (days <= 0) continue; // غير متأخر
      if (days <= 30) {
        bucket["0-30"] += rem;
        count["0-30"]++;
      } else if (days <= 60) {
        bucket["31-60"] += rem;
        count["31-60"]++;
      } else if (days <= 90) {
        bucket["61-90"] += rem;
        count["61-90"]++;
      } else {
        bucket["90+"] += rem;
        count["90+"]++;
      }
    }

    return { bucketsCents: bucket, counts: count };
  });

  // ---------- GET /reports/payments/timeseries ----------
  // ?from=2025-01-01&to=2025-08-31&bucket=day|month
  app.get(
    "/reports/payments/timeseries",
    {
      ...auth,
      schema: {
        ...schema,
        querystring: {
          type: "object",
          properties: {
            from: { type: "string", format: "date-time", nullable: true },
            to: { type: "string", format: "date-time", nullable: true },
            bucket: { type: "string", enum: ["day", "month"], default: "day" }
          }
        }
      }
    },
    async (req) => {
      const from = toDate(req.query.from) ?? new Date(0);
      const to = toDate(req.query.to) ?? new Date();
      const bucket = req.query.bucket || "day";

      // MySQL تجميع حسب يوم/شهر
      // day  -> DATE(paidAt)
      // month-> DATE_FORMAT(paidAt, '%Y-%m-01')
      const dateExpr = bucket === "month" ? `DATE_FORMAT(paidAt, '%Y-%m-01')` : `DATE(paidAt)`;

      const rows = await app.prisma.$queryRawUnsafe(
        `
        SELECT ${dateExpr} AS bucket, SUM(amountCents) AS sumCents, COUNT(*) AS n
        FROM Payment
        WHERE paidAt >= ? AND paidAt <= ?
        GROUP BY bucket
        ORDER BY bucket ASC
        `,
        from,
        to
      );

      return {
        bucket,
        from: from.toISOString(),
        to: to.toISOString(),
        points: rows.map((r) => ({
          bucket: typeof r.bucket === "string" ? r.bucket : new Date(r.bucket).toISOString().slice(0, 10),
          sumCents: Number(r.sumCents || 0),
          count: Number(r.n || 0)
        }))
      };
    }
  );

  // ---------- GET /reports/inventory/low-stock ----------
  // المنتجات التي مخزونها <= العتبة
  app.get("/reports/inventory/low-stock", { ...auth, schema: { ...schema } }, async () => {
    const items = await app.prisma.product.findMany();
    const low = items.filter((p) => p.stock <= p.stockThreshold);
    return { count: low.length, items: low };
  });

  // ---------- GET /reports/customers/top ----------
  // ?limit=10&from=2025-01-01&to=2025-08-31
  app.get(
    "/reports/customers/top",
    {
      ...auth,
      schema: {
        ...schema,
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
            from: { type: "string", format: "date-time", nullable: true },
            to: { type: "string", format: "date-time", nullable: true }
          }
        }
      }
    },
    async (req) => {
      const limit = toInt(req.query.limit, 10);
      const from = toDate(req.query.from) ?? new Date(0);
      const to = toDate(req.query.to) ?? new Date();

      // نجمع المدفوعات لكل عميل عبر join سلسلة: Payment -> Installment -> Contract -> Customer
      const rows = await app.prisma.$queryRawUnsafe(
        `
        SELECT c.id AS customerId, c.name AS customerName, SUM(p.amountCents) AS sumCents, COUNT(p.id) AS paymentsCount
        FROM Payment p
        JOIN Installment i ON i.id = p.installmentId
        JOIN Contract   ct ON ct.id = i.contractId
        JOIN Customer   c  ON c.id  = ct.customerId
        WHERE p.paidAt >= ? AND p.paidAt <= ?
        GROUP BY c.id, c.name
        ORDER BY sumCents DESC
        LIMIT ?
        `,
        from,
        to,
        limit
      );

      return rows.map((r) => ({
        customerId: Number(r.customerId),
        customerName: r.customerName,
        totalPaidCents: Number(r.sumCents || 0),
        paymentsCount: Number(r.paymentsCount || 0)
      }));
    }
  );

  // ---------- GET /reports/contracts/status ----------
  app.get("/reports/contracts/status", { ...auth, schema: { ...schema } }, async () => {
    const rows = await app.prisma.contract.groupBy({
      by: ["status"],
      _count: { status: true }
    });
    return Object.fromEntries(rows.map((r) => [r.status, r._count.status]));
  });
}
