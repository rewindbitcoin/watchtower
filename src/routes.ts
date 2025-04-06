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
        walletId,
        walletName,
        watchtowerUrl,
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
          !walletId ||
          !walletName ||
          !watchtowerUrl
        ) {
          res.status(400).json({
            error:
              "Invalid input data. pushToken, vaults array, walletId, walletName, and watchtowerUrl are required",
          });
          return;
        }

        const db = getDb(networkId);

        // Start a single transaction for the entire request
        await db.exec("BEGIN TRANSACTION");

        try {
          // Insert or update each vault and its transaction ids.
          for (const vault of vaults) {
            const { vaultId, triggerTxIds, commitment, vaultNumber } = vault;
            if (!vaultId || !Array.isArray(triggerTxIds)) {
              logger.error(
                `Invalid vault data for ${networkId} network: missing vaultId or triggerTxIds`,
                { vaultId, triggerTxIds },
              );
              await db.exec("ROLLBACK");
              res.status(400).json({
                error:
                  "Invalid vault data. vaultId, vaultNumber, and triggerTxIds array are required",
              });
              return;
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
              await db.exec("ROLLBACK");
              res.status(400).json({
                error: "Invalid vaultNumber. Must be a non-negative integer",
              });
              return;
            }

            // Verify commitment if required
            if (requireCommitments) {
              if (!commitment) {
                logger.error(
                  `Missing commitment for vault ${vaultId} on ${networkId} network`,
                );
                await db.exec("ROLLBACK");
                res.status(400).json({
                  error: "Missing commitment",
                  message:
                    "A commitment transaction is required for vault registration",
                });
                return;
              }

              const verificationResult = await verifyCommitmentAuthorization(
                commitment,
                networkId,
                dbFolder,
                vaultId,
              );

              if (!verificationResult.isValid) {
                await db.exec("ROLLBACK");
                res.status(403).json({
                  error: "Invalid commitment",
                  message:
                    verificationResult.error ||
                    "Unknown error while verifying the commitment",
                });
                return;
              }

              // Store the commitment in the database
              const commitmentTxid = verificationResult.txid!;
              await db.run(
                "INSERT OR IGNORE INTO commitments (txid, vaultId) VALUES (?, ?)",
                [commitmentTxid, vaultId],
              );

              logger.info(
                `Valid commitment ${commitmentTxid} verified for vault ${vaultId} on ${networkId} network`,
              );
            }

            // Check if this vault has already been notified and transaction is irreversible
            const existingNotification = await db.get(
              `SELECT n.attemptCount 
               FROM notifications n
               JOIN vault_txids vt ON n.vaultId = vt.vaultId
               WHERE n.vaultId = ? AND n.attemptCount > 0 AND vt.status = 'irreversible' 
               LIMIT 1`,
              [vaultId],
            );

            if (existingNotification) {
              logger.warn(
                `Vault ${vaultId} on ${networkId} network is spent and irreversible`,
                {
                  pushToken,
                  walletId,
                  walletName,
                  vaultNumber,
                  watchtowerId,
                  locale,
                },
              );
            }

            // Insert notification entry and check if it was actually inserted
            const result = await db.run(
              `INSERT OR IGNORE INTO notifications (pushToken, vaultId, walletId, walletName, vaultNumber, watchtowerId, locale) VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [
                pushToken,
                vaultId,
                walletId,
                walletName,
                vaultNumber,
                watchtowerId,
                locale,
              ],
            );

            // If changes === 0, the entry already existed, so skip processing txids
            if (result.changes || 0 > 0) {
              logger.info(
                `New device registered for vault ${vaultId} on ${networkId} network`,
                {
                  pushToken,
                  walletId,
                  walletName,
                  vaultNumber,
                  watchtowerId,
                },
              );

              // Process each transaction ID only if this is a new notification
              // Insert transaction if it doesn't exist yet
              const commitmentTxid = requireCommitments
                ? (
                    await db.get(
                      "SELECT txid FROM commitments WHERE vaultId = ?",
                      [vaultId],
                    )
                  )?.txid
                : null;

              for (const txid of triggerTxIds)
                await db.run(
                  "INSERT OR IGNORE INTO vault_txids (txid, vaultId, status, commitmentTxid) VALUES (?, ?, 'unchecked', ?)",
                  [txid, vaultId, commitmentTxid],
                );

              logger.info(
                `Registered vault ${vaultId} with ${triggerTxIds.length} trigger transactions on ${networkId} network`,
                { walletId, walletName, vaultNumber, watchtowerId, locale },
              );
            } else {
              logger.info(
                `Notification for vault ${vaultId} and push token ${pushToken} already exists on ${networkId} network, skipping txid processing`,
                { walletId, walletName, vaultNumber, watchtowerId },
              );
            }
          }

          // Commit the transaction after processing all vaults
          await db.exec("COMMIT");
          logger.info(
            `Successfully registered ${vaults.length} vaults for wallet "${walletName}" (ID: ${walletId}) on ${networkId} network`,
          );
          res.sendStatus(200);
        } catch (error) {
          // Rollback the transaction if any error occurs
          await db.exec("ROLLBACK");
          logger.error(`Database transaction failed on ${networkId} network`, {
            error: error instanceof Error ? error.message : String(error),
            walletId,
            walletName,
            watchtowerId,
          });
          throw error;
        }
        return;
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error(`Error in watchtower/register for ${networkId} network:`, {
          error: errorMessage,
          stack: err instanceof Error ? err.stack : undefined,
          walletId,
          walletName,
          watchtowerId,
          pushToken: pushToken ? pushToken.substring(0, 10) + "..." : undefined,
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
        const result = await db.run(
          `UPDATE notifications 
           SET acknowledged = 1 
           WHERE pushToken = ? AND vaultId = ?`,
          [pushToken, vaultId],
        );

        if (result.changes === 0) {
          logger.warn(
            `Acknowledgment received for unknown notification: ${vaultId} from ${pushToken.substring(0, 10)}...`,
          );
          res.status(404).json({
            error: "Notification not found",
            message:
              "No matching notification found for the provided pushToken and vaultId",
          });
          return;
        }

        logger.info(
          `Notification acknowledged for vault ${vaultId} by device ${pushToken.substring(0, 10)}...`,
        );
        res.sendStatus(200);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error(`Error in watchtower/ack for ${networkId} network:`, {
          error: errorMessage,
          stack: err instanceof Error ? err.stack : undefined,
          vaultId,
          pushToken: pushToken ? pushToken.substring(0, 10) + "..." : undefined,
        });
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
