"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { recordLabel } from "../lib/citation";
import { useT } from "../lib/i18n";
import { announce } from "../lib/toast";
import type { Knowledge, TypeDef } from "../lib/types";
import { CreateRecord } from "./CreateRecord";
import { Modal } from "./Modal";

/**
 * The page-level create action: a button on the title row, a modal holding the form.
 *
 * A button rather than a form sitting open above the list: an always-open form pushes the thing you
 * came to read one panel down on every visit, for an action most visits do not take.
 *
 * A successful create CLOSES the dialog — the form's job ends at the commit, and a dialog that
 * lingers over the list reads as "not done yet". What the gate had to say about that commit (saved
 * as a draft, similar records already exist, nothing was compared) follows the reader out as a
 * toast, so closing does not swallow it. Errors are the opposite case: the dialog stays open with
 * the gate's words next to the fields that caused them, because an error is not an outcome to walk
 * away from.
 */
export function CreateButton({
  ontology,
  type,
  scope,
  onCreated,
  label,
}: {
  ontology: TypeDef[];
  /** Fixed type, or undefined to let one be picked from the ontology. */
  type?: string;
  scope?: string;
  onCreated: (created: Knowledge) => void;
  label?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // From the dictionary, never a template literal: an interpolated English fallback stays English in
  // every locale. A caller with a type of its own passes `label`; the generic case is the record
  // wording.
  const text = label ?? t.create.newRecord;
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        {text}
      </Button>
      <Modal
        open={open}
        title={text}
        description={t.create.draftNotice}
        onClose={() => setOpen(false)}
      >
        <CreateRecord
          ontology={ontology}
          type={type}
          scope={scope}
          onCreated={(created) => {
            // One sentence, the most important one: a duplicate warning outranks the plain
            // "created" (it already says created), and "nothing was compared" outranks silence.
            const dups = created.duplicates ?? [];
            announce(
              dups.length > 0
                ? t.create.duplicates(
                    dups.length,
                    dups.map((d) => recordLabel(d)).join(" · "),
                  )
                : created.duplicateDetection === "skipped"
                  ? t.create.notChecked
                  : t.create.createdToast(recordLabel(created)),
            );
            setOpen(false);
            onCreated(created);
          }}
        />
      </Modal>
    </>
  );
}
