import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Application } from '../schemas/application.schema';
import { Job } from '../schemas/job.schema';
import { Resume } from '../schemas/resume.schema';
import { User } from '../schemas/user.schema';
import { QueueService } from '../queue/queue.service';

@Injectable()
export class ApplicationService {
  constructor(
    @InjectModel(Application.name) private appModel: Model<Application>,
    @InjectModel(Job.name) private jobModel: Model<Job>,
    @InjectModel(Resume.name) private resumeModel: Model<Resume>,
    @InjectModel(User.name) private userModel: Model<User>,
    private queueService: QueueService,
  ) {}

  async createApplication(userId: string, jobId: string): Promise<Application> {
    const job = await this.jobModel.findById(jobId).exec();
    if (!job) {
      throw new NotFoundException(
        'This job is no longer active or was removed by the employer.',
      );
    }

    let app = await this.appModel.findOne({ userId, jobId }).exec();
    if (!app) {
      app = new this.appModel({
        userId,
        jobId,
        status: 'Matched',
      });
      await app.save();
    }

    return app;
  }

  async getApplications(userId: string): Promise<Application[]> {
    const apps = await this.appModel
      .find({ userId })
      .populate('jobId')
      .sort({ updatedAt: -1 })
      .exec();
    return apps.map((app) => {
      if (app.source === 'external-board') {
        const mockJobId = {
          _id: app.externalBoardJobId || '',
          title: app.jobTitle || '',
          company: app.company || '',
          location: app.location || '',
          workType: 'Remote',
          url: app.url || '',
        };
        const appObj = (app.toObject ? app.toObject() : app) as any;
        appObj.jobId = mockJobId;
        return appObj;
      }
      return app;
    });
  }

  async requestTailoring(userId: string, appId: string): Promise<any> {
    const app = await this.appModel.findOne({ _id: appId, userId }).exec();
    if (!app) {
      throw new NotFoundException('Application not found');
    }
    if (!app.jobId) {
      throw new NotFoundException('Job ID is missing for this application');
    }

    app.status = 'Tailored';
    await app.save();

    // Push tailoring job to background queue
    await this.queueService.addResumeTailorJob(
      userId,
      app.jobId.toString(),
      app.id as string,
    );

    return {
      message:
        'AI customization (resume tailoring and cover letter) initiated.',
      status: app.status,
    };
  }

