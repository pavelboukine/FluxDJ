import type { ReactNode } from "react";
import { Users } from "lucide-react";
import { PublicCard } from "@/components/app/public-shell";

/** The frame of the staff invitation pages, in the sign-in pages' style. */
export function InviteCard({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <PublicCard icon={Users} title={title} description={description}>
      {children}
    </PublicCard>
  );
}
