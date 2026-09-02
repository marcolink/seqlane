import type { HTMLAttributes, ReactNode } from "react";
import { Heading } from "./typography.js";

interface ValueCardProps extends HTMLAttributes<HTMLElement> {
  readonly children: ReactNode;
  readonly heading: string;
  readonly headingId?: string;
}

interface CodeBlockProps extends HTMLAttributes<HTMLPreElement> {
  readonly children: ReactNode;
}

export function ValueCard({
  children,
  className,
  heading,
  headingId,
  ...props
}: ValueCardProps) {
  return (
    <section
      {...props}
      aria-labelledby={headingId}
      className={["studio-value-card", className].filter(Boolean).join(" ")}
    >
      <Heading as="h3" id={headingId} size="subsection">
        {heading}
      </Heading>
      {children}
    </section>
  );
}

export function CodeBlock({ className, ...props }: CodeBlockProps) {
  return (
    <pre
      {...props}
      className={["studio-code-block", className].filter(Boolean).join(" ")}
    />
  );
}
