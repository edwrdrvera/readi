import type { SearchHit } from "@/lib/api";
import { cn } from "@/lib/utils";

export function Snippet({ hit, className }: { hit: SearchHit; className?: string }) {
  const [a, b] = hit.snippet_match;
  return (
    <span className={cn("line-clamp-3 text-[13px] leading-snug", className)}>
      {/* WebKit drops the space before the mark when it wraps, so VoiceOver read "silverharbor". */}
      <span className="sr-only">{hit.snippet}</span>
      <span aria-hidden="true">
        {hit.snippet.slice(0, a)}
        <mark className="rounded-sm bg-yellow-300/70 px-0.5 text-inherit dark:bg-yellow-500/40">{hit.snippet.slice(a, b)}</mark>
        {hit.snippet.slice(b)}
      </span>
    </span>
  );
}
