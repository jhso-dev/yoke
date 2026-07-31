"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { copyText } from "../lib/clipboard";
import { useT } from "../lib/i18n";

export function CopyCode({ value }: { value: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <span className="copy-code">
      <code>{value}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        title={copied ? t.common.copied : t.common.copy}
        aria-label={copied ? t.common.copied : t.common.copy}
        onClick={async () => {
          await copyText(value, t.common.copied);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </span>
  );
}
