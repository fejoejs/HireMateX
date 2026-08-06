import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ExternalBoardJob } from '../schemas/external-board-job.schema';
import { PendingConfirmation } from '../schemas/pending-confirmation.schema';
import { Application } from '../schemas/application.schema';
import { User } from '../schemas/user.schema';
import { QueueService } from '../queue/queue.service';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';

@Injectable()
export class ExternalBoardService {
  private readonly EXPIRY_WINDOW_DAYS = 12;

  constructor(
    @InjectModel(ExternalBoardJob.name)
    private externalBoardJobModel: Model<ExternalBoardJob>,
    @InjectModel(PendingConfirmation.name)
    private pendingConfirmationModel: Model<PendingConfirmation>,
    @InjectModel(Application.name) private applicationModel: Model<Application>,
    @InjectModel(User.name) private userModel: Model<User>,
    private queueService: QueueService,
  ) {}

  async getExtensionToken(userId: string): Promise<string> {
    const jwtSecret =
      process.env.EXTENSION_JWT_SECRET || process.env.JWT_SECRET;
    if (!jwtSecret && process.env.NODE_ENV === 'production') {
      console.error(
        '[ExternalBoardService] CRITICAL: EXTENSION_JWT_SECRET or JWT_SECRET is missing in production!',
      );
      throw new Error('Server configuration error: missing JWT secret');
    }
    const secretToUse = jwtSecret || 'hirematex_extension_secure_key_dev';
    return jwt.sign({ userId }, secretToUse, { expiresIn: '180d' });
  }

  private isInvalidJob(dto: any): boolean {
    if (!dto || !dto.title) return true;
    const cleanTitle = (dto.title || '').trim().toLowerCase();
    if (cleanTitle.length < 3) return true;

    const blacklisted = [
      'welcome,',
      'sign in',
      'post a job',
      'top job picks for you',
      'job collections',
      'recommended jobs',
      'search results',
      'jobs you may be interested in',
      'easy apply',
      'viewed',
      'promoted',
      'what job are you looking for',
      'my jobs',
      'notifications',
      'messages',
    ];

    if (
      blacklisted.some(
        (phrase) => cleanTitle === phrase || cleanTitle.startsWith(phrase),
      )
    ) {
      return true;
    }

    if (
      !dto.url ||
      dto.url === 'https://in.indeed.com/' ||
      dto.url === 'https://www.indeed.com/' ||
      dto.url === 'https://www.linkedin.com/' ||
      dto.url === 'https://www.naukri.com/'
    ) {
      return true;
    }

    return false;
  }

