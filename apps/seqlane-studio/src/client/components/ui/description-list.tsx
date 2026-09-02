import type { HTMLAttributes, ReactNode } from "react";

interface DescriptionListItem {
  readonly description: ReactNode;
  readonly term: string;
}

interface DescriptionListProps extends HTMLAttributes<HTMLDListElement> {
  readonly items: readonly DescriptionListItem[];
}

export function DescriptionList({
  className,
  items,
  ...props
}: DescriptionListProps) {
  return (
    <dl
      {...props}
      className={["studio-description-list", className]
        .filter(Boolean)
        .join(" ")}
    >
      {items.map(({ description, term }) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{description}</dd>
        </div>
      ))}
    </dl>
  );
}
