import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import { Job } from '../schemas/job.schema';
import { JobMatch } from '../schemas/job-match.schema';
import { User } from '../schemas/user.schema';
import { SystemConfig } from '../schemas/system-config.schema';
import { Resume } from '../schemas/resume.schema';
import { Application } from '../schemas/application.schema';
import { QueueService } from '../queue/queue.service';
import { SystemConfigService } from '../system-config/system-config.service';

interface CompanyConfig {
  name: string;
  ats: 'greenhouse' | 'lever' | 'ashby';
  slug: string;
  website: string;
}

@Injectable()
export class JobService implements OnModuleInit {
  private adzunaCache: { data: any; timestamp: number } | null = null;
  private jSearchCache: { data: any; timestamp: number } | null = null;
  private careerjetCache: { data: any; timestamp: number } | null = null;
  private companiesConfig: any[] = [];

  constructor(
    @InjectModel(Job.name) private jobModel: Model<Job>,
    @InjectModel(JobMatch.name) private matchModel: Model<JobMatch>,
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(SystemConfig.name) private configModel: Model<SystemConfig>,
    @InjectModel(Resume.name) private resumeModel: Model<Resume>,
    @InjectModel(Application.name) private applicationModel: Model<Application>,
    private queueService: QueueService,
    private configService: SystemConfigService,
  ) {}

  async onModuleInit() {
    await this.loadCompaniesConfig();
    this.queueService.registerGlobalCrawlProcessor(
      async () => this.crawlGlobalJobs(),
      async () => this.validateCompanyConfig(),
    );
  }

  /**
   * Load companies config from database
   */
  private async loadCompaniesConfig() {
    try {
      const scripts: any[] = [];
      if (scripts && scripts.length > 0) {
        this.companiesConfig = scripts.map((s) => s.config);
        console.log(
          `[JobService] Loaded ${this.companiesConfig.length} active ATS companies from DB.`,
        );
      } else {
        console.warn('[JobService] No active ATS scripts found in database.');
      }
    } catch (err) {
      console.error('[JobService] Failed to load ATS scripts from DB:', err);
    }
  }

  /**
   * Update or create a user profile with filters
   */
  async updateFilters(
    userId: string,
    email: string,
    filters: any,
  ): Promise<User> {
    let user = await this.userModel
      .findOne({ $or: [{ clerkId: userId }, { email }] })
      .exec();
    if (!user) {
      user = new this.userModel({ clerkId: userId, email, filters: {} });
    }
    const currentFilters = user.get('filters')
      ? JSON.parse(JSON.stringify(user.get('filters')))
      : {};
    user.set('filters', { ...currentFilters, ...filters });
    user.markModified('filters');
    const saved = await user.save();

    // Trigger an asynchronous crawl for newly updated user preferences so fresh jobs are ready
    this.crawlGlobalJobs().catch((e) =>
      console.error('[JobService] Auto-crawl on filter update failed:', e),
    );

    return saved;
  }

  async getUser(userId: string): Promise<User | null> {
    return this.userModel
      .findOne({ $or: [{ clerkId: userId }, { email: userId }] })
      .exec();
  }

