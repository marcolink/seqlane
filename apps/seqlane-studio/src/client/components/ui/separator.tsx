import type { HTMLAttributes } from "react";

export function Separator({
  className,
  ...props
}: HTMLAttributes<HTMLHRElement>) {
  return (
    <hr
      {...props}
      className={["studio-separator", className].filter(Boolean).join(" ")}
    />
  );
}
