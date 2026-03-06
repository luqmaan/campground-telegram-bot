const config = require('./config.ts');
const { uploadsPromptBlock } = require('./media.ts');
const { startRunnerTask } = require('./runner-common.ts');

function startCodexTask(input: {
  prompt: string;
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
    '',
    'Current monitor status:',
    input.statusContext || 'No status available.',
    '',
    'Recent chat history:',
    input.historyContext || 'None.',
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
