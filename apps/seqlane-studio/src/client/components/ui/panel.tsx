import type { HTMLAttributes, ReactNode } from "react";
import { Heading } from "./typography.js";

type PanelElement = "aside" | "div" | "nav" | "section";

interface PanelRootProps extends HTMLAttributes<HTMLElement> {
  readonly as?: PanelElement;
  readonly children?: ReactNode;
}

interface PanelPartProps extends HTMLAttributes<HTMLElement> {
  readonly children?: ReactNode;
}

interface PanelTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  readonly children: ReactNode;
}

function PanelRoot({ as = "section", className, ...props }: PanelRootProps) {
  const Element = as;
  return (
    <Element
      {...props}
      className={["border border-studio-border bg-studio-surface", className]
        .filter(Boolean)
        .join(" ")}
    />
  );
}

function PanelHeader({ className, ...props }: PanelPartProps) {
  return (
    <div
      {...props}
      className={["flex items-center justify-between gap-3", className]
        .filter(Boolean)
        .join(" ")}
    />
  );
}

function PanelBody({ className, ...props }: PanelPartProps) {
  return <div {...props} className={className} />;
}

function PanelTitle({ className, ...props }: PanelTitleProps) {
  return <Heading {...props} className={className} size="section" />;
}

export const Panel = Object.assign(PanelRoot, {
  Body: PanelBody,
  Header: PanelHeader,
  Title: PanelTitle,
});
