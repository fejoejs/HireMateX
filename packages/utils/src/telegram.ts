import TelegramBot from 'node-telegram-bot-api';

export interface TelegramConfig {
  botToken?: string;
  isWorker?: boolean;
}

export class TelegramService {
  private botToken: string;
  private isWorker: boolean;

  // Singleton bot instance to prevent multiple polling loops
  private static bot: TelegramBot | null = null;
  // External callback registered by the worker to process /start commands
  private static onAuthCallback: ((chatId: number, userId: string, username: string) => Promise<void>) | null = null;

  constructor(config?: TelegramConfig) {
    this.botToken = config?.botToken || process.env.TELEGRAM_BOT_TOKEN || '';
    this.isWorker = config?.isWorker || false;
  }

  private get isConfigured(): boolean {
    return Boolean(this.botToken);
  }

  /**
   * Initializes the Telegram Bot.
   * If isWorker is true, it starts polling for incoming messages.
   */
  public async init(): Promise<void> {
    if (!this.isConfigured) return;

    if (!TelegramService.bot) {
      if (this.isWorker) {
        console.log('[TelegramService] Initializing Telegram Bot in POLLING mode...');
        TelegramService.bot = new TelegramBot(this.botToken, { polling: true });

        // Listen for /start messages (Magic Link Deep Linking)
        TelegramService.bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
          const chatId = msg.chat.id;
          const userId = match && match[1] ? match[1] : '';
          const username = msg.from?.username || msg.from?.first_name || 'User';

          if (userId && TelegramService.onAuthCallback) {
            try {
              await TelegramService.onAuthCallback(chatId, userId, username);
              await TelegramService.bot?.sendMessage(chatId, `✅ Successfully linked your Telegram account to HireMateX!\n\nYou will now receive live job matches and application updates here.`);
            } catch (err) {
              console.error('[TelegramService] Auth callback failed:', err);
              await TelegramService.bot?.sendMessage(chatId, `❌ Failed to link account. Please try clicking the button in your dashboard again.`);
            }
          } else {
             await TelegramService.bot?.sendMessage(chatId, `👋 Welcome to the HireMateX Bot!\n\nTo link your account and receive notifications, please click the "Connect via Telegram" button from your HireMateX dashboard settings.`);
          }
        });

        // Debug log for ALL incoming messages to ensure the bot is receiving them
        TelegramService.bot.on('message', (msg) => {
          console.log(`[TelegramService] Received raw message:`, msg.text, `from chat`, msg.chat.id);
        });

        // Handle polling errors to ensure we know if the token is wrong or webhook is conflicting
        TelegramService.bot.on('polling_error', (error) => {
          console.error(`[TelegramService] POLLING ERROR:`, error.message || error);
        });

      } else {
        // API server just needs to send messages, no polling
        TelegramService.bot = new TelegramBot(this.botToken, { polling: false });
      }
    }
  }

  /**
   * Register the callback to handle user verification
   */
  public static setAuthCallback(cb: (chatId: number, userId: string, username: string) => Promise<void>) {
    TelegramService.onAuthCallback = cb;
  }

  /**
   * Send a raw text message
   */
  public async sendTextMessage(chatId: string, message: string, opts?: any): Promise<boolean> {
    if (!this.isConfigured || !TelegramService.bot) {
      console.warn(`[TelegramService] Missing config or bot not initialized. Mocking message to ${chatId}: ${message}`);
      return true;
    }
    try {
      await TelegramService.bot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...opts });
      return true;
    } catch (err: any) {
      console.error('[TelegramService] Failed to send Telegram message:', err.message);
      return false;
    }
  }

  public async sendJobMatchNotification(
    chatId: string,
    jobTitle: string,
    company: string,
    matchScore: number,
    salary: string,
    applicationId: string
  ): Promise<boolean> {
    const dashboardUrl = process.env.WEB_URL || 'https://hirematex.vercel.app';
    const text = 
      `🎯 *New High-Match Job Found!*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `*${jobTitle}*\n` +
      `🏢 ${company}\n` +
      `📊 Match Score: *${matchScore}%*\n` +
      `💰 Salary: ${salary || 'Not specified'}\n\n` +
      `⚡ Your tailored resume is being prepared!`;
      
    const opts = {
      reply_markup: {
        inline_keyboard: [[{ text: '🚀 Open Dashboard', url: `${dashboardUrl}/dashboard` }]]
      }
    };
    return this.sendTextMessage(chatId, text, opts);
  }

  public async sendApplicationUpdate(
    chatId: string,
    jobTitle: string,
    company: string,
    status: string
  ): Promise<boolean> {
    let icon = 'ℹ️';
    if (status === 'Submitted') icon = '✅';
    if (status === 'Failed') icon = '❌';
    if (status === 'Interview') icon = '🎉';

    const dashboardUrl = process.env.WEB_URL || 'https://hirematex.vercel.app';
    const text = 
      `${icon} *Application Update*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `*${jobTitle}*\n` +
      `🏢 ${company}\n\n` +
      `📋 Status: *${status}*`;

    const opts = {
      reply_markup: {
        inline_keyboard: [[{ text: '🚀 View in Dashboard', url: `${dashboardUrl}/dashboard` }]]
      }
    };
    return this.sendTextMessage(chatId, text, opts);
  }
}
