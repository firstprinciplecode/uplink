import { Request, Response, NextFunction } from "express";
import { ZodSchema, ZodError } from "zod";
import { makeError } from "../schemas/error";
import { logger } from "../utils/logger";

export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        logger.warn({
          event: "validation.failed",
          path: req.path,
          errors: error.errors,
        });
        return res.status(400).json(
          makeError("VALIDATION_ERROR", "Invalid request body", {
            errors: error.errors.map((e) => ({
              path: e.path.join("."),
              message: e.message,
            })),
          })
        );
      }
      next(error);
    }
  };
}

export function validateQuery(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      req.query = schema.parse(req.query);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        logger.warn({
          event: "validation.failed",
          path: req.path,
          errors: error.errors,
        });
        return res.status(400).json(
          makeError("VALIDATION_ERROR", "Invalid query parameters", {
            errors: error.errors.map((e) => ({
              path: e.path.join("."),
              message: e.message,
            })),
          })
        );
      }
      next(error);
    }
  };
}

