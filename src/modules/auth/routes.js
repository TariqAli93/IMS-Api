import { includes } from "zod/v4";

export default async function routes(app) {
  const schema = {
    tags: ["auth"]
  };
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
        return reply.status(400).send({ message: "Missing username or password" });
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
      const matchPassword = await app.bcrypt.compare(req.body.password, user.password);
      if (user && matchPassword) {
        const userRoles = user?.roles?.map((ur) => ur.role.name) || [];
        const token = app.jwt.sign({
          userId: user.id,
          username: user.username,
          roles: userRoles
        });
        reply.status(200).send({ token });
      } else {
        reply.status(401).send({ message: "Invalid credentials" });
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
      const token = app.jwt.sign({ userId: user.id });
      return { token };
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
        return reply.status(404).send({ message: "User not found" });
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
        return reply.status(404).send({ message: "User not found" });
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
      // TODO: Invalidate JWT token
      return { message: "Logged out successfully" };
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
            token: { type: "string" }
          },
          required: ["token"]
        }
      }
    },
    async (req, reply) => {
      const { token } = req.body;
      try {
        const decoded = app.jwt.verify(token);
        const newToken = app.jwt.sign({ userId: decoded.userId });
        return { token: newToken };
      } catch (error) {
        return reply.status(401).send({ message: "Invalid token" });
      }
    }
  );
}
