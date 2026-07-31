import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { routes } from '@/lib/routes';

export default function NotFound() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-16 text-center">
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <h1 className="text-lg font-semibold">No such page</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        TraceIQ has Overview, Explorer, Architecture, Impact, Search and Ask TraceIQ.
      </p>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
        <Button size="sm" variant="outline" asChild>
          <Link href={routes.dashboard()}>Back to the Overview</Link>
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <Link href={routes.home()}>Home</Link>
        </Button>
      </div>
    </div>
  );
}
