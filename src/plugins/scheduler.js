import fp from "fastify-plugin";
import cron from "node-cron";

const TZ = "Asia/Baghdad";

async function markOverdueAndRecalc(app) {
  const now = new Date();

  // نفّذ القراءة والتحديث داخل ترانزاكشن واحدة وباستعلامات مُعلّمة لتجنّب SQL injection
  const { instIds, affectedContracts } = await app.prisma.$transaction(async (tx) => {
    // 1) هات الأقساط المتأخرة وغير المسددة بالكامل (paidCents < amountCents)
    // استخدم $queryRaw المعلّم بدل $queryRawUnsafe
    const overdueRows = await tx.$queryRaw`
      SELECT id, contractId
      FROM Installment
      WHERE dueDate < ${now} AND paidCents < amountCents AND status <> ${"PAID"}
    `;

    const instIdsLocal = overdueRows.map((r) => Number(r.id));
    const affectedContractsLocal = [...new Set(overdueRows.map((r) => Number(r.contractId)))];

    // 2) حدّث حالة الأقساط إلى LATE (للّي مو PAID)
    if (instIdsLocal.length) {
      // استخدم updateMany على مجموعة المعرفات مع شرط status <> 'PAID' كحماية إضافية ضد السباق
      await tx.installment.updateMany({
        where: { id: { in: instIdsLocal }, status: { not: "PAID" } },
        data: { status: "LATE" }
      });
    }

    return { instIds: instIdsLocal, affectedContracts: affectedContractsLocal };
  });

  // 3) أعد حساب حالة العقود المتأثرة
  await recalcContracts(app, affectedContracts);

  // 4) سجّل لوق بسيط
  if (instIds.length) {
    await app.prisma.notificationLog.create({
      data: {
        type: "SCHEDULER_OVERDUE",
        payload: JSON.stringify({ count: instIds.length, at: now.toISOString() })
      }
    });
  }
}

async function markPaidAndRecalc(app) {
  // الأقساط التي أصبحت paidCents >= amountCents وليست PAID
  const toPaid = await app.prisma.$queryRawUnsafe(
    `
    SELECT id, contractId
    FROM Installment
    WHERE paidCents >= amountCents AND status <> 'PAID'
    `
  );
  const ids = toPaid.map((r) => Number(r.id));
  const affected = [...new Set(toPaid.map((r) => Number(r.contractId)))];

  if (ids.length) {
    await app.prisma.$transaction(ids.map((id) => app.prisma.installment.update({ where: { id }, data: { status: "PAID" } })));
  }

  await recalcContracts(app, affected);

  if (ids.length) {
    await app.prisma.notificationLog.create({
      data: {
        type: "SCHEDULER_MARK_PAID",
        payload: JSON.stringify({ count: ids.length, at: new Date().toISOString() })
      }
    });
  }
}

async function recalcContracts(app, contractIds) {
  if (!contractIds.length) return;
  // أعِد حساب حالة كل عقد:
  // CLOSED إذا كل الأقساط مدفوعة
  // DEFAULTED إذا في قسط متأخر غير مدفوع
  // ACTIVE خلاف ذلك
  for (const cid of contractIds) {
    const insts = await app.prisma.installment.findMany({ where: { contractId: cid } });
    if (!insts.length) continue;
    const allPaid = insts.every((i) => i.paidCents >= i.amountCents);
    const anyLateUnpaid = insts.some((i) => i.dueDate < new Date() && i.paidCents < i.amountCents);
    const status = allPaid ? "CLOSED" : anyLateUnpaid ? "DEFAULTED" : "ACTIVE";
    await app.prisma.contract.update({ where: { id: cid }, data: { status } });
  }
}

async function lowStockAlert(app) {
  const prods = await app.prisma.product.findMany();
  const low = prods.filter((p) => p.stock <= p.stockThreshold);
  if (!low.length) return;
  await app.prisma.notificationLog.create({
    data: {
      type: "LOW_STOCK",
      payload: JSON.stringify({ at: new Date().toISOString(), items: low.map((p) => ({ id: p.id, name: p.name, stock: p.stock, threshold: p.stockThreshold })) })
    }
  });
}

// --- helpers للإرسال ---
async function sendSMS({ to, text }) {
  // TODO: وصل بمزوّدك (Twilio/WhatsApp Cloud API)
  // ارجع كائن نجاح/فشل
  // مثال: return { ok: true, providerId: "msg_123" };
  return { ok: true, providerId: "mock-" + Date.now() };
}

function dinarFmt(cents) {
  // فرضًا الـ cents = فلس * 100. عدّل حسب نظامك.
  const v = (cents / 100).toFixed(0);
  return `${v} د.ع`;
}

