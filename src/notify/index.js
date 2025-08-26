/** قناة إشعارات موحدة: الآن Console + DB. استبدلها لاحقاً بـ SMS/Email/Webhook */
export async function send(app, type, payload) {
  app.log.info({ type, payload }, 'Notify');
  await app.prisma.notificationLog.create({
    data: { type, payload: JSON.stringify(payload) }
  });
}
