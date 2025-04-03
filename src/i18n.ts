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

// Define supported locales
export type Locale = "en" | "es";

// Define message types
export type MessageType = "vaultAccessTitle" | "vaultAccessBody";

// Define message templates with placeholders
interface MessageTemplates {
  vaultAccessTitle: string;
  vaultAccessBody: string;
}

// Define translations for each supported locale
const messages: Record<Locale, MessageTemplates> = {
  // English translations
  en: {
    vaultAccessTitle: "Vault Access Detected",
    vaultAccessBody:
      'Access to Vault #{vaultNumber} from "{walletName}" detected {timeSince} ago.',
  },
  // Spanish translations
  es: {
    vaultAccessTitle: "Acceso a Bóveda Detectado",
    vaultAccessBody:
      'Acceso a Bóveda #{vaultNumber} de "{walletName}" detectado hace {timeSince}.',
  },
};

/**
 * Normalize a locale string to a supported locale
 * @param locale The locale string (e.g., "en-US", "es-MX")
 * @returns Normalized locale ("en" or "es")
 */
export function normalizeLocale(locale: string): Locale {
  // Extract the language code (part before the hyphen, if any)
  const languageCode = locale.split("-")[0]!.toLowerCase();

  // Return the language code if supported, otherwise default to 'en'
  return languageCode in messages ? (languageCode as Locale) : "en";
}

/**
 * Get a localized message with placeholders replaced by values
 * @param locale The locale to use (defaults to 'en' if not supported)
 * @param messageType The type of message to retrieve
 * @param placeholders Object containing values to replace placeholders
 * @returns Formatted message string
 */
export function getMessage(
  locale: string,
  messageType: MessageType,
  placeholders: Record<string, string | number>,
): string {
  // Normalize the locale
  const normalizedLocale = normalizeLocale(locale);

  // Get the message template
  let message = messages[normalizedLocale][messageType];

  // Replace all placeholders with their values
  Object.entries(placeholders).forEach(([key, value]) => {
    message = message.replace(`{${key}}`, String(value));
  });

  return message;
}

/**
 * Format time since a timestamp in a human-readable format with localization
 * @param timestamp Unix timestamp in milliseconds
 * @param locale The locale to use
 * @returns Localized time string
 */
export function formatTimeSince(timestamp: number, locale: string): string {
  const now = Date.now();
  const diffMs = now - timestamp;

  // Convert to seconds, minutes, hours, days
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  // Normalize the locale
  const normalizedLocale = normalizeLocale(locale);

  // Format based on locale
  if (normalizedLocale === "es") {
    if (days > 0) {
      return `${days} día${days > 1 ? "s" : ""}`;
    } else if (hours > 0) {
      return `${hours} hora${hours > 1 ? "s" : ""}`;
    } else if (minutes > 0) {
      return `${minutes} minuto${minutes > 1 ? "s" : ""}`;
    } else {
      return `${seconds} segundo${seconds !== 1 ? "s" : ""}`;
    }
  } else {
    // Default to English
    if (days > 0) {
      return `${days} day${days > 1 ? "s" : ""}`;
    } else if (hours > 0) {
      return `${hours} hour${hours > 1 ? "s" : ""}`;
    } else if (minutes > 0) {
      return `${minutes} minute${minutes > 1 ? "s" : ""}`;
    } else {
      return `${seconds} second${seconds !== 1 ? "s" : ""}`;
    }
  }
}
