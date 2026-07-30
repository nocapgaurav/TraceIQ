import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * A scrolling region.
 *
 * Native overflow rather than a virtualised or custom-scrollbar component: a native scroller keeps
 * keyboard paging, find-in-page and momentum scrolling for free, and `tabIndex={0}` makes it reachable
 * so a keyboard user can scroll a list they cannot otherwise focus.
 */
export const ScrollArea = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function ScrollArea({ className, ...props }, ref) {
    return <div ref={ref} tabIndex={0} className={cn('overflow-y-auto overflow-x-hidden', className)} {...props} />;
  },
);