  /**
   * Find jobs matching user filters and attach their AI matches if existing.
   * Strictly filters jobs based on user role, location, work type, experience, and salary preference criteria.
   */
  async getDashboardJobs(userId: string): Promise<any[]> {
    const user = await this.userModel
      .findOne({ $or: [{ clerkId: userId }, { email: userId }] })
      .exec();

    // If the user hasn't set up any job preferences, do not return random global jobs
    const filters = user?.filters;
    if (!user || !filters) {
      return [];
    }

    const {
      workTypes,
      minSalary,
      countries,
      experienceLevel,
      targetRoles,
      targetJobRole,
    } = filters;

    // 1. Parse Roles
    let rawRoles: string[] = [];
    if (Array.isArray(targetRoles) && targetRoles.length > 0) {
      rawRoles = targetRoles.flatMap((r: any) =>
        typeof r === 'string' ? r.split(',').map((s) => s.trim()) : [],
      );
    }
    if (targetJobRole && typeof targetJobRole === 'string') {
      rawRoles.push(...targetJobRole.split(',').map((s) => s.trim()));
    }
    const cleanRoles = Array.from(new Set(rawRoles.filter(Boolean)));

    // 2. Parse Locations
    let rawCountries: string[] = [];
    if (Array.isArray(countries) && countries.length > 0) {
      rawCountries = countries.flatMap((c: any) =>
        typeof c === 'string' ? c.split(',').map((s) => s.trim()) : [],
      );
    } else if (typeof countries === 'string' && countries) {
      rawCountries = (countries as string).split(',').map((s) => s.trim());
    }
    const cleanCountries = Array.from(new Set(rawCountries.filter(Boolean)));

    // 3. Parse Work Types
    const cleanWorkTypes = Array.isArray(workTypes)
      ? workTypes.filter(Boolean)
      : [];

    const hasPreferences =
      cleanRoles.length > 0 ||
      cleanCountries.length > 0 ||
      cleanWorkTypes.length > 0;
    if (!hasPreferences) {
      return [];
    }

    const andConditions: any[] = [];

    // Exclude jobs the user has already applied to or dismissed
    const appliedApps = await this.applicationModel
      .find({ userId })
      .select('jobId')
      .exec();
    const appliedJobIds = appliedApps.map((app) => app.jobId);

    const excludeIds: any[] = [...appliedJobIds];
    if (user.dismissedInternalJobs && user.dismissedInternalJobs.length > 0) {
      excludeIds.push(...user.dismissedInternalJobs);
    }

    if (excludeIds.length > 0) {
      andConditions.push({ _id: { $nin: excludeIds } });
    }

    // Freshness: Only show jobs created or posted in the last 14 days
    const fourteenDaysAgo = new Date();
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
    andConditions.push({
      $or: [
        { postedDate: { $gte: fourteenDaysAgo } },
        { postedDate: { $exists: false } },
        { postedDate: null },
        { createdAt: { $gte: fourteenDaysAgo } },
      ],
    });

    // 1. Target Roles & Synonym / Alias Expansion
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
    for (const role of cleanRoles) {
      const roleLower = role.toLowerCase().trim();
      if (!roleLower) continue;
      expandedRoles.add(roleLower);
      for (const [canonical, aliases] of Object.entries(roleAliasMap)) {
        if (
          roleLower.includes(canonical) ||
          canonical.includes(roleLower) ||
          aliases.some((a) => roleLower.includes(a) || a.includes(roleLower))
        ) {
          aliases.forEach((a) => expandedRoles.add(a));
          expandedRoles.add(canonical);
        }
      }
    }

    if (expandedRoles.size > 0) {
      const roleOr = Array.from(expandedRoles).map((r) => ({
        title: { $regex: new RegExp(this.escapeRegex(r), 'i') },
      }));
      andConditions.push({ $or: roleOr });
    }

    // 2. Work Types Handling
    const allowsRemote =
      cleanWorkTypes.includes('Remote') ||
      cleanCountries.some((c) => c.toLowerCase() === 'remote');
    const allowsHybrid = cleanWorkTypes.includes('Hybrid');
    const allowsOnsite = cleanWorkTypes.includes('Onsite');

    if (cleanWorkTypes.length > 0) {
      const workTypeOr: any[] = [];
      if (allowsRemote) {
        workTypeOr.push({ workType: 'Remote' });
        workTypeOr.push({ location: { $regex: /remote/i } });
        workTypeOr.push({ title: { $regex: /remote/i } });
      }
      if (allowsHybrid) {
        workTypeOr.push({ workType: 'Hybrid' });
        workTypeOr.push({ location: { $regex: /hybrid/i } });
        workTypeOr.push({ title: { $regex: /hybrid/i } });
      }
      if (allowsOnsite) {
        workTypeOr.push({ workType: 'Onsite' });
        workTypeOr.push({
          $and: [
            { workType: { $nin: ['Remote', 'remote'] } },
            { location: { $not: { $regex: /remote/i } } },
          ],
        });
      }
      if (workTypeOr.length > 0) {
        andConditions.push({ $or: workTypeOr });
      }
    }

    // 3. Locations Extraction & Matching
    const nonRemoteCountries = cleanCountries.filter(
      (c) => c.toLowerCase() !== 'remote',
    );
    if (nonRemoteCountries.length > 0) {
      const locationConditions: any[] = [];
      for (const c of nonRemoteCountries) {
        const norm = this.normalizeQueryLocation(c);
        if (norm) {
          locationConditions.push({
            location: { $regex: new RegExp(norm, 'i') },
          });
        }
      }

      if (allowsRemote) {
        locationConditions.push({ workType: 'Remote' });
        locationConditions.push({ location: { $regex: /remote/i } });
      }

      if (locationConditions.length > 0) {
        andConditions.push({ $or: locationConditions });
      }
    } else if (cleanCountries.length > 0 && !allowsRemote) {
      const locationConditions = cleanCountries.map((c) => ({
        location: { $regex: new RegExp(this.normalizeQueryLocation(c), 'i') },
      }));
      andConditions.push({ $or: locationConditions });
    }

    // 4. Minimum Salary
    if (minSalary && minSalary > 0) {
      let threshold =
        typeof minSalary === 'number'
          ? minSalary
          : parseFloat(String(minSalary).replace(/[^0-9.]/g, ''));
      if (!isNaN(threshold) && threshold > 0) {
        if (threshold < 100) threshold = threshold * 100000;
        andConditions.push({
          $or: [
            { salaryMax: { $gte: threshold } },
            { salaryMin: { $gte: threshold } },
            { salaryMin: { $exists: false } },
            { salaryMin: null },
          ],
        });
      }
    }

    // 5. Experience Level
    let forbiddenTitleRegex: RegExp | null = null;
    if (experienceLevel) {
      let allowedLevels = [experienceLevel];
      let maxAllowedYears = 99;

      if (experienceLevel === 'Fresher') {
        allowedLevels = ['Fresher', 'Junior', 'Intern'];
        maxAllowedYears = 1;
        forbiddenTitleRegex =
          /\b(senior|sr\.?|lead|principal|staff|architect|director|head|vp|manager|specialist|expert)\b/i;
      } else if (experienceLevel === 'Junior') {
        allowedLevels = ['Fresher', 'Junior', 'Intern'];
        maxAllowedYears = 3;
        forbiddenTitleRegex =
          /\b(senior|sr\.?|lead|principal|staff|architect|director|head|vp)\b/i;
      } else if (experienceLevel === 'Mid') {
        allowedLevels = ['Fresher', 'Junior', 'Intern', 'Mid'];
        maxAllowedYears = 5;
        forbiddenTitleRegex = /\b(principal|director|head of|vp)\b/i;
      } else if (experienceLevel === 'Senior') {
        allowedLevels = ['Senior', 'Mid', 'Lead', 'Principal', 'Staff'];
        maxAllowedYears = 99;
      }

      const expConditions: any[] = [
        {
          $or: [
            { experienceLevel: { $in: allowedLevels } },
            { experienceLevel: { $exists: false } },
            { experienceLevel: null },
          ],
        },
        {
          $or: [
            { requiredExperienceYears: { $lte: maxAllowedYears } },
            { requiredExperienceYears: { $exists: false } },
            { requiredExperienceYears: null },
          ],
        },
      ];

      if (forbiddenTitleRegex) {
        expConditions.push({
          title: { $not: { $regex: forbiddenTitleRegex } },
        });
      }

      andConditions.push({ $and: expConditions });
    }

    const strictQuery = {
      isClosed: { $ne: true },
      $and: andConditions,
    };

    const rawJobs = await this.jobModel
      .find(strictQuery)
      .sort({ createdAt: -1, postedDate: -1 })
      .limit(100)
      .exec();

    // In-memory double-check to eliminate edge case false positives
    const jobs = rawJobs
      .filter((job) => {
        const titleLower = (job.title || '').toLowerCase();
        const locLower = (job.location || '').toLowerCase();
        const jobWorkType =
          job.workType ||
          (locLower.includes('remote') || titleLower.includes('remote')
            ? 'Remote'
            : locLower.includes('hybrid')
              ? 'Hybrid'
              : 'Onsite');
        const isJobRemote =
          jobWorkType === 'Remote' ||
          locLower.includes('remote') ||
          titleLower.includes('remote');

        // 1. Role match
        if (expandedRoles.size > 0) {
          let roleMatched = false;
          for (const r of expandedRoles) {
            if (
              titleLower.includes(r) ||
              new RegExp(`\\b${this.escapeRegex(r)}\\b`, 'i').test(titleLower)
            ) {
              roleMatched = true;
              break;
            }
          }
          if (!roleMatched) return false;
        }

        // 2. Work type match
        if (cleanWorkTypes.length > 0) {
          if (!allowsRemote && isJobRemote) return false;
          if (!allowsHybrid && jobWorkType === 'Hybrid') return false;
          if (!allowsOnsite && !isJobRemote && jobWorkType !== 'Hybrid')
            return false;
        }

        // 3. Location match
        if (nonRemoteCountries.length > 0 && !isJobRemote) {
          let locMatched = false;
          for (const c of nonRemoteCountries) {
            const norm = this.normalizeQueryLocation(c);
            if (norm && new RegExp(norm, 'i').test(locLower)) {
              locMatched = true;
              break;
            }
          }
          if (!locMatched) return false;
        }

        // 4. Experience match
        if (forbiddenTitleRegex && forbiddenTitleRegex.test(titleLower)) {
          return false;
        }

        return true;
      })
      .slice(0, 50);

    // Find all match score records for this user
    const matches = await this.matchModel.find({ userId }).exec();
    const matchMap = new Map<string, JobMatch>();
    for (const match of matches) {
      matchMap.set(match.jobId.toString(), match);
    }

    const now = Date.now();
    const scoredJobs = jobs.map((job) => {
      const jobIdStr = String((job as any)._id || (job as any).id);
      const match = matchMap.get(jobIdStr);
      const jobObj =
        typeof (job as any).toObject === 'function'
          ? (job as any).toObject()
          : { ...job };
      jobObj.isNew = jobObj.createdAt
        ? now - new Date(jobObj.createdAt).getTime() < 24 * 60 * 60 * 1000
        : false;

      return {
        job: jobObj,
        match: match
          ? {
              matchScore: match.matchScore,
              recommendation: match.recommendation,
              reasoning: match.reasoning,
              pros: match.pros,
              cons: match.cons,
              missingSkills: match.missingSkills,
              decisionScore: match.decisionScore,
            }
          : null,
      };
    });

    return scoredJobs;
  }

  /**
   * Request manual AI matching evaluation for a specific job
   */
  async requestJobMatch(userId: string, jobId: string): Promise<any> {
    const job = await this.jobModel.findById(jobId).exec();
    if (!job) {
      throw new NotFoundException(
        'This job is no longer active or was removed by the employer.',
      );
    }

    // Trigger AI Match background job
    await this.queueService.addJobMatchJob(userId, jobId);

    return { message: 'AI Job Match evaluation triggered.' };
  }

  /**
   * Create a job (used for manual insertion)
   */
  async createJob(jobData: any): Promise<Job> {
    const job = new this.jobModel(jobData);
    return job.save();
  }

  async getIntegrationStatuses(): Promise<any[]> {
    const adzunaId = await this.configModel
      .findOne({ key: 'ADZUNA_API_ID' })
      .exec();
    const adzunaKey = await this.configModel
      .findOne({ key: 'ADZUNA_API_KEY' })
      .exec();
    const jsearchKey = await this.configModel
      .findOne({ key: 'JSEARCH_API_KEY' })
      .exec();
    const joobleKey = await this.configModel
      .findOne({ key: 'JOOBLE_API_KEY' })
      .exec();
    const careerjetKey = await this.configModel
      .findOne({ key: 'CAREERJET_API_KEY' })
      .exec();

    return [
      // Direct ATS — only platforms with actual fetch implementations
      {
        name: 'Greenhouse',
        type: 'Direct ATS',
        active: true,
        desc: 'Polls Greenhouse public company job boards',
      },
      {
        name: 'Lever',
        type: 'Direct ATS',
        active: true,
        desc: 'Polls Lever public company job boards',
      },
      {
        name: 'Ashby',
        type: 'Direct ATS',
        active: true,
        desc: 'Polls Ashby public company job boards',
      },
      {
        name: 'Workable',
        type: 'Direct ATS',
        active: true,
        desc: 'Polls Workable public company job boards',
      },
      {
        name: 'SmartRecruiters',
        type: 'Direct ATS',
        active: true,
        desc: 'Polls SmartRecruiters enterprise job boards',
      },
      {
        name: 'Recruitee',
        type: 'Direct ATS',
        active: true,
        desc: 'Polls Recruitee public company job boards',
      },
      {
        name: 'Teamtailor',
        type: 'Direct ATS',
        active: true,
        desc: 'Polls Teamtailor public company job boards',
      },
      // Aggregator APIs — conditional on API keys being configured
      {
        name: 'Adzuna',
        type: 'Aggregator API',
        active: !!(adzunaId?.value && adzunaKey?.value),
        desc: 'API search aggregator matching user cities',
      },
      {
        name: 'JSearch',
        type: 'Aggregator API',
        active: !!jsearchKey?.value,
        desc: 'RapidAPI job search engine for keyword search',
      },
      {
        name: 'Jooble',
        type: 'Aggregator API',
        active: !!joobleKey?.value,
        desc: 'Jooble job aggregator API search',
      },
      {
        name: 'Careerjet',
        type: 'Aggregator API',
        active: !!careerjetKey?.value,
        desc: 'Careerjet global job search aggregator',
      },
      // Remote Feeds — free public APIs, always active
      {
        name: 'Remote OK',
        type: 'Remote Feed',
        active: true,
        desc: 'Fetches Remote OK public JSON job feeds',
      },
      {
        name: 'Remotive',
        type: 'Remote Feed',
        active: true,
        desc: 'Fetches Remotive public API job postings',
      },
      {
        name: 'Jobicy',
        type: 'Remote Feed',
        active: true,
        desc: 'Fetches Jobicy public remote jobs API',
      },
      {
        name: 'We Work Remotely',
        type: 'Remote Feed',
        active: true,
        desc: 'Fetches WWR remote job listings via RSS',
      },
      {
        name: 'Himalayas',
        type: 'Remote Feed',
        active: true,
        desc: 'Fetches Himalayas remote developer jobs feed',
      },
    ];
  }

