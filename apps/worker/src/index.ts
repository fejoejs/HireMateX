import mongoose from 'mongoose';
import { Agenda, Job as AgendaJob } from 'agenda';
import dotenv from 'dotenv';
import express from 'express';
import { AIService, EmailService, TelegramService } from '@ai-copilot/utils';
import { 
  ResumeModel, 
  JobModel, 
  JobMatchModel, 
  ApplicationModel, 
  UserModel, 
  SystemConfigModel,
  ExternalBoardJobModel,
  PendingConfirmationModel,
  PendingDigestModel
} from './schemas';
import { extractTextFromFile } from './parser';

dotenv.config();

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/ai_job_copilot';
export const agenda = new Agenda({
  db: { address: mongoUri, collection: 'agendaJobs' },
  processEvery: '1 second',
} as any);

async function getDynamicEmailService(): Promise<EmailService> {
  try {
    const configs = await SystemConfigModel.find().exec();
    const configMap: { [key: string]: string } = {};
    for (const c of configs) {
      configMap[c.key] = c.value;
    }
    return new EmailService({
      smtpHost: configMap['SMTP_HOST'],
      smtpPort: configMap['SMTP_PORT'] ? parseInt(configMap['SMTP_PORT'], 10) : undefined,
      smtpUser: configMap['SMTP_USER'],
      smtpPass: configMap['SMTP_PASS'],
      fromName: configMap['EMAIL_FROM_NAME'],
      fromEmail: configMap['EMAIL_FROM_ADDRESS'],
    });
  } catch (error) {
    console.error('[Worker] Failed to load SMTP config, using fallback:', error);
    return new EmailService();
  }
}

async function getDynamicTelegramService(): Promise<TelegramService> {
  try {
    const configs = await SystemConfigModel.find().exec();
    const configMap: { [key: string]: string } = {};
    for (const c of configs) {
      configMap[c.key] = c.value;
    }

    return new TelegramService({
      botToken: configMap['TELEGRAM_BOT_TOKEN'],
      isWorker: true, // This enables polling
    });
  } catch (error) {
    console.error('[Worker] Failed to load Telegram config, using fallback:', error);
    return new TelegramService();
  }
}

async function getDynamicAIService(userId?: string): Promise<AIService> {
  try {
    const configs = await SystemConfigModel.find().exec();
    const configMap: { [key: string]: string } = {};
    for (const c of configs) {
      configMap[c.key] = c.value;
    }
    return new AIService({
      apiKey: configMap['ANTHROPIC_API_KEY'],
      geminiApiKey: configMap['GEMINI_API_KEY'],
      groqApiKey: configMap['GROQ_API_KEY'],
      onApiCall: (service: string, model: string, status: 'success' | 'failed', errorMessage?: string, tokens?: any) => {
        mongoose.connection.db?.collection('apilogs').insertOne({
          service,
          modelName: model,
          status,
          errorMessage,
          userId,
          tokens,
          timestamp: new Date(),
          createdAt: new Date(),
          updatedAt: new Date()
        }).catch((err: any) => {
          console.error('[Worker AI] Failed to write ApiLog:', err);
        });
      }
    });
  } catch (error) {
    console.error('[Worker] Failed to load config from database, using env fallback:', error);
    return new AIService();
  }
}

/**
 * Initialize connection to MongoDB
 */
async function connectDb() {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/ai_job_copilot';
  const maxRetries = 8;
  const retryDelayMs = 5000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await mongoose.connect(mongoUri, {
        serverSelectionTimeoutMS: 8000,
        readPreference: 'primary',          // always read from primary — no stale replica lag
        writeConcern: { w: 'majority', j: true }, // writes confirmed by majority before returning
      });
      console.log('Worker successfully connected to MongoDB');
      return;
    } catch (err) {
      console.error(`Worker database connection attempt ${attempt}/${maxRetries} failed:`, (err as Error).message);
      if (attempt < maxRetries) {
        console.log(`Retrying in ${retryDelayMs / 1000}s...`);
        await new Promise(r => setTimeout(r, retryDelayMs));
      } else {
        console.error('Worker: all MongoDB connection attempts exhausted, exiting.');
        process.exit(1);
      }
    }
  }
}

/**
 * 1. Resume Parser Queue Processor
 */
agenda.define('parse-resume', async (job: AgendaJob) => {
  const data: any = job.attrs.data || {};
  const { resumeId, userId, fileKey } = data;
  console.log(`[Resume Worker] Parsing resume: ${resumeId} for user: ${userId}`);

  try {
    // 1. Fetch resume meta from Mongo with extended retry + forced primary read.
    //    Atlas replicas can lag up to ~10s after a write; we retry up to 8 times.
    let resume: any = null;
    const delays = [2000, 3000, 4000, 5000, 5000, 5000, 5000, 5000]; // up to ~34s total
    for (let attempt = 1; attempt <= 8; attempt++) {
      // readPreference 'primary' bypasses secondary lag entirely
      resume = await (ResumeModel as any).findById(resumeId).read('primary').exec();
      if (resume) break;
      console.warn(`[Resume Worker] Resume ${resumeId} not found on attempt ${attempt}/8, waiting ${delays[attempt-1]}ms...`);
      await new Promise(r => setTimeout(r, delays[attempt - 1]));
    }
    if (!resume) {
      throw new Error(`Resume metadata not found in database after 8 retries: ${resumeId}`);
    }

    // 2. Load resume buffer directly from the MongoDB document
    let buffer = resume.fileBuffer;
    if (!buffer) {
      throw new Error(`File buffer not found in resume document for ID: ${resumeId}`);
    }
    
    // Ensure it is a standard Node.js Buffer (Mongoose sometimes returns Binary objects)
    if (!Buffer.isBuffer(buffer) && (buffer as any).buffer) {
      buffer = (buffer as any).buffer;
    }
    if (!Buffer.isBuffer(buffer) && (buffer as any).read) {
       buffer = Buffer.from((buffer as any).read(0, (buffer as any).length()));
    }
    
    // 3. Parse resume text
    console.log('[Resume Worker] Extracting text...');
    const rawText = await extractTextFromFile(buffer as Buffer, resume.originalFileName);
    if (!rawText || rawText.trim().length === 0) {
      throw new Error('No readable text could be extracted from this document.');
    }

    // 4. Structure resume using Claude
    console.log('[Resume Worker] Calling Claude AI for structured parsing...');
    const aiService = await getDynamicAIService(userId);
    const parsedProfile = await aiService.parseResume(rawText);

    // Fetch user target job title preference from filters
    let targetJobTitle = '';
    try {
      const user = await UserModel.findOne({ clerkId: userId }).exec();
      if (user && user.filters) {
        targetJobTitle = user.filters.targetJobRole || (user.filters.targetRoles && user.filters.targetRoles[0]) || '';
      }
    } catch (userErr) {
      console.warn('[Resume Worker] Failed to fetch user filters for target job title:', userErr);
    }

    // Calculate accurate ATS score with AI feedback
    console.log('[Resume Worker] Calculating accurate ATS score...');
    const atsResult = await calculateAccurateAtsScore(parsedProfile, resume.originalFileName, targetJobTitle, aiService);

    // 5. Update DB with updateOne — bypasses Mongoose instance tracking entirely.
    //    This is the safest approach for Mixed-type fields and avoids save() validation issues.
    await ResumeModel.updateOne(
      { _id: resumeId },
      { $set: { parsedProfile, atsScore: atsResult.overallScore, atsAnalysis: atsResult } }
    ).exec();
    console.log(`[Resume Worker] Resume ${resumeId} successfully parsed and scored.`);
  } catch (error: any) {
    console.error(`[Resume Worker] Failed to process resume job ${job.attrs._id}:`, error);
    try {
      await ResumeModel.findByIdAndUpdate(resumeId, {
        parsedProfile: { error: true, message: error.message || 'Unknown parsing error' }
      });
    } catch (dbErr) {
      console.error(`[Resume Worker] Failed to save error state to DB for ${resumeId}:`, dbErr);
    }
    throw error;
  }
});

