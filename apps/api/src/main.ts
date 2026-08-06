import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

function loadEnv() {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const envPath = path.join(dir, '.env');
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
      return;
    }
    dir = path.dirname(dir);
  }
  dotenv.config();
}
loadEnv();

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import helmet from 'helmet';
import { ValidationPipe } from '@nestjs/common';
import * as express from 'express';
import { sanitizeMongoInput } from './common/mongo-sanitize.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Increase payload limits for base64 image uploads (like profile pictures)
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ limit: '10mb', extended: true }));

  // Sanitize all incoming bodies, queries, and route params against MongoDB operators ($ne, $gt, etc.)
  app.use(
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (req.body) sanitizeMongoInput(req.body);
      if (req.query) sanitizeMongoInput(req.query);
      if (req.params) sanitizeMongoInput(req.params);
      next();
    },
  );

  // Enable Helmet for comprehensive security headers
  app.use(
    helmet({
      contentSecurityPolicy: false, // Let frontend handle CSP or enable API-level headers
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // Strict CORS configuration
  const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://hirematex.vercel.app',
    'https://hirematex-web.vercel.app',
  ];
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // Allow requests with no origin, allowed web origins, chrome extensions, and supported job platforms
      if (
        !origin ||
        allowedOrigins.indexOf(origin) !== -1 ||
        origin.startsWith('chrome-extension://') ||
        /https?:\/\/([a-z0-9-]+\.)*(linkedin\.com|indeed\.com|naukri\.com)(:\d+)?$/i.test(
          origin,
        )
      ) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  // Global validation pipe to strip non-whitelisted fields and block injection
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      // Note: whitelist and forbidNonWhitelisted are omitted until proper DTO classes are implemented
    }),
  );

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`NestJS API is running on: http://localhost:${port}`);
}
bootstrap();
