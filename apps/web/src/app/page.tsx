import type { Metadata } from 'next';

import { Features } from '@/components/marketing/features';
import { Hero } from '@/components/marketing/hero';
import { HowItWorks } from '@/components/marketing/how-it-works';
import { WhyTraceIQ } from '@/components/marketing/why-traceiq';

/**
 * The landing page, and the application's root.
 *
 * A server component holding four bands. Only the hero opts into the client, for its dialog and the
 * `/version` pill — the other three are static markup and are sent as HTML, which is what a first-visit
 * page should be.
 *
 * `-mx-4 -my-5` cancels the padding `AppShell` applies to `<main>`. Every other page wants that gutter;
 * a landing page needs its bands to reach the edge of the frame, and each `Band` re-applies its own
 * padding on the inside.
 *
 * The dashboard, which used to be the root, now lives at `/dashboard`.
 */
export const metadata: Metadata = {
  title: { absolute: 'TraceIQ — Understand Any Repository in Minutes' },
  description: 'AI-powered repository intelligence built on deterministic static analysis.',
};

export default function LandingPage() {
  return (
    <div className="-mx-4 -my-5">
      <Hero />
      <HowItWorks />
      <Features />
      <WhyTraceIQ />
    </div>
  );
}
