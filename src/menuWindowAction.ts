/**
 * Runs a native window action (minimise, maximise, close) and reports a refusal
 * instead of swallowing it.
 *
 * The title bar buttons used to drop the rejection on the floor: a window the OS
 * refused to minimise simply did nothing, with no trace anywhere. The action
 * still resolves either way, so callers can fire it from an event handler
 * without an unhandled rejection.
 */
export async function runWindowAction<T>(
  action: () => Promise<T>,
  report: (error: unknown) => void,
): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    report(error);
    return undefined;
  }
}
