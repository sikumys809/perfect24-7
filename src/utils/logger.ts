// ログ管理（簡易版）

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

interface LogContext {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: Record<string, any>;
  error?: any;
}

function formatLog(ctx: LogContext): string {
  const { timestamp, level, message, data, error } = ctx;
  let log = `[${timestamp}] ${level} - ${message}`;
  if (data) log += ` | ${JSON.stringify(data)}`;
  if (error) log += ` | Error: ${error.message || JSON.stringify(error)}`;
  return log;
}

export class Logger {
  static debug(message: string, data?: Record<string, any>) {
    this.log(LogLevel.DEBUG, message, data);
  }

  static info(message: string, data?: Record<string, any>) {
    this.log(LogLevel.INFO, message, data);
  }

  static warn(message: string, data?: Record<string, any>) {
    this.log(LogLevel.WARN, message, data);
  }

  static error(message: string, error?: any, data?: Record<string, any>) {
    this.log(LogLevel.ERROR, message, data, error);
  }

  private static log(level: LogLevel, message: string, data?: Record<string, any>, error?: any) {
    const ctx: LogContext = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
      error,
    };

    const formatted = formatLog(ctx);

    // 本番環境では JSON フォーマットで CloudLogging 等に送ることを想定
    if (process.env.NODE_ENV === 'production') {
      console.log(JSON.stringify(ctx));
    } else {
      const colors = {
        DEBUG: '\x1b[36m',
        INFO: '\x1b[32m',
        WARN: '\x1b[33m',
        ERROR: '\x1b[31m',
        RESET: '\x1b[0m',
      };
      console.log(`${colors[level]}${formatted}${colors.RESET}`);
    }
  }
}
