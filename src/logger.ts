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

type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Logger utility to standardize log formats across the application
 */
export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  /**
   * Format a timestamp in the format: YYYY-MM-DD HH:MM:SS.mmm
   */
  private formatTimestamp(date: Date): string {
    const pad = (num: number, size: number = 2): string => {
      let s = num.toString();
      while (s.length < size) s = "0" + s;
      return s;
    };

    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
      `${pad(date.getMilliseconds(), 3)}`
    );
  }

  /**
   * Format a log message with timestamp and context
   */
  private formatMessage(level: LogLevel, message: string, data?: unknown): string {
    const timestamp = this.formatTimestamp(new Date());
    let formattedMessage = `[${timestamp}] [${level.toUpperCase()}] [${this.context}] ${message}`;

    if (data) {
      if (data instanceof Error) {
        formattedMessage += `\n${data.stack || data.message}`;
      } else if (typeof data === "object") {
        try {
          formattedMessage += `\n${JSON.stringify(data, null, 2)}`;
        } catch (e) {
          formattedMessage += `\n[Object cannot be stringified]`;
        }
      } else {
        formattedMessage += `\n${data}`;
      }
    }

    return formattedMessage;
  }

  debug(message: string, data?: unknown): void {
    console.debug(this.formatMessage("debug", message, data));
  }

  info(message: string, data?: unknown): void {
    console.log(this.formatMessage("info", message, data));
  }

  warn(message: string, data?: unknown): void {
    console.warn(this.formatMessage("warn", message, data));
  }

  error(message: string, data?: unknown): void {
    console.error(this.formatMessage("error", message, data));
  }

  /**
   * Create a child logger with a sub-context
   */
  child(subContext: string): Logger {
    return new Logger(`${this.context}:${subContext}`);
  }
}

/**
 * Create a logger instance with the given context
 */
export function createLogger(context: string): Logger {
  return new Logger(context);
}