  async saveOrRefresh(
    discoveredByUserId: string,
    dto: any,
  ): Promise<{ job: ExternalBoardJob; isNew: boolean } | null> {
    if (this.isInvalidJob(dto)) {
      console.log(
        `[ExternalBoardService] Skipping invalid non-job payload: ${dto?.title}`,
      );
      return null;
    }

    const dedupKey = this.extractDedupKey(
      dto.url,
      dto.title,
      dto.company,
      dto.sourcePlatform,
      dto.id,
    );
    const now = new Date();

    // Validate explicit expiry date if provided by the extension
    if (dto.expiresAt) {
      const explicitExpiry = new Date(dto.expiresAt);
      if (explicitExpiry < now) {
        console.log(
          `[ExternalBoardService] Skipping expired job from extension: ${dto.title}`,
        );
        return null;
      }
    }

    const newExpiry = dto.expiresAt
      ? new Date(dto.expiresAt)
      : new Date(now.getTime() + this.EXPIRY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const existing = await this.externalBoardJobModel.findOne({ dedupKey });

    if (existing) {
      existing.lastSeenAt = now;
      existing.expiresAt = newExpiry;
      const updated = await existing.save();
      return { job: updated, isNew: false };
    }

    const description = dto.description || dto.shortDescription || '';
    const experienceLevel = this.detectExperienceLevel(
      dto.title || '',
      description,
    );
    const workType = this.detectWorkType(dto.location || '', description);

    let salaryMin, salaryMax;
    if (dto.salary) {
      const parsed = this.parseSalary(dto.salary);
      salaryMin = parsed?.min;
      salaryMax = parsed?.max;
    }

    let platform: 'LinkedIn' | 'Indeed' | 'Naukri' = 'LinkedIn';
    const rawPlatform = (dto.sourcePlatform || '').toLowerCase();
    if (rawPlatform.includes('indeed')) platform = 'Indeed';
    else if (rawPlatform.includes('naukri')) platform = 'Naukri';
    else platform = 'LinkedIn';

    let job: ExternalBoardJob;
    try {
      job = await this.externalBoardJobModel.create({
        title: dto.title,
        company: dto.company,
        location: dto.location,
        salary: dto.salary,
        salaryMin,
        salaryMax,
        experienceLevel,
        workType,
        shortDescription: this.formatShortDescription(description),
        url: dto.url,
        sourcePlatform: platform,
        dedupKey,
        discoveredByUserId,
        firstSeenAt: now,
        lastSeenAt: now,
        expiresAt: newExpiry,
      });
    } catch (err: any) {
      if (err.code === 11000) {
        // Race condition duplicate insert: retrieve existing record and update expiry
        const dup = await this.externalBoardJobModel.findOne({ dedupKey });
        if (dup) {
          dup.lastSeenAt = now;
          dup.expiresAt = newExpiry;
          const updated = await dup.save();
          return { job: updated, isNew: false };
        }
      }
      throw err;
    }

    // Notify users about the new external board job matching their criteria asynchronously
    if ((this.queueService as any).addExternalBoardNewJob) {
      await (this.queueService as any).addExternalBoardNewJob(
        job._id.toString(),
      );
    }

    return { job, isNew: true };
  }

  async saveOrRefreshBatch(
    discoveredByUserId: string,
    dtos: any[],
  ): Promise<{
    success: boolean;
    count: number;
    newInserted: number;
    refreshed: number;
    totalInDatabase: number;
  }> {
    if (!Array.isArray(dtos) || dtos.length === 0) {
      const totalInDatabase = await this.externalBoardJobModel.countDocuments();
      return {
        success: true,
        count: 0,
        newInserted: 0,
        refreshed: 0,
        totalInDatabase,
      };
    }
    let newCount = 0;
    let refreshedCount = 0;

    const tasks = dtos.map(async (dto) => {
      if (dto && dto.title && (dto.id || dto.url)) {
        try {
          const res = await this.saveOrRefresh(discoveredByUserId, dto);
          if (res) {
            if (res.isNew) newCount++;
            else refreshedCount++;
          }
        } catch (err) {
          console.warn(
            `[ExternalBoardService] Error saving job ${dto.title}:`,
            err,
          );
        }
      }
    });

    await Promise.allSettled(tasks);
    const totalInDatabase = await this.externalBoardJobModel.countDocuments();
    return {
      success: true,
      count: newCount + refreshedCount,
      newInserted: newCount,
      refreshed: refreshedCount,
      totalInDatabase,
    };
  }

  async getFilteredJobs(userId: string): Promise<any[]> {
    const user = await this.userModel
      .findOne({ $or: [{ clerkId: userId }, { email: userId }] })
      .lean()
      .exec();

    if (!user || !user.filters) {
      return [];
    }

    const filters = user.filters;
    const hasTargetRoles = !!(
      (filters.targetJobRole && filters.targetJobRole.trim().length > 0) ||
      (Array.isArray(filters.targetRoles) && filters.targetRoles.length > 0)
    );

    const hasLocations = !!(
      filters.countries &&
      (Array.isArray(filters.countries)
        ? filters.countries.length > 0
        : String(filters.countries).trim().length > 0)
    );

    const hasWorkTypes =
      Array.isArray(filters.workTypes) && filters.workTypes.length > 0;

    const hasPreferences = hasTargetRoles || hasLocations || hasWorkTypes;
    if (!hasPreferences) {
      return [];
    }

    // Exclude jobs this specific user has already confirmed as applied
    const appliedJobIds = await this.applicationModel
      .find({ userId, source: 'external-board' })
      .distinct('externalBoardJobId')
      .exec();

    const now = new Date();
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    const baseConditions: any[] = [
      {
        $or: [
          { expiresAt: { $exists: false } },
          { expiresAt: null },
          { expiresAt: { $gt: now } },
        ],
      },
      {
        $or: [
          { lastSeenAt: { $gte: fourteenDaysAgo } },
          { createdAt: { $gte: fourteenDaysAgo } },
          { updatedAt: { $gte: fourteenDaysAgo } },
        ],
      },
    ];

    if (appliedJobIds.length > 0) {
      baseConditions.push({ _id: { $nin: appliedJobIds } });
    }

    if (user?.dismissedExternalJobs && user.dismissedExternalJobs.length > 0) {
      baseConditions.push({ _id: { $nin: user.dismissedExternalJobs } });
    }

    // Fetch candidate vacancies up to 500
    const rawJobs = await this.externalBoardJobModel
      .find(
        baseConditions.length > 1
          ? { $and: baseConditions }
          : baseConditions[0],
      )
      .sort({ lastSeenAt: -1 })
      .limit(500)
      .lean()
      .exec();

    // Calculate match score and filter strictly by user preferences
    const scoredJobs: any[] = [];
    for (const job of rawJobs) {
      const matchData = this.calculateJobMatch(job, filters);

      if (matchData.isPreferenceMatch) {
        scoredJobs.push({
          ...job,
          matchScore: matchData.matchScore,
          matchHighlights: matchData.matchHighlights,
          isPreferenceMatch: true,
        });
      }
    }

    // Sort by match score descending, then by last seen date descending
    scoredJobs.sort((a, b) => {
      if ((b.matchScore || 0) !== (a.matchScore || 0)) {
        return (b.matchScore || 0) - (a.matchScore || 0);
      }
      return (
        new Date(b.lastSeenAt || 0).getTime() -
        new Date(a.lastSeenAt || 0).getTime()
      );
    });

    return scoredJobs;
  }

  async markPending(
    userId: string,
    jobId: string,
  ): Promise<{ success: boolean }> {
    await this.pendingConfirmationModel
      .findOneAndUpdate(
        { userId, externalBoardJobId: jobId },
        { userId, externalBoardJobId: jobId, markedAt: new Date() },
        { upsert: true },
      )
      .exec();
    return { success: true };
  }

  async confirmApplied(
    userId: string,
    jobId: string,
  ): Promise<{ success: boolean; note?: string }> {
    const job = await this.externalBoardJobModel.findById(jobId).exec();
    if (!job) {
      await this.pendingConfirmationModel
        .deleteOne({ userId, externalBoardJobId: jobId })
        .exec();
      return {
        success: true,
        note: 'Job no longer in pool, application not linked to a listing.',
      };
    }

    const alreadyApplied = await this.applicationModel
      .findOne({
        userId,
        externalBoardJobId: job._id.toString(),
        source: 'external-board',
      })
      .exec();

    if (!alreadyApplied) {
      // Snapshot details into Application record to remain independent of TTL expiry deletion
      await this.applicationModel.create({
        userId,
        externalBoardJobId: job._id.toString(),
        jobTitle: job.title,
        company: job.company,
        location: job.location || '',
        sourcePlatform: job.sourcePlatform,
        url: job.url,
        source: 'external-board',
        status: 'Applied',
        appliedDate: new Date(),
      });
    }

    await this.pendingConfirmationModel
      .deleteOne({ userId, externalBoardJobId: jobId })
      .exec();
    return { success: true };
  }

  async clearPending(
    userId: string,
    jobId: string,
  ): Promise<{ success: boolean }> {
    await this.pendingConfirmationModel
      .deleteOne({ userId, externalBoardJobId: jobId })
      .exec();
    return { success: true };
  }

  async dismissJob(
    userId: string,
    jobId: string,
  ): Promise<{ success: boolean }> {
    await this.userModel
      .findOneAndUpdate(
        { $or: [{ clerkId: userId }, { email: userId }] },
        { $addToSet: { dismissedExternalJobs: jobId } },
      )
      .exec();
    return { success: true };
  }

  extractDedupKey(
    url: string,
    title?: string,
    company?: string,
    sourcePlatform?: string,
    customId?: string,
  ): string {
    const platform = (sourcePlatform || 'ext').toLowerCase();

    // 1. Explicit ID passed from scraper
    if (
      customId &&
      typeof customId === 'string' &&
      customId.length >= 3 &&
      !customId.startsWith('http')
    ) {
      return `${platform}-${customId.trim()}`;
    }

    if (!url && !title) return `unknown-${Date.now()}-${Math.random()}`;

    // 2. LinkedIn Job ID
    const linkedinMatch =
      url?.match(/jobs\/view\/(\d+)/) ||
      url?.match(/currentJobId=(\d+)/) ||
      url?.match(/jobId=(\d+)/);
    if (linkedinMatch) return `linkedin-${linkedinMatch[1]}`;

    // 3. Indeed Job Key
    const indeedMatch = url?.match(/(?:jk=|vjk=)([a-f0-9]+)/i);
    if (indeedMatch) return `indeed-${indeedMatch[1]}`;

    // 4. Naukri Job ID
    const naukriMatch =
      url?.match(/job-listings-[\w-]+-(\d+)/) || url?.match(/\/(\d{6,})\b/);
    if (naukriMatch) return `naukri-${naukriMatch[1]}`;

    // 5. Fallback company + title dedup only if real company is identified
    if (
      title &&
      company &&
      company.toLowerCase() !== 'indeed employer' &&
      company.toLowerCase() !== 'linkedin company'
    ) {
      const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
      const normalizedCompany = company.toLowerCase().replace(/[^a-z0-9]/g, '');
      return `${platform}-${normalizedCompany}-${normalizedTitle}`;
    }

    return crypto
      .createHash('md5')
      .update(url || `${title}-${company}-${Date.now()}`)
      .digest('hex');
  }

  formatShortDescription(rawText: string | undefined): string {
    if (!rawText) return '';
    const clean = rawText.replace(/\s+/g, ' ').trim();
    return clean.length > 180 ? clean.slice(0, 180) + '...' : clean;
  }

  private calculateJobMatch(
    job: any,
    filters: any,
  ): {
    matchScore: number;
    matchHighlights: string[];
    isPreferenceMatch: boolean;
  } {
    if (!filters) {
      return { matchScore: 0, matchHighlights: [], isPreferenceMatch: false };
    }

    const titleLower = (job.title || '').toLowerCase();
    const locLower = (job.location || '').toLowerCase();
    const descLower = (job.shortDescription || '').toLowerCase();

    // 1. Role / Title Match (Target Roles)
    let rolesFilter: string[] = [];
    if (Array.isArray(filters.targetRoles) && filters.targetRoles.length > 0) {
      rolesFilter = [...filters.targetRoles];
    } else if (
      filters.targetJobRole &&
      typeof filters.targetJobRole === 'string'
    ) {
      rolesFilter = filters.targetJobRole
        .split(',')
        .map((r: string) => r.trim())
        .filter(Boolean);
    }

    const roleAliasMap: Record<string, string[]> = {
      'software engineer': [
        'software engineer',
        'software developer',
        'swe',
        'sde',
        'backend engineer',
        'software development engineer',
        'developer',
        'engineer',
        'tech lead',
      ],
      'frontend developer': [
        'frontend',
        'front-end',
        'react',
        'react developer',
        'reactjs',
        'ui developer',
        'front-end engineer',
        'frontend engineer',
        'ui engineer',
        'web developer',
        'angular developer',
        'vue developer',
        'javascript developer',
      ],
      'fullstack developer': [
        'fullstack',
        'full stack',
        'full-stack',
        'mern',
        'mean',
        'node developer',
        'full stack developer',
        'fullstack engineer',
        'full stack engineer',
      ],
      'backend developer': [
        'backend',
        'back-end',
        'api developer',
        'node developer',
        'python developer',
        'java developer',
        'golang developer',
        'django developer',
        'springboot developer',
        'backend engineer',
        'server developer',
      ],
      'data scientist': [
        'data scientist',
        'machine learning',
        'ml engineer',
        'ai engineer',
        'data analyst',
        'data engineer',
        'deep learning',
        'nlp engineer',
        'computer vision',
      ],
      'devops engineer': [
        'devops',
        'site reliability engineer',
        'sre',
        'cloud engineer',
        'platform engineer',
        'infrastructure engineer',
        'aws engineer',
        'devsecops',
        'cloud architect',
      ],
      'product manager': [
        'product manager',
        'product owner',
        'program manager',
        'apm',
        'associate product manager',
        'technical product manager',
        'pm',
      ],
      'ui ux designer': [
        'ux designer',
        'ui designer',
        'product designer',
        'ui/ux',
        'interaction designer',
        'visual designer',
        'web designer',
      ],
      'mobile developer': [
        'mobile developer',
        'ios developer',
        'android developer',
        'react native',
        'flutter developer',
        'ios engineer',
        'android engineer',
      ],
      'qa engineer': [
        'qa engineer',
        'sdet',
        'test engineer',
        'quality assurance',
        'automation tester',
        'tester',
        'qa lead',
        'test automation',
      ],
    };

    const expandedRoles = new Set<string>();
    for (const r of rolesFilter) {
      const rLower = r.toLowerCase().trim();
      if (!rLower) continue;
      expandedRoles.add(rLower);
      for (const [canonical, aliases] of Object.entries(roleAliasMap)) {
        if (
          rLower.includes(canonical) ||
          canonical.includes(rLower) ||
          aliases.some((a) => rLower.includes(a) || a.includes(rLower))
        ) {
          aliases.forEach((a) => expandedRoles.add(a));
          expandedRoles.add(canonical);
        }
      }
    }

    let roleMatched = false;
    let matchedKeyword = '';
    for (const r of expandedRoles) {
      if (r.length >= 2) {
        const escaped = this.escapeRegex(r);
        const wordBoundaryRegex = new RegExp(`\\b${escaped}\\b`, 'i');
        if (wordBoundaryRegex.test(titleLower) || titleLower.includes(r)) {
          roleMatched = true;
          matchedKeyword = r;
          break;
        }
      }
    }

    // If user specified target roles and this job's title does NOT match, reject immediately
    if (rolesFilter.length > 0 && !roleMatched) {
      return { matchScore: 0, matchHighlights: [], isPreferenceMatch: false };
    }

    let score = 0;
    const highlights: string[] = [];

    if (roleMatched) {
      score += 45;
      highlights.push(
        `Role: ${matchedKeyword ? matchedKeyword.charAt(0).toUpperCase() + matchedKeyword.slice(1) : 'Match'}`,
      );
    } else if (rolesFilter.length === 0) {
      score += 25;
    }

    // 2. Work Type & Remote Match
    const isJobRemote =
      job.workType === 'Remote' ||
      locLower.includes('remote') ||
      titleLower.includes('remote') ||
      locLower.includes('work from home') ||
      locLower.includes('wfh');

    const isJobHybrid =
      job.workType === 'Hybrid' ||
      locLower.includes('hybrid') ||
      titleLower.includes('hybrid');

    const isJobOnsite = !isJobRemote && !isJobHybrid;

    let countryList: string[] = [];
    if (Array.isArray(filters.countries)) {
      countryList = filters.countries.flatMap((c: string) =>
        typeof c === 'string' ? c.split(',').map((s) => s.trim()) : [],
      );
    } else if (typeof filters.countries === 'string') {
      countryList = filters.countries.split(',').map((c: string) => c.trim());
    }
    countryList = countryList.filter(Boolean);

    const workTypes = Array.isArray(filters.workTypes)
      ? filters.workTypes.filter(Boolean)
      : [];
    const wantsRemote =
      workTypes.includes('Remote') ||
      countryList.some((c) => c.toLowerCase() === 'remote');
    const wantsHybrid = workTypes.includes('Hybrid');
    const wantsOnsite = workTypes.includes('Onsite');

    if (workTypes.length > 0) {
      if (isJobRemote && !wantsRemote) {
        return { matchScore: 0, matchHighlights: [], isPreferenceMatch: false };
      }
      if (isJobHybrid && !wantsHybrid) {
        return { matchScore: 0, matchHighlights: [], isPreferenceMatch: false };
      }
      if (isJobOnsite && !wantsOnsite) {
        return { matchScore: 0, matchHighlights: [], isPreferenceMatch: false };
      }

      if (wantsRemote && isJobRemote) {
        score += 20;
        highlights.push('Remote');
      } else if (wantsHybrid && isJobHybrid) {
        score += 15;
        highlights.push('Hybrid');
      } else if (wantsOnsite && isJobOnsite) {
        score += 15;
        highlights.push('On-site');
      }
    } else {
      score += 15;
      if (isJobRemote) highlights.push('Remote');
    }

    // 3. Location & Country Match
    const nonRemoteCountries = countryList.filter(
      (c) => c.toLowerCase() !== 'remote',
    );
    if (nonRemoteCountries.length > 0) {
      if (isJobRemote) {
        if (!wantsRemote && workTypes.length > 0) {
          return {
            matchScore: 0,
            matchHighlights: [],
            isPreferenceMatch: false,
          };
        }
        score += 20;
      } else {
        let locMatched = false;
        let matchedLocationName = '';
        for (const c of nonRemoteCountries) {
          const norm = this.normalizeQueryLocation(c);
          if (norm && new RegExp(norm, 'i').test(locLower)) {
            locMatched = true;
            matchedLocationName = c;
            break;
          }
        }
        if (!locMatched) {
          return {
            matchScore: 0,
            matchHighlights: [],
            isPreferenceMatch: false,
          };
        }
        score += 20;
        if (
          matchedLocationName &&
          !highlights.some(
            (h) => h.toLowerCase() === matchedLocationName.toLowerCase(),
          )
        ) {
          highlights.push(matchedLocationName);
        }
      }
    } else if (countryList.length > 0) {
      // User only selected Remote as location
      if (!isJobRemote) {
        return { matchScore: 0, matchHighlights: [], isPreferenceMatch: false };
      }
      score += 20;
    } else {
      score += 15;
    }

    // 4. Experience Level Match
    if (filters.experienceLevel) {
      const userLevel = filters.experienceLevel;
      const forbiddenTitleRegex =
        userLevel === 'Fresher' || userLevel === 'Junior'
          ? /\b(senior|sr\.?|lead|principal|staff|architect|director|head|vp|manager|specialist|expert)\b/i
          : userLevel === 'Mid'
            ? /\b(principal|director|head of|vp)\b/i
            : null;

      if (forbiddenTitleRegex && forbiddenTitleRegex.test(titleLower)) {
        return { matchScore: 0, matchHighlights: [], isPreferenceMatch: false };
      }

      const jobLevel =
        job.experienceLevel ||
        this.detectExperienceLevel(job.title || '', job.shortDescription || '');

      if (
        userLevel === 'Fresher' &&
        (jobLevel === 'Senior' ||
          descLower.includes('4+ years') ||
          descLower.includes('5+ years'))
      ) {
        return { matchScore: 0, matchHighlights: [], isPreferenceMatch: false };
      }
      if (
        userLevel === 'Junior' &&
        (jobLevel === 'Senior' || descLower.includes('5+ years'))
      ) {
        return { matchScore: 0, matchHighlights: [], isPreferenceMatch: false };
      }
      if (
        userLevel === 'Senior' &&
        (jobLevel === 'Intern' ||
          titleLower.includes('intern') ||
          titleLower.includes('trainee'))
      ) {
        return { matchScore: 0, matchHighlights: [], isPreferenceMatch: false };
      }

      if (jobLevel) {
        if (userLevel.toLowerCase() === jobLevel.toLowerCase()) {
          score += 10;
        } else if (
          (userLevel === 'Junior' &&
            (jobLevel === 'Fresher' || jobLevel === 'Junior')) ||
          (userLevel === 'Mid' &&
            (jobLevel === 'Junior' || jobLevel === 'Mid')) ||
          (userLevel === 'Senior' &&
            (jobLevel === 'Mid' || jobLevel === 'Senior'))
        ) {
          score += 8;
        }
      } else {
        score += 5;
      }
    } else {
      score += 5;
    }

    // 5. Salary Match
    if (filters.minSalary) {
      let userMin = parseFloat(
        filters.minSalary.toString().replace(/[^0-9.]/g, ''),
      );
      if (!isNaN(userMin) && userMin > 0) {
        if (userMin < 100) {
          userMin = userMin * 100000;
        }

        const jobEffectiveSalary = job.salaryMax || job.salaryMin;
        if (jobEffectiveSalary) {
          if (jobEffectiveSalary < userMin) {
            return {
              matchScore: 0,
              matchHighlights: [],
              isPreferenceMatch: false,
            };
          }
          score += 10;
          highlights.push('Salary Match');
        } else {
          score += 5;
        }
      }
    } else {
      score += 5;
    }

    const finalScore = Math.min(100, Math.max(0, score));

    return {
      matchScore: finalScore,
      matchHighlights: Array.from(new Set(highlights)),
      isPreferenceMatch: true,
    };
  }

  private normalizeQueryLocation(loc: string): string {
    const clean = (loc || '').toLowerCase().trim();
    if (!clean) return '';

    if (
      clean.includes('thiruvananthapuram') ||
      clean.includes('thiruvanthapuram') ||
      clean === 'tvm' ||
      clean === 'trivandrum'
    ) {
      return 'Trivandrum|Thiruvananthapuram|Thiruvanthapuram|TVM';
    }
    if (clean === 'kochi' || clean === 'cochin' || clean === 'ernakulam') {
      return 'Kochi|Cochin|Ernakulam';
    }
    if (clean === 'bengaluru' || clean === 'bangalore' || clean === 'blr') {
      return 'Bengaluru|Bangalore';
    }
    return this.escapeRegex(loc.trim());
  }

  private escapeRegex(text: string): string {
    return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
  }

  private detectExperienceLevel(title: string, description: string): string {
    const titleLower = title.toLowerCase();
    if (titleLower.includes('intern') || titleLower.includes('internship'))
      return 'Intern';
    if (
      titleLower.includes('junior') ||
      titleLower.includes('entry level') ||
      titleLower.includes('fresher')
    )
      return 'Junior';
    if (
      titleLower.includes('senior') ||
      titleLower.includes('lead') ||
      titleLower.includes('principal') ||
      titleLower.includes('staff') ||
      titleLower.includes('director')
    )
      return 'Senior';
    if (titleLower.includes('mid') || titleLower.includes('intermediate'))
      return 'Mid';

    const descLower = description.toLowerCase();
    if (descLower.includes('fresher') || descLower.includes('entry level'))
      return 'Junior';

    const expRegex = /(\d+)\+?\s*(?:-\s*\d+)?\s*years?\s+(?:of\s+)?experience/i;
    const match = descLower.match(expRegex);
    if (match) {
      const years = parseInt(match[1], 10);
      if (years >= 5) return 'Senior';
      if (years >= 2) return 'Mid';
      return 'Junior';
    }

    return 'Mid';
  }

  private detectWorkType(
    location: string,
    description: string,
  ): 'Remote' | 'Hybrid' | 'Onsite' {
    const loc = location.toLowerCase();
    const desc = description.toLowerCase();
    if (loc.includes('remote') || desc.includes('remote')) return 'Remote';
    if (loc.includes('hybrid') || desc.includes('hybrid')) return 'Hybrid';
    return 'Onsite';
  }

  private parseSalary(
    salaryString: string,
  ): { min: number; max: number } | null {
    if (!salaryString) return null;
    const cleaned = salaryString.replace(/,/g, '').toLowerCase();

    const isHourly =
      cleaned.includes('/hr') ||
      cleaned.includes('hour') ||
      cleaned.includes('per hour');
    const isMonthly =
      cleaned.includes('/mo') ||
      cleaned.includes('month') ||
      cleaned.includes('per month');
    const isLakhs =
      cleaned.includes('lpa') ||
      cleaned.includes('lac') ||
      cleaned.includes('lakh');

    const numbers = cleaned.match(/\d+(\.\d+)?/g);
    if (!numbers || numbers.length === 0) return null;

    let min = parseFloat(numbers[0]);
    let max = numbers.length > 1 ? parseFloat(numbers[1]) : min;

    // Convert hourly to annual assuming 40h/wk, 52wk/yr (2080 hours)
    if (isHourly) {
      min = min * 2080;
      max = max * 2080;
    } else if (isMonthly) {
      min = min * 12;
      max = max * 12;
    } else if (isLakhs) {
      // e.g. "3 - 8 LPA" -> min: 300,000, max: 800,000
      if (min < 1000) {
        min = Math.round(min * 100000);
        max = Math.round(max * 100000);
      }
    } else if (cleaned.includes('k')) {
      min = Math.round(min * 1000);
      max = Math.round(max * 1000);
    } else if (min < 1000 && min > 0) {
      // Default small values to thousands (k)
      min = Math.round(min * 1000);
      max = Math.round(max * 1000);
    }

    return { min: Math.round(min), max: Math.round(max) };
  }
}
