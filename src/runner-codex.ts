const config = require('./config.ts');
const { uploadsPromptBlock } = require('./media.ts');
const { startRunnerTask } = require('./runner-common.ts');

function startCodexTask(input: {
  prompt: string;
  replyContext?: string | null;
  uploads: Array<Record<string, unknown>>;
  historyContext: string;
  statusContext: string;
  senderName: string;
  onProgress?: (progress: Record<string, unknown>) => Promise<void> | void;
}): Record<string, unknown> {
  const promptText = [
    `You are the campground Telegram bot Codex runner operating inside ${config.ROOT_DIR}.`,
    'Work only inside the current repository worktree.',
    'Keep your final response concise and operational.',
    'Maintain a short external status file named .campground-runner-status.json at the workspace root while you work.',
    'Use only concise operational summaries there, never private chain-of-thought.',
    'Treat that file as a public reasoning trace for Telegram.',
    'Status file JSON shape: {"stage":"planning|editing|testing|replying","summary":"what you are doing","hypothesis":"current guess or approach","evidence":"observed facts supporting it","decision":"key decision or finding","next_step":"immediate next step","updated_at":"ISO timestamp"}.',
    'Update that file when your stage changes, when you make a key decision, and before your final reply.',
    'Watch for live Telegram follow-up instructions in .campground-runner-steer.txt at the workspace root.',
    'Read that steer file before major edits, before tests, and again immediately before your final reply.',
    'If new steer entries appear, treat them as updated user instructions for this same task without restarting from scratch.',
    'If a steer entry references files under .campground-runner-steer-uploads/, inspect those files as part of the latest instruction.',
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
    runner: 'codex',
    promptText,
    promptPreview: input.prompt,
    uploads: input.uploads,
    timeoutSeconds: config.CODEX_TIMEOUT_SECONDS,
    onProgress: input.onProgress,
    buildCommand: (context: Record<string, unknown>) => {
      const args = ['-a', 'never', '-C', String(context.cwd)];
      if (config.CODEX_MODEL) {
        args.push('-m', config.CODEX_MODEL);
      }
      for (const upload of input.uploads) {
        if (String(upload.mimeType || '').startsWith('image/') || upload.kind === 'photo') {
          args.push('-i', String(upload.localPath));
        }
      }
      args.push('exec', '-s', 'workspace-write', '--ephemeral', '--color', 'never');
      return {
        command: 'codex',
        args,
      };
    },
  });
}

module.exports = {
  startCodexTask,
};
