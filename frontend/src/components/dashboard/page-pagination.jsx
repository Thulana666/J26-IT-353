import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

// Page numbers to show: first, last, and the current page with its neighbours,
// with null marking a gap ("…"). E.g. page 6 of 12 -> 1 … 5 6 7 … 12
function pageNumbers(page, pageCount) {
  const wanted = new Set([1, pageCount, page - 1, page, page + 1]);
  const numbers = [...wanted].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b);
  const result = [];
  numbers.forEach((n, i) => {
    if (i > 0 && n - numbers[i - 1] > 1) result.push(null);
    result.push(n);
  });
  return result;
}

// Link-based pagination: ?page=N on the given path (page 1 has no parameter).
export function PagePagination({ page, pageCount, basePath }) {
  if (pageCount <= 1) return null;
  const href = (n) => (n <= 1 ? basePath : `${basePath}?page=${n}`);

  return (
    <Pagination className="mt-4">
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            href={href(page - 1)}
            aria-disabled={page === 1}
            className={page === 1 ? "pointer-events-none opacity-50" : undefined}
          />
        </PaginationItem>
        {pageNumbers(page, pageCount).map((n, i) =>
          n === null ? (
            <PaginationItem key={`gap-${i}`}>
              <PaginationEllipsis />
            </PaginationItem>
          ) : (
            <PaginationItem key={n}>
              <PaginationLink href={href(n)} isActive={n === page}>
                {n}
              </PaginationLink>
            </PaginationItem>
          )
        )}
        <PaginationItem>
          <PaginationNext
            href={href(page + 1)}
            aria-disabled={page === pageCount}
            className={page === pageCount ? "pointer-events-none opacity-50" : undefined}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
