// カスタム Error クラス

export class AppError extends Error {
  constructor(
    public code: string,
    public statusCode: number,
    message: string,
    public details?: Record<string, any>
  ) {
    super(message);
    this.name = 'AppError';
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, any>) {
    super('VALIDATION_ERROR', 400, message, details);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super('NOT_FOUND', 404, `${resource} not found`);
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super('UNAUTHORIZED', 401, message);
    this.name = 'UnauthorizedError';
  }
}

export class DatabaseError extends AppError {
  constructor(message: string, details?: Record<string, any>) {
    super('DATABASE_ERROR', 500, message, details);
    this.name = 'DatabaseError';
  }
}

export class ExternalAPIError extends AppError {
  constructor(service: string, message: string, details?: Record<string, any>) {
    super('EXTERNAL_API_ERROR', 502, `${service} API error: ${message}`, details);
    this.name = 'ExternalAPIError';
  }
}

export function isAppError(err: any): err is AppError {
  return err instanceof AppError;
}
