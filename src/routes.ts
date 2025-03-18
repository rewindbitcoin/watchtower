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
import { verifyCommitment } from "./commitments";

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
      const { pushToken, vaults, walletName } = req.body;
      try {
        // Validate network parameter
        if (!["bitcoin", "testnet", "tape", "regtest"].includes(networkId)) {
          res.status(400).json({
            error:
              "Invalid networkId. Must be 'bitcoin', 'testnet', 'tape', or 'regtest'",
          });
          return;
        }

        if (!pushToken || !Array.isArray(vaults) || !walletName) {
          res.status(400).json({
            error:
              "Invalid input data. pushToken, walletName, and vaults array are required",
          });
          return;
        }

        const db = getDb(networkId);

        // Insert or update each vault and its transaction ids.
        for (const vault of vaults) {
          const { vaultId, triggerTxIds, commitment, vaultNumber } = vault;
          if (!vaultId || !Array.isArray(triggerTxIds)) {
            logger.error(
              `Invalid vault data: missing vaultId or triggerTxIds`,
              { vaultId, triggerTxIds },
            );
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
            logger.error(`Invalid vaultNumber: ${vaultNumber}`, { vaultId });
            res.status(400).json({
              error: "Invalid vaultNumber. Must be a non-negative integer",
            });
            return;
          }

          // Verify commitment if required
          if (requireCommitments) {
            if (!commitment) {
              logger.error(`Missing commitment for vault ${vaultId}`);
              res.status(400).json({
                error: "Missing commitment",
                message:
                  "A commitment transaction is required for vault registration",
              });
              return;
            }

            const isValid = await verifyCommitment(
              commitment,
              networkId,
              dbFolder,
            );
            if (!isValid) {
              res.status(403).json({
                error: "Invalid commitment",
                message:
                  "The commitment transaction does not pay to an authorized address",
              });
              return;
            }
            logger.info(`Valid commitment verified for vault ${vaultId}`);
          }

          // Check if this vault has already been notified and transaction is irreversible
          const existingNotification = await db.get(
            `SELECT n.status 
             FROM notifications n
             JOIN vault_txids vt ON n.vaultId = vt.vaultId
             WHERE n.vaultId = ? AND n.status = 'sent' AND vt.status = 'irreversible' 
             LIMIT 1`,
            [vaultId],
          );

          if (existingNotification) {
            logger.warn(
              `Attempt to register already accessed vault ${vaultId}`,
              {
                pushToken,
                walletName,
                vaultNumber,
              },
            );
            res.status(409).json({
              error: "Vault already accessed",
              message: `Vault ${vaultId} has already been accessed and cannot be registered again.`,
            });
            return;
          }

          // Use a transaction to ensure atomicity
          await db.exec("BEGIN TRANSACTION");

          try {
            // Insert notification entry and check if it was actually inserted
            const result = await db.run(
              `INSERT OR IGNORE INTO notifications (pushToken, vaultId, walletName, vaultNumber, status) VALUES (?, ?, ?, ?, 'pending')`,
              [pushToken, vaultId, walletName, vaultNumber],
            );

            // If changes === 0, the entry already existed, so skip processing txids
            if (result.changes || 0 > 0) {
              logger.info(`New device registered for vault ${vaultId}`, {
                pushToken,
                walletName,
                vaultNumber,
              });

              // Process each transaction ID only if this is a new notification
              // Insert transaction if it doesn't exist yet
              for (const txid of triggerTxIds)
                await db.run(
                  "INSERT OR IGNORE INTO vault_txids (txid, vaultId, status) VALUES (?, ?, 'unchecked')",
                  [txid, vaultId],
                );

              logger.info(
                `Registered vault ${vaultId} with ${triggerTxIds.length} trigger transactions (${triggerTxIds.length} new)`,
                { walletName, vaultNumber },
              );
            } else {
              logger.info(
                `Notification for vault ${vaultId} and push token ${pushToken} already exists, skipping txid processing`,
                { walletName, vaultNumber },
              );
            }

            // Commit the transaction
            await db.exec("COMMIT");
          } catch (error) {
            // Rollback the transaction if any error occurs
            await db.exec("ROLLBACK");
            logger.error(`Database transaction failed for vault ${vaultId}`, {
              error: error instanceof Error ? error.message : String(error),
              walletName,
              vaultNumber,
            });
            throw error;
          }
        }
        logger.info(
          `Successfully registered ${vaults.length} vaults for wallet "${walletName}"`,
        );
        res.sendStatus(200);
        return;
      } catch (err: any) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error(`Error in /${networkId}/watchtower/register:`, {
          error: errorMessage,
          stack: err instanceof Error ? err.stack : undefined,
          walletName,
          pushToken: pushToken ? pushToken.substring(0, 10) + "..." : undefined,
        });
        res.status(500).json({ error: "Internal server error" });
        return;
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
