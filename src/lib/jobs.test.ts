import { expect, it } from "vitest";
import type { ImportJob } from "./api";
import { upsertJob } from "./jobs";

const job = (over: Partial<ImportJob>): ImportJob => ({
  id: 1,
  source_path: "/a.epub",
  state: "queued",
  outcome: null,
  book_id: null,
  error: null,
  bytes_done: 0,
  bytes_total: null,
  created_at: 0,
  started_at: null,
  finished_at: null,
  ...over,
});

it("inserts and advances a job", () => {
  let jobs = upsertJob({}, job({}));
  jobs = upsertJob(jobs, job({ state: "running", bytes_done: 5 }));
  expect(jobs[1].state).toBe("running");
  jobs = upsertJob(jobs, job({ state: "done", outcome: "imported", book_id: 9 }));
  expect(jobs[1].book_id).toBe(9);
});

it("ignores stale snapshots", () => {
  let jobs = upsertJob({}, job({ state: "running", bytes_done: 10 }));
  expect(upsertJob(jobs, job({ state: "queued" }))).toBe(jobs);
  expect(upsertJob(jobs, job({ state: "running", bytes_done: 3 }))).toBe(jobs);
  jobs = upsertJob(jobs, job({ state: "failed", error: "bad" }));
  expect(upsertJob(jobs, job({ state: "done" }))).toBe(jobs);
});
