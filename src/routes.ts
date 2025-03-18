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
   * POST /register and /:networkId/register
   * Registers vaults and associates them with a push token.
   */
  app.post(
    ["/register", "/:networkId/register"],
    async (req: Request, res: Response): Promise<void> => {
      try {
        // Default to bitcoin if no networkId is provided in the path
        const networkId = req.params.networkId || "bitcoin";

        // Validate network parameter
        if (!["bitcoin", "testnet", "tape", "regtest"].includes(networkId)) {
          res.status(400).json({
            error:
              "Invalid networkId. Must be 'bitcoin', 'testnet', 'tape', or 'regtest'",
          });
          return;
        }

        const { pushToken, vaults, walletName } = req.body;
        if (!pushToken || !Array.isArray(vaults) || !walletName) {
          res.status(400).json({ error: "Invalid input data. pushToken, walletName, and vaults array are required" });
          return;
        }

        const db = getDb(networkId);

        // Insert or update each vault and its transaction ids.
        for (const vault of vaults) {
          const { vaultId, triggerTxIds, commitment } = vault;
          if (!vaultId || !Array.isArray(triggerTxIds)) {
            res.status(400).json({ error: "Invalid vault data" });
            return;
          }

          // Verify commitment if required
          if (requireCommitments) {
            if (!commitment) {
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
              `INSERT OR IGNORE INTO notifications (pushToken, vaultId, walletName, status) VALUES (?, ?, ?, 'pending')`,
              [pushToken, vaultId, walletName],
            );

            // If changes === 0, the entry already existed, so skip processing txids
            if (result.changes || 0 > 0) {
              // Process each transaction ID only if this is a new notification
              for (const txid of triggerTxIds) {
                // Insert transaction if it doesn't exist yet
                await db.run(
                  "INSERT OR IGNORE INTO vault_txids (txid, vaultId, status) VALUES (?, ?, 'unchecked')",
                  [txid, vaultId],
                );
              }
              logger.info(
                `Registered vault ${vaultId} with ${triggerTxIds.length} trigger transactions`,
              );
            } else {
              logger.info(
                `Notification for vault ${vaultId} and push token ${pushToken} already exists, skipping txid processing`,
              );
            }

            // Commit the transaction
            await db.exec("COMMIT");
          } catch (error) {
            // Rollback the transaction if any error occurs
            await db.exec("ROLLBACK");
            throw error;
          }
        }
        res.sendStatus(200);
        return;
      } catch (err: any) {
        logger.error("Error in /register:", err);
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
