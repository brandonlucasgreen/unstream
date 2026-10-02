// Wall-clock time per search phase, so a slow search says where its time went.
//
// Reported twice: one `[search-timing]` line in the function log (Netlify's log
// search finds them), and a Server-Timing header, which browser devtools draw in the
// request's Timing tab. A CDN-cached response replays the header from the request
// that filled the cache, so read it on a cache miss.

interface TimingEntry {
  name: string;
  ms: number;
  desc?: string;
}

export class SearchTimer {
  private readonly startedAt = Date.now();
  private readonly entries: TimingEntry[] = [];

  /** Time a promise under `name`. Rejections still propagate, and are timed too. */
  async time<T>(name: string, work: Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      return await work;
    } finally {
      this.record(name, Date.now() - startedAt);
    }
  }

  record(name: string, ms: number, desc?: string): void {
    this.entries.push({ name, ms, desc });
  }

  totalMs(): number {
    return Date.now() - this.startedAt;
  }

  /** e.g. `bandcamp;dur=812, mb;dur=3;desc="cached", total;dur=1490` */
  toServerTiming(): string {
    const parts = this.entries.map(e =>
      `${e.name};dur=${e.ms}${e.desc ? `;desc="${e.desc}"` : ''}`
    );
    parts.push(`total;dur=${this.totalMs()}`);
    return parts.join(', ');
  }

  /** e.g. `total=1490ms bandcamp=812ms mb=3ms(cached)` */
  toLogLine(): string {
    const parts = [`total=${this.totalMs()}ms`];
    for (const e of this.entries) {
      parts.push(`${e.name}=${e.ms}ms${e.desc ? `(${e.desc})` : ''}`);
    }
    return parts.join(' ');
  }
}
