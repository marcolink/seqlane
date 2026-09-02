import type { ReactNode, SelectHTMLAttributes } from "react";
import { Label } from "./typography.js";

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly children: ReactNode;
  readonly label: string;
}

export function Select({
  children,
  className,
  id,
  label,
  ...props
}: SelectProps) {
  return (
    <label className="studio-select" htmlFor={id}>
      <Label>{label}</Label>
      <select {...props} className={className} id={id}>
        {children}
      </select>
    </label>
  );
}
