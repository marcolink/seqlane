import type { SeqlaneDisplayValue } from "@seqlane/core";
import type { HTMLAttributes, ReactNode } from "react";
import { CodeBlock } from "../../components/ui/value-card.js";
import { Heading, Text } from "../../components/ui/typography.js";
import { displayValueText } from "../../session/projection.js";

interface InspectorSectionProps extends HTMLAttributes<HTMLElement> {
  readonly children: ReactNode;
  readonly detail?: ReactNode;
  readonly heading: string;
}

interface InspectorValueSectionProps {
  readonly heading: string;
  readonly value: SeqlaneDisplayValue | undefined;
}

export function InspectorSection({
  children,
  className,
  detail,
  heading,
  ...props
}: InspectorSectionProps) {
  return (
    <section
      {...props}
      aria-label={heading}
      className={["studio-inspector-section", className]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="studio-inspector-section__header">
        <Heading as="h3" size="subsection">
          {heading}
        </Heading>
        {detail === undefined ? null : (
          <Text as="span" tone="muted" variant="meta">
            {detail}
          </Text>
        )}
      </div>
      {children}
    </section>
  );
}

export function InspectorValueSection({
  heading,
  value,
}: InspectorValueSectionProps) {
  const display = displayValueText(value);
  return (
    <InspectorSection detail={display.label} heading={heading}>
      <InspectorValueContent value={value} />
    </InspectorSection>
  );
}

export function InspectorValueSubsection({
  heading,
  value,
}: InspectorValueSectionProps) {
  const display = displayValueText(value);
  return (
    <div className="studio-inspector-section__subsection">
      <div className="studio-inspector-section__subsection-heading">
        <Text as="strong" variant="meta">
          {heading}
        </Text>
        <Text as="span" tone="muted" variant="meta">
          {display.label}
        </Text>
      </div>
      <InspectorValueContent value={value} />
    </div>
  );
}

function InspectorValueContent({
  value,
}: Pick<InspectorValueSectionProps, "value">) {
  const display = displayValueText(value);
  return (
    <>
      {display.detail === undefined ? null : (
        <Text as="p" tone="muted" variant="meta">
          {display.detail}
        </Text>
      )}
      {display.raw === undefined ? null : <CodeBlock>{display.raw}</CodeBlock>}
    </>
  );
}
