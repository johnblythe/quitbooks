"use client";

import { use, useActionState } from "react";
import { login } from "@/app/actions/auth";
import { Button, ErrorText, Field, inputClass } from "@/components/ui";

export function LoginForm({ nextPromise }: { nextPromise: Promise<string> }) {
  const next = use(nextPromise);
  const [state, action, pending] = useActionState(login, undefined);

  return (
    <form action={action} className="mt-8 space-y-4">
      <input type="hidden" name="next" value={next} />
      <Field label="Email">
        <input name="email" type="email" autoComplete="username" required defaultValue={state?.email} className={inputClass} />
      </Field>
      <Field label="Password">
        <input name="password" type="password" autoComplete="current-password" required className={inputClass} />
      </Field>
      <ErrorText>{state?.error}</ErrorText>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
