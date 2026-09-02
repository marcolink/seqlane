import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonAppearance = "primary" | "quiet";
type ButtonSize = "standard" | "compact";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly appearance?: ButtonAppearance;
  readonly children: ReactNode;
  readonly size?: ButtonSize;
}

interface IconButtonProps extends Omit<ButtonProps, "aria-label" | "children"> {
  readonly "aria-label": string;
  readonly children: ReactNode;
}

function buttonClassName(
  appearance: ButtonAppearance,
  size: ButtonSize,
  className: string | undefined,
): string {
  return [
    "studio-button",
    `studio-button--${appearance}`,
    `studio-button--${size}`,
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

export function Button({
  appearance = "quiet",
  className,
  size = "standard",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={buttonClassName(appearance, size, className)}
    />
  );
}

export function IconButton({
  appearance = "quiet",
  className,
  size = "compact",
  ...props
}: IconButtonProps) {
  return (
    <Button
      {...props}
      appearance={appearance}
      size={size}
      className={[className, "studio-icon-button"].filter(Boolean).join(" ")}
    />
  );
}
