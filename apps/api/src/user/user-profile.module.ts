import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '../schemas/user.schema';
import { Resume, ResumeSchema } from '../schemas/resume.schema';
import { JobMatch, JobMatchSchema } from '../schemas/job-match.schema';
import { Application, ApplicationSchema } from '../schemas/application.schema';
import {
  SupportTicket,
  SupportTicketSchema,
} from '../schemas/support-ticket.schema';
import {
  PendingConfirmation,
  PendingConfirmationSchema,
} from '../schemas/pending-confirmation.schema';
import {
  PendingDigest,
  PendingDigestSchema,
} from '../schemas/pending-digest.schema';
import { UserProfileController } from './user-profile.controller';
import { UserProfileService } from './user-profile.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Resume.name, schema: ResumeSchema },
      { name: JobMatch.name, schema: JobMatchSchema },
      { name: Application.name, schema: ApplicationSchema },
      { name: SupportTicket.name, schema: SupportTicketSchema },
      { name: PendingConfirmation.name, schema: PendingConfirmationSchema },
      { name: PendingDigest.name, schema: PendingDigestSchema },
    ]),
    AuthModule,
  ],
  controllers: [UserProfileController],
  providers: [UserProfileService],
  exports: [UserProfileService],
})
export class UserProfileModule {}
