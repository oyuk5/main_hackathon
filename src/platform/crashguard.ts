/**
 * Keeps the server up when one portal's job throws where no promise catches it (for example an
 * assertion inside the HTTP client's socket handling). Without this, one such error stops the whole
 * process: every portal stops being read, and `docker run` without a restart policy stays down.
 * State lives in SQLite, so the other portals carry on; the error is logged with its stack.
 */
export function installCrashGuard(log: (message: string) => void = (m) => console.error(m)): () => void {
  const describe = (e: unknown) => (e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e));
  const onException = (e: unknown) => log(`Uncaught error, server keeps running: ${describe(e)}`);
  const onRejection = (e: unknown) => log(`Unhandled rejection, server keeps running: ${describe(e)}`);
  process.on("uncaughtException", onException);
  process.on("unhandledRejection", onRejection);
  return () => {
    process.off("uncaughtException", onException);
    process.off("unhandledRejection", onRejection);
  };
}