async function calculateAccurateAtsScore(
  profile: any,
  fileName: string,
  targetJobTitle: string,
  aiService: AIService,
): Promise<any> {
  if (!profile) return { overallScore: 0 };

  const expItems = Array.isArray(profile.experience) ? profile.experience.filter(Boolean) : [];
  const eduItems = Array.isArray(profile.education) ? profile.education.filter(Boolean) : [];
  const projItems = Array.isArray(profile.projects) ? profile.projects.filter(Boolean) : [];
  const skillItems = Array.isArray(profile.skills) ? profile.skills.filter((s: any) => typeof s === 'string') : [];

  const summaryText = profile.summary || '';
  const expText = expItems
    .map((e: any) => `${e.title || ''} ${e.company || ''} ${e.description || ''} ${(Array.isArray(e.achievements) ? e.achievements.filter((a: any) => typeof a === 'string') : []).join(' ')}`)
    .join(' ');
  const eduText = eduItems
    .map((ed: any) => `${ed.degree || ''} ${ed.institution || ''}`)
    .join(' ');
  const projectsText = projItems
    .map((p: any) => `${p.title || ''} ${p.description || ''} ${(Array.isArray(p.technologies) ? p.technologies.filter((t: any) => typeof t === 'string') : []).join(' ')}`)
    .join(' ');
  const skillsText = skillItems.join(' ');

  const fullProfileText = `${profile.fullName || ''} ${profile.email || ''} ${profile.phone || ''} ${summaryText} ${expText} ${eduText} ${projectsText} ${skillsText}`;
  const wordCount = fullProfileText.split(/\s+/).filter(Boolean).length;

  // 1. Keyword & Skills Match (35 points)
  const targetKeywords = [
    'javascript', 'typescript', 'react', 'node', 'python', 'java', 'sql', 'mongodb', 
    'docker', 'aws', 'kubernetes', 'git', 'ci/cd', 'agile', 'scrum', 'html', 'css', 
    'rest api', 'graphql', 'devops', 'testing', 'security', 'linux', 'cloud', 'system design',
    'communication', 'leadership', 'problem solving', 'collaboration', 'analytics', 
    'ui/ux', 'project management', 'software engineering', 'ai', 'machine learning'
  ];

  const synonymMap: { [key: string]: string[] } = {
    'js': ['javascript', 'js', 'ecmascript'],
    'javascript': ['javascript', 'js', 'ecmascript'],
    'ts': ['typescript', 'ts'],
    'typescript': ['typescript', 'ts'],
    'ml': ['machine learning', 'ml', 'deep learning'],
    'machine learning': ['machine learning', 'ml', 'deep learning'],
    'ai': ['artificial intelligence', 'ai'],
    'artificial intelligence': ['artificial intelligence', 'ai'],
    'aws': ['amazon web services', 'aws'],
    'gcp': ['google cloud', 'gcp', 'google cloud platform'],
    'react': ['reactjs', 'react.js', 'react'],
    'mongodb': ['mongo', 'mongodb'],
    'sql': ['postgresql', 'mysql', 'sql', 'sqlite'],
    'python': ['py', 'python'],
    'kubernetes': ['k8s', 'kubernetes'],
    'dev': ['developer', 'dev', 'engineer'],
    'developer': ['developer', 'dev', 'engineer'],
    'pm': ['product manager', 'pm'],
    'product manager': ['product manager', 'pm'],
  };

  const userSkillsNormalized = new Set<string>();
  for (const skill of skillItems) {
    if (!skill || typeof skill !== 'string') continue;
    const lowerSkill = skill.toLowerCase().trim();
    if (synonymMap[lowerSkill]) {
      synonymMap[lowerSkill].forEach(syn => userSkillsNormalized.add(syn));
    } else {
      userSkillsNormalized.add(lowerSkill);
    }
  }

  const synonymsLookup = new Set<string>();
  userSkillsNormalized.forEach(s => {
    synonymsLookup.add(s);
    if (synonymMap[s]) {
      synonymMap[s].forEach(alias => synonymsLookup.add(alias));
    }
  });

  let totalKeywordWeight = 0;
  for (const target of targetKeywords) {
    const inSkillsSection = synonymsLookup.has(target) || skillItems.some((s: string) => String(s).toLowerCase().includes(target));
    const inRestOfText = fullProfileText.toLowerCase().includes(target);
    
    if (inSkillsSection) {
      totalKeywordWeight += 1.5;
    } else if (inRestOfText) {
      totalKeywordWeight += 1.0;
    }
  }

  let keywordMatch = Math.round((Math.min(totalKeywordWeight, 18) / 18) * 35);

  // Job title exact-phrase matching bonus
  let jobTitleMatched = false;
  if (targetJobTitle && targetJobTitle.trim()) {
    const targetClean = targetJobTitle.toLowerCase().trim();
    const hasTitleInSummary = summaryText.toLowerCase().includes(targetClean);
    const hasTitleInExperience = expItems.some((e: any) => String(e.title || '').toLowerCase().includes(targetClean));
    if (hasTitleInSummary || hasTitleInExperience) {
      jobTitleMatched = true;
      keywordMatch = Math.min(35, keywordMatch + 3); // add +3 bonus points, cap at 35
    }
  }

  // 2. Standard Section Headers (15 points)
  let sectionHeaders = 0;
  const expCount = profile.experience?.length || 0;
  const eduCount = profile.education?.length || 0;
  const skillCount = profile.skills?.length || 0;
  const hasContact = !!(profile.fullName || profile.email || profile.phone);

  if (expCount > 0) sectionHeaders += 5;
  if (eduCount > 0) sectionHeaders += 4;
  if (skillCount > 0) sectionHeaders += 3;
  if (hasContact) sectionHeaders += 3;

  const creativeHeaderRegex = /\b(my journey|what i bring|about me|creative summary|my mission|why hire me)\b/i;
  if (creativeHeaderRegex.test(summaryText)) {
    sectionHeaders = Math.max(0, sectionHeaders - 2);
  }

  // 3. Contact Information Extractability (10 points)
  let contactInfo = 0;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const phoneClean = (profile.phone || '').replace(/[^0-9+]/g, '');

  if (profile.email && emailRegex.test(profile.email.trim())) {
    contactInfo += 3;
  }
  if (phoneClean.length >= 7) {
    contactInfo += 3;
  }
  if (profile.fullName && profile.fullName.trim().split(/\s+/).length >= 2) {
    contactInfo += 4;
  }

  // 4. Formatting & Parseability (20 points)
  let formatting = 0;
  const descriptionBlock = expItems.map((e: any) => e.description || '').join(' ');
  const hasTableIndicator = /\||\s{4,}/.test(descriptionBlock);
  if (!hasTableIndicator) {
    formatting += 7;
  }

  const isImagePdf = wordCount < 30;
  if (!isImagePdf) {
    formatting += 5;
  }

  const fancyFontRegex = /[\uD835][\uDC00-\uDFFF]/;
  const hasFancyFonts = fancyFontRegex.test(fullProfileText);
  const hasExcessiveEmojis = /[\uD83C-\uDBFF\uDC00-\uDFFF].*[\uD83C-\uDBFF\uDC00-\uDFFF]/.test(fullProfileText);
  if (!hasFancyFonts && !hasExcessiveEmojis) {
    formatting += 3;
  }

  const fileExt = (fileName || '').split('.').pop()?.toLowerCase();
  if (fileExt === 'docx' || (fileExt === 'pdf' && !isImagePdf)) {
    formatting += 5;
  } else if (fileExt === 'pdf') {
    formatting += 2;
  }

  let hasEmojiBullets = false;
  for (const exp of expItems) {
    for (const ach of (Array.isArray(exp.achievements) ? exp.achievements : [])) {
      if (/^[\uD800-\uDFFF]/.test(ach.trim()) || /^[^\w\s•\-▪]/.test(ach.trim())) {
        hasEmojiBullets = true;
      }
    }
  }
  if (hasEmojiBullets) {
    formatting = Math.max(0, formatting - 2);
  }

  // 5. Date & Chronology Consistency (10 points)
  let chronology = 0;
  const dateRegex = /^(0[1-9]|1[0-2])\/\d{4}$|^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$/i;
  let datesConsistent = true;
  for (const exp of expItems) {
    if (exp.startDate && !dateRegex.test(String(exp.startDate).trim())) datesConsistent = false;
    if (exp.endDate && String(exp.endDate).trim().toLowerCase() !== 'present' && !dateRegex.test(String(exp.endDate).trim())) datesConsistent = false;
  }
  if (datesConsistent && expItems.length > 0) {
    chronology += 5;
  } else if (expItems.length > 0) {
    chronology += 2;
  }

  let hasHugeGaps = false;
  if (expItems.length > 1) {
    const years = expItems.map((e: any) => {
      const match = String(e.startDate || '').match(/\d{4}/);
      return match ? parseInt(match[0], 10) : null;
    }).filter(Boolean);
    for (let i = 0; i < years.length - 1; i++) {
      if (Math.abs(years[i] - years[i+1]) > 2) hasHugeGaps = true;
    }
  }
  if (!hasHugeGaps) {
    chronology += 3;
  }

  let isReverseChronological = true;
  if (expItems.length > 1) {
    const getYear = (dateStr: any) => {
      const m = String(dateStr || '').match(/\d{4}/);
      return m ? parseInt(m[0], 10) : 0;
    };
    for (let i = 0; i < expItems.length - 1; i++) {
      const yearCur = getYear(expItems[i].startDate || '');
      const yearNext = getYear(expItems[i+1].startDate || '');
      if (yearCur < yearNext && yearCur > 0 && yearNext > 0) {
        isReverseChronological = false;
      }
    }
  }
  if (isReverseChronological) {
    chronology += 2;
  }

  // 6. Length & Density (10 points)
  let lengthDensity = 0;
  if (wordCount >= 400 && wordCount <= 1000) {
    lengthDensity += 5;
  } else if (wordCount >= 250 && wordCount <= 1200) {
    lengthDensity += 3;
  } else if (wordCount > 0) {
    lengthDensity += 1;
  }

  const stopWords = new Set(['the', 'and', 'a', 'of', 'in', 'to', 'for', 'with', 'on', 'at', 'by', 'an', 'is', 'was', 'were', 'that', 'as', 'it']);
  const words = fullProfileText.toLowerCase().split(/[^a-zA-Z]+/).filter(w => w.length > 2 && !stopWords.has(w));
  const freqs: { [word: string]: number } = {};
  let isStuffed = false;
  for (const w of words) {
    freqs[w] = (freqs[w] || 0) + 1;
    if (freqs[w] >= 10) {
      isStuffed = true;
    }
  }
  if (!isStuffed) {
    lengthDensity += 5;
  } else {
    lengthDensity += 2;
  }

  // Compute metrics presence
  const metricsPattern = /\d+%|\$\d|#?\d+\s*(users|customers|clients|projects|team|members|people|million|k\b|revenue|growth|increase|decrease|reduction|improvement|savings)/i;
  let totalBullets = 0;
  let metricBullets = 0;
  for (const exp of expItems) {
    for (const achievement of (Array.isArray(exp.achievements) ? exp.achievements : [])) {
      totalBullets++;
      if (metricsPattern.test(achievement)) {
        metricBullets++;
      }
    }
    if (exp.description) {
      totalBullets++;
      if (metricsPattern.test(exp.description)) {
        metricBullets++;
      }
    }
  }

  const isStandardFileName = /^[a-zA-Z]+_[a-zA-Z]+_Resume\.(pdf|docx)$/i.test(fileName);
  const overallScore = Math.round(keywordMatch + sectionHeaders + contactInfo + formatting + chronology + lengthDensity);

  const ruleScores = {
    overallScore,
    keywordMatch,
    sectionHeaders,
    contactInfo,
    formatting,
    chronology,
    lengthDensity,
    skillCount,
    wordCount,
    metricBullets,
    totalBullets,
    isStandardFileName,
    jobTitleMatched,
  };

  // Generate AI-powered feedback, strengths, and summary
  let aiFeedback;
  try {
    aiFeedback = await aiService.generateAtsFeedback(profile, {
      overallScore,
      formatCompatibility: Math.round((formatting / 20) * 100),
      keywordDensity: Math.round((keywordMatch / 35) * 100),
      quantifiableAchievements: totalBullets > 0 ? Math.round((metricBullets / totalBullets) * 100) : 0,
      sectionStructure: Math.round((sectionHeaders / 15) * 100),
      mncCompliance: Math.round(((contactInfo + chronology) / 20) * 100),
    });
  } catch (err) {
    console.error('[Worker ATS] AI feedback generation failed, using fallback:', err);
    aiFeedback = {
      feedback: [
        { type: 'suggestion', title: 'AI feedback unavailable', detail: 'Configure a Gemini API key in Admin panel to get personalized resume tips.' },
      ],
      strengths: skillCount > 5 ? [`${skillCount} technical skills detected`] : ['Resume successfully parsed'],
      summary: 'AI feedback is currently unavailable. Configure an API key to receive personalized optimization tips.',
    };
  }

  return {
    ...ruleScores,
    feedback: aiFeedback.feedback || [],
    strengths: aiFeedback.strengths || [],
    summary: aiFeedback.summary || '',
  };
}

