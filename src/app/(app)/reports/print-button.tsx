"use client";

import { buttonClass } from "@/components/ui";

/** Uses the browser's print dialog, which also offers "Save as PDF". */
export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className={buttonClass("secondary", "col-span-2")}>
      Print or save as PDF
    </button>
  );
}
