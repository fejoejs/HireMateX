# HireMateX 🤖

> **Next-Generation Autonomous AI Job Search, Resume Optimization & Verified ATS Application Platform**

[![Live Demo](https://img.shields.io/badge/Live%20Demo-hirematex.vercel.app-7c3aed?style=for-the-badge&logo=vercel&logoColor=white)](https://hirematex.vercel.app)
[![Next.js](https://img.shields.io/badge/Next.js-16.2-black?style=for-the-badge&logo=next.js&logoColor=white)](https://nextjs.org/)
[![NestJS](https://img.shields.io/badge/NestJS-10.0-E0234E?style=for-the-badge&logo=nestjs&logoColor=white)](https://nestjs.com/)
[![MongoDB](https://img.shields.io/badge/MongoDB-Atlas-47A248?style=for-the-badge&logo=mongodb&logoColor=white)](https://www.mongodb.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Agenda](https://img.shields.io/badge/Agenda-MongoDB%20Worker-22c55e?style=for-the-badge&logo=mongodb&logoColor=white)](https://github.com/agenda/agenda)

---

## 🌐 Live Web Application

- **Production URL:** [https://hirematex.vercel.app](https://hirematex.vercel.app)

---

## 🌟 About HireMateX

**HireMateX** is an intelligent, end-to-end AI career accelerator and automated job application platform designed to help job seekers discover matching vacancies, optimize their resumes against applicant tracking systems (ATS), and track their entire job application pipeline in one unified dashboard.

Powered by **Claude AI & Google Gemini AI**, HireMateX crawls official career boards (Greenhouse, Lever, etc.) and global job aggregators 3 times daily, evaluates real-time ATS compatibility scores, tailors resumes and cover letters for specific job descriptions, and provides seamless capture from LinkedIn, Indeed, and Naukri via the HireMateX Chrome Extension.

---

## ✨ Key Features & Capabilities

### 1. 🤖 AI Resume Optimizer & ATS Compatibility Checker
- **Deep Resume Analysis:** Parses PDF and DOCX resumes to extract contact information, technical skills, work experience, and education.
- **ATS Compliance Scoring:** Evaluates resume formatting, section structure, keyword density, and quantifiable impact metrics with an overall ATS readiness score out of 100.
- **AI Bullet Point Enhancer:** Powered by advanced AI models (Claude & Gemini) to automatically rewrite experience bullets using the Action Verb + Context + Quantifiable Metric framework to maximize recruiter engagement.
- **Skill Gap Detection:** Identifies critical competencies required by a target job description that are missing from your resume.

### 2. 🌐 Multi-Board Job Aggregator & Automated 3x Daily Crawler
- **Scheduled 3x Daily Crawls:** Automatically scrapes fresh opportunities at **7:00 AM, 12:00 PM, and 4:00 PM IST** from official company career portals (Greenhouse, Lever, Ashby) and global aggregators (Adzuna, JSearch, Remote OK, Himalayas, Remotive, We Work Remotely).
- **Preference-Based Scoring:** Ranks and filters opportunities against your career preferences (target job titles, core skills, experience level, salary range, and preferred work location).
- **24-Hour "NEW" Badge:** Highlights newly discovered postings with a distinct vibrant badge and positions them at the top of your feed for 24 hours.
- **Automated 12-Day Data Lifecycle:** Automatically purges expired and 12+ day old listings to keep your feeds clean, fast, and relevant.

### 3. 🧩 HireMateX Chrome Extension (External Job Board Capture)
- **1-Click Job Capture:** Instantly save job postings while browsing **LinkedIn, Indeed, and Naukri** directly into your HireMateX dashboard.
- **Floating Action Widget:** Live in-page widget with instant save, applied status toggle, and duplicate detection.
- **Separate External Board:** Dedicated board to manage opportunities saved from external networks with custom notes, deadline tracking, and status tags.

### 4. 🚀 Verified Greenhouse ATS Direct Submissions
- **Official ATS API Integration:** Submits candidate dossiers (resume and customized cover letter) directly to official company Greenhouse ATS endpoints.
- **Authentic Verification Badges:** Transparently distinguishes between verified direct API applications (`🛡️ Verified Application`) and self-reported applications (`📋 Applied`).

### 5. ✍️ AI Cover Letter & Resume Tailor Studio
- **Role-Specific Cover Letters:** Generates tailored, persuasive cover letters based on your background and the target job requirements.
- **Interactive Editing & Export:** Review, customize, and save tailored documents before applying.

### 6. 📬 Multi-Channel Notification Engine
- **Instant Match Alerts:** Real-time email notifications when high-match opportunities (80%+) are discovered.
- **Telegram Bot Integration:** Connect your Telegram account via `@BotFather` to receive instant job alerts and application status updates on mobile.
- **Daily Opportunity Digests:** Clean, beautifully formatted email digests highlighting top daily matches.

---

## 🛠️ Technology Stack

- **Frontend:** Next.js 16 (App Router), React 19, TypeScript, Vanilla CSS & TailwindCSS
- **Backend API:** NestJS 10, TypeScript, Express, Class Validator
- **Database & Queueing:** MongoDB Atlas, Mongoose, Agenda (MongoDB-native scheduler)
- **AI & Intelligent Processing:** Anthropic Claude AI & Google Gemini 2.5 AI SDK, `pdf-parse`, `mammoth` (DOCX parsing)
- **Authentication:** Firebase Authentication (Google OAuth & Email OTP)
- **Notifications:** Brevo API / SMTP (Nodemailer), Telegram Bot API
- **Browser Extension:** Chrome Manifest V3 (Vanilla JavaScript)

---

## 🚀 Getting Started Locally

### Prerequisites
- **Node.js**: `v18.0.0` or higher
- **npm** or **pnpm**
- **MongoDB**: Local MongoDB instance or MongoDB Atlas connection string

### 1. Clone the Repository
```bash
git clone https://github.com/fejoejs/HireMateX.git
cd HireMateX
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Environment Variables Configuration

Create a `.env` file in the root directory:

```env
# MongoDB Connection
MONGODB_URI=mongodb+srv://<username>:<password>@cluster0.mongodb.net/hirematex?retryWrites=true&w=majority

# AI API Keys
GEMINI_API_KEY=your_gemini_api_key_here
ANTHROPIC_API_KEY=your_claude_api_key_here

# JWT & Security
JWT_SECRET=your_secure_jwt_secret_key
EXTENSION_JWT_SECRET=your_secure_extension_jwt_secret

# Job Aggregators (Optional)
ADZUNA_APP_ID=your_adzuna_app_id
ADZUNA_API_KEY=your_adzuna_api_key
RAPIDAPI_KEY=your_rapidapi_key

# Email & Notifications (Brevo / SMTP)
BREVO_API_KEY=your_brevo_api_key
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=your_smtp_user
SMTP_PASS=your_smtp_password
SMTP_FROM="HireMateX <notifications@hirematex.com>"

# Telegram Bot (Optional)
TELEGRAM_BOT_TOKEN=your_telegram_bot_token

# Web Frontend Config
NEXT_PUBLIC_API_URL=http://localhost:4000
```

### 4. Run Development Servers
```bash
# Start all workspaces concurrently (Web, API, Background Worker)
npm run dev
```

The web application will be accessible at `http://localhost:3000` and the API server at `http://localhost:4000`.

### 5. Build for Production
```bash
npm run build
```

---

## 📄 License

This project is licensed under the **MIT License**.

---

<p align="center">
  Crafted with ❤️ by the <b>HireMateX Team</b>
</p>