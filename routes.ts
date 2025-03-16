import { Express, Request, Response } from 'express';
import { getDb } from './db';
import { sendPushNotification } from './notifications';

export function registerRoutes(app: Express) {
  /**
   * POST /register and /:networkId/register
   * Registers vaults and associates them with a push token.
   */
  app.post(['/register', '/:networkId/register'], async (req: Request, res: Response) => {
    try {
      // Default to bitcoin if no networkId is provided in the path
      const networkId = req.params.networkId || 'bitcoin';
      
      // Validate network parameter
      if (!['bitcoin', 'testnet', 'regtest'].includes(networkId)) {
        return res.status(400).json({ 
          error: "Invalid networkId. Must be 'bitcoin', 'testnet', or 'regtest'" 
        });
      }
      
      const { pushToken, vaults } = req.body;
      if (!pushToken || !Array.isArray(vaults)) {
        return res.status(400).json({ error: "Invalid input data" });
      }
      
      const db = getDb(networkId);

      // Insert or update each vault and its transaction ids.
      for (const vault of vaults) {
        const { vaultId, triggerTxIds } = vault;
        if (!vaultId || !Array.isArray(triggerTxIds)) {
          return res.status(400).json({ error: "Invalid vault data" });
        }
        await db.run(
          `INSERT INTO vaults (vaultId, pushToken) VALUES (?, ?)
          ON CONFLICT(vaultId) DO UPDATE SET pushToken = ?;`,
          vaultId, pushToken, pushToken
        );
        
        // Process each transaction ID
        for (const txid of triggerTxIds) {
          // Check if this txid is already being monitored for this vault
          const existing = await db.get(
            "SELECT id FROM vault_txids WHERE vaultId = ? AND txid = ?",
            [vaultId, txid]
          );
          
          if (!existing) {
            // Insert new transaction to monitor with default 'pending' status
            await db.run(
              "INSERT INTO vault_txids (vaultId, txid, status) VALUES (?, ?, 'pending')",
              [vaultId, txid]
            );
          }
        }
        
        // Remove any txids that are no longer in the list
        if (triggerTxIds.length > 0) {
          const placeholders = triggerTxIds.map(() => '?').join(',');
          await db.run(
            `DELETE FROM vault_txids WHERE vaultId = ? AND txid NOT IN (${placeholders})`,
            [vaultId, ...triggerTxIds]
          );
        }
      }
      return res.sendStatus(200);
    } catch (err: any) {
      console.error("Error in /register:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /generate_204
   * Health check endpoint that returns HTTP 204 No Content.
   */
  app.get('/generate_204', (req: Request, res: Response) => {
    res.status(204).send();
  });
}
