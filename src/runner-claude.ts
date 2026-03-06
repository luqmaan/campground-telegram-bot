const config = require('./config.ts');
const { uploadsPromptBlock } = require('./media.ts');
const { startRunnerTask } = require('./runner-common.ts');

function startClaudeTask(input: {
  prompt: string;
  replyContext?: string | null;
  uploads: Array<Record<string, unknown>>;
  historyContext: string;
  statusContext: string;
  senderName: string;
  onProgress?: (progress: Record<string, unknown>) => Promise<void> | void;
}): Record<string, unknown> {
  const promptText = [
    `You are the campground Telegram bot assistant operating inside ${config.ROOT_DIR}.`,
    'You are running headless inside a task-specific git worktree when one is available.',
    'Keep your reply concise and operational. State the outcome first.',
    'Stay focused on this repo and the campground monitor workflow.',
    'Maintain a short external status file named .campground-runner-status.json at the workspace root while you work.',
    'Use only concise operational summaries there, never private chain-of-thought.',
    'Treat that file as a public reasoning trace for Telegram.',
    'Status file JSON shape: {"stage":"planning|editing|testing|replying","summary":"what you are doing","hypothesis":"current guess or approach","evidence":"observed facts supporting it","decision":"key decision or finding","next_step":"immediate next step","updated_at":"ISO timestamp"}.',
    'Update that file when your stage changes, when you make a key decision, and before your final reply.',
    '',
    'Current monitor status:',
    input.statusContext || 'No status available.',
    '',
    'Recent chat history:',
    input.historyContext || 'None.',
    '',
    'Reply context:',
    input.replyContext || 'None.',
    '',
    'Attached local files:',
    uploadsPromptBlock(input.uploads, config.ROOT_DIR),
    '',
    `Latest Telegram message from ${input.senderName}:`,
    input.prompt,
  ].join('\n');

  return startRunnerTask({
    runner: 'claude',
    promptText,
    promptPreview: input.prompt,
    uploads: input.uploads,
    timeoutSeconds: config.CLAUDE_TIMEOUT_SECONDS,
    onProgress: input.onProgress,
    buildCommand: () => ({
      command: 'claude',
      args: [
        '-p',
        '--verbose',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--model',
        config.CLAUDE_MODEL,
        '--dangerously-skip-permissions',
        '--no-session-persistence',
        '--disable-slash-commands',
      ],
      streamFormat: 'claude-stream-json',
    }),
  });
}

module.exports = {
  startClaudeTask,
};
