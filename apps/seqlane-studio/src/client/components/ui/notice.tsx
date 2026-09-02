import type { HTMLAttributes, ReactNode } from "react";

type NoticeTone = "error" | "warning" | "info";

interface NoticeProps extends HTMLAttributes<HTMLDivElement> {
  readonly children: ReactNode;
  readonly tone: NoticeTone;
}

export function Notice({ className, tone, ...props }: NoticeProps) {
  return (
    <div
      {...props}
      className={["studio-notice", `studio-notice--${tone}`, className]
        .filter(Boolean)
        .join(" ")}
    />
  );
}
