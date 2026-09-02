import type { DetailsHTMLAttributes, ReactNode } from "react";

interface DisclosureProps extends DetailsHTMLAttributes<HTMLDetailsElement> {
  readonly children: ReactNode;
  readonly summary: ReactNode;
}

export function Disclosure({
  children,
  className,
  summary,
  ...props
}: DisclosureProps) {
  return (
    <details
      {...props}
      className={["studio-disclosure", className].filter(Boolean).join(" ")}
    >
      <summary>{summary}</summary>
      {children}
    </details>
  );
}
