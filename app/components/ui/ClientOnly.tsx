import { useEffect, useState } from "react";

/** Renders children only after hydration — prevents SSR mismatch for browser-only libs like Cytoscape. */
export function ClientOnly({ children, fallback = null }: {
  children: () => React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <>{children()}</> : <>{fallback}</>;
}
