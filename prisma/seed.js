import "dotenv/config";
import { PrismaClient, RoleName, InstallmentStatus, ContractStatus, DocType } from "@prisma/client";
import { config } from "dotenv";

const prisma = new PrismaClient({
  log: ["query", "info", "warn", "error"]
});
const SALT_ROUNDS = 10;

config({
  path: process.env.NODE_ENV === "development" ? "../.env.development" : "../.env.production"
});

// ---------- helpers ----------
const today = new Date();
const addMonths = (d, m) => new Date(d.getFullYear(), d.getMonth() + m, d.getDate());

function splitInstallments(total, months) {
  const base = Math.floor(total / months);
  const rest = total - base * months;
  // خليه يرجّع أول قسط فيه الزيادة حتى يساوي المجموع
  return Array.from({ length: months }, (_, i) => base + (i === 0 ? rest : 0));
}

async function upsertRole(name) {
  return prisma.role.upsert({ where: { name }, update: {}, create: { name } });
}

async function ensurePermissions() {
  const resources = ["users", "customers", "products", "contracts", "installments", "payments", "documents", "reports"];
  const actions = ["create", "read", "update", "delete", "export"];
  const data = [];
  for (const r of resources) for (const a of actions) data.push({ resource: r, action: a });
  await prisma.permission.createMany({ data, skipDuplicates: true });

  const perms = await prisma.permission.findMany({
    where: { OR: data.map((d) => ({ resource: d.resource, action: d.action })) }
  });
  const map = new Map(perms.map((p) => [`${p.resource}:${p.action}`, p.id]));
  return { list: perms, map };
}

async function ensureRoles() {
  const admin = await upsertRole(RoleName.ADMIN);
  const manager = await upsertRole(RoleName.MANAGER);
  const staff = await upsertRole(RoleName.STAFF);
  const owner = await upsertRole(RoleName.OWNER);
  return { admin, manager, staff, owner };
}

async function linkRolePermissions(roles, permMap) {
  const allPermIds = [...permMap.values()];

  // ADMIN: كل الصلاحيات
  await prisma.rolePermission.createMany({
    data: allPermIds.map((permId) => ({ roleId: roles.admin.id, permId })),
    skipDuplicates: true
  });

  // MANAGER:
  const mgrPairs = [...["customers", "products", "contracts", "installments", "payments", "documents"].flatMap((r) => ["create", "read", "update", "delete"].map((a) => ({ r, a }))), { r: "reports", a: "read" }, { r: "reports", a: "export" }, { r: "users", a: "read" }];
  await prisma.rolePermission.createMany({
    data: mgrPairs.map(({ r, a }) => ({ roleId: roles.manager.id, permId: permMap.get(`${r}:${a}`) })),
    skipDuplicates: true
  });

  // STAFF:
  const staffPairs = [...["customers", "contracts", "installments", "payments", "documents"].flatMap((r) => ["create", "read", "update"].map((a) => ({ r, a }))), { r: "products", a: "read" }];
  await prisma.rolePermission.createMany({
    data: staffPairs.map(({ r, a }) => ({ roleId: roles.staff.id, permId: permMap.get(`${r}:${a}`) })),
    skipDuplicates: true
  });

  // OWNER: للعرض والتقارير وقراءة المستخدمين
  const ownerPairs = [...["customers", "products", "contracts", "installments", "payments", "documents"].map((r) => ({ r, a: "read" })), { r: "reports", a: "read" }, { r: "reports", a: "export" }, { r: "users", a: "read" }];
  await prisma.rolePermission.createMany({
    data: ownerPairs.map(({ r, a }) => ({ roleId: roles.owner.id, permId: permMap.get(`${r}:${a}`) })),
    skipDuplicates: true
  });
}

async function ensureUsers(roles) {
  // خزن هاش سريع حتى ما نعتمد على bcrypt native هنا (Prisma/Node فقط)
  const { hash } = await import("bcrypt");
  const [adminPass, managerPass, staffPass, ownerPass] = await Promise.all([hash("Admin@123", SALT_ROUNDS), hash("Manager@123", SALT_ROUNDS), hash("Staff@123", SALT_ROUNDS), hash("Owner@123", SALT_ROUNDS)]);

  const admin = await prisma.user.upsert({
    where: { username: "admin" },
    update: {},
    create: { username: "admin", password: adminPass }
  });
  const manager = await prisma.user.upsert({
    where: { username: "manager" },
    update: {},
    create: { username: "manager", password: managerPass }
  });
  const staff = await prisma.user.upsert({
    where: { username: "staff" },
    update: {},
    create: { username: "staff", password: staffPass }
  });
  const owner = await prisma.user.upsert({
    where: { username: "owner" },
    update: {},
    create: { username: "owner", password: ownerPass }
  });

  await prisma.userRole.createMany({
    data: [
      { userId: admin.id, roleId: roles.admin.id },
      { userId: manager.id, roleId: roles.manager.id },
      { userId: staff.id, roleId: roles.staff.id },
      { userId: owner.id, roleId: roles.owner.id }
    ],
    skipDuplicates: true
  });

  return { admin, manager, staff, owner };
}