function msgOverdue({ name, seq, dueDate, amountCents, paidCents, sender }) {
  const rem = amountCents - paidCents;
  return `عزيزي/عزيزتي ${name}، لديك قسط رقم ${seq} متأخر منذ ${dueDate.toLocaleDateString("ar-IQ")} بمبلغ ${dinarFmt(rem)}. يرجى التسديد في أقرب وقت. - ${sender}`;
}

function msgUpcoming({ name, seq, dueDate, amountCents, paidCents, days, sender }) {
  const rem = amountCents - paidCents;
  return `تذكير: القسط رقم ${seq} يستحق بتاريخ ${dueDate.toLocaleDateString("ar-IQ")} (بعد ${days} يوم). المبلغ المتبقي ${dinarFmt(rem)}. - ${sender}`;
}

async function alreadyNotifiedRecently(app, kind, installmentId, hours = 24) {
  const since = new Date(Date.now() - hours * 3600 * 1000);
  const rows = await app.prisma.notificationLog.findMany({
    where: {
      type: kind,
      createdAt: { gte: since }
    },
    orderBy: { createdAt: "desc" },
    take: 100
  });
  return rows.some((r) => {
    try {
      const p = JSON.parse(r.payload || "{}");
      return p.installmentId === installmentId;
    } catch {
      return false;
    }
  });
}

// تجميع العملاء المتأثرين مع أقساطهم (overdue + upcoming)
async function collectReminderCandidates(app) {
  const daysBefore = Number(process.env.REMINDER_DAYS_BEFORE ?? 3);
  const resendHours = Number(process.env.REMINDER_RESEND_HOURS ?? 24);
  const now = new Date();
  const soon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysBefore); // نهاية اليوم بعد N أيام

  // overdue: dueDate < اليوم و paidCents < amountCents
  const overdue = await app.prisma.$queryRawUnsafe(`
    SELECT i.id, i.seq, i.dueDate, i.amountCents, i.paidCents, ct.id AS contractId, c.id AS customerId, c.name, c.phone
    FROM Installment i
    JOIN Contract ct ON ct.id = i.contractId
    JOIN Customer c ON c.id = ct.customerId
    WHERE i.dueDate < CURRENT_TIMESTAMP() AND i.paidCents < i.amountCents
  `);

  // upcoming: dueDate اليوم .. حتى soon و paidCents < amountCents
  const upcoming = await app.prisma.$queryRawUnsafe(
    `
    SELECT i.id, i.seq, i.dueDate, i.amountCents, i.paidCents, ct.id AS contractId, c.id AS customerId, c.name, c.phone
    FROM Installment i
    JOIN Contract ct ON ct.id = i.contractId
    JOIN Customer c ON c.id = ct.customerId
    WHERE i.dueDate >= CURRENT_DATE() AND i.dueDate <= ? AND i.paidCents < i.amountCents
    `,
    soon
  );

  // رشّح حسب عدم التذكير الحديث
  const filteredOverdue = [];
  for (const r of overdue) {
    const skip = await alreadyNotifiedRecently(app, "REMINDER_OVERDUE", Number(r.id), resendHours);
    if (!skip) filteredOverdue.push(r);
  }

  const filteredUpcoming = [];
  for (const r of upcoming) {
    const skip = await alreadyNotifiedRecently(app, "REMINDER_UPCOMING", Number(r.id), resendHours);
    if (!skip) filteredUpcoming.push(r);
  }

  return { overdue: filteredOverdue, upcoming: filteredUpcoming, daysBefore };
}