  /**
   * Genuine Greenhouse Board API submission.
   * Only marks application as 'Applied' (Verified) when Greenhouse returns HTTP 200/201.
   * On failure, throws BadRequestException and leaves application status in 'Tailored'.
   */
  async submitToGreenhouse(userId: string, appId: string): Promise<any> {
    const app = await this.appModel.findOne({ _id: appId, userId }).exec();
    if (!app) {
      throw new NotFoundException('Application not found');
    }
    if (!app.jobId) {
      throw new BadRequestException('Job ID is missing for this application');
    }

    const job = await this.jobModel.findById(app.jobId).exec();
    if (!job) {
      throw new NotFoundException('Job posting not found');
    }

    const isGhSource =
      job.sourceAts?.toLowerCase() === 'greenhouse' ||
      job.source?.toLowerCase() === 'greenhouse' ||
      (job.applyUrl && job.applyUrl.includes('greenhouse.io')) ||
      (job.url && job.url.includes('greenhouse.io'));

    if (!isGhSource) {
      throw new BadRequestException(
        'This job does not support automated Greenhouse submission.',
      );
    }

    // Determine company slug and Greenhouse job ID
    let companySlug = job.companySlug;
    let greenhouseJobId = job.greenhouseJobId;

    if (!companySlug || !greenhouseJobId) {
      const urlToParse = job.applyUrl || job.url || '';
      const slugMatch = urlToParse.match(
        /(?:boards|boards\.eu|job-board)\.greenhouse\.io\/(?:v1\/boards\/)?([a-zA-Z0-9_-]+)\/jobs\/([0-9]+)/i,
      );
      if (slugMatch) {
        companySlug = companySlug || slugMatch[1];
        greenhouseJobId = greenhouseJobId || slugMatch[2];
      } else {
        const altMatch = urlToParse.match(
          /(?:boards|boards\.eu|job-board)\.greenhouse\.io\/embed\/job_app\?for=([a-zA-Z0-9_-]+)&token=([0-9]+)/i,
        );
        if (altMatch) {
          companySlug = companySlug || altMatch[1];
          greenhouseJobId = greenhouseJobId || altMatch[2];
        }
      }
    }

    if (!companySlug || !greenhouseJobId) {
      throw new BadRequestException(
        'Could not determine Greenhouse company board or job ID for this position.',
      );
    }

    // Resolve user candidate information
    const user = await this.userModel
      .findOne({ $or: [{ clerkId: userId }, { email: userId }] })
      .exec();
    const resume = await this.resumeModel
      .findOne({ userId, isAtsCheckOnly: { $ne: true } })
      .sort({ createdAt: -1 })
      .exec();

    const fullName =
      resume?.parsedProfile?.fullName || user?.name || 'Applicant';
    const nameParts = fullName.trim().split(/\s+/);
    const firstName = nameParts[0] || 'Applicant';
    const lastName = nameParts.slice(1).join(' ') || firstName;
    const email = resume?.parsedProfile?.email || user?.email || '';
    const phone = resume?.parsedProfile?.phone || '';
    const coverLetter = app.coverLetterContent || '';

    if (!email) {
      throw new BadRequestException(
        'Applicant email is required for submission.',
      );
    }

    // Construct FormData for multipart submission
    const formData = new FormData();
    formData.append('first_name', firstName);
    formData.append('last_name', lastName);
    formData.append('email', email);
    if (phone) formData.append('phone', phone);
    if (coverLetter) formData.append('cover_letter_text', coverLetter);

    if (resume?.fileBuffer) {
      const resumeBlob = new Blob([new Uint8Array(resume.fileBuffer)], {
        type: resume.mimeType || 'application/pdf',
      });
      formData.append(
        'resume',
        resumeBlob,
        resume.originalFileName || 'Resume.pdf',
      );
    } else if (app.tailoredResumeContent) {
      const textBlob = new Blob([app.tailoredResumeContent], {
        type: 'text/plain',
      });
      formData.append('resume', textBlob, 'tailored-resume.txt');
    }

    const ghUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(companySlug)}/jobs/${encodeURIComponent(greenhouseJobId)}`;
    console.log(
      `[ApplicationService] Submitting candidate ${email} to Greenhouse board ${companySlug} job ${greenhouseJobId}`,
    );

    let ghResponse: Response | null = null;
    let lastNetErr: any = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        ghResponse = await fetch(ghUrl, {
          method: 'POST',
          body: formData,
        });
        break;
      } catch (netErr: any) {
        lastNetErr = netErr;
        console.warn(
          `[ApplicationService] Network attempt ${attempt + 1} to Greenhouse failed:`,
          netErr.message,
        );
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }

    if (!ghResponse) {
      console.error(
        '[ApplicationService] Network error during Greenhouse submission after retries:',
        lastNetErr,
      );
      throw new BadRequestException(
        `Failed to connect to Greenhouse: ${lastNetErr?.message || 'Network error'}`,
      );
    }

    if (ghResponse.status === 200 || ghResponse.status === 201) {
      if (resume) {
        app.resumeId = resume._id as any;
      }
      app.status = 'Applied';
      app.applicationVerified = true;
      app.appliedVia = 'greenhouse_api';
      app.appliedDate = new Date();
      app.companySlug = companySlug;
      await app.save();

      console.log(
        `[ApplicationService] Successfully submitted application ${appId} to Greenhouse (Verified)`,
      );
      return {
        success: true,
        verified: true,
        message: 'Application successfully submitted to Greenhouse!',
        application: app,
      };
    } else {
      const errText = await ghResponse.text().catch(() => '');
      console.warn(
        `[ApplicationService] Greenhouse rejected submission (${ghResponse.status}):`,
        errText,
      );

      // Crucial: do NOT mark as applied on failure. Leave application status unchanged.
      throw new BadRequestException(
        `Greenhouse rejected submission (HTTP ${ghResponse.status}). The board may require custom fields. Please apply directly on the company site.`,
      );
    }
  }

  /**
   * Self-reported application mark (for manual applies on company site / non-Greenhouse jobs).
   * Explicitly sets applicationVerified: false.
   */
  async selfReportApplied(userId: string, appId: string): Promise<any> {
    const app = await this.appModel.findOne({ _id: appId, userId }).exec();
    if (!app) {
      throw new NotFoundException('Application not found');
    }

    const latestResume = await this.resumeModel
      .findOne({ userId, isAtsCheckOnly: { $ne: true } })
      .sort({ createdAt: -1 })
      .exec();

    if (latestResume) {
      app.resumeId = latestResume._id as any;
    }

    app.status = 'Applied';
    app.applicationVerified = false;
    app.appliedVia = 'self_reported';
    app.appliedDate = new Date();
    await app.save();

    console.log(
      `[ApplicationService] Application ${appId} self-reported as applied by user ${userId}`,
    );
    return {
      success: true,
      verified: false,
      message: 'Application marked as self-reported.',
      application: app,
    };
  }

  /**
   * Create & track a self-reported application directly from Job Board
   */
  async createSelfReportedApplication(
    userId: string,
    jobId: string,
  ): Promise<any> {
    const job = await this.jobModel.findById(jobId).exec();
    if (!job) {
      throw new NotFoundException('Job posting not found');
    }

    let app = await this.appModel.findOne({ userId, jobId }).exec();
    if (!app) {
      app = new this.appModel({
        userId,
        jobId,
        status: 'Applied',
        applicationVerified: false,
        appliedVia: 'self_reported',
        appliedDate: new Date(),
        applicationUrl: job.applyUrl || job.url,
      });
    } else {
      app.status = 'Applied';
      app.applicationVerified = false;
      app.appliedVia = 'self_reported';
      app.appliedDate = new Date();
      app.applicationUrl = job.applyUrl || job.url;
    }

    const latestResume = await this.resumeModel
      .findOne({ userId, isAtsCheckOnly: { $ne: true } })
      .sort({ createdAt: -1 })
      .exec();

    if (latestResume) {
      app.resumeId = latestResume._id as any;
    }

    await app.save();
    return {
      success: true,
      verified: false,
      message: 'Job tracked as applied (self-reported).',
      application: app,
    };
  }

  async markAsApplied(userId: string, appId: string): Promise<Application> {
    const res = await this.selfReportApplied(userId, appId);
    return res.application;
  }

  async updateStatus(
    userId: string,
    appId: string,
    status: string,
    notes?: string,
  ): Promise<Application> {
    const app = await this.appModel.findOne({ _id: appId, userId }).exec();
    if (!app) {
      throw new NotFoundException('Application not found');
    }

    app.status = status;
    if (notes !== undefined) {
      app.notes = notes;
    }
    if (status === 'Applied') {
      app.appliedDate = new Date();
    }
    return app.save();
  }

  async updateCoverLetter(
    userId: string,
    appId: string,
    coverLetterContent: string,
  ): Promise<Application> {
    const app = await this.appModel.findOne({ _id: appId, userId }).exec();
    if (!app) {
      throw new NotFoundException('Application not found');
    }

    app.coverLetterContent = coverLetterContent;
    return app.save();
  }

  async getTailoredResumeFile(
    userId: string,
    appId: string,
  ): Promise<{ content: string; fileName: string }> {
    const app = await this.appModel.findOne({ _id: appId, userId }).exec();
    if (!app || !app.tailoredResumeContent) {
      throw new NotFoundException(
        'Tailored resume content not found in database',
      );
    }
    return {
      content: app.tailoredResumeContent,
      fileName: `tailored-resume-${appId}.txt`,
    };
  }
}
