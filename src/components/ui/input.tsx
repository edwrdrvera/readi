import * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "placeholder:text-muted-foreground flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-sm outline-none focus-visible:border-foreground/25 disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
