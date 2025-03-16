export interface NotificationPayload {
  to: string;
  title: string;
  body: string;
  data?: any;
}

export async function sendPushNotification(
  payload: NotificationPayload,
): Promise<void> {
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
    console.error(`Failed to send push notification: ${response.statusText}`);
    throw new Error(`Push notification error: ${response.statusText}`);
  }
}
