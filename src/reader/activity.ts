/** Pointer or wheel activity inside section iframes, which the window never sees. */
const target = new EventTarget();
export const readerActivity = {
  ping: () => target.dispatchEvent(new Event("activity")),
  subscribe(cb: () => void) {
    target.addEventListener("activity", cb);
    return () => target.removeEventListener("activity", cb);
  },
};