async function ensureCustomers() {
  const findOrCreate = async (name, phone) => {
    const hit = await prisma.customer.findFirst({ where: { name, phone } });
    return hit ?? prisma.customer.create({ data: { name, phone } });
  };
  const c1 = await findOrCreate("Ali Hassan", "0770000001");
  const c2 = await findOrCreate("Sara Ahmed", "0770000002");
  const c3 = await findOrCreate("Omar Kareem", "0770000003");
  return { c1, c2, c3 };
}

async function ensureCustomerDocs({ c1, c2, c3 }) {
  const docs = [
    {
      customerId: c1.id,
      type: DocType.ID,
      path: `uploads/${c1.id}/ali-national-id.jpg`,
      fileName: "ali-national-id.jpg",
      mimeType: "image/jpeg",
      size: 210345,
      checksum: "chk_ali_id_01"
    },
    {
      customerId: c1.id,
      type: DocType.CONTRACT,
      path: `uploads/${c1.id}/contract-2025-01.pdf`,
      fileName: "contract-2025-01.pdf",
      mimeType: "application/pdf",
      size: 134003,
      checksum: "chk_contract_ali_01"
    },
    {
      customerId: c2.id,
      type: DocType.ID,
      path: `uploads/${c2.id}/sara-id.png`,
      fileName: "sara-id.png",
      mimeType: "image/png",
      size: 130212,
      checksum: "chk_sara_id_01"
    },
    {
      customerId: c3.id,
      type: DocType.RECEIPT,
      path: `uploads/${c3.id}/receipt-001.pdf`,
      fileName: "receipt-001.pdf",
      mimeType: "application/pdf",
      size: 82000,
      checksum: "chk_receipt_omr_01"
    }
  ];

  for (const d of docs) {
    const exists = await prisma.document.findFirst({ where: { customerId: d.customerId, fileName: d.fileName } });
    if (!exists) await prisma.document.create({ data: d });
  }
}

async function ensureProducts() {
  const ensure = async (name, priceCents, stock, stockThreshold) => {
    const hit = await prisma.product.findFirst({ where: { name } });
    return hit ?? prisma.product.create({ data: { name, priceCents, stock, stockThreshold } });
  };
  const p1 = await ensure("Laptop Pro 14", 1450000, 8, 2);
  const p2 = await ensure("Smartphone X", 650000, 20, 5);
  const p3 = await ensure("Printer Lazer", 220000, 6, 2);
  const p4 = await ensure("Router AC1200", 95000, 15, 3);
  const p5 = await ensure('Monitor 27"', 300000, 5, 2);
  return { p1, p2, p3, p4, p5 };
}

async function createContractFull({ customerId, items, months, startDate, status = ContractStatus.ACTIVE }) {
  // items: [{ productId, qty }]
  const ids = items.map((i) => i.productId);
  const prods = await prisma.product.findMany({ where: { id: { in: ids } } });
  const norm = items.map((i) => {
    const p = prods.find((pp) => pp.id === i.productId);
    if (!p) throw new Error("Product not found: " + i.productId);
    return { productId: p.id, qty: i.qty, unitCents: p.priceCents };
  });
  const totalCents = norm.reduce((s, i) => s + i.unitCents * i.qty, 0);

  return prisma.$transaction(async (tx) => {
    // خصم المخزون
    for (const it of norm) {
      await tx.product.update({ where: { id: it.productId }, data: { stock: { decrement: it.qty } } });
    }

    // إنشاء العقد + الأصناف
    const contract = await tx.contract.create({
      data: { customerId, totalCents, months, startDate, status, items: { create: norm } }
    });

    // إنشاء الأقساط
    const amounts = splitInstallments(totalCents, months);
    for (let i = 0; i < months; i++) {
      await tx.installment.create({
        data: {
          contractId: contract.id,
          seq: i + 1,
          dueDate: addMonths(startDate, i),
          amountCents: amounts[i],
          status: InstallmentStatus.PENDING,
          paidCents: 0
        }
      });
    }

    return contract;
  });
}

