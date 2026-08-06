/**
 * Email Service for OTP Verification and Application Notifications
 * 
 * Uses Nodemailer with SMTP configuration. Supports Gmail, Resend, SendGrid, or any SMTP provider.
 * Falls back to console logging when SMTP is not configured (development mode).
 */

export interface EmailConfig {
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  fromName?: string;
  fromEmail?: string;
}

export class EmailService {
  private config: Required<EmailConfig>;
  private transporter: any; // nodemailer transporter

  constructor(config?: EmailConfig) {
    this.config = {
      smtpHost: config?.smtpHost || process.env.SMTP_HOST || '',
      smtpPort: config?.smtpPort || parseInt(process.env.SMTP_PORT || '587', 10),
      smtpUser: config?.smtpUser || process.env.SMTP_USER || '',
      smtpPass: config?.smtpPass || process.env.SMTP_PASS || '',
      fromName: config?.fromName || process.env.EMAIL_FROM_NAME || 'HireMateX',
      fromEmail: config?.fromEmail || process.env.EMAIL_FROM_ADDRESS || 'noreply@aijobcopilot.com',
    };

    this.initTransporter();
  }

  private async initTransporter() {
    // If using Brevo HTTP API, don't initialize Nodemailer
    if (this.config.smtpHost === 'brevo-http') {
      if (!this.config.smtpPass) {
        console.error('[Email Service] Brevo HTTP requires an API Key in SMTP_PASS');
      } else {
        console.log('[Email Service] Initialized with Brevo HTTP API');
      }
      return;
    }

    if (!this.config.smtpHost || !this.config.smtpUser) {
      if (process.env.NODE_ENV === 'production') {
        console.error('[Email Service] CRITICAL ERROR: SMTP credentials (SMTP_HOST or SMTP_USER) are not configured in production!');
        throw new Error('SMTP credentials are required in production to prevent silent email failures');
      }
      console.log('[Email Service] SMTP not configured — using console log mock mode');
      return;
    }

    try {
      const nodemailer = require('nodemailer');
      this.transporter = nodemailer.createTransport({
        host: this.config.smtpHost,
        port: this.config.smtpPort,
        secure: this.config.smtpPort === 465,
        auth: {
          user: this.config.smtpUser,
          pass: this.config.smtpPass,
        },
      });
      console.log('[Email Service] Initialized with SMTP transport');
    } catch (error: any) {
      console.error('[Email Service] Failed to initialize transporter:', error.message);
    }
  }

