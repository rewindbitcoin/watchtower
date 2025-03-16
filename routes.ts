import { Express, Request, Response } from 'express';
import { getDb } from './db';
import { sendPushNotification } from './notifications';

export function registerRoutes(app: Express) {
  /**
   * POST /register
   * Registers vaults and associates them with a push token.
   */
  app.post('/register', async (req: Request, res: Response) => {
    try {
      const { pushToken, vaults } = req.body;
      if (!pushToken || !Array.isArray(vaults)) {
        return res.status(400).json({ error: "Invalid input data" });
      }
      const db = getDb();

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
        // Remove previous txids and re-insert to ensure idempotence
        await db.run(`DELETE FROM vault_txids WHERE vaultId = ?`, vaultId);
        for (const txid of triggerTxIds) {
          await db.run(`INSERT INTO vault_txids (vaultId, txid) VALUES (?, ?)`, vaultId, txid);
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
