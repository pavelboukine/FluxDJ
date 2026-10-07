import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Workspace unavailable · Flux DJ", robots: { index: false, follow: false } };

/**
 * Where members of a suspended workspace land. Deliberately generic: no
 * business name, reason or administrator, and the same page for every
 * workspace, so it reveals nothing.
 */
export default function WorkspaceUnavailable() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-12">
      <Card>
        <CardHeader>
          <CardTitle>This workspace is unavailable</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <p>
            Access to this business on Flux DJ has been suspended, so it can&apos;t be opened right now and nothing can be changed in it.
            Nothing in it has been deleted.
          </p>
          <p>Your sign-in and any other businesses or events you have on Flux DJ aren&apos;t affected.</p>
          <p>If you think this is a mistake, contact Flux DJ.</p>
          <Link className="underline" href="/staff">Go to my businesses</Link>
        </CardContent>
      </Card>
    </main>
  );
}
