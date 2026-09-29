import { makeBook, type FoliateBook } from "foliate-js/view.js";
import { bookUrl } from "../lib/api";

export async function loadEpub(id: number, signal?: AbortSignal): Promise<FoliateBook> {
  const res = await fetch(bookUrl(id), { signal });
  if (!res.ok) throw new Error(`Book file unavailable (${res.status})`);
  const file = new File([await res.blob()], `${id}.epub`, { type: "application/epub+zip" });
  return makeBook(file);
}
