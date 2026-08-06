import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User } from '../schemas/user.schema';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@InjectModel(User.name) private userModel: Model<User>) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const clerkUser = request.user;
    if (!clerkUser) return false;

    const userUid = clerkUser.uid || clerkUser.sub || '';
    let dbUser = await this.userModel
      .findOne({
        $or: [
          { clerkId: userUid },
          ...(clerkUser.email ? [{ email: clerkUser.email }] : []),
        ],
      })
      .exec();

    const email = request.user?.email?.toLowerCase() || '';
    const masterAdminEmail =
      process.env.MASTER_ADMIN_EMAIL || 'hirematex@gmail.com';
    const isTargetAdmin = email === masterAdminEmail.toLowerCase();

    // Always allow master admins immediately (bypassing DB issues)
    if (isTargetAdmin) {
      // Background sync, don't await/block
      if (!dbUser || dbUser.role !== 'admin') {
        if (!dbUser) {
          dbUser = new this.userModel({
            clerkId: clerkUser.uid || clerkUser.sub,
            email: request.user.email,
            name: request.user.name || 'Admin User',
            role: 'admin',
            isEmailVerified: request.user.email_verified || false,
          });
          dbUser
            .save()
            .catch((e) => console.error('[AdminGuard] Create user error:', e));
        } else {
          dbUser.role = 'admin';
          dbUser
            .save()
            .catch((e) => console.error('[AdminGuard] Update user error:', e));
        }
      }
      return true;
    }

    const isAdmin = dbUser?.role === 'admin';

    if (!isAdmin) {
      throw new ForbiddenException('Access denied. Admin role required.');
    }
    return true;
  }
}
