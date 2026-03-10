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
  resumeSessionId?: string | null;
  onProgress?: (progress: Record<string, unknown>) => Promise<void> | void;
}): Record<string, unknown> {
  const promptText = input.resumeSessionId
    ? [
        'Continue the existing campground Telegram task conversation.',
        'Use the prior Claude session as context and continue the work instead of restarting from scratch.',
        'If more Telegram replies arrive while you are running, they will appear as additional user turns in this same conversation.',
        '',
        'Current monitor status:',
        input.statusContext || 'No status available.',
        '',
        'Reply context:',
        input.replyContext || 'None.',
        '',
        'Attached local files:',
        uploadsPromptBlock(input.uploads, config.ROOT_DIR),
        '',
        `Latest Telegram message from ${input.senderName}:`,
        input.prompt,
      ].join('\n')
    : [
        `You are the campground Telegram bot assistant operating inside ${config.ROOT_DIR}.`,
        'You are running headless inside a task-specific git worktree when one is available.',
        'Keep your reply concise and operational. State the outcome first.',
        'Stay focused on this repo and the campground monitor workflow.',
        'Maintain a short external status file named .campground-runner-status.json at the workspace root while you work.',
        'Use only concise operational summaries there, never private chain-of-thought.',
        'Treat that file as a public reasoning trace for Telegram.',
        'Status file JSON shape: {"stage":"planning|editing|testing|replying","summary":"what you are doing","hypothesis":"current guess or approach","evidence":"observed facts supporting it","decision":"key decision or finding","next_step":"immediate next step","updated_at":"ISO timestamp"}.',
        'Update that file when your stage changes, when you make a key decision, and before your final reply.',
        'If live Telegram follow-up instructions arrive while you are still running, they will appear as new user turns in this same conversation.',
        'Treat those extra user turns as updated instructions for this task without restarting from scratch.',
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
    resumeSessionId: input.resumeSessionId || null,
    onProgress: input.onProgress,
    buildCommand: (context: Record<string, unknown>) => {
      const args = [
        '-p',
        '--verbose',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--replay-user-messages',
        '--model',
        config.CLAUDE_MODEL,
        '--dangerously-skip-permissions',
        '--disable-slash-commands',
      ];
      if (context.resumeSessionId) {
        args.push('--resume', String(context.resumeSessionId));
      }
      return {
        command: 'claude',
        args,
        stdinMode: 'claude-json-input',
        streamFormat: 'claude-stream-json',
      };
    },
  });
}

module.exports = {
  startClaudeTask,
};
