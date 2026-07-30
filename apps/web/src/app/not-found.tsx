import Link from 'next/link';

import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-16 text-center">
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <h1 className="text-lg font-semibold">No such page</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        The application has seven pages: Dashboard, Explorer, Symbol, Impact, Architecture, Health and
        Search.
      </p>
      <Button size="sm" variant="outline" asChild className="mt-1">
        <Link href="/">Back to the dashboard</Link>
      </Button>
    </div>
  );
}
