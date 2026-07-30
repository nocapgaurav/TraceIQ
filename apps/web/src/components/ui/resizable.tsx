'use client';

import { GripVertical } from 'lucide-react';
import * as ResizablePrimitive from 'react-resizable-panels';

import { cn } from '@/lib/utils';

export const ResizablePanelGroup = ({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelGroup>) => (
  <ResizablePrimitive.PanelGroup
    className={cn('flex h-full w-full data-[panel-group-direction=vertical]:flex-col', className)}
    {...props}
  />
);

export const ResizablePanel = ResizablePrimitive.Panel;

/**
 * A draggable divider.
 *
 * `react-resizable-panels` gives the handle a role, `aria-valuenow` and arrow-key handling of its own,
 * so the layout is resizable from the keyboard without anything added here.
 */
export const ResizableHandle = ({
  withHandle = true,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelResizeHandle> & { readonly withHandle?: boolean }) => (
  <ResizablePrimitive.PanelResizeHandle
    className={cn(
      'relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full',
      className,
    )}
    {...props}
  >
    {withHandle ? (
      <div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border border-border bg-border">
        <GripVertical className="h-2.5 w-2.5" />
      </div>
    ) : null}
  </ResizablePrimitive.PanelResizeHandle>
);
