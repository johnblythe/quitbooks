import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-12">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">L Marie Beauty Collective</p>
      <h1 className="mt-2 font-serif text-3xl text-ink">The books</h1>
      <p className="mt-2 text-sm text-ink-2">Sign in to see how the salon is doing.</p>
      <Suspense fallback={<div className="mt-8 h-56" />}>
        <LoginForm nextPromise={searchParams.then((s) => s.next ?? "/")} />
      </Suspense>
    </main>
  );
}
