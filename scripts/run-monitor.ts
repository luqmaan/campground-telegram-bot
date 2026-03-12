const config = require('../src/config.ts');
const { CampgroundMonitor } = require('../src/monitor.ts');
const { nowIso } = require('../src/utils.ts');

function log(level: string, message: string, ...args: unknown[]): void {
  const parts = [`[${nowIso()}] [${level}] ${message}`];
  if (args.length > 0) {
    parts.push(String(args.map((a) => (a instanceof Error ? a.stack || a.message : JSON.stringify(a))).join(' ')));
  }
  process.stdout.write(`${parts.join(' ')}\n`);
}

async function sendTelegram(
  chatId: string | number,
  text: string,
  options: { threadId?: number | null; html?: boolean } = {}
): Promise<void> {
  const params: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: options.html ? 'HTML' : undefined,
  };
  if (options.threadId) {
    params.message_thread_id = options.threadId;
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      log('WARN', `Telegram sendMessage failed: ${response.status}`, body.slice(0, 200));
    }
  } catch (error) {
    log('WARN', `Telegram sendMessage error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const monitor = new CampgroundMonitor(sendTelegram);

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

async function main(): Promise<void> {
  log('INFO', `Starting bilal69-monitor pid=${process.pid}`);
  await monitor.startScheduler();
  log('INFO', 'Monitor scheduler running');
}

main().catch((error: Error) => {
  log('ERROR', 'Fatal error', error.stack || error.message);
  process.exit(1);
});
