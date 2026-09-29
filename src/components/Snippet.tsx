import type { SearchHit } from "@/lib/api";

export function Snippet({ hit }: { hit: SearchHit }) {
  const [a, b] = hit.snippet_match;
  return (
    <span className="line-clamp-3 text-[13px] leading-snug">
      {hit.snippet.slice(0, a)}
      <mark className="rounded-sm bg-yellow-300/70 px-0.5 text-inherit dark:bg-yellow-500/40">{hit.snippet.slice(a, b)}</mark>
      {hit.snippet.slice(b)}
    </span>
  );
}