/**
 * Helper to calculate Decision Score out of 100 based on Match Score and Filters
 */
function calculateDecisionScore(matchScore: number, job: any, userFilters: any): number {
  let score = matchScore; // base weight is match score
  
  if (!userFilters) return score;

  // 1. Work type preference check
  if (userFilters.workTypes && userFilters.workTypes.length > 0) {
    if (userFilters.workTypes.includes(job.workType)) {
      score += 5; // matching work preference bonus
    } else {
      score -= 10; // mismatch penalty
    }
  }

  // 2. Minimum salary preference check
  if (userFilters.minSalary && (job.salaryMax || job.salaryMin)) {
    const effectiveSalary = job.salaryMax || job.salaryMin;
    if (effectiveSalary >= userFilters.minSalary) {
      score += 5;
    } else {
      score -= 15;
    }
  }

  // Bound score between 0 and 100
  return Math.max(0, Math.min(100, score));
}

/**
 * 2. Main Job Processing Worker (Job Matches, Tailoring, Cover Letters)
 */
const processJobProcessing = async (job: AgendaJob) => {
  const name = job.attrs.name;
  const data: any = job.attrs.data || {};
  console.log(`[Processing Worker] Executing task "${name}" for job ID: ${data.jobId}`);

  try {
    if (name === 'match-job') {
      const { userId, jobId } = data;

      // 1. Fetch user's latest parsed resume
      const resume = await ResumeModel.findOne({ userId, isAtsCheckOnly: { $ne: true } }).sort({ createdAt: -1 });
      if (!resume || !resume.parsedProfile) {
        throw new Error(`Candidate has no parsed resume profile: ${userId}`);
      }

      // 2. Fetch job details
      const jobDetails = await JobModel.findById(jobId);
      if (!jobDetails) {
        throw new Error(`Job post not found: ${jobId}`);
      }

      // 3. Request Claude Match assessment
      console.log('[Processing Worker] Computing semantic match via Claude...');
      const aiService = await getDynamicAIService(userId);
      const matchResult = await aiService.matchJob(
        resume.parsedProfile,
        jobDetails.title,
        jobDetails.description
      );

      // 4. Load user filters to compute overall Decision Score
      const user = await UserModel.findOne({ clerkId: userId });
      const decisionScore = calculateDecisionScore(
        matchResult.matchScore,
        jobDetails,
        user?.filters
      );

      // 5. Update or save matching record
      await JobMatchModel.findOneAndUpdate(
        { userId, jobId },
        {
          matchScore: matchResult.matchScore,
          recommendation: matchResult.recommendation,
          reasoning: matchResult.reasoning,
          pros: matchResult.pros,
          cons: matchResult.cons,
          missingSkills: matchResult.missingSkills,
          decisionScore,
        },
        { upsert: true, new: true }
      );
      
      console.log(`[Processing Worker] Match completed for user: ${userId}, Job: ${jobId}. Score: ${matchResult.matchScore}%`);
      
      // 6. Send instant Telegram Notification for high-score Semantic Match
      if (user && user.telegramNotificationsEnabled && user.telegramChatId) {
        await agenda.now('telegram-job-match', { 
          chatId: user.telegramChatId, 
          jobTitle: jobDetails.title, 
          company: jobDetails.company, 
          matchScore: matchResult.matchScore, 
          salary: jobDetails.salaryString || 'Not specified', 
          applicationId: 'N/A' 
        });
      }
    }

    else if (name === 'tailor-resume') {
      const { userId, jobId, applicationId } = data;

      // 1. Fetch user resume and job
      const resume = await ResumeModel.findOne({ userId, isAtsCheckOnly: { $ne: true } }).sort({ createdAt: -1 });
      if (!resume || !resume.parsedProfile) {
        throw new Error('Parsed profile not found');
      }

      const jobDetails = await JobModel.findById(jobId);
      if (!jobDetails) {
        throw new Error('Job not found');
      }

      const application = await ApplicationModel.findById(applicationId);
      if (!application) {
        throw new Error('Application record not found');
      }

      console.log('[Processing Worker] Writing specialized cover letter with Claude...');
      const aiService = await getDynamicAIService(userId);
      const coverLetter = await aiService.generateCoverLetter(
        resume.parsedProfile,
        jobDetails.title,
        jobDetails.company,
        jobDetails.description
      );

      // We skip tailoring the resume as per user preference, but we still generate the cover letter
      // 2. Save tailored text content directly inside the Application document in MongoDB
      application.tailoredResumeContent = "Tailored resume generation disabled by user preference.";
      application.tailoredResumeUrl = `db://${applicationId}`;
      application.coverLetterContent = coverLetter;
      application.status = 'Tailored';
      await application.save();

      console.log(`[Processing Worker] Tailoring complete. Application ${applicationId} updated.`);
    }
  } catch (error) {
    console.error(`[Processing Worker] Error executing task "${name}":`, error);
    throw error;
  }
};

