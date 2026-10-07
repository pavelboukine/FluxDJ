import Link from "next/link";

/**
 * Not found. Always offers a way on: from the home-screen app there are no
 * browser controls, so a page without links would be a dead end.
 */
export default function NotFound() {
  return (
    <main className="mx-auto grid w-full max-w-md flex-1 content-center gap-3 px-4 py-16 text-sm">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p>This page doesn&apos;t exist, or this account can&apos;t open it.</p>
      <p>
        <Link className="underline" href="/start">Go to Flux DJ</Link>
      </p>
    </main>
  );
}
