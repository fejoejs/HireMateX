import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';

@Injectable()
export class ExtensionAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'Extension authorization token is required',
      );
    }

    const token = authHeader.split(' ')[1];
    const jwtSecret =
      process.env.EXTENSION_JWT_SECRET || process.env.JWT_SECRET;
    if (!jwtSecret && process.env.NODE_ENV === 'production') {
      console.error(
        '[ExtensionAuthGuard] CRITICAL: EXTENSION_JWT_SECRET or JWT_SECRET is missing in production!',
      );
      throw new UnauthorizedException(
        'Server configuration error: missing JWT secret',
      );
    }
    const secretToUse = jwtSecret || 'hirematex_extension_secure_key_dev';
    try {
      const decoded = jwt.verify(token, secretToUse) as any;
      if (!decoded || !decoded.userId) {
        throw new UnauthorizedException(
          'Invalid extension token: missing user ID',
        );
      }

      // Map userId to sub, matching standard GetUserId decorator expectations
      request.user = { sub: decoded.userId };
      return true;
    } catch (error) {
      console.error(
        '[ExtensionAuthGuard] JWT Verification failed:',
        (error as Error).message,
      );
      throw new UnauthorizedException('Invalid or expired extension token');
    }
  }
}
