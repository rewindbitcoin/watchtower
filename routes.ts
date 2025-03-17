import { Express, Request, Response } from "express";
import { getDb } from "./db";

export function registerRoutes(app: Express) {
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
        if (!["bitcoin", "testnet", "regtest"].includes(networkId)) {
          res.status(400).json({
            error:
              "Invalid networkId. Must be 'bitcoin', 'testnet', or 'regtest'",
          });
          return;
        }

        const { pushToken, vaults } = req.body;
        if (!pushToken || !Array.isArray(vaults)) {
          res.status(400).json({ error: "Invalid input data" });
          return;
        }

        const db = getDb(networkId);

        // Insert or update each vault and its transaction ids.
        for (const vault of vaults) {
          const { vaultId, triggerTxIds } = vault;
          if (!vaultId || !Array.isArray(triggerTxIds)) {
            res.status(400).json({ error: "Invalid vault data" });
            return;
          }

          // Check if this vault has already been notified as irreversible
          const existingNotification = await db.get(
            "SELECT status FROM notifications WHERE vaultId = ? AND status = 'notified_irreversible' LIMIT 1",
            [vaultId],
          );

          if (existingNotification) {
            res.status(409).json({
              error: "Vault already accessed",
              message: `Vault ${vaultId} has already been accessed and cannot be registered again.`,
            });
            return;
          }

          // Insert notification entry and check if it was actually inserted
          const result = await db.run(
            `INSERT OR IGNORE INTO notifications (pushToken, vaultId, status) VALUES (?, ?, 'pending')`,
            [pushToken, vaultId],
          );
          
          // If changes === 0, the entry already existed, so skip processing txids
          if (result.changes > 0) {
            // Process each transaction ID only if this is a new notification
            for (const txid of triggerTxIds) {
              // Check if this txid is already being monitored
              const existing = await db.get(
                "SELECT txid FROM vault_txids WHERE txid = ?",
                [txid],
              );
  
              if (!existing) {
                // Insert new transaction to monitor with default status of 'unknown'
                await db.run(
                  "INSERT INTO vault_txids (txid, vaultId, status) VALUES (?, ?, 'unknown')",
                  [txid, vaultId],
                );
              } else if (existing.vaultId !== vaultId) {
                // If txid exists but is associated with a different vault, update it
                await db.run(
                  "UPDATE vault_txids SET vaultId = ? WHERE txid = ?",
                  [vaultId, txid],
                );
              }
            }
          } else {
            console.log(`Notification for vault ${vaultId} and push token ${pushToken} already exists, skipping txid processing`);
          }

          // Remove any txids that are no longer in the list
          if (triggerTxIds.length > 0) {
            const placeholders = triggerTxIds.map(() => "?").join(",");
            await db.run(
              `DELETE FROM vault_txids WHERE vaultId = ? AND txid NOT IN (${placeholders})`,
              [vaultId, ...triggerTxIds],
            );
          }
        }
        res.sendStatus(200);
        return;
      } catch (err: any) {
        console.error("Error in /register:", err);
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
