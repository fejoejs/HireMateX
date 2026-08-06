import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SystemConfig } from '../schemas/system-config.schema';
import { User } from '../schemas/user.schema';
import { ApiLog } from '../schemas/api-log.schema';
import { CrawlLog } from '../schemas/crawl-log.schema';
import { Resume } from '../schemas/resume.schema';
import { JobMatch } from '../schemas/job-match.schema';
import { SupportTicket } from '../schemas/support-ticket.schema';
import { Application } from '../schemas/application.schema';
import { PendingConfirmation } from '../schemas/pending-confirmation.schema';
import { PendingDigest } from '../schemas/pending-digest.schema';

@Injectable()
export class SystemConfigService {
  constructor(
    @InjectModel(SystemConfig.name) private configModel: Model<SystemConfig>,
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(ApiLog.name) private apiLogModel: Model<ApiLog>,
    @InjectModel(CrawlLog.name) private crawlLogModel: Model<CrawlLog>,
    @InjectModel(Resume.name) private resumeModel: Model<Resume>,
    @InjectModel(JobMatch.name) private jobMatchModel: Model<JobMatch>,
    @InjectModel(SupportTicket.name)
    private supportTicketModel: Model<SupportTicket>,
    @InjectModel(Application.name) private applicationModel: Model<Application>,
    @InjectModel(PendingConfirmation.name)
    private pendingConfModel: Model<PendingConfirmation>,
    @InjectModel(PendingDigest.name)
    private pendingDigestModel: Model<PendingDigest>,
  ) {}

