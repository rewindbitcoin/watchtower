import { format } from 'date-fns';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Logger utility to standardize log formats across the application
 */
export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  /**
   * Format a log message with timestamp and context
   */
  private formatMessage(level: LogLevel, message: string, data?: any): string {
    const timestamp = format(new Date(), 'yyyy-MM-dd HH:mm:ss.SSS');
    let formattedMessage = `[${timestamp}] [${level.toUpperCase()}] [${this.context}] ${message}`;
    
    if (data) {
      if (data instanceof Error) {
        formattedMessage += `\n${data.stack || data.message}`;
      } else if (typeof data === 'object') {
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

  debug(message: string, data?: any): void {
    console.debug(this.formatMessage('debug', message, data));
  }

  info(message: string, data?: any): void {
    console.log(this.formatMessage('info', message, data));
  }

  warn(message: string, data?: any): void {
    console.warn(this.formatMessage('warn', message, data));
  }

  error(message: string, data?: any): void {
    console.error(this.formatMessage('error', message, data));
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
