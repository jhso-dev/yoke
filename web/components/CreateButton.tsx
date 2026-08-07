"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "../lib/i18n";
import type { Knowledge, TypeDef } from "../lib/types";
import { CreateRecord } from "./CreateRecord";
import { Modal } from "./Modal";

/**
 * The page-level create action: a button on the title row, a modal holding the form.
 *
 * A button rather than a form sitting open above the list: an always-open form pushes the thing you
 * came to read one panel down on every visit, for an action most visits do not take.
 *
 * It stays open after a successful create. Creating one record is rarely creating exactly one, and
 * the duplicate warning the gate returns is shown inside the form — closing on success would throw
 * that away at the moment it matters. Closing is the reader's call: the button, Esc, or the backdrop.
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
          onCreated={onCreated}
        />
      </Modal>
    </>
  );
}