  async logApiCall(
    service: string,
    model: string,
    status: string,
    errorMessage?: string,
    userId?: string,
    tokens?: any,
  ): Promise<void> {
    try {
      await this.apiLogModel.create({
        service,
        modelName: model,
        status,
        errorMessage,
        userId,
        tokens,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error(
        '[SystemConfigService] Failed to create ApiLog entry:',
        err,
      );
    }
  }

  async logCrawlRun(
    platform: string,
    startTime: Date,
    endTime: Date,
    status: string,
    jobsParsed: number,
    jobsSaved: number,
    errorMessage?: string,
  ): Promise<void> {
    try {
      await this.crawlLogModel.create({
        platform,
        startTime,
        endTime,
        status,
        jobsParsed,
        jobsSaved,
        errorMessage,
      });
    } catch (err) {
      console.error(
        '[SystemConfigService] Failed to create CrawlLog entry:',
        err,
      );
    }
  }

  async get(key: string): Promise<string> {
    const config = await this.configModel.findOne({ key }).exec();
    if (config && config.value) {
      return config.value;
    }
    // Fallback to process.env
    return process.env[key] || '';
  }

  async getAllConfigs(): Promise<any[]> {
    return this.configModel.find().exec();
  }

  async set(
    key: string,
    value: string,
    description?: string,
  ): Promise<SystemConfig> {
    return this.configModel
      .findOneAndUpdate(
        { key },
        { value, description },
        { upsert: true, new: true },
      )
      .exec();
  }

  // --- User Management Methods ---
  async getAllUsers(): Promise<User[]> {
    try {
      const { getAuth } = require('firebase-admin/auth');
      const listUsersResult = await getAuth().listUsers(1000);
      const firebaseUsers = listUsersResult.users;

      const dbUsers = await this.userModel.find().exec();

      // Auto-sync all Firebase users to MongoDB
      for (const fbUser of firebaseUsers) {
        let user = dbUsers.find(
          (u) => u.clerkId === fbUser.uid || u.email === fbUser.email,
        );

        let modified = false;
        if (!user) {
          user = new this.userModel({
            clerkId: fbUser.uid,
            email: fbUser.email,
            name: fbUser.displayName || fbUser.email?.split('@')[0],
            avatarUrl: fbUser.photoURL || null,
          });
          modified = true;
        } else {
          if (user.clerkId !== fbUser.uid) {
            const oldClerkId = user.clerkId;
            user.clerkId = fbUser.uid;
            modified = true;

            // Legacy Migration: Reconnect disconnected data
            if (oldClerkId) {
              console.log(
                `[SystemConfigService] Admin Sync: Migrating data from ${oldClerkId} to ${fbUser.uid}`,
              );
              await Promise.all([
                this.resumeModel.updateMany(
                  { userId: oldClerkId },
                  { $set: { userId: fbUser.uid } },
                ),
                this.jobMatchModel.updateMany(
                  { userId: oldClerkId },
                  { $set: { userId: fbUser.uid } },
                ),
                this.applicationModel.updateMany(
                  { userId: oldClerkId },
                  { $set: { userId: fbUser.uid } },
                ),
                this.supportTicketModel.updateMany(
                  { userId: oldClerkId },
                  { $set: { userId: fbUser.uid } },
                ),
                this.pendingConfModel.updateMany(
                  { userId: oldClerkId },
                  { $set: { userId: fbUser.uid } },
                ),
                this.pendingDigestModel.updateMany(
                  { userId: oldClerkId },
                  { $set: { userId: fbUser.uid } },
                ),
              ]);
            }
          }
          if (!user.avatarUrl && fbUser.photoURL) {
            user.avatarUrl = fbUser.photoURL;
            modified = true;
          }
          if (!user.name && fbUser.displayName) {
            user.name = fbUser.displayName;
            modified = true;
          }
        }

        if (modified) {
          await user.save();
        }
      }

      const allUsers = await this.userModel.find().lean().exec();

      // Aggregate jobs applied for each user
      const applicationCounts = await this.applicationModel
        .aggregate([{ $group: { _id: '$userId', count: { $sum: 1 } } }])
        .exec();

      const countMap = new Map(
        applicationCounts.map((item) => [item._id, item.count]),
      );

      return allUsers.map((user) => ({
        ...user,
        applicationsCount: countMap.get(user.clerkId) || 0,
      })) as any;
    } catch (err) {
      console.error(
        '[SystemConfigService] Failed to sync users from Firebase Admin:',
        err,
      );
      // Fallback
      return this.userModel.find().lean().exec() as any;
    }
  }

  async updateUserRole(
    userId: string,
    role: 'user' | 'admin',
  ): Promise<User | null> {
    const updatedUser = await this.userModel
      .findByIdAndUpdate(userId, { role }, { new: true })
      .exec();

    // Sync Firebase Custom Claims so user's token reflects new role immediately
    if (updatedUser && updatedUser.clerkId) {
      try {
        const { getAuth } = require('firebase-admin/auth');
        await getAuth().setCustomUserClaims(updatedUser.clerkId, {
          admin: role === 'admin',
        });
        console.log(
          `[SystemConfigService] Firebase Custom Claims updated for user ${updatedUser.clerkId}: admin=${role === 'admin'}`,
        );
      } catch (err) {
        console.error(
          '[SystemConfigService] Failed to sync Firebase Custom Claims:',
          err,
        );
        // DB update succeeded, so still return the user even if Firebase sync fails
      }
    }

    return updatedUser;
  }

  async generateImpersonationToken(
    clerkId: string,
  ): Promise<{ token: string }> {
    try {
      const { getAuth } = require('firebase-admin/auth');
      // Create a custom Firebase token for the target user ID
      const customToken = await getAuth().createCustomToken(clerkId);
      return { token: customToken };
    } catch (err) {
      console.error(
        '[SystemConfigService] Failed to generate impersonation token:',
        err,
      );
      throw new Error('Failed to generate impersonation token');
    }
  }

  async deleteUser(userId: string): Promise<User | null> {
    const user = await this.userModel.findByIdAndDelete(userId).exec();
    if (user) {
      const clerkId = user.clerkId;

      // 1. Delete associated data in MongoDB
      if (clerkId) {
        await Promise.all([
          this.resumeModel.deleteMany({ userId: clerkId }),
          this.jobMatchModel.deleteMany({ userId: clerkId }),
          this.supportTicketModel.deleteMany({ userId: clerkId }),
          this.applicationModel.deleteMany({ userId: clerkId }),
          this.pendingConfModel.deleteMany({ userId: clerkId }),
          this.pendingDigestModel.deleteMany({ userId: clerkId }),
        ]);
      }

      // 2. Delete user from Firebase Auth
      if (clerkId) {
        try {
          const { getAuth } = require('firebase-admin/auth');
          await getAuth().deleteUser(clerkId);
        } catch (err) {
          console.error(
            '[SystemConfigService] Failed to delete user from Firebase:',
            err,
          );
        }
      }
    }
    return user;
  }

  async testGeminiKey(): Promise<{
    valid: boolean;
    status: string;
    reason?: string;
  }> {
    try {
      const apiKey = await this.get('GEMINI_API_KEY');
      if (!apiKey) {
        return {
          valid: false,
          status: 'missing',
          reason: 'API Key not configured',
        };
      }

      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(apiKey);

      let testFailedError: any = null;
      const modelsToTest = ['gemini-1.5-flash', 'gemini-2.0-flash'];

      for (const modelName of modelsToTest) {
        try {
          const model = genAI.getGenerativeModel({ model: modelName });
          // Send a minimal request to test connection and quota
          await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
            generationConfig: { maxOutputTokens: 1 },
          });
          return { valid: true, status: 'active' };
        } catch (err: any) {
          testFailedError = err;
          // If the model is not found, try the next one
          if (err.status === 404 || err.message?.includes('404')) {
            continue;
          }
          // If it's a quota or auth error, don't try other models, just break and return the error
          break;
        }
      }

      // If we got here, all models failed
      throw testFailedError;
    } catch (err: any) {
      console.error(
        '[SystemConfigService] Gemini API Test failed:',
        err.message,
      );
      let status = 'error';
      let reason = err.message || 'Unknown error';

      if (
        err.status === 429 ||
        reason.includes('429') ||
        reason.toLowerCase().includes('quota')
      ) {
        status = 'quota_exceeded';
        reason =
          'Google API Error: Your API key is valid, but Google has blocked the request due to quota limits (429). Please enable billing in Google Cloud or check your free tier limits.';
      } else if (
        err.status === 400 ||
        err.status === 403 ||
        reason.includes('403') ||
        reason.includes('400') ||
        reason.toLowerCase().includes('api key not valid')
      ) {
        status = 'invalid_key';
        reason = 'API Key is invalid or expired';
      } else if (
        err.status === 404 ||
        reason.includes('404') ||
        reason.toLowerCase().includes('not found')
      ) {
        status = 'invalid_key';
        reason =
          'Model not found for this API Key (Check your region/permissions)';
      }

      return { valid: false, status, reason };
    }
  }

  async testTelegramBot(): Promise<{
    valid: boolean;
    botName?: string;
    username?: string;
    reason?: string;
  }> {
    try {
      const token = await this.get('TELEGRAM_BOT_TOKEN');
      if (!token) {
        return {
          valid: false,
          reason: 'Telegram bot token is not configured in settings.',
        };
      }

      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const data = await res.json();

      if (data && data.ok && data.result) {
        return {
          valid: true,
          botName: data.result.first_name,
          username: data.result.username,
        };
      } else {
        return {
          valid: false,
          reason: data?.description || 'Telegram rejected the bot token.',
        };
      }
    } catch (err: any) {
      console.error(
        '[SystemConfigService] Telegram Bot test failed:',
        err.message,
      );
      return {
        valid: false,
        reason: `Connection error: ${err.message || 'Failed to reach Telegram API'}`,
      };
    }
  }
}