  /**
   * Build combinations of target roles and target locations dynamically from user preferences and resume data.
   */
  private async getGlobalCrawlQueries(): Promise<
    { role: string; location: string }[]
  > {
    const users = await this.userModel.find({}, { filters: 1 }).lean().exec();
    const queryPairs = new Map<string, { role: string; location: string }>();

    for (const user of users) {
      const filters = user.filters as any;

      const userRoles: string[] = [];
      const filterRoles =
        filters?.targetRoles ||
        (filters?.targetJobRole ? filters.targetJobRole.split(',') : []);
      for (const r of filterRoles) {
        if (typeof r === 'string' && r.trim()) userRoles.push(r.trim());
      }
      if (userRoles.length === 0) {
        userRoles.push('Software Developer');
      }

      const userLocations: string[] = [];
      for (const l of filters?.countries || []) {
        if (typeof l === 'string' && l.trim()) userLocations.push(l.trim());
      }
      if (userLocations.length === 0) {
        userLocations.push('India');
      }

      for (const role of userRoles) {
        for (const location of userLocations) {
          const key = `${role.toLowerCase()}|${location.toLowerCase()}`;
          queryPairs.set(key, { role, location });
        }
      }
    }

    const list = [...queryPairs.values()];
    if (list.length === 0) {
      list.push({ role: 'Software Developer', location: 'India' });
    }
    return list.slice(0, 30);
  }

  /**
   * Helper to strip HTML tags from string to protect LLM context & index matching
   */
  private stripHtml(html: string): string {
    if (!html) return '';
    let text = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

    // Add newlines for block elements to preserve formatting
    text = text.replace(/<\/?(div|p|br|li|h[1-6])[^>]*>/gi, '\n');

    // Remove all remaining HTML tags
    text = text.replace(/<[^>]*>/g, '');

    // Decode common HTML entities
    text = text
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/&rsquo;/g, "'")
      .replace(/&lsquo;/g, "'")
      .replace(/&rdquo;/g, '"')
      .replace(/&ldquo;/g, '"')
      .replace(/&ndash;/g, '-')
      .replace(/&mdash;/g, '-');

    // Clean up excessive whitespace but preserve paragraph breaks
    text = text.replace(/[ \t]+/g, ' '); // collapse horizontal whitespace
    text = text.replace(/\n\s*\n+/g, '\n\n'); // collapse multiple newlines to max 2

