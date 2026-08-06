import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User } from '../schemas/user.schema';
import { Resume } from '../schemas/resume.schema';
import { JobMatch } from '../schemas/job-match.schema';
import { Application } from '../schemas/application.schema';
import { SupportTicket } from '../schemas/support-ticket.schema';
import { PendingConfirmation } from '../schemas/pending-confirmation.schema';
import { PendingDigest } from '../schemas/pending-digest.schema';

@Injectable()
export class UserProfileService {
  constructor(
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Resume.name) private resumeModel: Model<Resume>,
    @InjectModel(JobMatch.name) private jobMatchModel: Model<JobMatch>,
    @InjectModel(Application.name) private applicationModel: Model<Application>,
    @InjectModel(SupportTicket.name)
    private supportTicketModel: Model<SupportTicket>,
    @InjectModel(PendingConfirmation.name)
    private pendingConfirmationModel: Model<PendingConfirmation>,
    @InjectModel(PendingDigest.name)
    private pendingDigestModel: Model<PendingDigest>,
  ) {}

  async getProfile(userId: string, decodedToken?: any): Promise<User> {
    let user = await this.userModel.findOne({ clerkId: userId }).exec();

    // Firebase Auto-Sync / Creation
    if (!user && decodedToken && decodedToken.email) {
      // Check if user exists by email (migration case)
      user = await this.userModel.findOne({ email: decodedToken.email }).exec();

      if (!user) {
        // Entirely new user logging in via Firebase who is not in DB yet
        user = new this.userModel({
          clerkId: userId,
          email: decodedToken.email,
          name: decodedToken.name || decodedToken.email.split('@')[0],
          avatarUrl: decodedToken.picture || null,
        });
      } else {
        // Existing email, link the clerkId (Legacy Migration)
        if (user.clerkId !== userId) {
          const oldClerkId = user.clerkId;
          user.clerkId = userId;

          if (oldClerkId) {
            console.log(
              `[UserProfileService] Migrating user data from ${oldClerkId} to ${userId}`,
            );
            await Promise.all([
              this.resumeModel.updateMany(
                { userId: oldClerkId },
                { $set: { userId: userId } },
              ),
              this.jobMatchModel.updateMany(
                { userId: oldClerkId },
                { $set: { userId: userId } },
              ),
              this.applicationModel.updateMany(
                { userId: oldClerkId },
                { $set: { userId: userId } },
              ),
              this.supportTicketModel.updateMany(
                { userId: oldClerkId },
                { $set: { userId: userId } },
              ),
              this.pendingConfirmationModel.updateMany(
                { userId: oldClerkId },
                { $set: { userId: userId } },
              ),
              this.pendingDigestModel.updateMany(
                { userId: oldClerkId },
                { $set: { userId: userId } },
              ),
            ]);
          }
        }

        // Optionally update missing avatar
        if (!user.avatarUrl && decodedToken.picture) {
          user.avatarUrl = decodedToken.picture;
        }
      }
      await user.save();
    } else if (user && decodedToken) {
      // Background sync: If user exists but is missing avatar, heal the DB
      let modified = false;
      if (!user.avatarUrl && decodedToken.picture) {
        user.avatarUrl = decodedToken.picture;
        modified = true;
      }
      if (!user.name && decodedToken.name) {
        user.name = decodedToken.name;
        modified = true;
      }
      if (modified) {
        await user.save();
      }
    }

    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async updateProfile(
    userId: string,
    body: any,
    decodedToken?: any,
  ): Promise<User> {
    let user = await this.userModel.findOne({ clerkId: userId }).exec();

    // Firebase Migration
    if (!user && decodedToken && decodedToken.email) {
      user = await this.userModel.findOne({ email: decodedToken.email }).exec();
      if (user) {
        user.clerkId = userId;
        await user.save();
      }
    }

    const setPayload: any = {
      name: body.name,
      phone: body.phone,
      location: body.location,
      avatarUrl: body.avatarUrl,
      emailNotificationsEnabled: body.emailNotificationsEnabled,
      telegramNotificationsEnabled: body.telegramNotificationsEnabled,
      telegramUsername: body.telegramUsername,
      notifyMatchThreshold: body.notifyMatchThreshold,
    };

    if (decodedToken && decodedToken.email) {
      setPayload.email = decodedToken.email;
    }

    return this.userModel
      .findOneAndUpdate(
        { clerkId: userId },
        { $set: setPayload },
        { new: true, upsert: true },
      )
      .exec();
  }
}
