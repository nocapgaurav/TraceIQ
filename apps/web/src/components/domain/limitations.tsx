import { Info } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { count } from '@/lib/format';
import type { Limitation } from '@/types/api';

/**
 * What the analysis could not determine.
 *
 * Every capability reports its own limitations as fixed codes, and showing them is the whole point: a
 * result that hides what it could not see reads as more complete than it is. The wording is the
 * server's — nothing here is composed.
 */
export function Limitations({
  limitations,
  title = 'Limitations',
}: {
  readonly limitations: readonly Limitation[];
  readonly title?: string;
}) {
  if (limitations.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Info className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          {title}
          <span className="font-normal text-muted-foreground">({limitations.length})</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2">
          {limitations.map((limitation) => (
            <li key={limitation.code} className="border-l-2 border-border pl-3">
              <p className="font-mono text-[11px] text-muted-foreground">
                {limitation.code}
                {limitation.affected === null ? '' : ` · affects ${count(limitation.affected)}`}
              </p>
              <p className="text-xs">{limitation.detail}</p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