agenda.define('match-job', processJobProcessing);
agenda.define('tailor-resume', processJobProcessing);

/**
 * Helper to check if an ExternalBoardJob matches user preferences
 */
function matchesUserPreferences(job: any, user: any): boolean {
  if (!user || !user.filters) return true; // match all if no preferences set
  const { workTypes, countries, targetRoles, targetJobRole } = user.filters;

  const locLower = (job.location || '').toLowerCase();
  const titleLower = (job.title || '').toLowerCase();

  const isJobRemote = job.workType === 'Remote' || 
    locLower.includes('remote') || 
    titleLower.includes('remote') || 
    locLower.includes('work from home') || 
    locLower.includes('wfh');

  const isJobHybrid = job.workType === 'Hybrid' || 
    locLower.includes('hybrid') || 
    titleLower.includes('hybrid');

  // 1. Work type check
  if (workTypes && Array.isArray(workTypes) && workTypes.length > 0) {
    const wantsRemote = workTypes.includes('Remote');
    const wantsHybrid = workTypes.includes('Hybrid');
    const wantsOnsite = workTypes.includes('Onsite');

    let match = false;
    if (wantsRemote && isJobRemote) match = true;
    if (wantsHybrid && isJobHybrid) match = true;
    if (wantsOnsite && !isJobRemote && !isJobHybrid) match = true;

    if (!match) return false;
  }

  // 2. Countries / Locations check
  if (countries && ((Array.isArray(countries) && countries.length > 0) || (typeof countries === 'string' && countries.trim().length > 0))) {
    const countryList = Array.isArray(countries) 
      ? countries.flatMap((c: string) => typeof c === 'string' ? c.split(',').map(s => s.trim()) : []) 
      : String(countries).split(',').map((c: string) => c.trim()).filter(Boolean);

    let match = false;
    for (const c of countryList) {
      const cLower = c.toLowerCase().trim();
      if (!cLower) continue;
      if (cLower === 'tvm') {
        if (locLower.includes('tvm') || locLower.includes('thiruvananthapuram')) {
          match = true;
          break;
        }
      } else if (locLower.includes(cLower)) {
        match = true;
        break;
      }
    }
    // Remote jobs match any location
    if (isJobRemote) {
      match = true;
    }
    if (!match) return false;
  }

  // 3. Roles check
  let rolesFilter: string[] = targetRoles && Array.isArray(targetRoles) && targetRoles.length > 0
    ? [...targetRoles]
    : (user.filters.targetJobRole ? user.filters.targetJobRole.split(',').map((r: string) => r.trim()).filter(Boolean) : []);

  if (rolesFilter.length > 0) {
    const roleAliasMap: Record<string, string[]> = {
      'software engineer': ['software engineer', 'swe', 'software developer', 'sde', 'backend engineer', 'developer', 'engineer', 'tech lead'],
      'frontend developer': ['frontend', 'front-end', 'react', 'react developer', 'ui developer', 'web developer', 'angular developer', 'vue developer', 'javascript developer'],
      'fullstack developer': ['fullstack', 'full stack', 'full-stack', 'mern', 'mean', 'node developer', 'full stack developer', 'fullstack engineer'],
      'backend developer': ['backend', 'back-end', 'api developer', 'node developer', 'python developer', 'java developer', 'golang developer', 'django developer'],
      'data scientist': ['data scientist', 'machine learning', 'ml engineer', 'ai engineer', 'data analyst', 'data engineer', 'deep learning'],
      'devops engineer': ['devops', 'site reliability engineer', 'sre', 'cloud engineer', 'platform engineer', 'infrastructure engineer', 'aws engineer'],
      'product manager': ['product manager', 'product owner', 'program manager', 'apm'],
      'ui ux designer': ['ux designer', 'ui designer', 'product designer', 'ui/ux', 'interaction designer', 'visual designer'],
      'mobile developer': ['mobile developer', 'ios developer', 'android developer', 'react native', 'flutter developer'],
      'qa engineer': ['qa engineer', 'sdet', 'test engineer', 'quality assurance', 'automation tester', 'tester']
    };

    const expandedRoles = new Set<string>();
    for (const role of rolesFilter) {
      const roleLower = role.toLowerCase().trim();
      if (!roleLower) continue;
      expandedRoles.add(roleLower);
      for (const [canonical, aliases] of Object.entries(roleAliasMap)) {
        if (roleLower.includes(canonical) || aliases.some(a => roleLower.includes(a))) {
          aliases.forEach(a => expandedRoles.add(a));
          expandedRoles.add(canonical);
        }
      }
    }

    let match = false;
    for (const r of expandedRoles) {
      if (r.length >= 2) {
        const escaped = r.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
        const wordBoundaryRegex = new RegExp(`\\b${escaped}\\b`, 'i');
        if (wordBoundaryRegex.test(titleLower) || titleLower.includes(r)) {
          match = true;
          break;
        }
      }
    }
    if (!match) return false;
  }

  return true;
}


