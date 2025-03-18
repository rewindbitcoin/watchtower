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

## ⚙️ Usage

### 📱 For Users

You can run the Watchtower API directly using npx without installing it:

```bash
npx @rewindbitcoin/watchtower
```

#### Command Line Options

```bash
# Run with specific port
npx @rewindbitcoin/watchtower --port 3000

# Disable specific networks
npx @rewindbitcoin/watchtower --disable-testnet --disable-tape

# Enable regtest with custom Esplora API URL
npx @rewindbitcoin/watchtower --enable-regtest \
  http://localhost:3002

# Enable commitment verification
npx @rewindbitcoin/watchtower --with-commitments

# Specify custom database folder (default is ./db)
npx @rewindbitcoin/watchtower --db-folder /path/to/database

# Display help information
npx @rewindbitcoin/watchtower --help
```

### 💻 For Developers

If you want to modify or contribute to the Watchtower API:

#### 1️⃣ Clone and Install Dependencies

```bash
git clone https://github.com/rewindbitcoin/watchtower.git
cd watchtower
npm install
```

#### 2️⃣ Development Mode

```bash
# Run in development mode
npx ts-node src/index.ts
```

#### 3️⃣ Build from Source

```bash
# Build the project
npm run build

# Run the built version
npm start
```

#### Network Monitoring

If no port is specified, a random available port will be used and displayed in
the console.

By default, the watchtower monitors these networks:

- `bitcoin`
- `testnet`
- `tape`

The `regtest` network is disabled by default and must be explicitly enabled with
a valid Esplora API URL.

#### Publishing (for maintainers)

```bash
# Build and publish to npm
npm publish
```

---

## 🗃 Database Schema

The Watchtower API uses **SQLite** with the following structure:

**Notifications Table:**
| Column | Type | Description |
|----------|------|-------------|
| `pushToken` | TEXT | Device push notification token |
| `vaultId` | TEXT | Associated vault ID |
| `walletName` | TEXT | Name of the wallet containing the vault |
| `status` | TEXT | Status: 'pending' (not sent yet) or 'sent' |

**Vault Transactions Table:**
| Column | Type | Description |
|--------|------|-------------|
| `txid` | TEXT | Primary Key - Transaction ID to monitor |
| `vaultId` | TEXT | Associated vault ID |
| `status` | TEXT | Status: 'unchecked', 'unseen', 'reversible', 'irreversible' |

**Network State Table:**
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Primary Key (always 1) |
| `last_checked_height` | INTEGER | Last block height that was checked |

**Authorized Addresses Table (in separate database):**
| Column | Type | Description |
|--------|------|-------------|
| `address` | TEXT | Primary Key - Btc address authorized to use the service |
| `created_at` | TIMESTAMP | When the address was added to the database |

This table is stored in a separate database file (`{networkId}.sqlite`) and is
managed by another process. The watchtower only reads from this database when
commitment verification is enabled.

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
        "walletName": "My Bitcoin Wallet",
        "triggerTxIds": ["txid1", "txid2"],
        "commitment": "0200000001abcdef..." // Optional with --with-commitments
      },
      {
        "vaultId": "vault456",
        "walletName": "My Other Wallet",
        "triggerTxIds": ["txid3", "txid4"],
        "commitment": "0200000001ghijkl..." // Optional
      }
    ]
  }
  ```

- **Commitment Verification:**

  - When enabled with `--with-commitments` flag, each vault registration
    requires a valid commitment
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

3. **Reorg handling:** Recheck the last 4 blocks (IRREVERSIBLE_THRESHOLD) on each
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
  "body": "Your vault vault123 in wallet 'My Bitcoin Wallet' is being accessed!",
  "data": {
    "vaultId": "vault123",
    "walletName": "My Bitcoin Wallet",
    "txid": "abcdef1234567890abcdef1234567890"
  }
}
```

---

## 🎯 Summary

The **Watchtower API** efficiently tracks Bitcoin transactions related to vaults
and notifies users when their funds are accessed. It is designed to minimize
redundant API calls and maximize efficiency in blockchain polling.
