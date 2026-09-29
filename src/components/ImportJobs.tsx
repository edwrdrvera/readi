import { useEffect, useState } from "react";
import { XIcon } from "lucide-react";
import type { ImportJob } from "@/lib/api";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

const PROGRESS_AFTER_MS = 1000;

const fileName = (path: string) => path.split("/").pop() ?? path;

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function JobRow({ job, now }: { job: ImportJob; now: number }) {
  const dismiss = useApp((s) => s.dismissJob);
  const cancelImport = useApp((s) => s.cancelImport);
  const active = job.state === "queued" || job.state === "running";
  const showProgress = job.state === "running" && job.started_at !== null && now - job.started_at > PROGRESS_AFTER_MS;
  const percent = job.bytes_total ? Math.round((job.bytes_done / job.bytes_total) * 100) : undefined;
  const cancel = () => void cancelImport(job.id);
  return (
    <li className="flex flex-col gap-1 py-1.5" data-job-state={job.state}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{fileName(job.source_path)}</span>
        {active && (
          <Button variant="ghost" size="sm" className="h-6 px-2" onClick={cancel}>
            Cancel
          </Button>
        )}
        {job.state === "failed" && (
          <Button variant="ghost" size="icon-sm" className="size-6" aria-label="Dismiss" onClick={() => dismiss(job.id)}>
            <XIcon />
          </Button>
        )}
      </div>
      {job.state === "queued" && <span className="text-muted-foreground">Waiting…</span>}
      {job.state === "running" && !showProgress && <span className="text-muted-foreground">Importing…</span>}
      {showProgress && <Progress value={percent} aria-label={`Importing ${fileName(job.source_path)}`} />}
      {job.state === "failed" && <span className="text-destructive">{job.error ?? "Import failed"}</span>}
      {job.state === "cancelled" && <span className="text-muted-foreground">Cancelled</span>}
    </li>
  );
}

/** Import acknowledgement, progress, and failures. Finished imports leave the panel. */
export function ImportJobs() {
  const pending = useApp((s) => s.pendingImports);
  const jobs = useApp((s) => s.jobs);
  const visible = Object.values(jobs)
    .filter((j) => j.state !== "done")
    .sort((a, b) => a.id - b.id);
  const now = useNow(visible.some((j) => j.state === "running"));
  if (pending === 0 && visible.length === 0) return null;
  return (
    <section aria-label="Imports" className="fixed bottom-4 left-4 z-40 w-80 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <ul className="flex max-h-72 flex-col divide-y overflow-y-auto">
        {pending > 0 && (
          <li className="py-1.5 text-muted-foreground" role="status">
            Preparing import…
          </li>
        )}
        {visible.map((j) => (
          <JobRow key={j.id} job={j} now={now} />
        ))}
      </ul>
    </section>
  );
}