/**
 * 3. Notification Queue Worker (External Board job matches & consolidated digest scheduling)
 */
const processNotification = async (job: AgendaJob) => {
  const name = job.attrs.name;
  const data: any = job.attrs.data || {};
  console.log(`[Notification Worker] Executing task "${name}"`);

  try {
    if (name === 'external-board-new-job') {
      const { jobId } = data;
      const boardJob = await ExternalBoardJobModel.findById(jobId).exec();
      if (!boardJob) return;

      const users = await UserModel.find({}).exec();
      const matchedUserIds: string[] = [];

      for (const user of users) {
        if (matchesUserPreferences(boardJob, user)) {
          matchedUserIds.push(user.clerkId);
        }
      }

      if (matchedUserIds.length === 0) return;

      // Group into digest via Agenda
      await agenda.now('queue-for-digest', { jobId: boardJob._id.toString(), userIds: matchedUserIds });
      console.log(`[Notification Worker] Discovered match for job ${boardJob.title}. Enqueued digest queue for ${matchedUserIds.length} users.`);
    }

    else if (name === 'queue-for-digest') {
      const { jobId, userIds } = data;
      const digestItems = userIds.map((userId: string) => ({
        userId,
        externalBoardJobId: jobId,
        sent: false,
      }));
      await PendingDigestModel.insertMany(digestItems);
      console.log(`[Notification Worker] Saved ${userIds.length} pending digest items for job ID: ${jobId}`);
    }

    else if (name === 'crawled-new-job') {
      const { jobId } = data;
      const boardJob = await JobModel.findById(jobId).exec();
      if (!boardJob) return;

      const users = await UserModel.find({}).exec();
      const matchedUserIds: string[] = [];

      for (const user of users) {
        if (matchesUserPreferences(boardJob, user)) {
          matchedUserIds.push(user.clerkId);
        }
      }

      if (matchedUserIds.length === 0) return;

      await agenda.now('queue-for-digest-crawled', { jobId: boardJob._id.toString(), userIds: matchedUserIds });
      console.log(`[Notification Worker] Discovered match for crawled job ${boardJob.title}. Enqueued digest queue for ${matchedUserIds.length} users.`);
    }

    else if (name === 'queue-for-digest-crawled') {
      const { jobId, userIds } = data;
      const digestItems = userIds.map((userId: string) => ({
        userId,
        jobId: jobId,
        sent: false,
      }));
      await PendingDigestModel.insertMany(digestItems);
      console.log(`[Notification Worker] Saved ${userIds.length} pending digest items for crawled job ID: ${jobId}`);
    }

    else if (name === 'send-digest-cron') {
      console.log('[Notification Worker] Running 6-hour digest cron...');
      const pendingItems = await PendingDigestModel.find({ sent: false }).exec();
      if (pendingItems.length === 0) {
        console.log('[Notification Worker] No pending digest items. Skipping digest email.');
        return;
      }

      // Group by userId
      const grouped: { [userId: string]: typeof pendingItems } = {};
      for (const item of pendingItems) {
        if (!grouped[item.userId]) grouped[item.userId] = [];
        grouped[item.userId].push(item);
      }

      const emailService = await getDynamicEmailService();
      const telegramService = await getDynamicTelegramService();

      for (const [userId, items] of Object.entries(grouped)) {
        const userObj = await UserModel.findOne({ clerkId: userId }).exec();
        if (!userObj) {
          await PendingDigestModel.updateMany(
            { _id: { $in: items.map((i: any) => i._id) } },
            { sent: true }
          ).exec();
          continue;
        }

        const extJobIds = items.filter((i: any) => i.externalBoardJobId).map((i: any) => i.externalBoardJobId);
        const crawledJobIds = items.filter((i: any) => i.jobId).map((i: any) => i.jobId);

        const extJobs = await ExternalBoardJobModel.find({ _id: { $in: extJobIds } }).exec();
        const crawledJobs = await JobModel.find({ _id: { $in: crawledJobIds } }).exec();

        const extJobsMap = extJobs.map(j => ({
          title: j.title,
          company: j.company,
          location: j.location,
          sourcePlatform: j.sourcePlatform,
          url: j.url,
          shortDescription: '',
          isExternal: true
        }));

        const crawledJobsMap = crawledJobs.map(j => ({
          title: j.title,
          company: j.company,
          location: j.location,
          sourcePlatform: j.source,
          url: j.url,
          shortDescription: j.description ? j.description.substring(0, 150) + '...' : '',
          isExternal: false
        }));

        const jobs = [...extJobsMap, ...crawledJobsMap];
        
        const internalJobs = jobs.filter((j: any) => !j.isExternal);
        const externalJobs = jobs.filter((j: any) => j.isExternal);

        if (jobs.length === 0) {
          await PendingDigestModel.updateMany(
            { _id: { $in: items.map((i: any) => i._id) } },
            { sent: true }
          ).exec();
          continue;
        }

        // Send Email Digest
        if (userObj.isEmailVerified && userObj.email && userObj.emailNotificationsEnabled !== false) {
          const subject = `${jobs.length} new matching job(s) from HireMateX`;
          const emailHtml = `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 24px; background-color: #050508; color: #fafafa; border-radius: 16px; border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 0 20px 40px rgba(0,0,0,0.6);">
              ${emailService.emailHeader(40, 28)}
              
              <p style="color: #fafafa; font-size: 15px; font-weight: 500; margin-bottom: 20px;">Hello ${userObj.name || 'Candidate'},</p>
              <p style="color: #a1a1aa; font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
                We found <strong>${jobs.length}</strong> new job match(es) from your passive browsing and automated crawls matching your career preferences:
              </p>
              
              <div style="margin-bottom: 24px;">
                ${internalJobs.length > 0 ? `
                  <h2 style="color: #fafafa; font-size: 16px; font-weight: 700; margin-bottom: 16px;">🌟 Job Board (Trackable)</h2>
                  ${internalJobs.map((j: any) => `
                    <div style="background: transparent; border: 1px solid rgba(168, 85, 247, 0.15); border-radius: 12px; padding: 20px; margin-bottom: 16px;">
                      <div style="margin-bottom: 8px;">
                        <span style="background: rgba(168, 85, 247, 0.1); border: 1px solid rgba(168, 85, 247, 0.2); color: #c084fc; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 6px; float: right;">${j.sourcePlatform}</span>
                        <h3 style="font-size: 16px; font-weight: 700; margin: 0; color: #ffffff;">${j.title}</h3>
                      </div>
                      <p style="color: #d4d4d8; font-size: 13px; margin: 0 0 4px; font-weight: 500;">${j.company}</p>
                      <p style="color: #71717a; font-size: 12px; margin: 0 0 12px;">📍 ${j.location || 'Location not specified'}</p>
                      ${j.shortDescription ? `<p style="color: #a1a1aa; font-size: 12px; line-height: 1.5; margin: 0 0 0px; font-style: italic;">"${j.shortDescription}"</p>` : ''}
                    </div>
                  `).join('')}
                ` : ''}

                ${externalJobs.length > 0 ? `
                  <h2 style="color: #fafafa; font-size: 16px; font-weight: 700; margin-top: 32px; margin-bottom: 16px;">🌐 External Boards (Apply on Site)</h2>
                  ${externalJobs.map((j: any) => `
                    <div style="background: transparent; border: 1px solid rgba(168, 85, 247, 0.15); border-radius: 12px; padding: 20px; margin-bottom: 16px;">
                      <div style="margin-bottom: 8px;">
                        <span style="background: rgba(168, 85, 247, 0.1); border: 1px solid rgba(168, 85, 247, 0.2); color: #c084fc; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 6px; float: right;">${j.sourcePlatform}</span>
                        <h3 style="font-size: 16px; font-weight: 700; margin: 0; color: #ffffff;">${j.title}</h3>
                      </div>
                      <p style="color: #d4d4d8; font-size: 13px; margin: 0 0 4px; font-weight: 500;">${j.company}</p>
                      <p style="color: #71717a; font-size: 12px; margin: 0 0 12px;">📍 ${j.location || 'Location not specified'}</p>
                      ${j.shortDescription ? `<p style="color: #a1a1aa; font-size: 12px; line-height: 1.5; margin: 0 0 16px; font-style: italic;">"${j.shortDescription}"</p>` : ''}
                      ${j.url ? `<a href="${j.url}" style="display: inline-block; background: transparent; border: 1px solid #c084fc; color: #c084fc; text-decoration: none; font-size: 12px; font-weight: 700; padding: 8px 16px; border-radius: 8px;">Apply on Official Site →</a>` : ''}
                    </div>
                  `).join('')}
                ` : ''}
              </div>

              <div style="text-align: center; margin-top: 32px; border-top: 1px solid #1f1f23; padding-top: 24px;">
                <p style="color: #71717a; font-size: 11px;">
                  Open your <a href="${process.env.WEB_URL || 'https://hirematex.vercel.app'}/jobs" style="color: #c084fc; text-decoration: none;">Job Board</a> or <a href="${process.env.WEB_URL || 'https://hirematex.vercel.app'}/external-boards" style="color: #c084fc; text-decoration: none;">External Boards</a> to track and confirm applications.
                </p>
              </div>
            </div>
          `;
          try {
            await emailService.sendGenericEmail(userObj.email, subject, emailHtml);
          } catch (err) {
            console.error('[Notification Worker] Email digest failed:', err);
          }
        }

        // Send Telegram Digest
        if (userObj.isTelegramVerified && userObj.telegramNotificationsEnabled && userObj.telegramChatId) {

          let listText = '';
          
          if (internalJobs.length > 0) {
            listText += `*🌟 Job Board (Trackable)*\n`;
            listText += internalJobs.map((j: any) => `🔹 *${j.title}* at ${j.company} _(${j.sourcePlatform})_`).join('\n');
          }

          if (externalJobs.length > 0) {
            if (internalJobs.length > 0) listText += `\n\n`;
            listText += `*🌐 External Boards (Apply on Site)*\n`;
            listText += externalJobs.map((j: any) => {
              let text = `🔹 *${j.title}* at ${j.company} _(${j.sourcePlatform})_`;
              if (j.url) {
                text += `\n    🔗 [Apply on Official Site](${j.url})`;
              }
              return text;
            }).join('\n\n');
          }
          
          const telegramMsg = [
            `📋 *HireMateX — Consolidated Job Match Digest*`,
            ``,
            `We found *${jobs.length}* new job matches matching your preferences:`,
            ``,
            listText,
            ``,
            `👉 *Open your dashboard to track applications:*`,
            `${process.env.WEB_URL || 'https://hirematex.vercel.app'}/dashboard`
          ].join('\n');
          try {
            await telegramService.sendTextMessage(userObj.telegramChatId, telegramMsg);
          } catch (err) {
            console.error('[Notification Worker] Telegram digest failed:', err);
          }
        }

        // Mark items as sent
        await PendingDigestModel.updateMany(
          { _id: { $in: items.map((i: any) => i._id) } },
          { sent: true }
        ).exec();
      }

      console.log('[Notification Worker] Consolidated digests processed and sent.');
    } else if (name === 'telegram-job-match') {
      const { chatId, jobTitle, company, matchScore, salary, applicationId } = data;
      const user = await UserModel.findOne({ telegramChatId: chatId }).exec();
      if (!user || user.telegramNotificationsEnabled === false) {
        console.log(`[Notification Worker] Skipping Telegram Job Match for ${chatId} (notifications disabled)`);
        return;
      }
      const telegramService = await getDynamicTelegramService();
      await telegramService.sendJobMatchNotification(chatId, jobTitle, company, matchScore, salary, applicationId);
      console.log(`[Notification Worker] Sent Telegram Job Match to ${chatId}`);
    } else if (name === 'telegram-app-update') {
      const { chatId, jobTitle, company, status } = data;
      const user = await UserModel.findOne({ telegramChatId: chatId }).exec();
      if (!user || user.telegramNotificationsEnabled === false) {
        console.log(`[Notification Worker] Skipping Telegram App Update for ${chatId} (notifications disabled)`);
        return;
      }
      const telegramService = await getDynamicTelegramService();
      await telegramService.sendApplicationUpdate(chatId, jobTitle, company, status);
      console.log(`[Notification Worker] Sent Telegram App Update to ${chatId}`);
    } else {
      console.warn(`[Notification Worker] Unknown job type: ${name}`);
    }
  } catch (err) {
    console.error(`[Notification Worker] Job failed:`, err);
    throw err;
  }
};

