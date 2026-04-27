const LOG_PREFIX = "[orders-create-webhook]";

export function ordersCreateWebhookLog(
  message: string,
  data?: Record<string, unknown>,
): void {
  const suffix = data && Object.keys(data).length ? ` ${JSON.stringify(data)}` : "";
  console.log(`${LOG_PREFIX} ${message}${suffix}`);
}