    return text.trim();
  }

  private detectSource(url: string, publisherName?: string): string {
    const lowerUrl = (url || '').toLowerCase();
    const lowerPub = (publisherName || '').toLowerCase();

    if (
      lowerUrl.includes('greenhouse.io') ||
      lowerUrl.includes('boards.greenhouse')
    )
      return 'Greenhouse';
    if (lowerUrl.includes('lever.co') || lowerUrl.includes('jobs.lever'))
      return 'Lever';
    if (lowerUrl.includes('ashbyhq.com')) return 'Ashby';
    if (lowerUrl.includes('rippling.com')) return 'Rippling';
    if (lowerUrl.includes('workday.com') || lowerUrl.includes('myworkday'))
      return 'Workday';
    if (lowerUrl.includes('linkedin.com')) return 'LinkedIn';
    if (lowerUrl.includes('indeed.com')) return 'Indeed';
    if (lowerUrl.includes('naukri.com')) return 'Naukri';
    if (lowerPub.includes('greenhouse')) return 'Greenhouse';
    if (lowerPub.includes('lever')) return 'Lever';
    if (lowerPub.includes('ashby')) return 'Ashby';
    if (lowerPub.includes('workday')) return 'Workday';

    return 'JSearch';
  }

  private detectExperienceLevel(
    title: string,
    description: string,
    seniorityHint?: string,
    yearsRequired?: number,
  ): string {
    // 1. If years required is explicitly set, use it first
    if (yearsRequired !== undefined && yearsRequired !== null) {
      if (yearsRequired <= 1) {
        return title.toLowerCase().includes('intern') ? 'Intern' : 'Junior';
      }
      if (yearsRequired >= 5) {
        return 'Senior';
      }
      return 'Mid';
    }

    // 2. Direct seniority hint
    if (seniorityHint) {
      const hint = seniorityHint.toLowerCase();
      if (hint.includes('intern')) return 'Intern';
      if (
        hint.includes('entry') ||
        hint.includes('junior') ||
        hint.includes('fresher')
      )
        return 'Junior';
      if (hint.includes('mid') || hint.includes('intermediate')) return 'Mid';
      if (
        hint.includes('senior') ||
        hint.includes('lead') ||
        hint.includes('principal') ||
        hint.includes('staff') ||
        hint.includes('architect') ||
        hint.includes('director')
      )
        return 'Senior';
    }

    // 3. Match title keywords strictly
    const titleLower = title.toLowerCase();
    if (titleLower.includes('intern') || titleLower.includes('internship'))
      return 'Intern';
    if (
      titleLower.includes('junior') ||
      titleLower.includes('entry level') ||
      titleLower.includes('fresher') ||
      titleLower.includes('associate') ||
      titleLower.includes('trainee')
    )
      return 'Junior';
    if (
      titleLower.includes('senior') ||
      titleLower.includes('lead') ||
      titleLower.includes('principal') ||
      titleLower.includes('staff') ||
      titleLower.includes('sr.') ||
      titleLower.includes('director') ||
      titleLower.includes('architect') ||
      titleLower.includes('manager')
    )
      return 'Senior';
    if (titleLower.includes('mid') || titleLower.includes('intermediate'))
      return 'Mid';

    // 4. Description fallback matching using strict patterns to avoid general mentions
    const descLower = description.toLowerCase();
    if (descLower.includes('fresher') || descLower.includes('entry level'))
      return 'Junior';

    // Check if description has "X years of experience" patterns
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
    isRemote: boolean | null,
    workArrangement?: string,
  ): 'Remote' | 'Hybrid' | 'Onsite' {
    if (isRemote === true) return 'Remote';
    const wa = (workArrangement || '').toLowerCase();
    if (wa.includes('remote')) return 'Remote';
    if (wa.includes('hybrid')) return 'Hybrid';
    return 'Onsite';
  }

  /**
   * Main search and crawl pipeline:
   * 1. Pull jobs directly from Greenhouse, Lever, and Ashby configs.
   * 2. Search aggregator APIs (JSearch, Adzuna).
   * 3. Normalize all jobs and store in the global pool.
   * 4. Auto-detect closed/expired roles.
   */
  private getCountryForCrawl(location: string): {
    countryCode: string;
    countryName: string;
  } {
    const lower = (location || '').toLowerCase();
    if (
      lower.includes('united states') ||
      lower.includes('us') ||
      lower.includes('usa') ||
      lower.includes('america') ||
      lower.includes('ny') ||
      lower.includes('ca')
    ) {
      return { countryCode: 'us', countryName: 'United States' };
    }
    if (
      lower.includes('united kingdom') ||
      lower.includes('uk') ||
      lower.includes('gb') ||
      lower.includes('london')
    ) {
      return { countryCode: 'gb', countryName: 'United Kingdom' };
    }
    if (lower.includes('canada') || lower.includes('ca')) {
      return { countryCode: 'ca', countryName: 'Canada' };
    }
    if (lower.includes('germany') || lower.includes('de')) {
      return { countryCode: 'de', countryName: 'Germany' };
    }
    return { countryCode: 'in', countryName: 'India' };
  }

  private async checkQuotaAndIncrement(
    apiName: string,
    limit: number,
  ): Promise<boolean> {
    try {
      const todayStr = new Date().toISOString().split('T')[0];
      const dbKey = `${apiName}_CALL_COUNT_${todayStr}`;
      let config = await this.configModel.findOne({ key: dbKey }).exec();
      if (!config) {
        config = new this.configModel({
          key: dbKey,
          value: '0',
          description: `API count check for ${apiName} on ${todayStr}`,
        });
      }
      const current = parseInt(config.value || '0', 10);
      if (current >= limit) {
        console.warn(
          `[JobService] Persistent quota limit reached for ${apiName}: ${current}/${limit}`,
        );
        await this.configService.logApiCall(
          apiName,
          'REST-API',
          'failed',
          `Quota limit reached: ${current}/${limit}`,
        );
        return false;
      }
      config.value = (current + 1).toString();
      await config.save();
      await this.configService.logApiCall(apiName, 'REST-API', 'success');
      return true;
    } catch (err: any) {
      console.error('[JobService] Failed checking persistent API quota:', err);
      await this.configService.logApiCall(
        apiName,
        'REST-API',
        'failed',
        err.message || String(err),
      );
      return true; // fail open to not crash crawl completely
    }
  }

  async crawlGlobalJobs(): Promise<void> {
    console.log('[JobService] Starting scheduled global crawl.');

    // 1. Direct ATS company board polling
    await this.pollAllAts();

    // 2. Aggregator crawl uses the combined preference coverage of all users,
    // while the dashboard remains a read-only personalized database query.
    const combinations = await this.getGlobalCrawlQueries();
    const jsearchKey = await this.configModel
      .findOne({ key: 'JSEARCH_API_KEY' })
      .exec();
    const adzunaId = await this.configModel
      .findOne({ key: 'ADZUNA_API_ID' })
      .exec();
    const adzunaKey = await this.configModel
      .findOne({ key: 'ADZUNA_API_KEY' })
      .exec();
    const joobleKey = await this.configModel
      .findOne({ key: 'JOOBLE_API_KEY' })
      .exec();
    const careerjetKey = await this.configModel
      .findOne({ key: 'CAREERJET_API_KEY' })
      .exec();

    // 1.5 Remote Feeds
    await this.fetchRemoteFeeds();

    for (const combo of combinations) {
      await this.crawlSingleRoleLocation(
        combo.role,
        combo.location,
        jsearchKey,
        adzunaId,
        adzunaKey,
        joobleKey,
        careerjetKey,
      );
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private async crawlSingleRoleLocation(
    role: string,
    location: string,
    jsearchKey: any,
    adzunaId: any,
    adzunaKey: any,
    joobleKey: any,
    careerjetKey: any,
  ): Promise<void> {
    const targetCountry = this.getCountryForCrawl(location);

    // JSearch Aggregator Crawl (paginated, max 2 pages, limit 15 calls/day)
    if (jsearchKey?.value) {
      const crawlStart = new Date();
      let jsearchJobs: any[] = [];
      let crawlStatus = 'success';
      let errorMsg = '';

      try {
        // Step 1: Try exact city query
        for (let page = 1; page <= 2; page++) {
          const quotaOk = await this.checkQuotaAndIncrement('JSEARCH', 15);
          if (!quotaOk) break;

          const query = `${role} in ${location}`;
          const url = `https://jsearch.p.rapidapi.com/search-v2?query=${encodeURIComponent(query)}&num_pages=1&page=${page}`;
          console.log(
            `[JobService] Querying JSearch-v2 page ${page} (city: ${location}): "${query}"`,
          );
          try {
            const response = await this.fetchWithTimeout(url, {
              headers: {
                'X-RapidAPI-Key': jsearchKey.value,
                'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
              },
            });
            if (response.ok) {
              const result = await response.json();
              const pageJobs = result.data?.jobs || [];
              if (pageJobs.length === 0) break;
              jsearchJobs = jsearchJobs.concat(pageJobs);
            } else {
              break;
            }
          } catch (err) {
            console.error('[JobService] JSearch city fetch failed:', err);
            break;
          }
        }

        // Step 2: Fall back to country-wide search if exact city returned 0 jobs
        if (jsearchJobs.length === 0) {
          console.log(
            `[JobService] No JSearch results for "${role}" in city "${location}". Falling back to country "${targetCountry.countryName}"`,
          );
          for (let page = 1; page <= 2; page++) {
            const quotaOk = await this.checkQuotaAndIncrement('JSEARCH', 15);
            if (!quotaOk) break;

            const query = `${role} in ${targetCountry.countryName}`;
            const url = `https://jsearch.p.rapidapi.com/search-v2?query=${encodeURIComponent(query)}&num_pages=1&page=${page}`;
            console.log(
              `[JobService] Querying JSearch-v2 page ${page} (country fallback): "${query}"`,
            );
            try {
              const response = await this.fetchWithTimeout(url, {
                headers: {
                  'X-RapidAPI-Key': jsearchKey.value,
                  'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
                },
              });
              if (response.ok) {
                const result = await response.json();
                const pageJobs = result.data?.jobs || [];
                if (pageJobs.length === 0) break;
                jsearchJobs = jsearchJobs.concat(pageJobs);
              } else {
                break;
              }
            } catch (err) {
              console.error(
                '[JobService] JSearch country fallback fetch failed:',
                err,
              );
              break;
            }
          }
        }
      } catch (err: any) {
        crawlStatus = 'failed';
        errorMsg = err.message || String(err);
      } finally {
        const crawlEnd = new Date();
        await this.configService.logCrawlRun(
          'JSearch',
          crawlStart,
          crawlEnd,
          crawlStatus,
          jsearchJobs.length,
          jsearchJobs.length,
          errorMsg || undefined,
        );
      }

      // Process all gathered JSearch jobs
      for (const aj of jsearchJobs) {
        // Validation: Check if the job is explicitly marked as closed or expired
        if (aj.job_is_closed === true) {
          console.log(`[JobService] Skipping closed job: ${aj.job_title}`);
          continue;
        }

        if (aj.job_offer_expiration_datetime_utc) {
          const expiryDate = new Date(aj.job_offer_expiration_datetime_utc);
          if (expiryDate < new Date()) {
            console.log(
              `[JobService] Skipping expired job: ${aj.job_title} (Expired: ${expiryDate.toISOString()})`,
            );
            continue;
          }
        } else if (aj.job_offer_expiration_timestamp) {
          const expiryDate = new Date(aj.job_offer_expiration_timestamp * 1000);
          if (expiryDate < new Date()) {
            console.log(
              `[JobService] Skipping expired job: ${aj.job_title} (Expired: ${expiryDate.toISOString()})`,
            );
            continue;
          }
        }

        const applyUrl = aj.job_apply_link || aj.job_google_link || '';
        const detectedSource = this.detectSource(applyUrl, aj.job_publisher);
        const workType = this.detectWorkType(
          aj.job_is_remote,
          aj.work_arrangement,
        );
        const expLevel = this.detectExperienceLevel(
          aj.job_title || '',
          aj.job_description || '',
          aj.seniority_level,
          aj.required_experience_years,
        );

        let salaryString: string | undefined;
        if (aj.job_min_salary && aj.job_max_salary) {
          const currency = aj.job_salary_period === 'YEAR' ? '$' : '$';
          const period =
            aj.job_salary_period === 'YEAR'
              ? '/yr'
              : `/${(aj.job_salary_period || 'year').toLowerCase()}`;
          salaryString = `${currency}${aj.job_min_salary.toLocaleString()} - ${currency}${aj.job_max_salary.toLocaleString()} ${period}`;
        }

        await this.ingestGlobalJob({
          title: aj.job_title || 'Untitled',
          company: aj.employer_name || 'Company',
          description: aj.job_description || '',
          url: applyUrl,
          source: detectedSource,
          location:
            aj.job_city && aj.job_country
              ? `${aj.job_city}, ${aj.job_country}`
              : aj.job_location || location,
          workType,
          salaryMin: aj.job_min_salary || undefined,
          salaryMax: aj.job_max_salary || undefined,
          salaryString,
          salaryCurrency: aj.job_salary_period ? 'USD' : undefined,
          salaryPeriod: aj.job_salary_period || undefined,
          companyUrl: aj.employer_website || undefined,
          applyUrl: aj.job_apply_link || undefined,
          companyLogoUrl: aj.employer_logo || undefined,
          requiredSkills: aj.required_technologies || [],
          preferredSkills: aj.preferred_technologies || [],
          experienceLevel: expLevel,
          requiredExperienceYears: aj.required_experience_years || undefined,
          employmentType: aj.job_employment_type || undefined,
          benefits: aj.benefits_extended || aj.job_benefits || [],
          postedDate: aj.job_posted_at_datetime_utc
            ? new Date(aj.job_posted_at_datetime_utc)
            : undefined,
        });
      }
    }

    // Adzuna Aggregator Crawl (paginated, max 2 pages, limit 50 calls/day)
    if (adzunaId?.value && adzunaKey?.value) {
      const crawlStart = new Date();
      const countryCode = targetCountry.countryCode;
      let adzunaJobs: any[] = [];
      let crawlStatus = 'success';
      let errorMsg = '';

      try {
        // Step 1: Try exact city query
        for (let page = 1; page <= 2; page++) {
          const quotaOk = await this.checkQuotaAndIncrement('ADZUNA', 50);
          if (!quotaOk) break;

          const queryRoleAndLoc = `${role} ${location}`;
          const url = `https://api.adzuna.com/v1/api/jobs/${countryCode}/search/${page}?app_id=${adzunaId.value}&app_key=${adzunaKey.value}&what=${encodeURIComponent(queryRoleAndLoc)}&results_per_page=20&content-type=application/json`;
          console.log(
            `[JobService] Querying Adzuna page ${page} (city: ${location}): "${queryRoleAndLoc}" in ${countryCode}`,
          );
          try {
            const response = await this.fetchWithTimeout(url);
            if (response.ok) {
              const result = await response.json();
              const pageJobs = result.results || [];
              if (pageJobs.length === 0) break;
              adzunaJobs = adzunaJobs.concat(pageJobs);
            } else {
              break;
            }
          } catch (err) {
            console.error('[JobService] Adzuna city fetch failed:', err);
            break;
          }
        }

        // Step 2: Fall back to country-wide query if exact city returned 0 jobs
        if (adzunaJobs.length === 0) {
          console.log(
            `[JobService] No Adzuna results for "${role}" in city "${location}". Falling back to country-wide: "${role}"`,
          );
          for (let page = 1; page <= 2; page++) {
            const quotaOk = await this.checkQuotaAndIncrement('ADZUNA', 50);
            if (!quotaOk) break;

            const url = `https://api.adzuna.com/v1/api/jobs/${countryCode}/search/${page}?app_id=${adzunaId.value}&app_key=${adzunaKey.value}&what=${encodeURIComponent(role)}&results_per_page=20&content-type=application/json`;
            console.log(
              `[JobService] Querying Adzuna page ${page} (country fallback): "${role}" in ${countryCode}`,
            );
            try {
              const response = await this.fetchWithTimeout(url);
              if (response.ok) {
                const result = await response.json();
                const pageJobs = result.results || [];
                if (pageJobs.length === 0) break;
                adzunaJobs = adzunaJobs.concat(pageJobs);
              } else {
                break;
              }
            } catch (err) {
              console.error(
                '[JobService] Adzuna country fallback fetch failed:',
                err,
              );
              break;
            }
          }
        }
      } catch (err: any) {
        crawlStatus = 'failed';
        errorMsg = err.message || String(err);
      } finally {
        const crawlEnd = new Date();
        await this.configService.logCrawlRun(
          'Adzuna',
          crawlStart,
          crawlEnd,
          crawlStatus,
          adzunaJobs.length,
          adzunaJobs.length,
          errorMsg || undefined,
        );
      }

      // Process all gathered Adzuna jobs
      for (const aj of adzunaJobs) {
        const jobUrl = aj.redirect_url || '';
        const detectedSource = this.detectSource(
          jobUrl,
          aj.company?.display_name,
        );
        const isRemote =
          aj.description?.toLowerCase().includes('remote') ||
          aj.title?.toLowerCase().includes('remote');
        const expLevel = this.detectExperienceLevel(
          aj.title || '',
          aj.description || '',
        );

        let salaryString: string | undefined;
        if (aj.salary_min && aj.salary_max) {
          salaryString = `₹${Math.round(aj.salary_min).toLocaleString()} - ₹${Math.round(aj.salary_max).toLocaleString()} /yr`;
        }

        await this.ingestGlobalJob({
          title: aj.title || 'Untitled',
          company: aj.company?.display_name || 'Company',
          description: aj.description || '',
          url: jobUrl,
          source: detectedSource,
          location: aj.location?.display_name || location,
          workType: isRemote ? 'Remote' : 'Onsite',
          salaryMin: aj.salary_min ? Math.round(aj.salary_min) : undefined,
          salaryMax: aj.salary_max ? Math.round(aj.salary_max) : undefined,
          salaryString,
          salaryCurrency: countryCode === 'in' ? 'INR' : 'USD',
          salaryPeriod: 'YEAR',
          companyUrl: undefined,
          applyUrl: jobUrl,
          requiredSkills: this.extractSkillsFromDescription(
            aj.description || '',
          ),
          experienceLevel: expLevel,
          postedDate: aj.created ? new Date(aj.created) : undefined,
        });
      }
    }

    // Jooble Aggregator Crawl
    if (joobleKey?.value) {
      const crawlStart = new Date();
      let joobleJobs: any[] = [];
      let crawlStatus = 'success';
      let errorMsg = '';
      try {
        const quotaOk = await this.checkQuotaAndIncrement('JOOBLE', 50);
        if (quotaOk) {
          console.log(
            `[JobService] Querying Jooble for "${role}" in "${location}"`,
          );
          const url = `https://jooble.org/api/${joobleKey.value}`;
          const response = await this.fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keywords: role, location, page: '1' }),
          });
          if (response.ok) {
            const result = await response.json();
            joobleJobs = result.jobs || [];
          }
        }
      } catch (err: any) {
        crawlStatus = 'failed';
        errorMsg = err.message || String(err);
      } finally {
        await this.configService.logCrawlRun(
          'Jooble',
          crawlStart,
          new Date(),
          crawlStatus,
          joobleJobs.length,
          joobleJobs.length,
          errorMsg || undefined,
        );
      }
      for (const jj of joobleJobs) {
        await this.ingestGlobalJob({
          title: jj.title || 'Untitled',
          company: jj.company || 'Company',
          description: jj.snippet || '',
          url: jj.link || '',
          source: 'Jooble',
          location: jj.location || location,
          workType: jj.location?.toLowerCase().includes('remote')
            ? 'Remote'
            : 'Onsite',
          salaryString: jj.salary || undefined,
          applyUrl: jj.link || undefined,
          postedDate: jj.updated ? new Date(jj.updated) : undefined,
        });
      }
    }

    // Careerjet Aggregator Crawl
    if (careerjetKey?.value) {
      const crawlStart = new Date();
      let careerjetJobs: any[] = [];
      let crawlStatus = 'success';
      let errorMsg = '';
      try {
        const quotaOk = await this.checkQuotaAndIncrement('CAREERJET', 50);
        if (quotaOk) {
          console.log(
            `[JobService] Querying Careerjet for "${role}" in "${location}"`,
          );
          const url = `https://search.api.careerjet.net/v4/query?keywords=${encodeURIComponent(role)}&location=${encodeURIComponent(location)}&locale_code=en_GB&user_ip=127.0.0.1&user_agent=AIJobCopilot/1.0`;
          const response = await this.fetchWithTimeout(url, {
            headers: {
              Authorization: `Basic ${Buffer.from(careerjetKey.value + ':').toString('base64')}`,
            },
          });
          if (response.ok) {
            const result = await response.json();
            careerjetJobs = result.jobs || [];
          }
        }
      } catch (err: any) {
        crawlStatus = 'failed';
        errorMsg = err.message || String(err);
      } finally {
        await this.configService.logCrawlRun(
          'Careerjet',
          crawlStart,
          new Date(),
          crawlStatus,
          careerjetJobs.length,
          careerjetJobs.length,
          errorMsg || undefined,
        );
      }
      for (const cj of careerjetJobs) {
        await this.ingestGlobalJob({
          title: cj.title || 'Untitled',
          company: cj.company || 'Company',
          description: cj.description || '',
          url: cj.url || '',
          source: 'Careerjet',
          location: cj.locations || location,
          workType: cj.locations?.toLowerCase().includes('remote')
            ? 'Remote'
            : 'Onsite',
          salaryString: cj.salary || undefined,
          applyUrl: cj.url || undefined,
          postedDate: cj.date ? new Date(cj.date) : undefined,
        });
      }
    }
  }

  /**
   * Poll direct Greenhouse, Lever, and Ashby APIs with error isolation & throttling
   */
  async pollAllAts(): Promise<void> {
    console.log(
      '[JobService] Starting direct ATS poll for configured companies.',
    );
    const results = await Promise.allSettled(
      this.companiesConfig.map((company) => this.pollCompanyAts(company)),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.error(
          `[JobService] Unhandled ATS poll failure for ${this.companiesConfig[index].name}:`,
          result.reason,
        );
      }
    });
  }

  async validateCompanyConfig(): Promise<void> {
    const failures: Array<{
      company: string;
      ats: string;
      slug: string;
      error: string;
    }> = [];
    for (const company of this.companiesConfig) {
      try {
        const jobs =
          company.ats === 'greenhouse'
            ? await this.fetchGreenhouseJobs(company.slug)
            : company.ats === 'lever'
              ? await this.fetchLeverJobs(company.slug)
              : company.ats === 'ashby'
                ? await this.fetchAshbyJobs(company.slug)
                : [];
        console.log(
          `[JobService] ATS validation passed: ${company.name} (${jobs.length} jobs).`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({
          company: company.name,
          ats: company.ats,
          slug: company.slug,
          error: message,
        });
        console.error(
          `[JobService] ATS validation failed: ${company.name} (${company.ats}/${company.slug}): ${message}`,
        );
      }
    }
    if (failures.length) {
      console.warn(
        `[JobService] Weekly ATS validation completed with ${failures.length} failing board(s).`,
        failures,
      );
    }
  }

  private async pollCompanyAts(company: CompanyConfig): Promise<void> {
    const startTime = new Date();
    const platform = company.ats.charAt(0).toUpperCase() + company.ats.slice(1);
    console.log(`[JobService] Polling ${company.name} (${company.ats})...`);
    const activeUrls: string[] = [];
    let jobsCount = 0;

    try {
      let rawJobs: any[] = [];
      if (company.ats === 'greenhouse') {
        rawJobs = await this.fetchGreenhouseJobs(company.slug);
        for (const rj of rawJobs) {
          const applyUrl = rj.absolute_url || '';
          if (applyUrl) activeUrls.push(applyUrl);

          const isRemote =
            rj.title?.toLowerCase().includes('remote') ||
            rj.content?.toLowerCase().includes('remote');
          const desc = this.stripHtml(rj.content || '');

          await this.ingestGlobalJob({
            title: rj.title,
            company: company.name,
            description: desc,
            url: applyUrl,
            source: 'Greenhouse',
            location: rj.location?.name || 'Remote',
            workType: isRemote ? 'Remote' : 'Onsite',
            companyUrl: company.website,
            applyUrl: applyUrl,
            experienceLevel: this.detectExperienceLevel(rj.title, desc),
            postedDate: rj.updated_at ? new Date(rj.updated_at) : undefined,
            applicationMethod: 'greenhouse_api',
            sourceAts: 'Greenhouse',
            companySlug: company.slug,
            greenhouseJobId: rj.id ? rj.id.toString() : undefined,
          });
        }
      } else if (company.ats === 'lever') {
        rawJobs = await this.fetchLeverJobs(company.slug);
        for (const rj of rawJobs) {
          const applyUrl = rj.hostedUrl || '';
          if (applyUrl) activeUrls.push(applyUrl);

          const commitment = rj.categories?.commitment?.toLowerCase() || '';
          const isRemote =
            commitment.includes('remote') ||
            rj.title?.toLowerCase().includes('remote') ||
            rj.description?.toLowerCase().includes('remote');
          const desc =
            this.stripHtml(rj.description || '') +
            ' ' +
            this.stripHtml(
              rj.lists?.map((l: any) => l.content).join(' ') || '',
            );

          await this.ingestGlobalJob({
            title: rj.title,
            company: company.name,
            description: desc,
            url: applyUrl,
            source: 'Lever',
            location: rj.categories?.location || 'Remote',
            workType: isRemote ? 'Remote' : 'Onsite',
            companyUrl: company.website,
            applyUrl: applyUrl,
            experienceLevel: this.detectExperienceLevel(rj.title, desc),
            postedDate: rj.createdAt ? new Date(rj.createdAt) : undefined,
            applicationMethod: 'manual_site',
            sourceAts: 'Lever',
            companySlug: company.slug,
          });
        }
      } else if (company.ats === 'ashby') {
        rawJobs = await this.fetchAshbyJobs(company.slug);
        for (const rj of rawJobs) {
          const applyUrl = rj.jobUrl || '';
          if (applyUrl) activeUrls.push(applyUrl);

          const isRemote =
            rj.location?.toLowerCase().includes('remote') ||
            rj.title?.toLowerCase().includes('remote');
          const desc = this.stripHtml(rj.descriptionHtml || '');

          await this.ingestGlobalJob({
            title: rj.title,
            company: company.name,
            description: desc,
            url: applyUrl,
            source: 'Ashby',
            location: rj.location || 'Remote',
            workType: isRemote ? 'Remote' : 'Onsite',
            companyUrl: company.website,
            applyUrl: applyUrl,
            experienceLevel: this.detectExperienceLevel(rj.title, desc),
            postedDate: rj.publishedAt ? new Date(rj.publishedAt) : undefined,
            applicationMethod: 'manual_site',
            sourceAts: 'Ashby',
            companySlug: company.slug,
          });
        }
      } else if (company.ats === 'workable') {
        rawJobs = await this.fetchWorkableJobs(company.slug);
        for (const rj of rawJobs) {
          const applyUrl = `https://apply.workable.com/${company.slug}/j/${rj.shortcode || ''}`;
          if (applyUrl) activeUrls.push(applyUrl);

          const loc = rj.location
            ? `${rj.location.city || ''}, ${rj.location.country || ''}`.replace(
                /^,\s*|,\s*$/g,
                '',
              )
            : '';
          const isRemote =
            rj.title?.toLowerCase().includes('remote') ||
            loc.toLowerCase().includes('remote');

          await this.ingestGlobalJob({
            title: rj.title,
            company: company.name,
            description: this.stripHtml(rj.description || ''),
            url: applyUrl,
            source: 'Workable',
            location: loc || 'Remote',
            workType: isRemote ? 'Remote' : 'Onsite',
            companyUrl: company.website,
            applyUrl: applyUrl,
            employmentType: rj.employment_type || undefined,
            experienceLevel: this.detectExperienceLevel(
              rj.title || '',
              rj.description || '',
            ),
            applicationMethod: 'manual_site',
            sourceAts: 'Workable',
            companySlug: company.slug,
          });
        }
      } else if (company.ats === 'smartrecruiters') {
        rawJobs = await this.fetchSmartRecruitersJobs(company.slug);
        for (const rj of rawJobs) {
          const applyUrl = `https://jobs.smartrecruiters.com/${company.slug}/${rj.id || ''}`;
          if (applyUrl) activeUrls.push(applyUrl);

          const loc = rj.location
            ? `${rj.location.city || ''}, ${rj.location.country || ''}`.replace(
                /^,\s*|,\s*$/g,
                '',
              )
            : '';
          const isRemote =
            rj.name?.toLowerCase().includes('remote') ||
            loc.toLowerCase().includes('remote');

          await this.ingestGlobalJob({
            title: rj.name,
            company: company.name,
            description: this.stripHtml(
              rj.jobAd?.sections?.jobDescription?.text || '',
            ),
            url: applyUrl,
            source: 'SmartRecruiters',
            location: loc || 'Remote',
            workType: isRemote ? 'Remote' : 'Onsite',
            companyUrl: company.website,
            applyUrl: applyUrl,
            experienceLevel: this.detectExperienceLevel(rj.name || '', ''),
            postedDate: rj.releasedDate ? new Date(rj.releasedDate) : undefined,
            applicationMethod: 'manual_site',
            sourceAts: 'SmartRecruiters',
            companySlug: company.slug,
          });
        }
      } else if (company.ats === 'recruitee') {
        rawJobs = await this.fetchRecruiteeJobs(company.slug);
        for (const rj of rawJobs) {
          const applyUrl = `https://${company.slug}.recruitee.com/o/${rj.slug || ''}`;
          if (applyUrl) activeUrls.push(applyUrl);

          const isRemote =
            rj.title?.toLowerCase().includes('remote') ||
            rj.location?.toLowerCase().includes('remote');
          const desc = this.stripHtml(rj.description || '');

          await this.ingestGlobalJob({
            title: rj.title,
            company: company.name,
            description: desc,
            url: applyUrl,
            source: 'Recruitee',
            location: rj.location || 'Remote',
            workType: isRemote ? 'Remote' : 'Onsite',
            companyUrl: company.website,
            applyUrl: applyUrl,
            experienceLevel: this.detectExperienceLevel(rj.title || '', desc),
            postedDate: rj.created_at ? new Date(rj.created_at) : undefined,
            applicationMethod: 'manual_site',
            sourceAts: 'Recruitee',
            companySlug: company.slug,
          });
        }
      } else if (company.ats === 'teamtailor') {
        rawJobs = await this.fetchTeamtailorJobs(company.slug);
        for (const rj of rawJobs) {
          const applyUrl =
            rj.links?.['careersite-job-url'] ||
            `https://${company.slug}.teamtailor.com/jobs/${rj.id || ''}`;
          if (applyUrl) activeUrls.push(applyUrl);

          const title = rj.attributes?.title || '';
          const isRemote = title.toLowerCase().includes('remote');
          const desc = this.stripHtml(rj.attributes?.body || '');

          await this.ingestGlobalJob({
            title: title,
            company: company.name,
            description: desc,
            url: applyUrl,
            source: 'Teamtailor',
            location: rj.attributes?.['locations-display-name'] || 'Remote',
            workType: isRemote ? 'Remote' : 'Onsite',
            companyUrl: company.website,
            applyUrl: applyUrl,
            experienceLevel: this.detectExperienceLevel(title, desc),
            postedDate: rj.attributes?.['created-at']
              ? new Date(rj.attributes['created-at'])
              : undefined,
            applicationMethod: 'manual_site',
            sourceAts: 'Teamtailor',
            companySlug: company.slug,
          });
        }
      } else {
        // Unknown or custom ATS: gracefully skip polling
        console.log(
          `[JobService] Skipping direct polling for ${company.name} (ATS: ${company.ats} not supported yet)`,
        );
      }

      jobsCount = rawJobs.length;

      // Close out any jobs from this specific company that were NOT in the latest pull
      if (activeUrls.length > 0) {
        const closeRes = await this.jobModel
          .deleteMany({
            company: company.name,
            source: company.ats.charAt(0).toUpperCase() + company.ats.slice(1),
            url: { $nin: activeUrls },
          })
          .exec();
        if (closeRes.deletedCount > 0) {
          console.log(
            `[JobService] Deleted ${closeRes.deletedCount} closed/expired jobs for ${company.name}`,
          );
        }
      }

      await this.configService.logCrawlRun(
        `${platform} - ${company.name}`,
        startTime,
        new Date(),
        'success',
        jobsCount,
        jobsCount,
      );
    } catch (err: any) {
      console.error(
        `[JobService] Direct API poll failed for company "${company.name}":`,
        err,
      );
      await this.configService.logCrawlRun(
        `${platform} - ${company.name}`,
        startTime,
        new Date(),
        'failed',
        0,
        0,
        err.message || String(err),
      );
    }
  }

  private async fetchWithTimeout(
    url: string,
    init?: RequestInit,
    timeoutMs = 15_000,
    maxRetries = 2,
  ): Promise<Response> {
    let lastError: any = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          ...init,
          signal: controller.signal,
        });
        if (response.ok || (response.status >= 400 && response.status < 500)) {
          // Return valid response (or client error like 404 which should not retry)
          return response;
        }
        // If 5xx server error, throw to trigger retry
        throw new Error(`HTTP Error ${response.status}: Server Error`);
      } catch (err: any) {
        lastError = err;
        if (attempt < maxRetries) {
          const backoff = Math.pow(2, attempt) * 500;
          await new Promise((resolve) => setTimeout(resolve, backoff));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw (
      lastError ||
      new Error(
        `Network request to ${url} failed after ${maxRetries + 1} attempts`,
      )
    );
  }

  private async fetchGreenhouseJobs(slug: string): Promise<any[]> {
    const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
    const response = await this.fetchWithTimeout(url);
    if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
    const data = await response.json();
    return data.jobs || [];
  }

  private async fetchLeverJobs(
    slug: string,
    offset = 0,
    limit = 100,
  ): Promise<any[]> {
    const url = `https://api.lever.co/v0/postings/${slug}?mode=json&limit=${limit}&offset=${offset}`;
    const response = await this.fetchWithTimeout(url);
    if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
    const data = await response.json();
    let jobs = data || [];

    // Lever pagination offset check
    if (jobs.length === limit) {
      const nextJobs = await this.fetchLeverJobs(slug, offset + limit, limit);
      jobs = jobs.concat(nextJobs);
    }
    return jobs;
  }

  private async fetchAshbyJobs(slug: string): Promise<any[]> {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
    const response = await this.fetchWithTimeout(url);
    if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
    const data = await response.json();
    return data.jobs || [];
  }

  private async fetchWorkableJobs(slug: string): Promise<any[]> {
    const url = `https://apply.workable.com/api/v3/accounts/${slug}/jobs`;
    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collection: 'jobs', token: null }),
    });
    if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
    const data = await response.json();
    return data.results || [];
  }

  private async fetchSmartRecruitersJobs(slug: string): Promise<any[]> {
    const url = `https://api.smartrecruiters.com/v1/companies/${slug}/postings`;
    const response = await this.fetchWithTimeout(url);
    if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
    const data = await response.json();
    return data.content || [];
  }

  private async fetchRecruiteeJobs(slug: string): Promise<any[]> {
    const url = `https://${slug}.recruitee.com/api/offers`;
    const response = await this.fetchWithTimeout(url);
    if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
    const data = await response.json();
    return data.offers || [];
  }

  private async fetchTeamtailorJobs(slug: string): Promise<any[]> {
    const url = `https://${slug}.teamtailor.com/jobs`;
    const response = await this.fetchWithTimeout(url, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
    const data = await response.json();
    return data.data || [];
  }

  private extractSkillsFromDescription(description: string): string[] {
    const skillKeywords = [
      'JavaScript',
      'TypeScript',
      'Python',
      'Java',
      'C#',
      'C++',
      'Go',
      'Rust',
      'Ruby',
      'PHP',
      'Swift',
      'Kotlin',
      'React',
      'Angular',
      'Vue',
      'Next.js',
      'Node.js',
      'Express',
      'Django',
      'Flask',
      'Spring',
      'FastAPI',
      'AWS',
      'Azure',
      'GCP',
      'Docker',
      'Kubernetes',
      'Terraform',
      'Jenkins',
      'CI/CD',
      'PostgreSQL',
      'MySQL',
      'MongoDB',
      'Redis',
      'Elasticsearch',
      'SQL',
      'NoSQL',
      'GraphQL',
      'REST',
      'API',
      'Microservices',
      'Agile',
      'Scrum',
      'DevOps',
      'Git',
      'HTML',
      'CSS',
      'Sass',
      'Tailwind',
      'Bootstrap',
    ];
    const found: string[] = [];
    const lowerDesc = description.toLowerCase();
    for (const skill of skillKeywords) {
      if (lowerDesc.includes(skill.toLowerCase())) {
        found.push(skill);
      }
    }
    return found.slice(0, 12);
  }

  /**
   * Ingest a normalized job globally.
   * Deduplicates primarily on URL. Uses title + company + location as a secondary fallback.
   */
  async ingestGlobalJob(jobData: any) {
    if (jobData.description) {
      jobData.description = this.stripHtml(jobData.description);
    }
    jobData.location = this.normalizeLocation(
      jobData.location,
      jobData.workType,
    );
    const twelveDaysAgo = new Date();
    twelveDaysAgo.setDate(twelveDaysAgo.getDate() - 12);
    if (jobData.postedDate && jobData.postedDate < twelveDaysAgo) {
      return; // Skip stale jobs older than 12 days
    }

    // 1. Determine deduplication query
    const normalizedTitle = jobData.title ? jobData.title.trim() : '';
    const normalizedCompany = jobData.company ? jobData.company.trim() : '';

    // Safely escape regex characters
    const escapeRegex = (string: string) =>
      string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const query = {
      $or: [
        { url: jobData.url },
        {
          title: {
            $regex: new RegExp(`^${escapeRegex(normalizedTitle)}$`, 'i'),
          },
          company: {
            $regex: new RegExp(`^${escapeRegex(normalizedCompany)}$`, 'i'),
          },
        },
      ],
    };

    // 2. Check if job already exists before upserting
    const existingJob = await this.jobModel.findOne(query).exec();

    // 3. Perform atomic update/upsert to prevent duplicate plain inserts
    // Ensure createdAt is NEVER overwritten on updates so the 24h New badge logic remains accurate
    let result;
    if (existingJob) {
      const { createdAt, ...updateFields } = jobData;
      result = await this.jobModel
        .findByIdAndUpdate(
          existingJob._id,
          { $set: { ...updateFields, isClosed: false } },
          { new: true },
        )
        .exec();
    } else {
      result = await this.jobModel.create({ ...jobData, isClosed: false });
    }

    // 4. If this was a NEW job (not an update), queue it for user notification
    if (!existingJob && result && result._id) {
      try {
        await this.queueService.addCrawledNewJob(result._id.toString());
      } catch (err) {
        // Don't let notification queue failure break the crawl
        console.error('[ingestGlobalJob] Failed to queue notification:', err);
      }
    }
  }

  private normalizeLocation(location: unknown, workType?: string): string {
    if (typeof location === 'string' && location.trim()) return location.trim();
    if (Array.isArray(location)) {
      const values = location.filter(
        (value): value is string =>
          typeof value === 'string' && Boolean(value.trim()),
      );
      if (values.length) return values.join(', ');
    }
    if (location && typeof location === 'object') {
      const value = location as {
        name?: unknown;
        display_name?: unknown;
        city?: unknown;
        country?: unknown;
      };
      const named = value.name || value.display_name;
      if (typeof named === 'string' && named.trim()) return named.trim();
      const parts = [value.city, value.country].filter(
        (part): part is string =>
          typeof part === 'string' && Boolean(part.trim()),
      );
      if (parts.length) return parts.join(', ');
    }
    return workType === 'Remote' ? 'Remote' : 'Location not specified';
  }

  private normalizeQueryLocation(loc: string): string {
    const clean = (loc || '').toLowerCase().trim();
    if (!clean) return '';

    // Spelling variations / common abbreviations mappings
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

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async fetchRemoteFeeds(): Promise<void> {
    console.log('[JobService] Fetching free remote job feeds...');
    // RemoteOK
    try {
      console.log('[JobService] Fetching RemoteOK jobs');
      const res = await this.fetchWithTimeout('https://remoteok.com/api', {
        headers: { 'User-Agent': 'AIJobCopilot/1.0' },
      });
      if (res.ok) {
        const jobs = await res.json();
        for (let i = 1; i < jobs.length; i++) {
          // Skip index 0 (legal)
          const j = jobs[i];
          if (!j.id) continue;
          await this.ingestGlobalJob({
            title: j.position,
            company: j.company,
            description: j.description || '',
            url: j.url,
            source: 'Remote OK',
            location: j.location || 'Remote',
            workType: 'Remote',
            salaryMin: j.salary_min || undefined,
            salaryMax: j.salary_max || undefined,
            salaryCurrency: 'USD',
            salaryPeriod: 'YEAR',
            companyLogoUrl: j.company_logo || undefined,
            applyUrl: j.url,
            requiredSkills: j.tags || [],
            postedDate: j.date ? new Date(j.date) : undefined,
          });
        }
      }
    } catch (e) {
      console.error('[JobService] RemoteOK fetch failed', e);
    }

    // Himalayas
    try {
      console.log('[JobService] Fetching Himalayas jobs');
      const res = await this.fetchWithTimeout(
        'https://himalayas.app/jobs/api?limit=50',
      );
      if (res.ok) {
        const data = await res.json();
        const jobs = data.jobs || [];
        for (const j of jobs) {
          await this.ingestGlobalJob({
            title: j.title,
            company: j.companyName,
            description: j.description || j.excerpt || '',
            url: j.applicationLink || j.himalayasUrl || '',
            source: 'Himalayas',
            location: j.locationRestrictions?.join(', ') || 'Remote',
            workType: 'Remote',
            salaryMin: j.minSalary || undefined,
            salaryMax: j.maxSalary || undefined,
            salaryCurrency: 'USD',
            salaryPeriod: 'YEAR',
            companyLogoUrl: j.companyLogo || undefined,
            applyUrl: j.applicationLink || j.himalayasUrl || '',
            requiredSkills: j.categories || [],
            postedDate: j.pubDate ? new Date(j.pubDate * 1000) : undefined,
          });
        }
      }
    } catch (e) {
      console.error('[JobService] Himalayas fetch failed', e);
    }

    // Remotive
    try {
      console.log('[JobService] Fetching Remotive jobs');
      const res = await this.fetchWithTimeout(
        'https://remotive.com/api/remote-jobs?limit=50',
      );
      if (res.ok) {
        const data = await res.json();
        const jobs = data.jobs || [];
        for (const j of jobs) {
          await this.ingestGlobalJob({
            title: j.title,
            company: j.company_name,
            description: j.description || '',
            url: j.url,
            source: 'Remotive',
            location: j.candidate_required_location || 'Remote',
            workType: 'Remote',
            salaryString: j.salary || undefined,
            companyLogoUrl: j.company_logo || undefined,
            applyUrl: j.url,
            requiredSkills: j.tags || [],
            postedDate: j.publication_date
              ? new Date(j.publication_date)
              : undefined,
          });
        }
      }
    } catch (e) {
      console.error('[JobService] Remotive fetch failed', e);
    }

    // Jobicy
    try {
      console.log('[JobService] Fetching Jobicy jobs');
      const res = await this.fetchWithTimeout(
        'https://jobicy.com/api/v2/remote-jobs?count=50',
      );
      if (res.ok) {
        const data = await res.json();
        const jobs = data.jobs || [];
        for (const j of jobs) {
          if (!j.url) continue;

          let salaryString: string | undefined;
          if (j.annualSalaryMin && j.annualSalaryMax) {
            salaryString = `${j.salaryCurrency || '$'}${j.annualSalaryMin.toLocaleString()} - ${j.salaryCurrency || '$'}${j.annualSalaryMax.toLocaleString()} /yr`;
          }

          await this.ingestGlobalJob({
            title: j.jobTitle,
            company: j.companyName,
            description: j.jobDescription || j.jobExcerpt || '',
            url: j.url,
            source: 'Jobicy',
            location: j.jobGeo || 'Remote',
            workType: 'Remote',
            salaryMin: j.annualSalaryMin || undefined,
            salaryMax: j.annualSalaryMax || undefined,
            salaryString,
            salaryCurrency: j.salaryCurrency || 'USD',
            salaryPeriod: 'YEAR',
            applyUrl: j.url,
            experienceLevel: Array.isArray(j.jobLevel)
              ? j.jobLevel[0]
              : j.jobLevel || undefined,
            employmentType: Array.isArray(j.jobType)
              ? j.jobType[0]
              : j.jobType || undefined,
            postedDate: j.pubDate ? new Date(j.pubDate) : undefined,
          });
        }
      }
    } catch (e) {
      console.error('[JobService] Jobicy fetch failed', e);
    }

    // We Work Remotely (RSS feed — parse with regex)
    try {
      console.log('[JobService] Fetching We Work Remotely jobs');
      const res = await this.fetchWithTimeout(
        'https://weworkremotely.com/remote-jobs.rss',
        {
          headers: { 'User-Agent': 'AIJobCopilot/1.0' },
        },
      );
      if (res.ok) {
        const xml = await res.text();
        const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
        for (const item of items.slice(0, 50)) {
          const titleMatch = item.match(
            /<title><!\[CDATA\[(.*?)\]\]><\/title>/,
          );
          const linkMatch = item.match(/<link>(.*?)<\/link>/);
          const companyMatch =
            item.match(/<company><!\[CDATA\[(.*?)\]\]><\/company>/) ||
            item.match(/<dc:creator><!\[CDATA\[(.*?)\]\]><\/dc:creator>/);
          const regionMatch = item.match(
            /<region><!\[CDATA\[(.*?)\]\]><\/region>/,
          );
          const dateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);

          const title = titleMatch?.[1]?.trim();
          const link = linkMatch?.[1]?.trim();
          const company = companyMatch?.[1]?.trim() || 'Company';

          if (!title || !link) continue;

          await this.ingestGlobalJob({
            title,
            company,
            description: '',
            url: link,
            source: 'We Work Remotely',
            location: regionMatch?.[1]?.trim() || 'Remote',
            workType: 'Remote',
            applyUrl: link,
            postedDate: dateMatch?.[1] ? new Date(dateMatch[1]) : undefined,
          });
        }
      }
    } catch (e) {
      console.error('[JobService] We Work Remotely fetch failed', e);
    }
  }

  async dismissJob(
    userId: string,
    jobId: string,
  ): Promise<{ success: boolean }> {
    await this.userModel
      .findOneAndUpdate(
        { $or: [{ clerkId: userId }, { email: userId }] },
        { $addToSet: { dismissedInternalJobs: jobId } },
      )
      .exec();
    return { success: true };
  }
}
