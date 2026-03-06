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
        '--model',
        config.CLAUDE_MODEL,
        '--dangerously-skip-permissions',
        '--no-session-persistence',
        '--disable-slash-commands',
      ],
    }),
  });
}

module.exports = {
  startClaudeTask,
};