async function applyPayments(contractId, paymentsByInstallmentSeq) {
  // paymentsByInstallmentSeq: { [seq]: [amountCents, ...] }
  const installments = await prisma.installment.findMany({ where: { contractId }, orderBy: { seq: "asc" } });

  for (const inst of installments) {
    const arr = paymentsByInstallmentSeq[inst.seq] || [];
    for (const amt of arr) {
      await prisma.payment.create({
        data: { installmentId: inst.id, amountCents: amt, paidAt: new Date() }
      });
      await prisma.installment.update({
        where: { id: inst.id },
        data: { paidCents: { increment: amt } }
      });
    }
  }
}

async function recalcInstallmentsAndContract(contractId) {
  const installments = await prisma.installment.findMany({ where: { contractId } });
  const now = new Date();

  // حدّث حالة الأقساط
  for (const inst of installments) {
    let nextStatus = InstallmentStatus.PENDING;
    if (inst.paidCents >= inst.amountCents) nextStatus = InstallmentStatus.PAID;
    else if (inst.dueDate < now) nextStatus = InstallmentStatus.LATE;

    if (nextStatus !== inst.status) {
      await prisma.installment.update({ where: { id: inst.id }, data: { status: nextStatus } });
    }
  }

  // حدّث حالة العقد: إذا كل الأقساط مدفوعة => CLOSED
  // إذا في أقساط متأخرة غير مدفوعة => DEFAULTED
  // غير ذلك => ACTIVE
  const fresh = await prisma.installment.findMany({ where: { contractId } });
  const allPaid = fresh.every((i) => i.paidCents >= i.amountCents);
  const anyLateUnpaid = fresh.some((i) => i.status === InstallmentStatus.LATE && i.paidCents < i.amountCents);

  const newStatus = allPaid ? ContractStatus.CLOSED : anyLateUnpaid ? ContractStatus.DEFAULTED : ContractStatus.ACTIVE;
  await prisma.contract.update({ where: { id: contractId }, data: { status: newStatus } });
}

// ---------- main ----------
async function main() {
  console.log("🌱 Seeding started...");

  const { map: permMap } = await ensurePermissions();
  const roles = await ensureRoles();
  await linkRolePermissions(roles, permMap);
  await ensureUsers(roles);

  const customers = await ensureCustomers();
  await ensureCustomerDocs(customers);

  const products = await ensureProducts();

  // عقود تجريبية:
  // 1) عقد فعّال يبدأ قبل شهرين، 6 أشهر
  const c1Contract = await createContractFull({
    customerId: customers.c1.id,
    items: [
      { productId: products.p1.id, qty: 1 }, // Laptop Pro 14
      { productId: products.p4.id, qty: 1 } // Router
    ],
    months: 6,
    startDate: addMonths(today, -2),
    status: ContractStatus.ACTIVE
  });

  // 2) عقد مغلق (كل الأقساط مدفوعة) يبدأ قبل 5 أشهر، 5 أشهر
  const c2Contract = await createContractFull({
    customerId: customers.c2.id,
    items: [{ productId: products.p2.id, qty: 1 }], // Smartphone X
    months: 5,
    startDate: addMonths(today, -5),
    status: ContractStatus.ACTIVE // يتغير لاحقاً إلى CLOSED بعد المدفوعات
  });

  // 3) عقد متعثر يبدأ قبل 4 أشهر، 8 أشهر
  const c3Contract = await createContractFull({
    customerId: customers.c3.id,
    items: [
      { productId: products.p3.id, qty: 1 }, // Printer
      { productId: products.p5.id, qty: 1 } // Monitor 27"
    ],
    months: 8,
    startDate: addMonths(today, -4),
    status: ContractStatus.ACTIVE // قد يتحول DEFAULTED
  });

  // مدفوعات تجريبية:
  // عقد 1: دفع أول قسط كامل وثاني قسط جزئي
  await applyPayments(c1Contract.id, {
    1: [9999999], // رقم كبير يضمن يغطي القسط 1 بالكامل (safe)، راح يُحسب paidCents >= amountCents
    2: [10000] // دفع جزئي للقسط 2
  });

  // عقد 2: دفع كل الأقساط
  const c2Installments = await prisma.installment.findMany({
    where: { contractId: c2Contract.id },
    orderBy: { seq: "asc" }
  });
  const c2PayAll = Object.fromEntries(c2Installments.map((i) => [i.seq, [i.amountCents]]));
  await applyPayments(c2Contract.id, c2PayAll);

  // عقد 3: ولا قسط مدفوع + مرّت مواعيد بعض الأقساط => يتعثر
  // (لا نضيف مدفوعات)

  // إعادة حساب الحالات
  await recalcInstallmentsAndContract(c1Contract.id);
  await recalcInstallmentsAndContract(c2Contract.id);
  await recalcInstallmentsAndContract(c3Contract.id);

  console.log("✅ Seeding complete.");
}

main()
  .catch((e) => {
    console.error("❌ Seed error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
