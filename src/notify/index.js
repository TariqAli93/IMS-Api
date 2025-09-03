/** قناة إشعارات موحدة: الآن Console + DB. استبدلها لاحقاً بـ SMS/Email/Webhook */
export async function send(app, type, payload) {
  app.log.info({ type, payload }, "Notify");
  await app.prisma.notificationLog.create({
    data: { type, payload: JSON.stringify(payload) }
  });

  // TODO: Implement actual notification sending logic (SMS/Email/Webhook)
  switch (type) {
    case "sms":
      // Implement SMS sending logic
      break;
    case "email":
      // Implement Email sending logic
      break;
    case "webhook":
      // Implement Webhook sending logic
      break;
    default:
      app.log.warn({ type }, "Unknown notification type");
  }
}
