"use client";

import { cn } from "@/lib/cn";

interface Step {
  label: string;
  id: string;
}

interface StepIndicatorProps {
  steps: Step[];
  currentStep: string;
}

export function StepIndicator({ steps, currentStep }: StepIndicatorProps) {
  const currentIdx = steps.findIndex((s) => s.id === currentStep);

  return (
    <div className="flex items-center w-full">
      {steps.map((step, idx) => {
        const isCompleted = idx < currentIdx;
        const isCurrent = idx === currentIdx;
        const isLast = idx === steps.length - 1;

        return (
          <div
            key={step.id}
            className={cn("flex items-center", !isLast && "flex-1")}
          >
            <div className="flex flex-col items-center">
              <div
                className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold transition-colors",
                  isCompleted
                    ? "bg-primary text-on-primary"
                    : isCurrent
                      ? "border-2 border-primary bg-transparent"
                      : "bg-surface-container-high text-on-surface-variant",
                )}
              >
                {isCompleted ? (
                  <span className="material-symbols-outlined text-base">check</span>
                ) : isCurrent ? (
                  <span className="w-2.5 h-2.5 rounded-full bg-primary" />
                ) : (
                  idx + 1
                )}
              </div>
              <span
                className={cn(
                  "text-xs mt-2 whitespace-nowrap",
                  isCompleted || isCurrent
                    ? "text-on-surface"
                    : "text-on-surface-variant",
                )}
              >
                {step.label}
              </span>
            </div>

            {!isLast && (
              <div
                className={cn(
                  "flex-1 h-0.5 mx-2 transition-colors",
                  isCompleted ? "bg-primary" : "bg-outline-variant/30",
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
