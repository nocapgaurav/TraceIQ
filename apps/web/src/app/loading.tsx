import { LoadingState } from '@/components/domain/states';

/** The route-level fallback Next shows while a page's code is still arriving. */
export default function Loading() {
  return <LoadingState label="Loading page" rows={6} />;
}
