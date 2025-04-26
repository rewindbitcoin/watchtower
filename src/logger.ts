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
  private formatMessage(
    level: LogLevel,
    message: string,
    data?: unknown,
  ): string {
    const timestamp = this.formatTimestamp(new Date());
    let dataToLog = data;

    // Extract requestId if present in data
    let requestIdStr = "";
    if (data && typeof data === "object" && "requestId" in data) {
      requestIdStr = ` [ReqID:${data.requestId}]`;
      // If data only contains requestId, don't log it separately
      if (Object.keys(data as object).length === 1 && "requestId" in data) {
        dataToLog = undefined;
      }
    }

    let formattedMessage = `[${timestamp}] [${level.toUpperCase()}]${requestIdStr} [${this.context}] ${message}`;

    if (dataToLog) {
      if (dataToLog instanceof Error) {
        formattedMessage += `\n${dataToLog.stack || dataToLog.message}`;
      } else if (typeof dataToLog === "object") {
        try {
          formattedMessage += `\n${JSON.stringify(dataToLog, null, 2)}`;
        } catch (e) {
          formattedMessage += `\n[Object cannot be stringified]`;
        }
      } else {
        formattedMessage += `\n${dataToLog}`;
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
