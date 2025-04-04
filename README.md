# Watchtower API for RewindBitcoin Wallet

## 📌 Overview

The **Watchtower API** is a security monitoring service for the
**RewindBitcoin Wallet** that protects users' Bitcoin vaults from unauthorized
access. It continuously watches the blockchain for specific transactions that
would indicate someone is attempting to unfreeze a vault. When such activity is
detected, the service immediately sends **system-level push notifications** to the user's
iOS and Android devices where the RewindBitcoin app is installed, allowing them to take
action before funds can be moved.

In practical terms, this means:

- If someone gains access to your wallet (through theft, etc.), the Watchtower notifies you immediately
- When an attacker tries to unfreeze your vault, you receive alerts on all your registered devices as high-priority system notifications
- The RewindBitcoin app immediately displays emergency action options when you tap on the notification
- You then have time to execute a "panic transaction" to move funds to your emergency cold storage before the attacker can access them
- The service works silently in the background, only alerting you when necessary

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

#### Network Monitoring

If no port is specified, a random available port will be used and displayed in
the console.

By default, the watchtower monitors these networks:

- `bitcoin`
- `testnet`
- [`tape`](https://tape.rewindbitcoin.com/) (Rewind Bitcoin's own test network)

The `regtest` network is disabled by default and must be explicitly enabled with
a valid Esplora API URL.

### 💻 For Developers

If you want to modify or contribute to the Watchtower API:

#### Clone and Install Dependencies

```bash
git clone https://github.com/rewindbitcoin/watchtower.git
cd watchtower
npm install
```

#### Development Mode

```bash
# Run in development mode
npx ts-node src/index.ts
```

#### Build from Source

```bash
# Build the project
npm run build

# Run the built version
npm start
```

#### Publishing (for maintainers)

```bash
# Build and publish to npm
npm publish
```

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

5. **Commitment verification:** An optional security feature that validates transactions against their original vault creation transaction
   (See the [Commitment Verification](#-commitment-verification) section for complete details)

This approach efficiently monitors transactions while handling multiple devices
per vault and maintaining proper notification state.

---

## 🔐 Commitment Verification

The Watchtower API uses a commitment verification system to prevent abuse:

- When enabled with `--with-commitments` flag, each vault registration requires a valid commitment transaction
- The `commitment` is the actual transaction that created the vault on the blockchain
- This transaction should have paid a fee to an authorized service address
- The transactions being monitored by the watchtower are those that spend from this commitment
  (i.e., transactions that initiate the unfreezing of a vault)
- This commitment system serves several important purposes:
  - Prevents spam registrations by requiring a real on-chain payment
  - Ensures only legitimate vaults can be registered with the service
- Each commitment can only be used for one vault ID
- When a trigger transaction is detected, it's verified to be spending from the commitment
- If the trigger is not spending from the commitment, the alert is not sent
- Note: If you're running your own private watchtower, you can disable this feature
  as long as you don't make your service publicly available

---

## 📩 Push Notifications

The service uses **Expo Push Notifications** to deliver critical security alerts directly to users' iOS and Android devices when a monitored vault is accessed. These notifications appear as system-level alert dialogs with warning messages, ensuring users are promptly informed of potential security events.

### Critical Security Alerts

When a vault access attempt is detected, the Watchtower immediately sends a push notification to all registered devices associated with that vault. These notifications:

- Appear as high-priority system dialogs on both iOS and Android devices
- Display clear warning messages about the vault being accessed
- Include essential information about which vault is affected
- Provide context about the wallet and transaction

**Example Payload:**

```json
{
  "to": "ExponentPushToken[xyz]",
  "title": "Vault Access Alert!",
  "body": "Your vault vault123 in wallet 'My Bitcoin Wallet' is being accessed!",
  "data": {
    "vaultId": "vault123",
    "walletName": "My Bitcoin Wallet",
    "vaultNumber": 1,
    "txid": "abcdef1234567890abcdef1234567890"
  }
}
```

### Persistent Notification System

The Watchtower implements a robust retry mechanism to ensure critical security alerts are not missed:

- **Persistent Retries:** The system periodically retries sending notifications until the user explicitly acknowledges receipt
- **Escalating Schedule:**
  - First day: Retry every 6 hours
  - After first day: Retry once per day for up to a week
- **Enhanced Context:** Retry notifications include additional information about when the issue was first detected

This persistent approach ensures that even if a user's device is temporarily offline or notifications are missed, they will still be alerted to potential security issues with their vaults.

**Example Retry Payload:**

```json
{
  "to": "ExponentPushToken[xyz]",
  "title": "Vault Access Alert!",
  "body": "Your vault vault123 in wallet 'My Bitcoin Wallet' is being accessed! (Attempt 3, first detected 14 hours ago)",
  "data": {
    "vaultId": "vault123",
    "walletName": "My Bitcoin Wallet",
    "vaultNumber": 1,
    "txid": "abcdef1234567890abcdef1234567890",
    "attemptCount": 3,
    "firstDetectedAt": 1634567890
  }
}
```

### Acknowledging Notifications

To stop receiving retry notifications once the alert has been seen, the client app should acknowledge receipt using the [Acknowledge Notification Receipt](#acknowledge-notification-receipt) API endpoint:

```bash
POST /watchtower/ack
{
  "pushToken": "ExponentPushToken[xyz]",
  "vaultId": "vault123"
}
```

This acknowledgment system ensures that users are only notified until they've confirmed awareness of the security event.

---

## 📡 API Endpoints

The Watchtower provides a simple REST API for registering vaults and acknowledging notifications. Below are the available endpoints:

### Register Vaults to Be Monitored

**`POST /watchtower/register`** or **`POST /:networkId/watchtower/register`**

- **Purpose:** Registers vaults and associates them with a push notification token.
- **URL Parameters:**
  - `networkId`: The Bitcoin network (`bitcoin`, `testnet`, `tape`, or `regtest`)
  - If using `/watchtower/register` without networkId, defaults to `bitcoin` mainnet
- **Request Body:**

  ```json
  {
    "pushToken": "ExponentPushToken[xyz]",
    "walletName": "My Bitcoin Wallet",
    "locale": "es", // Optional, defaults to "en"
    "vaults": [
      {
        "vaultId": "vault123",
        "vaultNumber": 1,
        "triggerTxIds": ["txid1", "txid2"],
        "commitment": "0200000001abcdef..." // Required when commitment verification is enabled
      },
      {
        "vaultId": "vault456",
        "vaultNumber": 2,
        "triggerTxIds": ["txid3", "txid4"],
        "commitment": "0200000001ghijkl..." // Required when commitment verification is enabled
      }
    ]
  }
  ```

### Supported Languages

The Watchtower API currently supports the following languages for notifications:

- English (`en`) - Default
- Spanish (`es`)

The language is specified using the `locale` parameter during vault registration.

- **Responses:**
  - `200 OK`: Registration successful
  - `400 Bad Request`: Invalid input data or commitment transaction
  - `403 Forbidden`: Commitment transaction doesn't pay to an authorized address
  - `409 Conflict`: Vault has already been accessed and cannot be registered again

### Health Check

**`GET /generate_204`**

- **Purpose:** Checks if the service is running.
- **Response:** `204 No Content`

### Acknowledge Notification Receipt

**`POST /watchtower/ack`** or **`POST /:networkId/watchtower/ack`**

- **Purpose:** Acknowledges receipt of a notification for a specific vault.
- **URL Parameters:**
  - `networkId`: The Bitcoin network (`bitcoin`, `testnet`, `tape`, or `regtest`)
  - If using `/watchtower/ack` without networkId, defaults to `bitcoin` mainnet
- **Request Body:**

  ```json
  {
    "pushToken": "ExponentPushToken[xyz]",
    "vaultId": "vault123"
  }
  ```

- **Responses:**
  - `200 OK`: Acknowledgment successful
  - `400 Bad Request`: Invalid input data
  - `404 Not Found`: No matching notification found
  - `500 Internal Server Error`: Server error

---

## 🗃 Database Schema

The Watchtower API uses **SQLite** with the following structure:

**Notifications Table:**
| Column | Type | Description |
|----------|------|-------------|
| `pushToken` | TEXT | Device push notification token |
| `vaultId` | TEXT | Associated vault ID |
| `walletName` | TEXT | Name of the wallet containing the vault |
| `vaultNumber` | INTEGER | The nth vault created in the wallet |
| `firstAttemptAt` | INTEGER | Unix timestamp of first notification attempt |
| `acknowledged` | INTEGER | Whether notification was acknowledged (0=no, 1=yes) |
| `lastAttemptAt` | INTEGER | Unix timestamp of last notification attempt |
| `attemptCount` | INTEGER | Number of notification attempts made |
| `locale` | TEXT | User's preferred language (default: 'en') |

**Vault Transactions Table:**
| Column | Type | Description |
|--------|------|-------------|
| `txid` | TEXT | Primary Key - Transaction ID to monitor |
| `vaultId` | TEXT | Associated vault ID |
| `status` | TEXT | Status: 'unchecked', 'unseen', 'reversible', 'irreversible' |
| `commitmentTxid` | TEXT | The txid of the commitment transaction (when using commitments) |

**Commitments Table:**
| Column | Type | Description |
|--------|------|-------------|
| `txid` | TEXT | Primary Key - Transaction ID of the commitment |
| `vaultId` | TEXT | Associated vault ID |
| `created_at` | INTEGER | Unix timestamp when the commitment was registered |

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

## 🎯 Summary

The **Watchtower API** efficiently tracks Bitcoin transactions related to vaults
and notifies users when their funds are accessed. It is designed to minimize
redundant API calls and maximize efficiency in blockchain polling.

By combining [commitment verification](#-commitment-verification), [efficient blockchain monitoring](#-blockchain-monitoring-strategy), and [persistent push notifications](#-push-notifications), the Watchtower provides a robust security layer for Bitcoin vault users.
