# Watchtower API for RewindBitcoin Wallet

## 📌 Overview

The **Watchtower API** is a monitoring service for the **RewindBitcoin Wallet**
that tracks Bitcoin transactions associated with vaults. When a transaction
related to a monitored vault is detected, the service sends **push notifications**
to the user.

## 🚀 Features

- Monitors **vault-related transactions** on the Bitcoin blockchain.
- Tracks **mempool** and **confirmed transactions** efficiently.
- Sends **push notifications** via Expo when vaults are accessed.
- Uses **SQLite** for persistent data storage.
- Provides a **REST API** for registering vaults and checking service health.

---

## 🏗 Tech Stack

- **Node.js with TypeScript** - Backend service.
- **Express.js** - API framework.
- **SQLite** - Data persistence.
- **Expo Push Notifications** - Alerting users.
- **fetch API** - Blockchain API requests.

---

## ⚙️ Setup & Installation

### 1️⃣ Install Dependencies

```bash
npm install
```

### 2️⃣ Run the Watchtower API

Start the server to monitor all networks:

```bash
npx ts-node src/index.ts
```

You can disable specific networks:

```bash
npx ts-node src/index.ts --disable-bitcoin --disable-tape
```

Command line options:

```bash
npx ts-node src/index.ts --port 3000 --disable-testnet --disable-tape
```

To enable regtest with a custom Esplora API URL:

```bash
npx ts-node src/index.ts --enable-regtest http://localhost:3002
```

To enable commitment verification:

```bash
npx ts-node src/index.ts --with-commitments
```

To specify a custom database folder (default is ./db):

```bash
npx ts-node src/index.ts --db-folder /path/to/database
```

Display help information:

```bash
npx ts-node src/index.ts --help
```

If no port is specified, a random available port will be used and displayed in
the console.

By default, the watchtower monitors these networks:

- `bitcoin`
- `testnet`
- `tape`

The `regtest` network is disabled by default and must be explicitly enabled with a valid Esplora API URL.

---

## 🗃 Database Schema

The Watchtower API uses **SQLite** with the following structure:

**Notifications Table:**
| Column | Type | Description |
|----------|------|-------------|
| `pushToken` | TEXT | Device push notification token |
| `vaultId` | TEXT | Associated vault ID |
| `status` | TEXT | Status: 'pending' (notification not sent yet) or 'sent' (notification already sent) |

**Vault Transactions Table:**
| Column | Type | Description |
|--------|------|-------------|
| `txid` | TEXT | Primary Key - Transaction ID to monitor |
| `vaultId` | TEXT | Associated vault ID |
| `status` | TEXT | Status: 'unchecked', 'unseen', 'reversible', or 'irreversible' |

**Network State Table:**
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Primary Key (always 1) |
| `last_checked_height` | INTEGER | Last block height that was checked |

**Authorized Addresses Table (in separate database):**
| Column | Type | Description |
|--------|------|-------------|
| `address` | TEXT | Primary Key - Bitcoin address authorized to use the service |
| `created_at` | TIMESTAMP | When the address was added to the database |

This table is stored in a separate database file (`{networkId}.sqlite`) and is managed by another process. The watchtower only reads from this database when commitment verification is enabled.

---

## 📡 API Endpoints

### **1️⃣ Register Vaults to Be Monitored**

**`POST /register`** or **`POST /:networkId/register`**

- **Purpose:** Registers vaults and associates them with a push notification token.
- **URL Parameters:**
  - `networkId`: The Bitcoin network (`bitcoin`, `testnet`, `tape`, or `regtest`)
  - If using `/register` without networkId, defaults to `bitcoin` mainnet
- **Request Body:**

  ```json
  {
    "pushToken": "ExponentPushToken[xyz]",
    "vaults": [
      {
        "vaultId": "vault123",
        "triggerTxIds": ["txid1", "txid2"],
        "commitment": "0200000001abcdef..." // Optional, required when --with-commitments is enabled
      }
    ]
  }
  ```

- **Commitment Verification:**
  - When enabled with `--with-commitments` flag, each vault registration requires a valid commitment
  - The `commitment` field contains a hex-encoded Bitcoin transaction
  - This transaction must pay to at least one authorized address
  - Authorized addresses are stored in a separate database (`{networkId}.sqlite`)
  - This prevents spam registrations by requiring a payment to use the service

- **Responses:**
  - `200 OK`: Registration successful
  - `400 Bad Request`: Invalid input data or commitment transaction
  - `403 Forbidden`: Commitment transaction doesn't pay to an authorized address
  - `409 Conflict`: Vault has already been accessed and cannot be registered again

### **2️⃣ Health Check**

**`GET /generate_204`**

- **Purpose:** Checks if the service is running.
- **Response:** `204 No Content`

---

## 🔍 Blockchain Monitoring Strategy

The Watchtower uses an efficient monitoring strategy to minimize API calls:

1. **On startup:** Initialize with the last checked block height minus
   IRREVERSIBLE_THRESHOLD from the database or current height (minus
   IRREVERSIBLE_THRESHOLD) if starting fresh.

2. **For each monitoring cycle:**
   - Get all new blocks since the last checked height
   - Check if any pending transactions appear in these blocks
   - Send notifications to all devices for found transactions
   - Mark notifications as 'sent' or 'pending'
   - Update the last checked height

3. **Reorg handling:** Recheck the last 6 blocks (IRREVERSIBLE_THRESHOLD) on each
   cycle to handle potential blockchain reorganizations

4. **In-memory caching:** Keep track of checked blocks in memory to avoid
   redundant processing within a session

This approach efficiently monitors transactions while handling multiple devices
per vault and maintaining proper notification state.

---

## 📩 Push Notifications

The service uses **Expo Push Notifications** to alert users when a monitored
vault is accessed.

**Example Payload:**

```json
{
  "to": "ExponentPushToken[xyz]",
  "title": "Vault Access Alert!",
  "body": "Your vault vault123 is being accessed!",
  "data": { "vaultId": "vault123" }
}
```

---

## 🎯 Summary

The **Watchtower API** efficiently tracks Bitcoin transactions related to vaults
and notifies users when their funds are accessed. It is designed to minimize
redundant API calls and maximize efficiency in blockchain polling.
