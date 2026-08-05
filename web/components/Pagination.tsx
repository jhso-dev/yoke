"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "../lib/i18n";

const LIST_PAGE_SIZE = 20;

export function usePage<T>(items: T[], pageSize = LIST_PAGE_SIZE) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  useEffect(() => {
    setPage(0);
  }, []);
  const current = Math.min(page, pages - 1);
  return {
    page: current,
    pages,
    items: items.slice(current * pageSize, current * pageSize + pageSize),
    setPage,
  };
}

export function Pagination({
  page,
  pages,
  setPage,
  total,
}: {
  page: number;
  pages: number;
  setPage: (page: number) => void;
  total: number;
}) {
  const t = useT();
  if (total <= LIST_PAGE_SIZE) return null;
  return (
    <div className="controls pager">
      <Button
        type="button"
        variant="secondary"
        disabled={page === 0}
        onClick={() => setPage(page - 1)}
      >
        <ChevronLeftIcon />
        {t.common.prev}
      </Button>
      <span className="muted">{t.common.page(page + 1, pages, total)}</span>
      <Button
        type="button"
        variant="secondary"
        disabled={page >= pages - 1}
        onClick={() => setPage(page + 1)}
      >
        {t.common.next}
        <ChevronRightIcon />
      </Button>
    </div>
  );
}