  private async sendEmail(to: string, subject: string, html: string): Promise<any> {
    // Brevo HTTP API path
    if (this.config.smtpHost === 'brevo-http') {
      try {
        const response = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'api-key': this.config.smtpPass,
          },
          body: JSON.stringify({
            sender: { name: this.config.fromName, email: this.config.fromEmail },
            to: [{ email: to }],
            subject: subject,
            htmlContent: html,
          }),
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(`Brevo API Error: ${response.status} - ${JSON.stringify(errData)}`);
        }
        
        console.log(`[Email Service - Brevo] Sent to ${to}: ${subject}`);
        return await response.json();
      } catch (error: any) {
        console.error(`[Email Service - Brevo] Failed to send to ${to}:`, error.message);
        throw error;
      }
    }

    if (!this.transporter) {
      console.log(`[Email Mock] To: ${to}`);
      console.log(`[Email Mock] Subject: ${subject}`);
      console.log(`[Email Mock] Body: ${html.replace(/<[^>]*>/g, '')}`);
      return { mock: true, to, subject };
    }

    try {
      // Adding a 15-second timeout. Nodemailer TLS handshakes can take 6-10 seconds.
      const result = await Promise.race([
        this.transporter.sendMail({
          from: `"${this.config.fromName}" <${this.config.fromEmail}>`,
          to,
          subject,
          html,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SMTP Connection Timeout (Blocked by Firewall or Slow Network)')), 15000))
      ]);
      console.log(`[Email Service] Sent to ${to}: ${subject}`);
      return result;
    } catch (error: any) {
      console.error(`[Email Service] Failed to send to ${to}:`, error.message);
      
      if (process.env.NODE_ENV === 'production') {
        throw new Error(`Email delivery failed: ${error.message}`);
      }
      
      // Fallback to mock mode so the app doesn't crash in local development
      console.log(`[Email Mock Fallback] To: ${to}`);
      console.log(`[Email Mock Fallback] Subject: ${subject}`);
      console.log(`[Email Mock Fallback] Body: ${html.replace(/<[^>]*>/g, '')}`);
      return { mock: true, to, subject, error: error.message };
    }
  }

  // ─── Shared email header/footer helpers ────────────────────────────────────
  // Uses table-based layout for universal email client support (Gmail, Outlook, Apple Mail).
  // Logo + brand name are centered via align="center" on the outer td.

  public emailHeader(logoSize: number = 36, fontSize: number = 28): string {
    return `
      <table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation" align="center" style="margin: 0 auto 24px auto; text-align: center;">
        <tr>
          <td align="center" style="text-align: center; padding: 0;">
            <span style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; font-size: ${fontSize}px; font-weight: 800; letter-spacing: -0.5px; line-height: 1.2; text-align: center; display: inline-block;">
              <span style="color: #c084fc; font-weight: 800;">HireMate</span><span style="color: #38bdf8; font-weight: 900; margin-left: 1px;">X</span>
            </span>
          </td>
        </tr>
      </table>`;
  }

  /**
   * Wrap any inner HTML with the standard branded dark-background layout.
   * Used for support ticket emails and any custom notification templates.
   */
  public wrapWithBrandedHeader(innerHtml: string): string {
    return `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; max-width: 480px; margin: 0 auto;
                  padding: 40px 24px; background-color: #050508; color: #fafafa; border-radius: 16px; border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 0 20px 40px rgba(0,0,0,0.6);">
        ${this.emailHeader(44, 32)}
        ${innerHtml}
      </div>
    `;
  }

  /**
   * Send 6-digit OTP verification email
   */
  async sendOtp(to: string, otp: string): Promise<any> {
    const subject = `${otp} is your HireMateX verification code`;
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px; background-color: #050508; color: #fafafa; border-radius: 16px; border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 0 20px 40px rgba(0,0,0,0.6);">
        ${this.emailHeader(44, 32)}
        <p style="color: #a1a1aa; font-size: 14px; margin-bottom: 24px; text-align: center;">Enter this code to verify your email address:</p>
        <div style="background: rgba(168, 85, 247, 0.05); border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 24px;">
          <span style="font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #c084fc; font-family: monospace;">${otp}</span>
        </div>
        <p style="color: #71717a; font-size: 12px; text-align: center;">This code expires in <strong>10 minutes</strong>. If you didn't request this, ignore this email.</p>
      </div>
    `;
    return this.sendEmail(to, subject, html);
  }

  /**
   * Send forgot password OTP email
   */
  async sendForgotPasswordOtp(to: string, otp: string): Promise<any> {
    const subject = `${otp} is your HireMateX password reset code`;
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px; background-color: #050508; color: #fafafa; border-radius: 16px; border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 0 20px 40px rgba(0,0,0,0.6);">
        ${this.emailHeader(44, 32)}
        <p style="color: #a1a1aa; font-size: 14px; margin-bottom: 24px; text-align: center;">Enter this code to reset your password:</p>
        <div style="background: rgba(168, 85, 247, 0.05); border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 24px;">
          <span style="font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #c084fc; font-family: monospace;">${otp}</span>
        </div>
        <p style="color: #71717a; font-size: 12px; text-align: center;">This code expires in <strong>10 minutes</strong>. If you didn't request a password reset, you can safely ignore this email.</p>
      </div>
    `;
    return this.sendEmail(to, subject, html);
  }

  /**
   * Send job match notification email
   */
  async sendJobMatchNotification(
    to: string,
    jobTitle: string,
    company: string,
    matchScore: number,
    dashboardUrl: string,
  ): Promise<any> {
    const subject = `🚀 ${matchScore}% Match Found — ${jobTitle} at ${company}`;
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px; background-color: #050508; color: #fafafa; border-radius: 16px; border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 0 20px 40px rgba(0,0,0,0.6);">
        ${this.emailHeader(36, 26)}
        <div style="background: rgba(168, 85, 247, 0.05); border: 1px solid rgba(168, 85, 247, 0.2); border-radius: 12px; padding: 24px; margin-bottom: 20px;">
          <h2 style="font-size: 18px; font-weight: 700; margin: 0 0 8px;">${jobTitle}</h2>
          <p style="color: #a1a1aa; font-size: 13px; margin: 0 0 16px;">${company}</p>
          <div style="display: inline-block; background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.3); border-radius: 8px; padding: 8px 16px;">
            <span style="font-size: 24px; font-weight: 800; color: #22c55e;">${matchScore}%</span>
            <span style="font-size: 12px; color: #86efac; margin-left: 4px;">Match</span>
          </div>
        </div>
        <p style="color: #a1a1aa; font-size: 13px; margin-bottom: 20px; text-align: center;">Your tailored resume and cover letter are ready for review.</p>
        <a href="${dashboardUrl}" style="display: block; text-align: center; background: transparent; color: #c084fc; font-weight: 700; font-size: 14px; padding: 14px; border-radius: 12px; border: 1px solid #c084fc; text-decoration: none;">Review &amp; Apply →</a>
        <p style="color: #52525b; font-size: 11px; text-align: center; margin-top: 20px;">Or reply "APPLY" on WhatsApp to apply instantly.</p>
      </div>
    `;
    return this.sendEmail(to, subject, html);
  }

  /**
   * Send application status update email
   */
  async sendApplicationUpdate(
    to: string,
    jobTitle: string,
    company: string,
    status: string,
  ): Promise<any> {
    const subject = `Application Update: ${jobTitle} at ${company} — ${status}`;
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px; background-color: #050508; color: #fafafa; border-radius: 16px; border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 0 20px 40px rgba(0,0,0,0.6);">
        ${this.emailHeader(36, 26)}
        <p style="color: #fafafa; font-size: 14px; text-align: center;">Your application for <strong>${jobTitle}</strong> at <strong>${company}</strong> has been updated:</p>
        <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; padding: 16px; margin: 16px 0; text-align: center;">
          <span style="font-size: 16px; font-weight: 700; color: #c084fc;">Status: ${status}</span>
        </div>
        <p style="color: #71717a; font-size: 12px; text-align: center;">Visit your dashboard for full details.</p>
      </div>
    `;
    return this.sendEmail(to, subject, html);
  }

  /**
   * Send a generic email with HTML content (used for external boards matching digest)
   */
  async sendGenericEmail(to: string, subject: string, html: string): Promise<any> {
    return this.sendEmail(to, subject, html);
  }
}
