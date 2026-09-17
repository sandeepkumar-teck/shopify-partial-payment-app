export default function Pagination({
  label = "Pages",
  pages = [],
  current = 1,
  total = 1,
  summary,
  busy = false,
  canPrev = false,
  canNext = false,
  onPrev,
  onNext,
  onPage,
}) {
  if (!(total > 1) && !canPrev && !canNext) return null;

  return (
    <nav className="pp-pager" aria-label={label}>
      <span className="pp-pager__meta">{summary || `Page ${current} of ${total}`}</span>
      <div className="pp-pager__track">
        <button
          type="button"
          className="pp-pager__dir"
          disabled={!canPrev || busy}
          onClick={onPrev}
          aria-label="Previous page"
        >
          ‹
        </button>
        {pages.map((n, index) => {
          const prev = pages[index - 1];
          const gap = prev && n - prev > 1;
          return (
            <span key={n} className="pp-pager__group">
              {gap ? <span className="pp-pager__gap">···</span> : null}
              {n === current ? (
                <span className="pp-pager__page is-current" aria-current="page">
                  {n}
                </span>
              ) : (
                <button
                  type="button"
                  className="pp-pager__page"
                  disabled={busy}
                  onClick={() => onPage?.(n)}
                >
                  {n}
                </button>
              )}
            </span>
          );
        })}
        <button
          type="button"
          className="pp-pager__dir"
          disabled={!canNext || busy}
          onClick={onNext}
          aria-label="Next page"
        >
          ›
        </button>
      </div>
    </nav>
  );
}
