import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import type { Database } from "./database.types";
import { publicEnv } from "@/lib/env";
import { allowedNext } from "@/lib/auth/redirects";

/**
 * Refreshes the Supabase session cookie on each matched request and makes an
 * optimistic redirect to the DJ sign-in for signed-out visitors of /staff. This is not
 * authorization: pages and actions verify the user and membership themselves.
 */
export async function updateSession(request: NextRequest) {
  const env = publicEnv();
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);

  if (!signedIn && request.nextUrl.pathname.startsWith("/staff")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // The DJ sign-in, coming back to this page afterwards when it's an allowed destination.
    const next = allowedNext(request.nextUrl.pathname);
    url.search = next && next !== "/staff" ? `?role=dj&next=${encodeURIComponent(next)}` : "?role=dj";
    const redirect = NextResponse.redirect(url);
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }
  return response;
}
