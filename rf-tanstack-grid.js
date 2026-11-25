// Rahul Finance — TanStack Table Core v9 Sortable Grid Engine
// Powered by @tanstack/table-core + @tanstack/store reactivity bindings

import {
  constructTable,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  tableFeatures
} from '@tanstack/table-core';
import { storeReactivityBindings } from '@tanstack/table-core/store-reactivity-bindings';

const features = tableFeatures({
  coreReactivityFeature: storeReactivityBindings(),
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    basic: sortFn_basic,
    numeric: (rowA, rowB, columnId) => {
      const a = Number(rowA.getValue(columnId)?.num);
      const b = Number(rowB.getValue(columnId)?.num);
      const aOk = Number.isFinite(a);
      const bOk = Number.isFinite(b);
      if (!aOk && !bOk) {
        return String(rowA.getValue(columnId)?.raw || '').localeCompare(String(rowB.getValue(columnId)?.raw || ''));
      }
      if (!aOk) return -1;
      if (!bOk) return 1;
      return a === b ? 0 : (a > b ? 1 : -1);
    }
  }
});

function parseCellSortValue(cellEl) {
  if (!cellEl) return { raw: '', num: NaN };
  const raw = String(cellEl.getAttribute('data-sort-val') ?? cellEl.textContent ?? '').trim();
  const cleaned = raw
    .replace(/[₹$,%+\s]/g, '')
    .replace(/,/g, '')
    .replace(/(days|hrs|min|pts|x)$/i, '');
  const num = cleaned !== '' && /^[-+]?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : NaN;
  return { raw, num };
}

const sortStatesByTable = new Map();

function sortTableBodyWithTanStack(tableEl, colIdx, desc) {
  if (!tableEl) return;
  const tbody = tableEl.querySelector('tbody');
  if (!tbody) return;
  const rows = Array.from(tbody.querySelectorAll('tr')).filter(tr => tr.cells && tr.cells.length > 1);
  if (rows.length < 2) return;

  const data = rows.map((tr) => {
    const record = { __tr: tr };
    Array.from(tr.cells).forEach((td, i) => {
      record[`c${i}`] = parseCellSortValue(td);
    });
    return record;
  });

  const sampleVals = data.map(r => r[`c${colIdx}`]).filter(Boolean);
  const numericCount = sampleVals.filter(v => Number.isFinite(v.num)).length;
  const isNumericCol = numericCount >= Math.max(1, Math.floor(sampleVals.length * 0.5));

  const columns = Array.from(tableEl.querySelectorAll('thead th')).map((_, i) => ({
    id: `c${i}`,
    accessorFn: (row) => (isNumericCol && i === colIdx ? row[`c${i}`] : row[`c${i}`]?.raw ?? ''),
    sortingFn: (isNumericCol && i === colIdx) ? 'numeric' : 'alphanumeric'
  }));

  const table = constructTable({
    features,
    data,
    columns,
    state: {
      sorting: [{ id: `c${colIdx}`, desc }]
    }
  });

  const sortedRows = table.getSortedRowModel().rows;
  const frag = document.createDocumentFragment();
  sortedRows.forEach(r => frag.appendChild(r.original.__tr));
  tbody.appendChild(frag);
}

function attachSortableTable(tableId, options = {}) {
  const tableEl = document.getElementById(tableId);
  if (!tableEl || tableEl.dataset.tanstackWired === '1') return;
  tableEl.dataset.tanstackWired = '1';

  const skipLastCols = Number(options.skipLastCols ?? 1);
  const thead = tableEl.querySelector('thead');
  if (!thead) return;

  const markHeaders = () => {
    const ths = Array.from(thead.querySelectorAll('th'));
    ths.forEach((th, idx) => {
      const text = (th.textContent || '').trim().toLowerCase();
      const isAction = text.includes('action') || text.includes('ઍક્શન') || text.includes('એકશન') || text.includes('remove') || text.includes('watchlist');
      if (isAction || (skipLastCols > 0 && idx >= ths.length - skipLastCols && ths.length > 2)) {
        th.classList.remove('rf-sortable-th');
        return;
      }
      th.classList.add('rf-sortable-th');
      th.setAttribute('title', 'Click to sort column');
    });
  };

  markHeaders();
  const observer = new MutationObserver(() => markHeaders());
  observer.observe(thead, { childList: true, subtree: true });

  thead.addEventListener('click', (e) => {
    const th = e.target.closest('th.rf-sortable-th');
    if (!th) return;
    const ths = Array.from(thead.querySelectorAll('th'));
    const colIdx = ths.indexOf(th);
    if (colIdx < 0) return;

    const prev = sortStatesByTable.get(tableId);
    const nextDesc = (prev && prev.colIdx === colIdx) ? !prev.desc : true;
    sortStatesByTable.set(tableId, { colIdx, desc: nextDesc });

    ths.forEach(el => el.removeAttribute('data-sort-dir'));
    th.setAttribute('data-sort-dir', nextDesc ? 'desc' : 'asc');

    sortTableBodyWithTanStack(tableEl, colIdx, nextDesc);
  });
}

function initAllSortableGrids() {
  // Note: #option-tips-table is intentionally excluded per strict non-auto-sort requirement
  const sortableIds = [
    ['results-table', { skipLastCols: 0 }],
    ['movement-table', { skipLastCols: 1 }],
    ['portfolio-table', { skipLastCols: 1 }],
    ['watchlist-table', { skipLastCols: 2 }],
    ['upcoming-results-table', { skipLastCols: 1 }],
    ['picks-table', { skipLastCols: 1 }],
    ['advice-table', { skipLastCols: 1 }],
    ['vol-promoter-table', { skipLastCols: 1 }],
    ['circuits-table', { skipLastCols: 1 }],
    ['global-indices-table', { skipLastCols: 0 }],
    ['intraday-table', { skipLastCols: 1 }],
    ['master-piece-table', { skipLastCols: 1 }]
  ];
  sortableIds.forEach(([id, opts]) => attachSortableTable(id, opts));
}

window.RfTanStackGrid = {
  attachSortableTable,
  initAllSortableGrids,
  constructTable,
  tableFeatures,
  storeReactivityBindings,
  rowSortingFeature,
  createSortedRowModel
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAllSortableGrids);
} else {
  initAllSortableGrids();
}
