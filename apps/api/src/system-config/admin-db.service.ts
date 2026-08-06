import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Model, Connection } from 'mongoose';
import { ExternalBoardJob } from '../schemas/external-board-job.schema';
import { PendingConfirmation } from '../schemas/pending-confirmation.schema';
import { PendingDigest } from '../schemas/pending-digest.schema';
import { Job } from '../schemas/job.schema';
import { Application } from '../schemas/application.schema';
import { CrawlLog } from '../schemas/crawl-log.schema';
import { ApiLog } from '../schemas/api-log.schema';
import { User } from '../schemas/user.schema';
import { Resume } from '../schemas/resume.schema';
import { QueueService } from '../queue/queue.service';

@Injectable()
export class AdminDbService implements OnModuleInit {
  constructor(
    @InjectConnection() private connection: Connection,
    @InjectModel(ExternalBoardJob.name)
    private externalBoardJobModel: Model<ExternalBoardJob>,
    @InjectModel(PendingConfirmation.name)
    private pendingConfirmationModel: Model<PendingConfirmation>,
    @InjectModel(PendingDigest.name)
    private pendingDigestModel: Model<PendingDigest>,
    @InjectModel(Job.name) private jobModel: Model<Job>,
    @InjectModel(Application.name) private applicationModel: Model<Application>,
    @InjectModel(CrawlLog.name) private crawlLogModel: Model<CrawlLog>,
    @InjectModel(ApiLog.name) private apiLogModel: Model<ApiLog>,
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Resume.name) private resumeModel: Model<Resume>,
    private queueService: QueueService,
  ) {}

  async onModuleInit() {
    this.queueService.registerDailyCleanupProcessor(async () => {
      await this.cleanupOldJobsAuto();
    });
  }

  // --- Document counts ---
  async getCollectionCounts() {
    const [
      externalBoardJobs,
      pendingConfirmations,
      pendingDigests,
      jobs,
      applications,
      closedJobs,
      expiredExternalJobs,
    ] = await Promise.all([
      this.externalBoardJobModel.countDocuments(),
      this.pendingConfirmationModel.countDocuments(),
      this.pendingDigestModel.countDocuments({ sent: false }),
      this.jobModel.countDocuments(),
      this.applicationModel.countDocuments(),
      this.jobModel.countDocuments({ isClosed: true }),
      this.externalBoardJobModel.countDocuments({
        expiresAt: { $lt: new Date() },
      }),
    ]);

    return {
      externalBoardJobs,
      pendingConfirmations,
      pendingDigests,
      tier1to3Jobs: jobs,
      applications, // shown as read-only info, never exposed with a delete action
      closedTier1to3Jobs: closedJobs,
      alreadyExpiredExternalJobs: expiredExternalJobs,
    };
  }

  async getAnalytics() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const totalUsers = await this.userModel.countDocuments();
    const applicationsToday = await this.applicationModel.countDocuments({
      createdAt: { $gte: today },
    });
    const totalApplicationsAllTime =
      await this.applicationModel.countDocuments();

    const applications = await this.applicationModel
      .find({ createdAt: { $gte: today } })
      .exec();
    const totalApps = applications.length;
    const successApps = applications.filter(
      (a) => a.status === 'Applied',
    ).length;
    const failedApps = applications.filter((a) => a.status === 'Failed').length;

    // Tokens burned per user
    const tokenAgg = await this.apiLogModel.aggregate([
      {
        $match: { userId: { $exists: true, $ne: null } },
      },
      {
        $group: {
          _id: '$userId',
          promptTokens: { $sum: '$tokens.prompt' },
          completionTokens: { $sum: '$tokens.completion' },
          totalTokens: { $sum: '$tokens.total' },
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: 'clerkId',
          as: 'user',
        },
      },
      {
        $unwind: { path: '$user', preserveNullAndEmptyArrays: true },
      },
      {
        $project: {
          userId: '$_id',
          email: '$user.email',
          totalTokens: 1,
          promptTokens: 1,
          completionTokens: 1,
        },
      },
    ]);

    return {
      totalUsers,
      globalApplicationsToday: applicationsToday,
      totalApplicationsAllTime,
      autoApplySuccessRate: totalApps > 0 ? (successApps / totalApps) * 100 : 0,
      applicationsSuccess: successApps,
      applicationsFailed: failedApps,
      tokenUsagePerUser: tokenAgg,
    };
  }

  // --- Real storage size per collection ---
  async getStorageStats() {
    const db = this.connection.db!;

    const dbCollections = await db.listCollections().toArray();

    const perCollection = await Promise.all(
      dbCollections.map(async (collInfo) => {
        const name = collInfo.name;
        try {
          const stat = await db.command({ collStats: name });
          return {
            key: name,
            collection: name,
            documentCount: stat.count,
            storageSizeMB: +(stat.storageSize / (1024 * 1024)).toFixed(2),
            dataSizeMB: +(stat.size / (1024 * 1024)).toFixed(2),
            avgDocSizeKB: +(stat.avgObjSize / 1024).toFixed(2),
            indexSizeMB: +(stat.totalIndexSize / (1024 * 1024)).toFixed(2),
          };
        } catch {
          // Collection may not exist yet or no perms - skip gracefully
          return {
            key: name,
            collection: name,
            documentCount: 0,
            storageSizeMB: 0,
            dataSizeMB: 0,
            avgDocSizeKB: 0,
            indexSizeMB: 0,
          };
        }
      }),
    );

    // Sort collections alphabetically to mirror MongoDB Atlas
    perCollection.sort((a, b) => a.collection.localeCompare(b.collection));

    const dbStats = await db.command({ dbStats: 1 });

    return {
      collections: perCollection,
      totalDataSizeMB: +(dbStats.dataSize / (1024 * 1024)).toFixed(2),
      totalStorageSizeMB: +(dbStats.storageSize / (1024 * 1024)).toFixed(2),
      totalIndexSizeMB: +(dbStats.indexSize / (1024 * 1024)).toFixed(2),
    };
  }

  // --- Bulk cleanup ---
  async forceExpireExternalBoardJobs() {
    const twelveDaysAgo = new Date(Date.now() - 12 * 24 * 60 * 60 * 1000);
    const result = await this.externalBoardJobModel.deleteMany({
      $or: [
        { expiresAt: { $lt: new Date() } },
        { createdAt: { $lt: twelveDaysAgo } },
      ],
    });
    return { deletedCount: result.deletedCount };
  }

  async clearStalePendingConfirmations(olderThanHours: number) {
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
    const result = await this.pendingConfirmationModel.deleteMany({
      createdAt: { $lt: cutoff },
    });
    return { deletedCount: result.deletedCount };
  }

  async clearSentDigests() {
    const result = await this.pendingDigestModel.deleteMany({ sent: true });
    return { deletedCount: result.deletedCount };
  }

  async clearClosedJobs(olderThanDays: number) {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const result = await this.jobModel.deleteMany({
      isClosed: true,
      updatedAt: { $lt: cutoff },
    });
    return { deletedCount: result.deletedCount };
  }

  async purgeCompanyJobs(companySlug: string) {
    const result = await this.jobModel.deleteMany({ companySlug });
    return { deletedCount: result.deletedCount };
  }

  // --- Purge Tier 4 by platform ---
  async purgeBySourcePlatform(platform: 'LinkedIn' | 'Indeed' | 'Naukri') {
    const result = await this.externalBoardJobModel.deleteMany({
      sourcePlatform: platform,
    });
    return { deletedCount: result.deletedCount };
  }

  // --- Wipe all jobs across both tables ---
  async purgeAllJobs(source?: string) {
    if (source === 'tier1-3') {
      const result = await this.jobModel.deleteMany({});
      return { deletedCount: result.deletedCount || 0 };
    } else if (source === 'external-board') {
      const result = await this.externalBoardJobModel.deleteMany({});
      return { deletedCount: result.deletedCount || 0 };
    } else {
      const [result, extResult] = await Promise.all([
        this.jobModel.deleteMany({}),
        this.externalBoardJobModel.deleteMany({}),
      ]);
      return {
        deletedCount:
          (result.deletedCount || 0) + (extResult.deletedCount || 0),
      };
    }
  }

  async cleanupOldJobsAuto() {
    console.log('[AdminDbService] Running daily job cleanup task...');
    const cutoff = new Date(Date.now() - 12 * 24 * 60 * 60 * 1000); // 12 days ago

    // Get all jobs that are either >12 days old OR closed
    const staleJobs = await this.jobModel
      .find(
        {
          $or: [
            { postedDate: { $lt: cutoff } },
            { createdAt: { $lt: cutoff } },
            { isClosed: true },
          ],
        },
        { _id: 1 },
      )
      .lean();

    const staleExtJobs = await this.externalBoardJobModel
      .find(
        {
          createdAt: { $lt: cutoff },
        },
        { _id: 1 },
      )
      .lean();

    const jobIds = staleJobs.map((j) => j._id.toString());
    const extJobIds = staleExtJobs.map((j) => j._id.toString());

    // Filter out jobs that have been applied to
    const appliedApps = await this.applicationModel
      .find(
        {
          jobId: { $in: [...jobIds, ...extJobIds] },
        },
        { jobId: 1 },
      )
      .lean();

    const appliedJobIds = new Set(
      appliedApps.map((a) => a.jobId?.toString() || ''),
    );

    const jobsToDelete = jobIds.filter((id) => !appliedJobIds.has(id));
    const extJobsToDelete = extJobIds.filter((id) => !appliedJobIds.has(id));

    let deleted = 0;
    if (jobsToDelete.length > 0) {
      const res = await this.jobModel.deleteMany({
        _id: { $in: jobsToDelete },
      });
      deleted += res.deletedCount || 0;
    }
    if (extJobsToDelete.length > 0) {
      const res = await this.externalBoardJobModel.deleteMany({
        _id: { $in: extJobsToDelete },
      });
      deleted += res.deletedCount || 0;
    }

    console.log(
      `[AdminDbService] Cleanup finished. Deleted ${deleted} stale jobs. preserved ${appliedJobIds.size} applied jobs.`,
    );
    return deleted;
  }

  // --- Browse & individual delete ---
  async browseJobs(
    search: string,
    source: 'tier1-3' | 'external-board',
    page: number,
  ) {
    const model = (
      source === 'external-board' ? this.externalBoardJobModel : this.jobModel
    ) as Model<any>;
    const query = search
      ? {
          $or: [
            { title: { $regex: search, $options: 'i' } },
            { company: { $regex: search, $options: 'i' } },
          ],
        }
      : {};

    const pageSize = 25;
    const [results, total] = await Promise.all([
      model
        .find(query)
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .sort({ createdAt: -1 })
        .exec(),
      model.countDocuments(query),
    ]);

    return { results, total, page, pageSize };
  }

  async deleteOneJob(id: string, source: 'tier1-3' | 'external-board') {
    const model = (
      source === 'external-board' ? this.externalBoardJobModel : this.jobModel
    ) as Model<any>;
    await model.findByIdAndDelete(id);
    return { success: true };
  }

  async getScraperStats() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [logs, apiCalls, totalSavedJobs] = await Promise.all([
      this.crawlLogModel.find().sort({ startTime: -1 }).limit(30).exec(),
      this.apiLogModel.find({ timestamp: { $gte: todayStart } }).exec(),
      this.jobModel.countDocuments(),
    ]);

    const apiStatsMap: {
      [service: string]: { success: number; failed: number };
    } = {
      JSEARCH: { success: 0, failed: 0 },
      ADZUNA: { success: 0, failed: 0 },
      Gemini: { success: 0, failed: 0 },
      Anthropic: { success: 0, failed: 0 },
      Groq: { success: 0, failed: 0 },
    };

    for (const log of apiCalls) {
      const srv = log.service.toUpperCase();
      let targetKey = log.service;
      if (srv === 'JSEARCH') targetKey = 'JSEARCH';
      else if (srv === 'ADZUNA') targetKey = 'ADZUNA';
      else if (srv.includes('GEMINI')) targetKey = 'Gemini';
      else if (srv.includes('CLAUDE') || srv.includes('ANTHROPIC'))
        targetKey = 'Anthropic';
      else if (srv.includes('GROQ')) targetKey = 'Groq';

      if (!apiStatsMap[targetKey]) {
        apiStatsMap[targetKey] = { success: 0, failed: 0 };
      }
      if (log.status === 'success') {
        apiStatsMap[targetKey].success++;
      } else {
        apiStatsMap[targetKey].failed++;
      }
    }

    return {
      crawlLogs: logs,
      apiStats: apiStatsMap,
      totalSavedJobs,
    };
  }

  async createSnapshot() {
    await this.applicationModel.aggregate([
      { $match: {} },
      { $out: `${this.applicationModel.collection.name}_snapshot` },
    ]);
    await this.jobModel.aggregate([
      { $match: {} },
      { $out: `${this.jobModel.collection.name}_snapshot` },
    ]);
    await this.userModel.aggregate([
      { $match: {} },
      { $out: `${this.userModel.collection.name}_snapshot` },
    ]);
    return {
      success: true,
      message: 'Database snapshot created successfully.',
    };
  }

  async rollbackSnapshot() {
    const db = this.applicationModel.db.db;
    if (!db) {
      throw new Error('Database connection not available.');
    }

    const appSnapName = `${this.applicationModel.collection.name}_snapshot`;
    const collections = await db
      .listCollections({ name: appSnapName })
      .toArray();
    if (collections.length === 0) {
      throw new Error(
        'No snapshot found in the database. Please create a snapshot first.',
      );
    }

    await db
      .collection(appSnapName)
      .aggregate([
        { $match: {} },
        { $out: this.applicationModel.collection.name },
      ])
      .toArray();
    await db
      .collection(`${this.jobModel.collection.name}_snapshot`)
      .aggregate([{ $match: {} }, { $out: this.jobModel.collection.name }])
      .toArray();
    await db
      .collection(`${this.userModel.collection.name}_snapshot`)
      .aggregate([{ $match: {} }, { $out: this.userModel.collection.name }])
      .toArray();

    return {
      success: true,
      message: 'Database rolled back to snapshot successfully.',
    };
  }

  async triggerScraper() {
    await this.queueService.addGlobalCrawlJob();
    return {
      success: true,
      message: 'Scraper background run triggered successfully.',
    };
  }

  async triggerDigest() {
    await this.queueService.addGlobalDigestJob();
    return {
      success: true,
      message: 'Global digest dispatch triggered successfully.',
    };
  }

  async debugResume() {
    const resume = await this.resumeModel
      .findOne()
      .sort({ createdAt: -1 })
      .lean();
    return resume;
  }
}
