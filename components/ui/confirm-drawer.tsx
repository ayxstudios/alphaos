"use client";

import { Button } from "./button";
import { Drawer } from "./drawer";

/**
 * "Are you sure?" in the app's own drawer, never a browser alert: what will
 * happen, then Cancel and the one action. Used before anything that is not
 * undone from the same screen (mark paid, delete a style, backfill a shop).
 */
export function ConfirmDrawer({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel,
  danger = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
}) {
  return (
    <Drawer open={open} onClose={onClose} title={title}>
      <div className="flex flex-col gap-4">
        {children}
        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" className="min-h-11 sm:min-h-0" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={danger ? "danger" : "primary"}
            className="min-h-11 sm:min-h-0"
            onClick={() => {
              onClose();
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
