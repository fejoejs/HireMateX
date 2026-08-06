import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * Recursively strips keys starting with '$' or containing '.' to prevent NoSQL/MongoDB injection attacks.
 */
export function sanitizeMongoInput(target: any): any {
  if (!target || typeof target !== 'object') {
    return target;
  }

  if (Array.isArray(target)) {
    for (let i = 0; i < target.length; i++) {
      target[i] = sanitizeMongoInput(target[i]);
    }
    return target;
  }

  for (const key of Object.keys(target)) {
    if (key.startsWith('$') || key.includes('.')) {
      delete target[key];
    } else if (typeof target[key] === 'object' && target[key] !== null) {
      target[key] = sanitizeMongoInput(target[key]);
    }
  }

  return target;
}

@Injectable()
export class MongoSanitizeMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    if (req.body) sanitizeMongoInput(req.body);
    if (req.query) sanitizeMongoInput(req.query);
    if (req.params) sanitizeMongoInput(req.params);
    next();
  }
}
