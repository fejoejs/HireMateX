jest.mock('firebase-admin/app', () => ({
  getApps: () => [{ name: 'default' }],
  initializeApp: jest.fn(),
  cert: jest.fn(),
}));

jest.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    verifyIdToken: jest.fn().mockResolvedValue({
      uid: 'dummy-user-uid-999',
      email: 'dummy.developer@hirematex.test',
      email_verified: true,
    }),
  }),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppController } from '../src/app.controller';
import { AppService } from '../src/app.service';
import { VerificationController } from '../src/auth/verification.controller';
import { UserProfileController } from '../src/user/user-profile.controller';
import { UserProfileService } from '../src/user/user-profile.service';
import { ResumeController } from '../src/resume/resume.controller';
import { ResumeService } from '../src/resume/resume.service';
import { JobController } from '../src/job/job.controller';
import { JobService } from '../src/job/job.service';
import { ExternalBoardController } from '../src/external-board/external-board.controller';
import { ExternalBoardService } from '../src/external-board/external-board.service';
import { ApplicationController } from '../src/application/application.controller';
import { ApplicationService } from '../src/application/application.service';
import { SupportController } from '../src/support/support.controller';
import { SupportService } from '../src/support/support.service';
import {
  PublicConfigController,
  SystemConfigController,
} from '../src/system-config/system-config.controller';
import { SystemConfigService } from '../src/system-config/system-config.service';
import { NotificationService } from '../src/notification/notification.service';
import { FirebaseAuthGuard } from '../src/auth/firebase-auth.guard';
import { ExtensionAuthGuard } from '../src/auth/extension-auth.guard';
import { AdminGuard } from '../src/auth/admin.guard';
import * as jwt from 'jsonwebtoken';

