import Link from 'next/link';
import { Card } from '@javis-dog/ui/components';

export function SignInPrompt({ what }: { what: string }) {
  return (
    <Card labelledBy="sign-in-prompt">
      <div className="flex flex-wrap items-center justify-between gap-3 p-5">
        <p id="sign-in-prompt" className="text-sm text-ink">
          Sign in to see {what}.
        </p>
        <Link
          href="/sign-in"
          className="rounded-control bg-primary px-4 py-2.5 text-xs font-bold text-on-primary"
        >
          Sign in
        </Link>
      </div>
    </Card>
  );
}
