import { db } from '../config/mongo';
import { Request } from 'express';

interface LogContext {
  userId?: string;
  fingerprint?: string;
  ip?: string;
  path?: string;
  method?: string;
  [key: string]: any;
}

/**
 * Hit and forget MongoDB logger for critical server errors.
 * This runs asynchronously without blocking the main event loop.
 */
export function logCriticalError(error: Error | string, req?: Request, additionalContext?: LogContext) {
  if (!db) return;

  try {
    const errorDetails = error instanceof Error ? {
      message: error.message,
      stack: error.stack,
      name: error.name
    } : { message: String(error) };

    const context: LogContext = { ...additionalContext };

    if (req) {
      context.path = req.path;
      context.method = req.method;
      context.ip = req.ip || req.headers['x-forwarded-for'] as string;
      
      // Attempt to extract identity from req if our middlewares populated it
      // @ts-ignore
      if (req.apiUser) {
        // @ts-ignore
        context.userId = req.apiUser.userId;
      }
      // @ts-ignore
      if (req.userContext) {
        // @ts-ignore
        context.userId = req.userContext.userId;
        // @ts-ignore
        context.fingerprint = req.userContext.fingerprint;
      }
      
      if (req.headers['x-fp']) {
        context.fingerprint = req.headers['x-fp'] as string;
      }
    }

    // Fire and forget insert
    db.collection('server_error_logs').insertOne({
      timestamp: new Date(),
      error: errorDetails,
      context,
    }).catch(err => {
      // If logging to mongo fails, just dump to console
      console.error('[Logger] Failed to write error log to MongoDB:', err);
    });

  } catch (err) {
    console.error('[Logger] Unhandled error inside logCriticalError:', err);
  }
}
