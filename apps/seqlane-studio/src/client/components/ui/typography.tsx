import type { HTMLAttributes, ReactNode } from "react";

type HeadingElement = "h1" | "h2" | "h3";
type HeadingSize = "product" | "title" | "section" | "subsection";
type TextElement = "div" | "p" | "small" | "span" | "strong";
type LabelElement = "p" | "span";
type MonoElement = "code" | "dd" | "div" | "small" | "span" | "strong";

interface HeadingProps extends HTMLAttributes<HTMLHeadingElement> {
  readonly as?: HeadingElement;
  readonly children: ReactNode;
  readonly size?: HeadingSize;
}

interface TextProps extends HTMLAttributes<HTMLElement> {
  readonly as?: TextElement;
  readonly children: ReactNode;
  readonly tone?: "default" | "muted" | "faint";
  readonly variant?: "body" | "meta";
}

interface LabelProps extends HTMLAttributes<HTMLElement> {
  readonly as?: LabelElement;
  readonly children: ReactNode;
}

interface MonoProps extends HTMLAttributes<HTMLElement> {
  readonly as?: MonoElement;
  readonly children: ReactNode;
}

function typeClassName(...names: readonly (string | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

export function Heading({
  as: Element = "h2",
  children,
  className,
  size = "section",
  ...props
}: HeadingProps) {
  return (
    <Element
      {...props}
      className={typeClassName(
        "studio-heading",
        `studio-heading--${size}`,
        className,
      )}
    >
      {children}
    </Element>
  );
}

export function Text({
  as: Element = "span",
  children,
  className,
  tone = "default",
  variant = "body",
  ...props
}: TextProps) {
  return (
    <Element
      {...props}
      className={typeClassName(
        "studio-text",
        `studio-text--${variant}`,
        `studio-text--${tone}`,
        className,
      )}
    >
      {children}
    </Element>
  );
}

export function Label({
  as: Element = "span",
  children,
  className,
  ...props
}: LabelProps) {
  return (
    <Element {...props} className={typeClassName("studio-label", className)}>
      {children}
    </Element>
  );
}

export function Mono({
  as: Element = "span",
  children,
  className,
  ...props
}: MonoProps) {
  return (
    <Element {...props} className={typeClassName("studio-mono", className)}>
      {children}
    </Element>
  );
}
