import { Controller, Get, Post, Body, UseGuards, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { GetUserId } from '../auth/get-user.decorator';
import { NotificationService } from '../notification/notification.service';

@Controller('auth')
export class VerificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get('status')
  @UseGuards(FirebaseAuthGuard)
  async getVerificationStatus(@GetUserId() userId: string, @Req() req: any) {
    return this.notificationService.getVerificationStatus(
      userId,
      req.user?.email_verified,
      req.user?.email,
    );
  }

  // ── Pre-Signup Email OTP (Public) ──────────────────────────

  @Post('signup-send-otp')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async signupSendOtp(@Body('email') email: string) {
    return this.notificationService.sendSignupOtp(email);
  }

  @Post('signup-verify-otp')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async signupVerifyOtp(
    @Body('email') email: string,
    @Body('otp') otp: string,
  ) {
    return this.notificationService.verifySignupOtp(email, otp);
  }

  // ── Forgot Password Email OTP (Public) ─────────────────────

  @Post('forgot-password-send-otp')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async forgotPasswordSendOtp(@Body('email') email: string) {
    return this.notificationService.forgotPasswordSendOtp(email);
  }

  @Post('forgot-password-verify-otp')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async forgotPasswordVerifyOtp(
    @Body('email') email: string,
    @Body('otp') otp: string,
  ) {
    return this.notificationService.forgotPasswordVerifyOtp(email, otp);
  }

  @Post('forgot-password-reset')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async forgotPasswordReset(
    @Body('email') email: string,
    @Body('otp') otp: string,
    @Body('newPassword') newPassword: string,
  ) {
    return this.notificationService.forgotPasswordReset(
      email,
      otp,
      newPassword,
    );
  }

  // ── Email OTP ──────────────────────────────────────────────

  @Post('send-email-otp')
  @UseGuards(FirebaseAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async sendEmailOtp(
    @GetUserId() userId: string,
    @Body('email') email?: string,
  ) {
    return this.notificationService.sendEmailOtp(userId, email);
  }

  @Post('verify-email-otp')
  @UseGuards(FirebaseAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async verifyEmailOtp(
    @GetUserId() userId: string,
    @Req() req: any,
    @Body('otp') otp: string,
  ) {
    return this.notificationService.verifyEmailOtp(
      userId,
      otp,
      req.user?.email,
    );
  }
}
