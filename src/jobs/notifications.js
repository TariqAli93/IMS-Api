import { addDays, startOfDay, endOfDay } from 'date-fns';
import { send } from '../notify/index.js';

export async function runDueInstallmentsScan(app) {
  const from = startOfDay(new Date());
  const to = endOfDay(addDays(from, 3));
  const due = await app.prisma.installment.findMany({
    where: { status: 'PENDING', dueDate: { gte: from, lte: to } },
    include: { contract: { include: { customer: true } } }
  });
  for (const inst of due) {
    await send(app, 'due_soon', {
      installmentId: inst.id,
      contractId: inst.contractId,
      customer: inst.contract.customer.name,
      dueDate: inst.dueDate
    });
  }
  return { count: due.length };
}

export async function runLowStockScan(app) {
  const all = await app.prisma.product.findMany();
  let count = 0;
  for (const p of all) {
    if (p.stock < p.stockThreshold) {
      count++;
      await send(app, 'low_stock', {
        productId: p.id, name: p.name,
        stock: p.stock, threshold: p.stockThreshold
      });
    }
  }
  return { count };
}
