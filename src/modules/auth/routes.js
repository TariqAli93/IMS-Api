// Auth routes

export default async function routes(app) {
  const schema = {
    tags: ["auth"]
  };

  function parseDuration(str, defMs) {
    if (!str) return defMs;
    const m = /^([0-9]+)\s*(ms|s|m|h|d)?$/i.exec(str.trim());
    if (!m) return defMs;
    const n = Number(m[1]);
    const unit = (m[2] || 's').toLowerCase();
    const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000;
    return n * mult;
  }
  app.post(
    "/login",
    {
      schema: {
        ...schema,
        body: {
          type: "object",
          properties: {
            username: { type: "string" },
            password: { type: "string" }
          },
          required: ["username", "password"]
        }
      }
    },
    async (req, reply) => {
      // Validate request body
      const { username, password } = req.body;

      if (!username || !password) {
        return reply.error(400, "Missing username or password");
      }

      const user = await app.prisma.user.findUnique({
        where: { username },
        include: {
          roles: {
            include: {
              role: true
            }
          }
        }
      });
      // Guard against non-existent user before bcrypt compare
      if (!user) {
        return reply.error(401, "Invalid credentials");
      }

      const matchPassword = await app.bcrypt.compare(password, user.password);
      if (matchPassword) {
        const userRoles = user?.roles?.map((ur) => ur.role.name) || [];
        const accessToken = app.jwt.sign({
          userId: user.id,
          username: user.username,
          roles: userRoles
        });
        // Create rotating refresh token
        const ttl = parseDuration(process.env.JWT_REFRESH_TOKEN_EXPIRES_IN, 7 * 24 * 3600 * 1000);
        const expiresAt = new Date(Date.now() + ttl);
        const { randomBytes, createHash } = await import('node:crypto');
        const raw = randomBytes(32).toString('hex');
        const tokenHash = createHash('sha256').update(raw).digest('hex');
        await app.prisma.refreshToken.create({ data: { userId: user.id, tokenHash, expiresAt } });
        reply.status(200).send({ accessToken, refreshToken: raw });
      } else {
        return reply.error(401, "Invalid credentials");
      }
    }
  );

  app.post(
    "/register",
    {
      schema: {
        ...schema,
        body: {
          type: "object",
          properties: {
            username: { type: "string" },
            password: { type: "string" }
          },
          required: ["username", "password"]
        }
      }
    },
    async (req, reply) => {
      const { username, password } = req.body;
      const hashedPassword = await app.bcrypt.hash(password);
      const user = await app.prisma.user.create({
        data: { username, password: hashedPassword }
      });
      const accessToken = app.jwt.sign({ userId: user.id, username });
      const ttl = parseDuration(process.env.JWT_REFRESH_TOKEN_EXPIRES_IN, 7 * 24 * 3600 * 1000);
      const expiresAt = new Date(Date.now() + ttl);
      const { randomBytes, createHash } = await import('node:crypto');
      const raw = randomBytes(32).toString('hex');
      const tokenHash = createHash('sha256').update(raw).digest('hex');
      await app.prisma.refreshToken.create({ data: { userId: user.id, tokenHash, expiresAt } });
      return { accessToken, refreshToken: raw };
    }
  );

  app.post(
    "/forgot-password",
    {
      schema: {
        ...schema,
        body: {
          type: "object",
          properties: {
            email: { type: "string", format: "email" }
          },
          required: ["email"]
        }
      }
    },
    async (req, reply) => {
      const { email } = req.body;
      const user = await app.prisma.user.findUnique({ where: { email } });
      if (!user) {
        return reply.error(404, "User not found");
      }
      // TODO: Send password reset email
      return { message: "Password reset email sent" };
    }
  );

  app.post(
    "/reset-password",
    {
      schema: {
        ...schema,
        body: {
          type: "object",
          properties: {
            username: { type: "string" },
            newPassword: { type: "string" }
          },
          required: ["username", "newPassword"]
        }
      }
    },
    async (req, reply) => {
      const { username, newPassword } = req.body;
      const user = await app.prisma.user.findUnique({ where: { username } });
      if (!user) {
        return reply.error(404, "User not found");
      }
      const hashedPassword = await app.bcrypt.hash(newPassword);
      await app.prisma.user.update({
        where: { username },
        data: { password: hashedPassword }
      });
      return { message: "Password reset successfully" };
    }
  );

  app.post(
    "/logout",
    {
      schema: {
        ...schema
      }
    },
    async (req, reply) => {
      const { refreshToken } = req.body || {};
      if (!refreshToken) return reply.status(200).send({ ok: true });
      const { createHash } = await import('node:crypto');
      const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
      await app.prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() }
      });
      return { ok: true };
    }
  );

  app.post(
    "/refresh-token",
    {
      schema: {
        ...schema,
        body: {
          type: "object",
          properties: {
            refreshToken: { type: "string" }
          },
          required: ["refreshToken"]
        }
      }
    },
    async (req, reply) => {
      const { refreshToken } = req.body;
      const { createHash } = await import('node:crypto');
      const tokenHash = createHash('sha256').update(refreshToken).digest('hex');

      const existing = await app.prisma.refreshToken.findFirst({ where: { tokenHash }, include: { user: { include: { roles: { include: { role: true } } } } } });
      if (!existing) return reply.error(401, "Invalid token");

      // Reuse detection: already revoked
      if (existing.revokedAt) {
        // Revoke all active for this user (defensive)
        await app.prisma.refreshToken.updateMany({ where: { userId: existing.userId, revokedAt: null }, data: { revokedAt: new Date() } });
        return reply.error(401, "Token reused");
      }

      if (existing.expiresAt <= new Date()) {
        // Expired
        await app.prisma.refreshToken.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });
        return reply.error(401, "Token expired");
      }

      // Rotate
      const ttl = parseDuration(process.env.JWT_REFRESH_TOKEN_EXPIRES_IN, 7 * 24 * 3600 * 1000);
      const expiresAt = new Date(Date.now() + ttl);
      const { randomBytes } = await import('node:crypto');
      const raw = randomBytes(32).toString('hex');
      const newHash = createHash('sha256').update(raw).digest('hex');

      const updated = await app.prisma.$transaction(async (tx) => {
        const created = await tx.refreshToken.create({ data: { userId: existing.userId, tokenHash: newHash, expiresAt } });
        await tx.refreshToken.update({ where: { id: existing.id }, data: { revokedAt: new Date(), replacedById: created.id } });
        return created;
      });

      const user = existing.user;
      const roles = user?.roles?.map((r) => r.role.name) || [];
      const accessToken = app.jwt.sign({ userId: user.id, username: user.username, roles });
      return { accessToken, refreshToken: raw };
    }
  );
}
