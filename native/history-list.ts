/** Replayable JSON array whose elements can be loaded one at a time. */
export class HistoryList<T> implements Iterable<T> {
  private readonly entries: Array<() => T> = [];

  get length(): number {
    return this.entries.length;
  }

  append(load: () => T): void {
    this.entries.push(load);
  }

  *[Symbol.iterator](): Iterator<T> {
    for (const load of this.entries) yield load();
  }
}