/**
 * Purge old jobs, orphan PendingDigest records, and stale sent digest items.
 * Runs daily via Agenda cron.
 */
const processPurgeOldJobs = async (job: AgendaJob) => {
  console.log('[Purge Worker] Starting scheduled data purge...');
  try {
    const twelveDaysAgo = new Date(Date.now() - 12 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo  = new Date(Date.now() -  7 * 24 * 60 * 60 * 1000);

    // 1. Purge closed jobs and internal jobs older than 12 days
    const jobResult = await JobModel.deleteMany({
      $or: [
        { isClosed: true },
        { createdAt: { $lt: twelveDaysAgo } },
      ]
    }).exec();
    console.log(`[Purge Worker] Deleted ${jobResult.deletedCount} old/closed internal jobs (older than 12 days).`);

    // 2. Purge expired or 12+ day old external board jobs
    const externalRes = await ExternalBoardJobModel.deleteMany({
      $or: [
        { expiresAt: { $lt: new Date() } },
        { createdAt: { $lt: twelveDaysAgo } },
      ]
    }).exec();
    console.log(`[Purge Worker] Deleted ${externalRes.deletedCount} old/expired ExternalBoardJob records (older than 12 days).`);

    // 3. Purge PendingDigest records whose userId has no matching User document (orphans)
    const allUsers = await UserModel.find({}, { clerkId: 1 }).exec();
    const validUserIds = new Set(allUsers.map((u: any) => u.clerkId));
    const allPending = await PendingDigestModel.find({}, { userId: 1 }).exec();
    const orphanIds = allPending
      .filter((p: any) => !validUserIds.has(p.userId))
      .map((p: any) => p._id);
    if (orphanIds.length > 0) {
      await PendingDigestModel.deleteMany({ _id: { $in: orphanIds } }).exec();
      console.log(`[Purge Worker] Deleted ${orphanIds.length} orphan PendingDigest records.`);
    } else {
      console.log('[Purge Worker] No orphan PendingDigest records found.');
    }

    // 4. Purge already-sent digest items older than 7 days
    const sentResult = await PendingDigestModel.deleteMany({
      sent: true,
      createdAt: { $lt: sevenDaysAgo },
    }).exec();
    console.log(`[Purge Worker] Deleted ${sentResult.deletedCount} stale sent digest items.`);

    // 5. Purge completed and failed one-off Agenda job records older than 24h to prevent unbounded collection growth
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    try {
      const agendaCollection = mongoose.connection.collection('agendaJobs');
      if (agendaCollection) {
        const purgeRes = await agendaCollection.deleteMany({
          type: 'single',
          $or: [
            { lastFinishedAt: { $lt: oneDayAgo } },
            { failedAt: { $lt: oneDayAgo } },
          ],
        });
        console.log(`[Purge Worker] Purged ${purgeRes.deletedCount} stale finished/failed Agenda job records.`);
      }
    } catch (agendaErr: any) {
      console.warn('[Purge Worker] Agenda collection purge skipped:', agendaErr.message);
    }

    console.log('[Purge Worker] Data purge complete.');
  } catch (err) {
    console.error('[Purge Worker] Purge job failed:', err);
    throw err;
  }
};

agenda.define('external-board-new-job', processNotification);
agenda.define('crawled-new-job', processNotification);
agenda.define('queue-for-digest', processNotification);
agenda.define('queue-for-digest-crawled', processNotification);
agenda.define('send-digest-cron', processNotification);
agenda.define('telegram-job-match', processNotification);
agenda.define('telegram-app-update', processNotification);
agenda.define('purge-old-jobs', processPurgeOldJobs);

agenda.define('crawl-jobs', async (job: AgendaJob) => {
  console.log('[Worker] Scheduled crawl-jobs triggered. Pinging API to execute crawl...');
  const apiUrl = process.env.API_URL || 'https://hirematex-api-97nu.onrender.com';
  try {
    const res = await fetch(`${apiUrl}/job/system/trigger-global-crawl`, { method: 'POST' });
    if (!res.ok) throw new Error(`API responded with ${res.status}`);
    console.log('[Worker] API crawl triggered successfully.');
  } catch (err: any) {
    console.error('[Worker] Failed to trigger API crawl:', err.message);
  }
});

// Startup
async function start() {
  await connectDb();
  await agenda.start();
  console.log('Worker background services are listening for queues...');
  
  // Register recurring cron jobs securely in the persistent worker
  await agenda.every('24 hours', 'purge-old-jobs');
  await agenda.every('30 1,6,10 * * *', 'crawl-jobs'); // 07:00, 12:00, 16:00 IST
  await agenda.every('40 1,6,10 * * *', 'send-digest-cron'); // 07:10, 12:10, 16:10 IST
  
  // Initialize Telegram Bot Polling Mode
  try {
    const telegram = await getDynamicTelegramService();
    
    // Setup callback to instantly verify users in MongoDB when they click the bot link
    TelegramService.setAuthCallback(async (chatId: number, userId: string, username: string) => {
      const user = await UserModel.findOne({ clerkId: userId }).exec();
      if (!user) {
        throw new Error('User not found');
      }
      user.telegramChatId = chatId.toString();
      user.telegramUsername = username;
      user.isTelegramVerified = true;
      await user.save();
      console.log(`[TelegramService] Successfully linked user ${userId} to Telegram Chat ${chatId}`);
    });

    await telegram.init();
  } catch (err) {
    console.error('Failed to initialize Telegram service on startup:', err);
  }
}

// --- DUMMY SERVER FOR RENDER FREE TIER ---
// Render Web Services must bind to a PORT within 60 seconds or they fail deployment.
// This allows the worker to be hosted for FREE as a "Web Service".
const app = express();
const port = process.env.PORT || 4000;

app.get('/', (req: any, res: any) => {
  res.send('HireMateX Worker is running!');
});

app.get('/health', (req: any, res: any) => {
  res.status(200).json({ status: 'ok', worker: true });
});

app.listen(port, () => {
  console.log(`[Worker] Dummy web server listening on port ${port} to satisfy Render health checks.`);
});

start().catch(err => {
  console.error('[Worker] Fatal error during startup:', err);
});

