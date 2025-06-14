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

import { Express, Request, Response } from "express";
import { getDb } from "./db";
import { createLogger } from "./logger";
import { verifyCommitmentAuthorization } from "./commitments";
import { NotificationData } from "./notifications";

// Create logger for this module
const logger = createLogger("Routes");

export function registerRoutes(
  app: Express,
  dbFolder: string,
  requireCommitments = false,
) {
  /**
   * POST /watchtower/register and /:networkId/watchtower/register
   * Registers vaults and associates them with a push token.
   */
  app.post(
    ["/watchtower/register", "/:networkId/watchtower/register"],
    async (req: Request, res: Response): Promise<void> => {
      // Default to bitcoin if no networkId is provided in the path
      const networkId = req.params.networkId || "bitcoin";
      const {
        pushToken,
        vaults,
        walletUUID,
        walletName,
        watchtowerId, // Client-provided unique ID for the watchtower instance
        locale = "en",
      } = req.body;
      try {
        // Validate network parameter
        if (!["bitcoin", "testnet", "tape", "regtest"].includes(networkId)) {
          res.status(400).json({
            error:
              "Invalid networkId. Must be 'bitcoin', 'testnet', 'tape', or 'regtest'",
          });
          return;
        }

        if (
          !pushToken ||
          !Array.isArray(vaults) ||
          !walletUUID ||
          !walletName ||
          !watchtowerId
        ) {
          res.status(400).json({
            error:
              "Invalid input data. pushToken, vaults array, walletUUID, walletName, and watchtowerId are required",
          });
          return;
        }

        const db = getDb(networkId);

        try {
          // Use better-sqlite3's transaction API
          db.transaction(() => {
            // Insert or update each vault and its transaction ids.
            for (const vault of vaults) {
              const { vaultId, triggerTxIds, commitment, vaultNumber } = vault;
              if (!vaultId || !Array.isArray(triggerTxIds)) {
                logger.error(
                  `Invalid vault data for ${networkId} network: missing vaultId or triggerTxIds`,
                  { vaultId, triggerTxIds },
                );
                throw new Error(
                  "Invalid vault data. vaultId, vaultNumber, and triggerTxIds array are required",
                );
              }

              // Validate vaultNumber is a non-negative integer
              if (
                vaultNumber === undefined ||
                !Number.isInteger(vaultNumber) ||
                vaultNumber < 0
              ) {
                logger.error(
                  `Invalid vaultNumber for ${networkId} network: ${vaultNumber}`,
                  { vaultId },
                );
                throw new Error(
                  "Invalid vaultNumber. Must be a non-negative integer",
                );
              }

              // Verify commitment if required
              if (requireCommitments) {
                if (!commitment) {
                  logger.error(
                    `Missing commitment for vault ${vaultId} on ${networkId} network`,
                  );
                  throw new Error(
                    "A commitment transaction is required for vault registration",
                  );
                }

                const verificationResult = verifyCommitmentAuthorization(
                  commitment,
                  networkId,
                  dbFolder,
                  vaultId,
                );

                if (!verificationResult.isValid) {
                  throw new Error(
                    verificationResult.error ||
                      "Unknown error while verifying the commitment",
                  );
                }

                // Store the commitment in the database
                const commitmentTxid = verificationResult.txid!;
                db.prepare(
                  "INSERT OR IGNORE INTO commitments (txid, vaultId) VALUES (?, ?)",
                ).run(commitmentTxid, vaultId);

                logger.info(
                  `Valid commitment ${commitmentTxid} verified for vault ${vaultId} on ${networkId} network`,
                );
              }

              // Check if this vault has already been notified and transaction is irreversible
              const existingNotification = db
                .prepare(
                  `SELECT n.attemptCount 
                 FROM notifications n
                 JOIN vault_txids vt ON n.vaultId = vt.vaultId
                 WHERE n.vaultId = ? AND n.attemptCount > 0 AND vt.status = 'irreversible' 
                 LIMIT 1`,
                )
                .get(vaultId);

              if (existingNotification) {
                logger.warn(
                  `Vault ${vaultId} on ${networkId} network is spent and irreversible`,
                  {
                    pushToken,
                    walletUUID,
                    walletName,
                    vaultNumber,
                    watchtowerId,
                    locale,
                  },
                );
              }

              // Insert notification entry and check if it was actually inserted
              const result = db
                .prepare(
                  `INSERT OR IGNORE INTO notifications (pushToken, vaultId, walletUUID, walletName, vaultNumber, watchtowerId, locale) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                  pushToken,
                  vaultId,
                  walletUUID,
                  walletName,
                  vaultNumber,
                  watchtowerId,
                  locale,
                );

              // If changes === 0, the entry already existed, so skip processing txids
              if (result.changes > 0) {
                logger.info(
                  `New device registered for vault ${vaultId} on ${networkId} network`,
                  {
                    pushToken,
                    walletUUID,
                    walletName,
                    vaultNumber,
                    watchtowerId,
                  },
                );

                // Process each transaction ID only if this is a new notification
                // Insert transaction if it doesn't exist yet
                const commitmentTxid = requireCommitments
                  ? (
                      db
                        .prepare(
                          "SELECT txid FROM commitments WHERE vaultId = ?",
                        )
                        .get(vaultId) as
                        | {
                            txid: string;
                          }
                        | undefined
                    )?.txid
                  : null;

                const insertTxStmt = db.prepare(
                  "INSERT OR IGNORE INTO vault_txids (txid, vaultId, status, commitmentTxid) VALUES (?, ?, 'unchecked', ?)",
                );

                for (const txid of triggerTxIds) {
                  insertTxStmt.run(txid, vaultId, commitmentTxid);
                }

                logger.info(
                  `Registered vault ${vaultId} with ${triggerTxIds.length} trigger transactions on ${networkId} network`,
                  { walletUUID, walletName, vaultNumber, watchtowerId, locale },
                );
              } else {
                logger.info(
                  `Notification for vault ${vaultId} and push token ${pushToken} already exists on ${networkId} network, skipping txid processing`,
                  { walletUUID, walletName, vaultNumber, watchtowerId },
                );
              }
            }
          })();

          logger.info(
            `Successfully registered ${vaults.length} vaults for wallet "${walletName}" (ID: ${walletUUID}) on ${networkId} network`,
            { requestId: req.requestId },
          );
          res.sendStatus(200);
        } catch (error) {
          logger.error(`Database transaction failed on ${networkId} network`, {
            error: error instanceof Error ? error.message : String(error),
            walletUUID,
            walletName,
            watchtowerId,
            requestId: req.requestId,
          });

          // Send appropriate error response based on the error message
          if (error instanceof Error) {
            if (error.message.includes("Invalid vault data")) {
              res.status(400).json({ error: error.message });
              return;
            } else if (error.message.includes("Invalid vaultNumber")) {
              res.status(400).json({ error: error.message });
              return;
            } else if (error.message.includes("commitment")) {
              res
                .status(403)
                .json({ error: "Invalid commitment", message: error.message });
              return;
            }
          }

          throw error;
        }
        return;
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error(`Error in watchtower/register for ${networkId} network:`, {
          error: errorMessage,
          stack: err instanceof Error ? err.stack : undefined,
          walletUUID,
          walletName,
          watchtowerId,
          pushToken,
          requestId: req.requestId,
        });
        res.status(500).json({ error: "Internal server error" });
        return;
      }
    },
  );

  /**
   * POST /watchtower/ack and /:networkId/watchtower/ack
   * Acknowledges receipt of a notification for a specific vault.
   */
  app.post(
    ["/watchtower/ack", "/:networkId/watchtower/ack"],
    async (req: Request, res: Response): Promise<void> => {
      // Default to bitcoin if no networkId is provided in the path
      const networkId = req.params.networkId || "bitcoin";
      const { pushToken, vaultId } = req.body;

      try {
        // Validate network parameter
        if (!["bitcoin", "testnet", "tape", "regtest"].includes(networkId)) {
          res.status(400).json({
            error:
              "Invalid networkId. Must be 'bitcoin', 'testnet', 'tape', or 'regtest'",
          });
          return;
        }

        if (!pushToken || !vaultId) {
          res.status(400).json({
            error: "Invalid input data. pushToken and vaultId are required",
          });
          return;
        }

        const db = getDb(networkId);

        // Update the notification to mark it as acknowledged
        const result = db
          .prepare(
            `UPDATE notifications 
           SET acknowledged = 1 
           WHERE pushToken = ? AND vaultId = ?`,
          )
          .run(pushToken, vaultId);

        if (result.changes === 0) {
          logger.warn(
            `Acknowledgment received for unknown notification: ${vaultId} from ${pushToken}`,
          );
          res.status(404).json({
            error: "Notification not found",
            message:
              "No matching notification found for the provided pushToken and vaultId",
          });
          return;
        }

        logger.info(
          `Notification acknowledged for vault ${vaultId} by device ${pushToken}`,
        );
        res.sendStatus(200);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error(`Error in watchtower/ack for ${networkId} network:`, {
          error: errorMessage,
          stack: err instanceof Error ? err.stack : undefined,
          vaultId,
          pushToken,
          requestId: req.requestId,
        });
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  /**
   * POST /watchtower/notifications and /:networkId/watchtower/notifications
   * Retrieves unacknowledged notifications for a specific push token.
   */
  app.post(
    ["/watchtower/notifications", "/:networkId/watchtower/notifications"],
    async (req: Request, res: Response): Promise<void> => {
      // Default to bitcoin if no networkId is provided in the path
      const networkId = req.params.networkId || "bitcoin";
      const { pushToken } = req.body;

      try {
        // Validate network parameter
        if (!["bitcoin", "testnet", "tape", "regtest"].includes(networkId)) {
          res.status(400).json({
            error:
              "Invalid networkId. Must be 'bitcoin', 'testnet', 'tape', or 'regtest'",
          });
          return;
        }

        if (!pushToken) {
          res.status(400).json({
            error:
              "Invalid input data. pushToken is required in the request body",
          });
          return;
        }

        const db = getDb(networkId);

        // Get all unacknowledged notifications for this push token
        const queriedNotifications = db
          .prepare(
            `
          SELECT n.vaultId, n.walletUUID, n.walletName, n.vaultNumber, n.watchtowerId,
                 vt.txid, n.attemptCount, n.firstAttemptAt as firstDetectedAt
          FROM notifications n
          JOIN vault_txids vt ON n.vaultId = vt.vaultId
          WHERE n.pushToken = ? 
            AND n.acknowledged = 0
            AND (vt.status = 'reversible' OR vt.status = 'irreversible')
            AND n.attemptCount > 0
          `,
          )
          .all(pushToken) as Array<NotificationData>;

        // Add network ID to each notification
        const notifications = queriedNotifications.map((notification) => ({
          vaultId: notification.vaultId,
          walletUUID: notification.walletUUID,
          walletName: notification.walletName,
          vaultNumber: notification.vaultNumber,
          watchtowerId: notification.watchtowerId,
          txid: notification.txid,
          attemptCount: notification.attemptCount,
          firstDetectedAt: notification.firstDetectedAt,
          networkId,
        }));

        logger.info(
          `Retrieved ${notifications.length} unacknowledged notifications for device ${pushToken} on ${networkId} network`,
        );

        res.status(200).json({ notifications });
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error(
          `Error in watchtower/notifications for ${networkId} network:`,
          {
            error: errorMessage,
            stack: err instanceof Error ? err.stack : undefined,
            pushToken,
            requestId: req.requestId,
          },
        );
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  /**
   * GET /generate_204
   * Health check endpoint that returns HTTP 204 No Content.
   */
  app.get("/generate_204", (_req: Request, res: Response) => {
    res.status(204).send();
  });
}
