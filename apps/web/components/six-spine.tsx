'use client';

import { useEffect, useState } from 'react';

export interface SpineEntry {
  readonly key: string;
  readonly numeral: string;
  readonly title: string;
  readonly count: number;
}

export interface SixSpineProps {
  readonly entries: readonly SpineEntry[];
  /** Section marked active before the scroll-spy takes over on the client. */
  readonly initialActiveKey?: string;
}

/**
 * The Six Spine.
 *
 * The same six sections in the same order in every report forever, each showing
 * a mono count. The active section carries a 2px emerald tick. On a phone the
 * rail collapses to a 44px sticky strip of six numerals with the same counts.
 *
 * The order is never reordered and never configurable — that is the whole point:
 * a manager learns the geography of the page in two days.
 */
export function SixSpine({ entries, initialActiveKey }: SixSpineProps) {
  const [activeKey, setActiveKey] = useState<string>(initialActiveKey ?? entries[0]?.key ?? '');

  useEffect(() => {
    const targets = entries
      .map((entry) => document.getElementById(`section-${entry.key}`))
      .filter((element): element is HTMLElement => element !== null);

    if (targets.length === 0 || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (records) => {
        const visible = records
          .filter((record) => record.isIntersecting)
          .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)[0];
        if (visible?.target.id.startsWith('section-')) {
          setActiveKey(visible.target.id.slice('section-'.length));
        }
      },
      { rootMargin: '-72px 0px -55% 0px', threshold: 0 },
    );

    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, [entries]);

  return (
    <>
      {/* Phone: a 44px sticky strip of six numerals. */}
      <nav
        aria-label="Report sections"
        className="sticky top-0 z-20 -mx-5 flex h-11 items-stretch border-b border-rule bg-surface/95 backdrop-blur lg:hidden"
      >
        {entries.map((entry) => {
          const isActive = entry.key === activeKey;
          return (
            <a
              key={entry.key}
              href={`#section-${entry.key}`}
              aria-current={isActive ? 'true' : undefined}
              title={entry.title}
              className={[
                'flex flex-1 flex-col items-center justify-center gap-0.5 border-t-2 transition-colors duration-150',
                isActive ? 'border-verified text-ink-strong' : 'border-transparent text-ink-faint',
                'hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px]',
              ].join(' ')}
            >
              <span className="font-mono text-[11px] leading-none tracking-tight tabular-nums">{entry.numeral}</span>
              <span className="font-mono text-[10px] leading-none tabular-nums opacity-70">{entry.count}</span>
              <span className="sr-only">
                {entry.title}, {entry.count} items
              </span>
            </a>
          );
        })}
      </nav>

      {/* Desktop: the left rail. */}
      <nav aria-label="Report sections" className="hidden lg:sticky lg:top-16 lg:block lg:self-start">
        <ul className="space-y-0">
          {entries.map((entry) => {
            const isActive = entry.key === activeKey;
            return (
              <li key={entry.key}>
                <a
                  href={`#section-${entry.key}`}
                  aria-current={isActive ? 'true' : undefined}
                  className={[
                    'group flex items-baseline gap-3 border-l-2 py-1.5 pl-3 pr-2 transition-colors duration-150',
                    isActive ? 'border-verified' : 'border-transparent hover:border-rule-strong',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'font-mono text-[11px] tabular-nums',
                      isActive ? 'text-verified-text' : 'text-ink-faint',
                    ].join(' ')}
                  >
                    {entry.numeral}
                  </span>
                  <span
                    className={[
                      'flex-1 text-[13px]',
                      isActive ? 'text-ink-strong' : 'text-ink-faint group-hover:text-ink',
                    ].join(' ')}
                  >
                    {entry.title}
                  </span>
                  <span className="font-mono text-[11px] tabular-nums text-ink-faint">{entry.count}</span>
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
