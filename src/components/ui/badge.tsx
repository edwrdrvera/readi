import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex w-fit shrink-0 items-center justify-center gap-1 rounded-md border px-1.5 py-px text-[11px] font-medium whitespace-nowrap", {
  variants: {
    variant: {
      default: "bg-primary text-primary-foreground border-transparent",
      secondary: "bg-secondary text-secondary-foreground border-transparent",
      destructive: "bg-destructive border-transparent text-white",
      outline: "text-foreground",
    },
  },
  defaultVariants: { variant: "default" },
});

function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
