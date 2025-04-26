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

import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { createLogger } from "./logger";

// Create logger for this module
const logger = createLogger("Middleware");

// Extend Express Request type to include requestId
declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

/**
 * Middleware to add a unique request ID to each request
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // Check if client provided a request ID
  const clientProvidedId = req.headers["x-request-id"];

  // Use client ID or generate a new one
  req.requestId = (clientProvidedId as string) || randomUUID();

  // Add it to response headers for debugging
  res.setHeader("X-Request-ID", req.requestId);

  logger.debug(`Request started: ${req.method} ${req.originalUrl}`, {
    requestId: req.requestId,
  });

  // Track response completion
  res.on("finish", () => {
    logger.debug(
      `Request completed: ${req.method} ${req.originalUrl} - Status: ${res.statusCode}`,
      { requestId: req.requestId },
    );
  });

  next();
}
