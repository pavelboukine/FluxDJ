import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: ["/staff/:path*", "/login", "/auth/:path*", "/my", "/start", "/:tenant/invitations/:path*", "/:tenant/contracts/:path*", "/join/:path*", "/platform/:path*"],
};
