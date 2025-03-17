import { createLogger } from "./logger";

// Create logger for this module
const logger = createLogger("Notifications");

export interface NotificationPayload {
  to: string;
  title: string;
  body: string;
  data?: any;
}

export async function sendPushNotification(
  payload: NotificationPayload,
): Promise<boolean> {
  try {
    const expoEndpoint = "https://exp.host/--/api/v2/push/send";
    const response = await fetch(expoEndpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      logger.error(`Failed to send push notification: ${response.statusText}`);
      return false;
    }

    const result = await response.json();
    logger.info("Push notification sent:", result);
    return true;
  } catch (error) {
    logger.error("Error sending push notification:", error);
    return false;
  }
}
