import { cn } from '@/lib/utils';

/** A loading placeholder. `aria-hidden`, since a screen reader is told by the live region instead. */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}
