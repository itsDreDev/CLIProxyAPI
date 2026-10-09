"use client";

import type { ReactNode } from "react";
import { DeskProvider } from "@/lib/desk";

export function Providers({ children }: { children: ReactNode }) {
  return <DeskProvider>{children}</DeskProvider>;
}
