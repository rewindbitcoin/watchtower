/**
 * Project: Rewind Bitcoin
 * Website: https://rewindbitcoin.com
 *
 * Author: Jose-Luis Landabaso
 * Email: landabaso@gmail.com
 *
 * Contact Email: hello@rewindbitcoin.com
 *
 * License: MIT License
 *
 * Copyright (c) 2025 Jose-Luis Landabaso, Rewind Bitcoin
 */

import { createLogger } from "./logger";

// Create logger for this module
const logger = createLogger("Notifications");

export interface NotificationData {
  vaultId: string;
  walletId: string;
  walletName: string;
  vaultNumber: number;
  watchtowerUrl: string;
  txid: string;
  attemptCount?: number;
  firstDetectedAt?: number;
}

export interface NotificationPayload {
  to: string;
  title: string;
  body: string;
  data?: NotificationData;
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

    // Check for errors in the response data
    // Expo API returns 200 OK even when there are errors in the push notification
    if (result.data?.status === "error") {
      logger.error(`Push notification failed:`, {
        error: result.data.message,
        details: result.data.details,
        recipient: payload.to,
      });
      return false;
    }

    logger.info("Push notification sent successfully", {
      recipient: payload.to,
      vaultId: payload.data?.vaultId,
    });
    return true;
  } catch (error) {
    logger.error("Error sending push notification:", error);
    return false;
  }
}
