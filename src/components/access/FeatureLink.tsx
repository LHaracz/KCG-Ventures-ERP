"use client";

import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { useAccess } from "@/components/access/AccessProvider";
import type { FeatureKey } from "@/lib/access/catalog";

/**
 * A link into another feature's page. Rendered only when the signed-in
 * employee has that feature (or is an Admin, for admin pages); otherwise the
 * fallback (plain text or nothing) is shown. The target page checks access on
 * the server regardless.
 */
export function FeatureLink({
  feature,
  admin,
  fallback = null,
  ...props
}: ComponentProps<typeof Link> & { feature?: FeatureKey; admin?: boolean; fallback?: ReactNode }) {
  const { has, me } = useAccess();
  const allowed = admin ? !!me?.active && me.isAdmin : feature ? has(feature) : false;
  if (!allowed) return <>{fallback}</>;
  return <Link {...props} />;
}