describe('HireMateX End-to-End Dummy User Feature Validation', () => {
  let app: INestApplication;

  const dummyUser = {
    uid: 'dummy-user-uid-999',
    sub: 'dummy-user-uid-999',
    email: 'dummy.developer@hirematex.test',
    email_verified: true,
    name: 'Alex Developer',
  };

  const dummyProfileState: any = {
    userId: dummyUser.uid,
    name: 'Alex Developer',
    email: dummyUser.email,
    title: 'Senior Full Stack Engineer',
    skills: ['TypeScript', 'React', 'Node.js', 'NestJS', 'Python'],
    location: 'Remote',
    experienceYears: 5,
  };

  const dummyResumeState: any = {
    id: 'resume-12345',
    userId: dummyUser.uid,
    originalFileName: 'Alex_Developer_Resume.pdf',
    parsedProfile: {
      fullName: 'Alex Developer',
      email: dummyUser.email,
      skills: ['TypeScript', 'React', 'Next.js', 'NestJS', 'MongoDB', 'Docker'],
      experience: [
        {
          title: 'Senior Software Engineer',
          company: 'Tech Innovators Inc.',
          startDate: '2022',
          endDate: 'Present',
          description:
            'Architected scalable microservices using NestJS and Next.js.',
        },
      ],
      education: [
        {
          degree: 'B.S. in Computer Science',
          institution: 'State University',
          year: '2020',
        },
      ],
    },
    rawText:
      'Alex Developer - Senior Full Stack Engineer - TypeScript, React, NestJS, MongoDB',
  };

  const dummyApplications: any[] = [];
  const dummyExternalJobs: any[] = [];
  const dummyTickets: any[] = [];

  const mockAppService = {
    getHello: () => 'Hello World!',
  };

  const mockNotificationService = {
    getVerificationStatus: jest
      .fn()
      .mockImplementation(async (userId: string) => ({
        emailVerified: true,
        telegramVerified: false,
        telegramBotUsername: 'AIJobCopilotBot',
      })),
    sendSignupOtp: jest.fn().mockImplementation(async (email: string) => ({
      success: true,
      message: `OTP sent to ${email}`,
    })),
    verifySignupOtp: jest
      .fn()
      .mockImplementation(async (email: string, otp: string) => ({
        verified: true,
        message: 'OTP verified successfully',
      })),
    sendEmailOtp: jest.fn().mockResolvedValue({ success: true }),
    verifyEmailOtp: jest.fn().mockResolvedValue({ verified: true }),
    forgotPasswordSendOtp: jest.fn().mockResolvedValue({ success: true }),
    forgotPasswordVerifyOtp: jest.fn().mockResolvedValue({ verified: true }),
    forgotPasswordReset: jest.fn().mockResolvedValue({ success: true }),
  };

  const mockUserProfileService = {
    getProfile: jest.fn().mockImplementation(async () => dummyProfileState),
    updateProfile: jest
      .fn()
      .mockImplementation(async (userId: string, body: any) => {
        Object.assign(dummyProfileState, body);
        return dummyProfileState;
      }),
  };

  const mockResumeService = {
    uploadAndParse: jest
      .fn()
      .mockImplementation(async (userId, originalFileName) => ({
        id: dummyResumeState.id,
        userId,
        originalFileName,
      })),
    getLatestResume: jest.fn().mockImplementation(async () => dummyResumeState),
    getResumeById: jest.fn().mockImplementation(async () => dummyResumeState),
    analyzeAts: jest
      .fn()
      .mockImplementation(async (userId, resumeId, targetJobTitle) => ({
        overallScore: 92,
        atsFeedback: 'Excellent keyword match and clear formatting.',
        categoryScores: {
          skills: 95,
          experience: 90,
          education: 90,
        },
        matchedKeywords: ['TypeScript', 'React', 'NestJS'],
        missingKeywords: ['GraphQL'],
      })),
    optimizeResume: jest
      .fn()
      .mockImplementation(async (userId, resumeId, jobId, targetTitle) => ({
        tailoredResumeText: `Optimized Resume for ${targetTitle || 'Full Stack Engineer'}\nAlex Developer\nExpertise in NestJS, React, TypeScript.`,
        changesSummary: [
          'Highlighted NestJS experience',
          'Added relevant keywords',
        ],
      })),
  };

  const mockJobService = {
    getDashboardJobs: jest.fn().mockImplementation(async () => ({
      matches: [
        {
          _id: 'job-101',
          title: 'Senior Backend Engineer',
          company: 'CloudScale Inc',
          location: 'Remote',
          matchScore: 94,
          source: 'greenhouse',
          tags: ['NestJS', 'TypeScript', 'Docker'],
        },
      ],
      totalMatches: 1,
    })),
    getIntegrationStatuses: jest.fn().mockImplementation(async () => [
      { name: 'Greenhouse', connected: true, activeJobs: 42 },
      { name: 'Lever', connected: true, activeJobs: 18 },
      { name: 'Workable', connected: true, activeJobs: 12 },
    ]),
    updateFilters: jest
      .fn()
      .mockImplementation(async (userId, email, filters) => ({
        success: true,
        filters,
      })),
    dismissJob: jest.fn().mockResolvedValue({ success: true }),
    crawlGlobalJobs: jest.fn().mockResolvedValue(true),
  };

  const mockExternalBoardService = {
    getExtensionToken: jest.fn().mockImplementation(async (userId: string) => {
      const secret =
        process.env.EXTENSION_JWT_SECRET ||
        'hirematex_extension_secure_key_2026';
      return jwt.sign({ userId }, secret, { expiresIn: '180d' });
    }),
    saveOrRefresh: jest.fn().mockImplementation(async (userId, dto) => {
      const newJob = {
        _id: `ext-${Date.now()}`,
        userId,
        ...dto,
        status: 'saved',
      };
      dummyExternalJobs.push(newJob);
      return { success: true, job: newJob };
    }),
    saveOrRefreshBatch: jest.fn().mockImplementation(async (userId, jobs) => {
      jobs.forEach((j: any) =>
        dummyExternalJobs.push({ _id: `ext-${Date.now()}`, userId, ...j }),
      );
      return { success: true, count: jobs.length };
    }),
    getFilteredJobs: jest
      .fn()
      .mockImplementation(async () => dummyExternalJobs),
    markPending: jest.fn().mockImplementation(async (userId, id) => {
      const j = dummyExternalJobs.find((x) => x._id === id);
      if (j) j.status = 'pending_confirmation';
      return { success: true };
    }),
    confirmApplied: jest.fn().mockImplementation(async (userId, id) => {
      const j = dummyExternalJobs.find((x) => x._id === id);
      if (j) j.status = 'applied';
      return { success: true };
    }),
    clearPending: jest.fn().mockResolvedValue({ success: true }),
    dismissJob: jest.fn().mockResolvedValue({ success: true }),
  };

  const mockApplicationService = {
    createApplication: jest.fn().mockImplementation(async (userId, jobId) => {
      const app = {
        _id: `app-${Date.now()}`,
        userId,
        jobId,
        status: 'applied',
        appliedDate: new Date(),
      };
      dummyApplications.push(app);
      return app;
    }),
    getApplications: jest
      .fn()
      .mockImplementation(async () => dummyApplications),
    updateStatus: jest
      .fn()
      .mockImplementation(async (userId, appId, status, notes) => {
        const app = dummyApplications.find((a) => a._id === appId);
        if (app) {
          app.status = status;
          app.notes = notes;
        }
        return { success: true, application: app };
      }),
    updateCoverLetter: jest
      .fn()
      .mockImplementation(async (userId, appId, coverLetter) => {
        const app = dummyApplications.find((a) => a._id === appId);
        if (app) app.coverLetter = coverLetter;
        return { success: true, application: app };
      }),
    requestTailoring: jest
      .fn()
      .mockResolvedValue({ success: true, status: 'tailored' }),
  };

  const mockSupportService = {
    createTicket: jest.fn().mockImplementation(async (userId, email, body) => {
      const ticket = {
        _id: `ticket-${Date.now()}`,
        userId,
        email,
        subject: body.subject,
        message: body.message,
        category: body.category,
        status: 'open',
        replies: [],
      };
      dummyTickets.push(ticket);
      return ticket;
    }),
    getMyTickets: jest.fn().mockImplementation(async () => dummyTickets),
    getUnreadRepliesCount: jest.fn().mockResolvedValue(0),
    markRepliesAsRead: jest.fn().mockResolvedValue({ success: true }),
  };

  const mockSystemConfigService = {
    get: jest.fn().mockImplementation(async (key: string) => 'true'),
    getFeatures: jest.fn().mockResolvedValue({
      feature_ats_enabled: true,
      feature_optimizer_enabled: true,
    }),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [
        AppController,
        PublicConfigController,
        VerificationController,
        UserProfileController,
        ResumeController,
        JobController,
        ExternalBoardController,
        ApplicationController,
        SupportController,
        SystemConfigController,
      ],
      providers: [
        { provide: AppService, useValue: mockAppService },
        { provide: NotificationService, useValue: mockNotificationService },
        { provide: UserProfileService, useValue: mockUserProfileService },
        { provide: ResumeService, useValue: mockResumeService },
        { provide: JobService, useValue: mockJobService },
        { provide: ExternalBoardService, useValue: mockExternalBoardService },
        { provide: ApplicationService, useValue: mockApplicationService },
        { provide: SupportService, useValue: mockSupportService },
        { provide: SystemConfigService, useValue: mockSystemConfigService },
      ],
    })
      .overrideGuard(FirebaseAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          const req = context.switchToHttp().getRequest();
          req.user = dummyUser;
          return true;
        },
      })
      .overrideGuard(ExtensionAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          const req = context.switchToHttp().getRequest();
          req.user = { sub: dummyUser.uid };
          return true;
        },
      })
      .overrideGuard(AdminGuard)
      .useValue({
        canActivate: () => true,
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('1. Health & Public Configuration Feature Flags', () => {
    it('GET /health - should return status ok', async () => {
      const res = await request(app.getHttpServer()).get('/health').expect(200);
      expect(res.body.status).toBe('ok');
    });

    it('GET /public/config/features - should return feature flags', async () => {
      const res = await request(app.getHttpServer())
        .get('/public/config/features')
        .expect(200);
      expect(res.body.feature_ats_enabled).toBe(true);
      expect(res.body.feature_optimizer_enabled).toBe(true);
    });
  });

  describe('2. Authentication & Verification Lifecycle', () => {
    it('POST /auth/signup-send-otp - sends pre-signup OTP', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/signup-send-otp')
        .send({ email: dummyUser.email })
        .expect(201);
      expect(res.body.success).toBe(true);
    });

    it('POST /auth/signup-verify-otp - verifies OTP', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/signup-verify-otp')
        .send({ email: dummyUser.email, otp: '123456' })
        .expect(201);
      expect(res.body.verified).toBe(true);
    });

    it('GET /auth/status - returns verified status for dummy user', async () => {
      const res = await request(app.getHttpServer())
        .get('/auth/status')
        .expect(200);
      expect(res.body.emailVerified).toBe(true);
      expect(res.body.telegramBotUsername).toBeDefined();
    });
  });

  describe('3. User Profile Management', () => {
    it('GET /user/profile - retrieves user profile', async () => {
      const res = await request(app.getHttpServer())
        .get('/user/profile')
        .expect(200);
      expect(res.body.name).toBe('Alex Developer');
      expect(res.body.skills).toContain('TypeScript');
    });

    it('POST /user/profile - updates user profile with preferences and skills', async () => {
      const res = await request(app.getHttpServer())
        .post('/user/profile')
        .send({
          title: 'Lead Full Stack Architect',
          location: 'San Francisco, CA (Remote)',
          skills: [
            'TypeScript',
            'React',
            'Next.js',
            'NestJS',
            'GraphQL',
            'Docker',
          ],
          salaryMin: 140000,
        })
        .expect(201);
      expect(res.body.title).toBe('Lead Full Stack Architect');
      expect(res.body.skills).toContain('GraphQL');
    });
  });

  describe('4. Resume Profile, ATS Scanner & AI Optimization', () => {
    it('POST /resume/upload - uploads and initiates parsing', async () => {
      const buffer = Buffer.from('Mock Resume Content');
      const res = await request(app.getHttpServer())
        .post('/resume/upload')
        .attach('file', buffer, {
          filename: 'Alex_Resume.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);
      expect(res.body.resumeId).toBe(dummyResumeState.id);
      expect(res.body.message).toContain('Resume uploaded successfully');
    });

    it('GET /resume/latest - fetches latest parsed resume', async () => {
      const res = await request(app.getHttpServer())
        .get('/resume/latest')
        .expect(200);
      expect(res.body.id).toBe(dummyResumeState.id);
      expect(res.body.parsedProfile.fullName).toBe('Alex Developer');
    });

    it('POST /resume/:id/ats-analyze - scores resume against ATS standards', async () => {
      const res = await request(app.getHttpServer())
        .post(`/resume/${dummyResumeState.id}/ats-analyze`)
        .send({ targetJobTitle: 'Full Stack Engineer' })
        .expect(201);
      expect(res.body.overallScore).toBe(92);
      expect(res.body.matchedKeywords).toContain('NestJS');
    });

    it('POST /resume/:id/optimize - generates AI tailored resume', async () => {
      const res = await request(app.getHttpServer())
        .post(`/resume/${dummyResumeState.id}/optimize`)
        .send({ customJobTitle: 'Lead Software Architect' })
        .expect(201);
      expect(res.body.tailoredResumeText).toContain('Optimized Resume');
    });
  });

  describe('5. Jobs Board & Match Recommendation Engine', () => {
    it('POST /job/filters - saves user job search preferences', async () => {
      const res = await request(app.getHttpServer())
        .post('/job/filters')
        .send({
          email: dummyUser.email,
          filters: {
            titles: ['Senior Software Engineer', 'Full Stack Developer'],
            locations: ['Remote', 'United States'],
            experienceLevels: ['senior'],
            jobTypes: ['full-time'],
          },
        })
        .expect(201);
      expect(res.body.success).toBe(true);
    });

    it('GET /job/dashboard - returns matched jobs for user profile', async () => {
      const res = await request(app.getHttpServer())
        .get('/job/dashboard')
        .expect(200);
      expect(res.body.matches.length).toBeGreaterThan(0);
      expect(res.body.matches[0].title).toBe('Senior Backend Engineer');
    });

    it('GET /job/integrations - returns active crawler integrations', async () => {
      const res = await request(app.getHttpServer())
        .get('/job/integrations')
        .expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0].connected).toBe(true);
    });
  });

  describe('6. Chrome Extension & External Job Board', () => {
    let extensionToken = '';

    it('GET /user/extension-token - generates a secure extension auth token', async () => {
      const res = await request(app.getHttpServer())
        .get('/user/extension-token')
        .expect(200);
      expect(res.body.token).toBeDefined();
      extensionToken = res.body.token;
    });

    it('POST /external-board/receive - ingests a job parsed from LinkedIn', async () => {
      const res = await request(app.getHttpServer())
        .post('/external-board/receive')
        .set('Authorization', `Bearer ${extensionToken}`)
        .send({
          title: 'Senior React Developer',
          company: 'Innovative Labs',
          location: 'Remote',
          url: 'https://linkedin.com/jobs/view/123456789',
          source: 'linkedin',
          description: 'Building high performance web applications.',
        })
        .expect(201);
      expect(res.body.success).toBe(true);
      expect(res.body.job.title).toBe('Senior React Developer');
    });

    it('GET /external-board/list - lists all ingested external jobs', async () => {
      const res = await request(app.getHttpServer())
        .get('/external-board/list')
        .expect(200);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0].title).toBe('Senior React Developer');
    });

    it('POST /external-board/:id/mark-pending - marks external job as pending application', async () => {
      const jobId = dummyExternalJobs[0]._id;
      const res = await request(app.getHttpServer())
        .post(`/external-board/${jobId}/mark-pending`)
        .expect(201);
      expect(res.body.success).toBe(true);
    });

    it('POST /external-board/:id/confirm-applied - confirms external job application', async () => {
      const jobId = dummyExternalJobs[0]._id;
      const res = await request(app.getHttpServer())
        .post(`/external-board/${jobId}/confirm-applied`)
        .expect(201);
      expect(res.body.success).toBe(true);
    });
  });

  describe('7. Applications Tracker', () => {
    let createdAppId = '';

    it('POST /application - creates a new tracked job application', async () => {
      const res = await request(app.getHttpServer())
        .post('/application')
        .send({ jobId: 'job-101' })
        .expect(201);
      expect(res.body._id).toBeDefined();
      expect(res.body.status).toBe('applied');
      createdAppId = res.body._id;
    });

    it('GET /application - lists all applications for dummy user', async () => {
      const res = await request(app.getHttpServer())
        .get('/application')
        .expect(200);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0]._id).toBe(createdAppId);
    });

    it('PUT /application/:id/status - updates application status to interviewing', async () => {
      const res = await request(app.getHttpServer())
        .put(`/application/${createdAppId}/status`)
        .send({
          status: 'interviewing',
          notes: 'Scheduled technical interview round 1',
        })
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.application.status).toBe('interviewing');
    });

    it('PUT /application/:id/cover-letter - saves custom cover letter for application', async () => {
      const res = await request(app.getHttpServer())
        .put(`/application/${createdAppId}/cover-letter`)
        .send({
          coverLetter:
            'Dear Hiring Manager,\nI am thrilled to apply for the position...',
        })
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.application.coverLetter).toContain('Dear Hiring Manager');
    });
  });

  describe('8. Support & Ticketing System', () => {
    it('POST /support - creates a new support ticket', async () => {
      const res = await request(app.getHttpServer())
        .post('/support')
        .send({
          subject: 'Feedback on AI Resume Tailor',
          message:
            'The AI recommendations worked amazingly on my latest interview!',
          category: 'feedback',
          email: dummyUser.email,
        })
        .expect(201);
      expect(res.body._id).toBeDefined();
      expect(res.body.subject).toBe('Feedback on AI Resume Tailor');
    });

    it('GET /support/my-tickets - retrieves user support tickets', async () => {
      const res = await request(app.getHttpServer())
        .get('/support/my-tickets')
        .expect(200);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0].subject).toBe('Feedback on AI Resume Tailor');
    });

    it('GET /support/notifications - retrieves unread ticket notifications count', async () => {
      const res = await request(app.getHttpServer())
        .get('/support/notifications')
        .expect(200);
      expect(res.body.count).toBe(0);
    });

    it('PUT /support/notifications/read - marks ticket replies as read', async () => {
      const res = await request(app.getHttpServer())
        .put('/support/notifications/read')
        .expect(200);
      expect(res.body.success).toBe(true);
    });
  });
});
