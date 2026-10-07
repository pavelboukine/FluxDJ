const STEPS = ["Invitation received", "Verify your email", "Name your business", "Open your workspace"] as const;

/** Where the invited DJ is in onboarding (1-based). */
export function JoinSteps({ current }: { current: 1 | 2 | 3 | 4 }) {
  return (
    <ol aria-label="Setup steps" className="grid gap-1 text-sm">
      {STEPS.map((label, index) => {
        const step = index + 1;
        return (
          <li key={label} aria-current={step === current ? "step" : undefined} className={step === current ? "font-medium" : "text-muted-foreground"}>
            {step < current ? "✓" : `${step}.`} {label}
          </li>
        );
      })}
    </ol>
  );
}
