import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Agenda } from 'agenda';

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private agenda: Agenda;

  async onModuleInit() {
    const mongoUri =
      process.env.MONGODB_URI || 'mongodb://localhost:27017/ai_job_copilot';

    this.agenda = new Agenda({
      db: { address: mongoUri, collection: 'agendaJobs' },
    });

    await this.agenda.start();
    console.log('[QueueService] Agenda started and connected to MongoDB');

    // One global crawl at 07:00, 12:00, and 16:00 IST (which is 01:30, 06:30, 10:30 UTC)
    await this.agenda.every('30 1,6,10 * * *', 'crawl-jobs');

    await this.agenda.every('0 9 * * 1', 'validate-ats-config');

    // Digest delivery scheduled for 07:10, 12:10, and 16:10 IST (01:40, 06:40, 10:40 UTC)
    await this.agenda.every('40 1,6,10 * * *', 'send-digest-cron');

    // Daily cleanup at midnight UTC
    await this.agenda.every('0 0 * * *', 'daily-cleanup-jobs');
  }

  async addResumeParseJob(resumeId: string, userId: string, fileKey: string) {
    return this.agenda.now('parse-resume', { resumeId, userId, fileKey });
  }

  async addJobMatchJob(userId: string, jobId: string) {
    return this.agenda.now('match-job', { userId, jobId });
  }

  async addResumeTailorJob(
    userId: string,
    jobId: string,
    applicationId: string,
  ) {
    return this.agenda.now('tailor-resume', { userId, jobId, applicationId });
  }

  async addGlobalCrawlJob() {
    return this.agenda.now('crawl-jobs', {});
  }

  async addGlobalDigestJob() {
    return this.agenda.now('send-digest-cron', {});
  }

  async addExternalBoardNewJob(jobId: string) {
    return this.agenda.now('external-board-new-job', { jobId });
  }

  async addCrawledNewJob(jobId: string) {
    return this.agenda.now('crawled-new-job', { jobId });
  }

  async addQueueForDigest(jobId: string, userIds: string[]) {
    return this.agenda.now('queue-for-digest', { jobId, userIds });
  }

  async addTelegramJobMatch(
    chatId: string,
    jobTitle: string,
    company: string,
    matchScore: number,
    salary: string,
    applicationId: string,
  ) {
    return this.agenda.now('telegram-job-match', {
      chatId,
      jobTitle,
      company,
      matchScore,
      salary,
      applicationId,
    });
  }

  async addTelegramAppUpdate(
    chatId: string,
    jobTitle: string,
    company: string,
    status: string,
  ) {
    return this.agenda.now('telegram-app-update', {
      chatId,
      jobTitle,
      company,
      status,
    });
  }

  registerGlobalCrawlProcessor(
    processor: () => Promise<void>,
    validator: () => Promise<void>,
  ): void {
    // Agenda runs the processors locally when agenda.start() is called (which we did in onModuleInit).
    this.agenda.define('crawl-jobs', async (job: any) => {
      try {
        await processor();
      } catch (err) {
        console.error(`[QueueService] Global crawl job failed:`, err);
        throw err;
      }
    });

    this.agenda.define('validate-ats-config', async (job: any) => {
      try {
        await validator();
      } catch (err) {
        console.error(`[QueueService] ATS config validation failed:`, err);
        throw err;
      }
    });
  }

  registerDailyCleanupProcessor(processor: () => Promise<void>): void {
    this.agenda.define('daily-cleanup-jobs', async (job: any) => {
      try {
        await processor();
      } catch (err) {
        console.error(`[QueueService] Daily cleanup job failed:`, err);
        throw err;
      }
    });
  }

  async onModuleDestroy() {
    await this.agenda?.stop();
    console.log('[QueueService] Agenda stopped gracefully');
  }
}
