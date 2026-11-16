/** Read-only, conservative host probe. PID reuse, permissions and surviving group members hold recovery. */
export function hostProcessGroupAbsent(pid: number, group: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1 || group !== pid) return false;
  const absent = (target: number) => {
    try { process.kill(target, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  return absent(pid) && absent(-group);
}
