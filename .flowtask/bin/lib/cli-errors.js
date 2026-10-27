/**
 * Run a CLI action, capturing any thrown error and reporting it on stderr
 * with a non-zero exit code instead of an unhandled stack trace.
 */
export async function runCliAction(action, { stderr = process.stderr, setExitCode = true } = {}) {
  try {
    await action();
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    stderr.write(`[FlowTask] ${message}\n`);
    if (setExitCode) process.exitCode = 1;
  }
}