async function runReminders(app) {
  const sender = process.env.SENDER_NAME || "Tasdeed";
  const { overdue, upcoming, daysBefore } = await collectReminderCandidates(app);

  let sent = 0;
  let errors = 0;

  // أرسل المتأخر
  for (const i of overdue) {
    if (!i.phone) continue;
    const text = msgOverdue({
      name: i.name,
      seq: i.seq,
      dueDate: new Date(i.dueDate),
      amountCents: Number(i.amountCents),
      paidCents: Number(i.paidCents),
      sender
    });
    const res = await sendSMS({ to: i.phone, text }).catch((e) => ({ ok: false, error: String(e) }));
    await app.prisma.notificationLog.create({
      data: {
        type: "REMINDER_OVERDUE",
        payload: JSON.stringify({
          installmentId: Number(i.id),
          contractId: Number(i.contractId),
          customerId: Number(i.customerId),
          phone: i.phone,
          ok: !!res.ok,
          providerId: res.providerId ?? null,
          error: res.ok ? null : res.error || "send_failed",
          text
        })
      }
    });
    res.ok ? sent++ : errors++;
  }

  // أرسل القريب الاستحقاق
  for (const i of upcoming) {
    if (!i.phone) continue;
    const days = Math.max(0, Math.ceil((new Date(i.dueDate) - new Date()) / 86400000));
    const text = msgUpcoming({
      name: i.name,
      seq: i.seq,
      dueDate: new Date(i.dueDate),
      amountCents: Number(i.amountCents),
      paidCents: Number(i.paidCents),
      days,
      sender
    });
    const res = await sendSMS({ to: i.phone, text }).catch((e) => ({ ok: false, error: String(e) }));
    await app.prisma.notificationLog.create({
      data: {
        type: "REMINDER_UPCOMING",
        payload: JSON.stringify({
          installmentId: Number(i.id),
          contractId: Number(i.contractId),
          customerId: Number(i.customerId),
          phone: i.phone,
          ok: !!res.ok,
          providerId: res.providerId ?? null,
          error: res.ok ? null : res.error || "send_failed",
          text
        })
      }
    });
    res.ok ? sent++ : errors++;
  }

  return { sent, errors, overdue: overdue.length, upcoming: upcoming.length, daysBefore };
}

export default fp(async function schedulerPlugin(app, opts) {
  const enabled = opts?.enabled ?? true;
  if (!enabled) return;

  const jobs = [];

  // Job 1: كل 15 دقيقة → علّم المتأخر وشيّك العقود
  const j1 = cron.schedule("*/15 * * * *", () => markOverdueAndRecalc(app).catch((e) => app.log.error(e)), { timezone: TZ });
  jobs.push(j1);

  // Job 2: كل 10 دقائق → علّم الأقساط اللي اكتملت دفعاتها كـ PAID + شيّك العقود
  const j2 = cron.schedule("*/10 * * * *", () => markPaidAndRecalc(app).catch((e) => app.log.error(e)), { timezone: TZ });
  jobs.push(j2);

  // Job 3: يوميًا 08:30 صباحًا بغداد → تنبيه مخزون منخفض
  const j3 = cron.schedule("30 8 * * *", () => lowStockAlert(app).catch((e) => app.log.error(e)), { timezone: TZ });
  jobs.push(j3);

  const j4 = cron.schedule("0 9 * * *", () => runReminders(app).catch((e) => app.log.error(e)), { timezone: TZ });
  jobs.push(j4);

  // API إداري بسيط لتشغيل أي Job يدويًا
  app.post(
    "/admin/jobs/run",
    {
      preHandler: [app.verifyJwt],
      schema: {
        tags: ["admin"],
        body: {
          type: "object",
          properties: {
            job: { type: "string", enum: Object.values({ overdue: "overdue", markPaid: "markPaid", lowStock: "lowStock" }) }
          },
          required: ["job"]
        }
      }
    },
    async (req, reply) => {
      const { job } = req.body || {};
      try {
        if (job === "overdue") {
          await markOverdueAndRecalc(app);
          return { ok: true, ran: "overdue" };
        }
        if (job === "markPaid") {
          await markPaidAndRecalc(app);
          return { ok: true, ran: "markPaid" };
        }
        if (job === "lowStock") {
          await lowStockAlert(app);
          return { ok: true, ran: "lowStock" };
        }
        return reply.error(400, "Unknown job");
      } catch (e) {
        app.log.error(e);
        return reply.error(500, "Job failed");
      }
    }
  );

  // Preview: يشوف من راح يتذكّر اليوم بدون إرسال
  app.get("/admin/reminders/preview", { preHandler: [app.verifyJwt], schema: { tags: ["admin"] } }, async () => {
    const { overdue, upcoming, daysBefore } = await collectReminderCandidates(app);
    return {
      daysBefore,
      counts: { overdue: overdue.length, upcoming: upcoming.length },
      sample: {
        overdue: overdue.slice(0, 5),
        upcoming: upcoming.slice(0, 5)
      }
    };
  });

  // Send now: إرسال فوري يدوي
  app.post(
    "/admin/reminders/send",
    {
      preHandler: [app.verifyJwt],
      schema: {
        tags: ["admin"],
        body: {
          type: "object",
          properties: {
            job: { type: "string", enum: ["overdue", "upcoming"] }
          },
          required: ["job"]
        }
      }
    },
    async () => {
      const res = await runReminders(app);
      return res;
    }
  );

  // تنظيف عند الإغلاق
  app.addHook("onClose", async () => {
    for (const j of jobs) j.stop();
  });

  app.log.info({ msg: "scheduler registered", timezone: TZ, jobs: 3 });
});
