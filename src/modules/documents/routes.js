// src/modules/documents/routes.js
import { DocType } from "@prisma/client";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";

export default async function routes(app) {
  const canRead = { preHandler: [app.verifyJwt, app.authorize("documents", "read")] };
  const canCreate = { preHandler: [app.verifyJwt, app.authorize("documents", "create")] };
  const canUpdate = { preHandler: [app.verifyJwt, app.authorize("documents", "update")] };
  const canDelete = { preHandler: [app.verifyJwt, app.authorize("documents", "delete")] };
  const schema = {
    tags: ["documents"]
  };

  const toInt = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
  };

  const UPLOAD_ROOT = path.resolve("uploads"); // غيّرها إذا تريد مسار آخر
  const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB

  async function ensureDir(p) {
    await fsp.mkdir(p, { recursive: true });
  }

  function safeName(name) {
    // تبسيط للتنظيف: يمنع traversal وأحرف غريبة
    return name.replace(/[^a-zA-Z0-9._-]/g, "_");
  }

  async function sha256File(filePath) {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    await pipeline(stream, hash);
    return hash.digest("hex");
  }

  // ---------- GET /documents ----------
  // ?page=1&pageSize=20&q=id.pdf&type=ID&customerId=1&sort=uploadedAt:desc
  app.get(
    "/documents",
    {
      ...canRead,
      schema: {
        ...schema,
        querystring: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1, default: 1 },
            pageSize: { type: "integer", minimum: 1, maximum: 200, default: 20 },
            q: { type: "string", nullable: true },
            type: { type: "string", enum: Object.values(DocType), nullable: true },
            customerId: { type: "integer", nullable: true },
            sort: {
              type: "string",
              enum: ["uploadedAt:asc", "uploadedAt:desc", "fileName:asc", "fileName:desc", "size:asc", "size:desc"],
              default: "uploadedAt:desc"
            }
          }
        }
      }
    },
    async (req) => {
      const page = toInt(req.query.page, 1);
      const pageSize = toInt(req.query.pageSize, 20);
      const { q, type, customerId, sort = "uploadedAt:desc" } = req.query;

      const where = {};
      if (q) {
        where.OR = [{ fileName: { contains: q, mode: "insensitive" } }, { path: { contains: q, mode: "insensitive" } }, { mimeType: { contains: q, mode: "insensitive" } }];
      }
      if (type) where.type = type;
      if (customerId) where.customerId = Number(customerId);

      const [field, dir] = sort.split(":");
      const orderBy = [{ [field]: dir }];

      const [items, total] = await app.prisma.$transaction([
        app.prisma.document.findMany({
          where,
          orderBy,
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: { customer: { select: { id: true, name: true, phone: true } } }
        }),
        app.prisma.document.count({ where })
      ]);

      return { page, pageSize, total, items };
    }
  );

  // ---------- GET /documents/:id ----------
  app.get("/documents/:id", { ...canRead, schema: { ...schema, params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } } }, async (req, reply) => {
    const id = toInt(req.params.id);
    const doc = await app.prisma.document.findUnique({
      where: { id },
      include: { customer: { select: { id: true, name: true, phone: true } } }
    });
    if (!doc) return reply.error(404, "Document not found");
    return doc;
  });

  // ---------- POST /documents (metadata only) ----------
  // استخدمها إذا عندك رفع خارجي وتريد بس تسجّل ميتاداتا
  app.post(
    "/documents",
    {
      ...canCreate,
      schema: {
        ...schema,
        body: {
          type: "object",
          required: ["customerId", "type", "path", "fileName", "mimeType", "size"],
          additionalProperties: false,
          properties: {
            customerId: { type: "integer" },
            type: { type: "string", enum: Object.values(DocType) },
            path: { type: "string" },
            fileName: { type: "string" },
            mimeType: { type: "string" },
            size: { type: "integer", minimum: 0 },
            checksum: { type: "string", nullable: true }
          }
        }
      }
    },
    async (req, reply) => {
      const { customerId } = req.body;
      const exists = await app.prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } });
      if (!exists) return reply.error(400, "Invalid customerId");

      // منع تكرار نفس الاسم لنفس العميل
      const dupe = await app.prisma.document.findFirst({
        where: { customerId, fileName: req.body.fileName },
        select: { id: true }
      });
      if (dupe) return reply.error(409, "File with same name already exists for this customer");

      const doc = await app.prisma.document.create({ data: req.body });
      return doc;
    }
  );

  // ---------- POST /documents/upload (multipart) ----------
  // fields: customerId (int), type (DocType), file (binary)
  app.post(
    "/documents/upload",
    {
      ...canCreate,
      config: {
        // حدود عامة
        bodyLimit: MAX_FILE_BYTES + 1024 * 1024
      },
      schema: {
        ...schema,
        consumes: ["multipart/form-data"],
        body: {
          type: "object",
          properties: {
            customerId: { type: "integer" },
            type: { type: "string", enum: Object.values(DocType) }
            // Swagger ما يعبّر عن الملف هنا، بس يكفي تعريف النوع
          },
          required: ["customerId", "type"]
        }
      }
    },
    async (req, reply) => {
      if (!req.isMultipart) {
        return reply.error(400, "Content-Type must be multipart/form-data");
      }
      // تأكد أنك مسجل @fastify/multipart في السيرفر:
      // await app.register(import("@fastify/multipart"));
      const mp = await req.file({ limits: { fileSize: MAX_FILE_BYTES } }); // ملف واحد
      if (!mp) return reply.error(400, "file field is required");

      const { customerId: customerIdRaw, type } = mp.fields;
      const customerId = toInt(customerIdRaw?.value ?? customerIdRaw, NaN);
      if (!Number.isFinite(customerId)) return reply.error(400, "Invalid customerId");
      if (!Object.values(DocType).includes(type?.value ?? type)) return reply.error(400, "Invalid type");

      const customer = await app.prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } });
      if (!customer) return reply.error(400, "Invalid customerId");

      const original = safeName(mp.filename || "upload.bin");
      const dir = path.join(UPLOAD_ROOT, String(customerId));
      await ensureDir(dir);

      const targetPath = path.join(dir, original);

      // منع الكتابة فوق ملف موجود بنفس الاسم لنفس العميل
      try {
        await fsp.access(targetPath, fs.constants.F_OK);
        return reply.error(409, "File already exists");
      } catch {
        // ok, not exists
      }

      // حفظ الملف إلى القرص
      const tmpPath = path.join(dir, `.__tmp_${Date.now()}_${original}`);
      await pipeline(mp.file, fs.createWriteStream(tmpPath));
      const stats = await fsp.stat(tmpPath);
      if (stats.size > MAX_FILE_BYTES) {
        await fsp.unlink(tmpPath).catch(() => {});
        return reply.error(413, "File too large");
      }

      // احسب checksum ثم انقل الملف
      const checksum = await sha256File(tmpPath);
      await fsp.rename(tmpPath, targetPath);

      const rec = await app.prisma.document.create({
        data: {
          customerId,
          type: type?.value ?? type,
          path: `uploads/${customerId}/${original}`,
          fileName: original,
          mimeType: mp.mimetype || "application/octet-stream",
          size: stats.size,
          checksum
        }
      });

      return { ok: true, document: rec };
    }
  );

  // ---------- PATCH /documents/:id ----------
  app.patch(
    "/documents/:id",
    {
      ...canUpdate,
      schema: {
        ...schema,
        params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: Object.values(DocType), nullable: true },
            fileName: { type: "string", nullable: true },
            mimeType: { type: "string", nullable: true },
            path: { type: "string", nullable: true }
          }
        }
      }
    },
    async (req, reply) => {
      const id = toInt(req.params.id);
      const doc = await app.prisma.document.findUnique({ where: { id } });
      if (!doc) return reply.error(404, "Document not found");

      // منع تكرار اسم الملف لنفس العميل
      if (req.body?.fileName && req.body.fileName !== doc.fileName) {
        const dupe = await app.prisma.document.findFirst({
          where: { customerId: doc.customerId, fileName: req.body.fileName },
          select: { id: true }
        });
        if (dupe) return reply.error(409, "File with same name already exists for this customer");
      }

      const updated = await app.prisma.document.update({ where: { id }, data: req.body });
      return updated;
    }
  );

  // ---------- GET /documents/:id/download ----------
  app.get("/documents/:id/download", { ...canRead, schema: { ...schema, params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } } }, async (req, reply) => {
    const id = toInt(req.params.id);
    const doc = await app.prisma.document.findUnique({ where: { id } });
    if (!doc) return reply.error(404, "Document not found");

    const absPath = path.resolve(doc.path);
    try {
      await fsp.access(absPath, fs.constants.R_OK);
    } catch {
      return reply.error(404, "File not found on disk");
    }

    reply.header("Content-Type", doc.mimeType);
    reply.header("Content-Disposition", `attachment; filename="${doc.fileName}"`);
    return reply.send(fs.createReadStream(absPath));
  });

  // ---------- DELETE /documents/:id ----------
  // ?deleteFile=true لحذف الملف من القرص أيضاً
  app.delete(
    "/documents/:id",
    {
      ...canDelete,
      schema: {
        ...schema,
        params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
        querystring: {
          type: "object",
          properties: { deleteFile: { type: "boolean", nullable: true } }
        }
      }
    },
    async (req, reply) => {
      const id = toInt(req.params.id);
      const { deleteFile } = req.query;
      const doc = await app.prisma.document.findUnique({ where: { id } });
      if (!doc) return reply.error(404, "Document not found");

      await app.prisma.document.delete({ where: { id } });

      if (deleteFile) {
        const absPath = path.resolve(doc.path);
        try {
          await fsp.unlink(absPath);
        } catch {
          // تجاهل إذا الملف غير موجود
        }
      }

      return { ok: true };
    }
  );
}
