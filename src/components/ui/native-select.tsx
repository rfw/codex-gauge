import * as React from "react"
import { ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"

type NativeSelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  containerClassName?: string
}

export function NativeSelect({
  className,
  containerClassName,
  children,
  ...props
}: NativeSelectProps) {
  return (
    <div className={cn("relative", containerClassName)}>
      <select
        className={cn(
          "peer h-8 w-full appearance-none rounded-md border border-input bg-background px-2.5 pr-8 text-sm text-foreground shadow-xs outline-none transition-[color,box-shadow,border-color]",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground peer-disabled:opacity-50"
        strokeWidth={1.75}
      />
    </div>
  )
}
