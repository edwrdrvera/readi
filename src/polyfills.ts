// foliate-js and PDF.js call these; WebKit gained them in Safari 17.4, after
// the Safari 16 that macOS 13 shipped with.
const groupBy = <T, K>(items: Iterable<T>, key: (item: T, i: number) => K) => {
  const out = new Map<K, T[]>();
  let i = 0;
  for (const item of items) {
    const k = key(item, i++);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
};

const O = Object as unknown as { groupBy?: unknown };
O.groupBy ??= <T>(items: Iterable<T>, key: (item: T, i: number) => PropertyKey) =>
  Object.assign(Object.create(null), Object.fromEntries(groupBy(items, key)));
const M = Map as unknown as { groupBy?: unknown };
M.groupBy ??= groupBy;
const P = Promise as unknown as { withResolvers?: unknown };
P.withResolvers ??= function <T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
