import type { ImportJob, JobState } from "./api";

export const TERMINAL: ReadonlySet<JobState> = new Set(["done", "failed", "cancelled"]);
export const isTerminal = (job: ImportJob) => TERMINAL.has(job.state);

const RANK: Record<JobState, number> = { queued: 0, running: 1, done: 2, failed: 2, cancelled: 2 };

/**
 * The event stream and the import_books/list_import_jobs replies can arrive
 * in either order, so an older snapshot never replaces a newer one.
 */
export function upsertJob(jobs: Record<number, ImportJob>, job: ImportJob): Record<number, ImportJob> {
  const prev = jobs[job.id];
  if (prev) {
    if (isTerminal(prev)) return jobs;
    if (RANK[job.state] < RANK[prev.state]) return jobs;
    if (job.state === prev.state && job.bytes_done < prev.bytes_done) return jobs;
  }
  return { ...jobs, [job.id]: job };
}
