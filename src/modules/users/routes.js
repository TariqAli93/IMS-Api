export default async function routes(app) {
  const auth = { preHandler: [app.verifyJwt] };
  const schema = {
    tags: ["users"]
  };
  app.get(
    "/users/me",
    {
      ...auth,
      schema: {
        ...schema
      }
    },
    async (req) => ({ user: req.user })
  );
  app.get("/users", { ...auth, schema: { ...schema } }, async () => app.prisma.user.findMany());
  app.post("/users", { ...auth, schema: { ...schema } }, async (req) => {
    const user = await app.prisma.user.create({ data: req.body });
    return { user };
  });
  app.delete("/users/:id", { ...auth, schema: { ...schema } }, async (req) => {
    const { id } = req.params;
    await app.prisma.user.delete({ where: { id } });
    return { message: "User deleted" };
  });
  app.patch("/users/:id", { ...auth, schema: { ...schema } }, async (req) => {
    const { id } = req.params;
    const user = await app.prisma.user.update({ where: { id }, data: req.body });
    return { user };
  });
  app.get("/users/:id", { ...auth, schema: { ...schema } }, async (req) => {
    const { id } = req.params;
    const user = await app.prisma.user.findUnique({ where: { id } });
    return { user };
  });
}
