import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-4 px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Flux DJ</h1>
      <p className="text-muted-foreground">Proposal, contract and event planning portal for independent DJs.</p>
      <div>
        <Link className={buttonVariants()} href="/login">
          Staff sign in
        </Link>
      </div>
    </main>
  );
}
